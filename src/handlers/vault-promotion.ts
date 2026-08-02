/**
 * Vault promotion — migrate stable hot-memory entries into the vault.
 *
 * Trigger: after a store mutation crosses vaultPromoteThreshold (default 67%)
 * of its character limit, a background promotion is scheduled (fire-and-forget,
 * deduped per target — same pattern as auto-consolidation).
 *
 * Pipeline: a child `pi -p` reads the current entries and returns STRICT JSON:
 *   {"promote":[{"file":"System/Assistant/context.md","content":"..."}],"remove":["<entry text>"]}
 * The PARENT executes the plan deterministically:
 *   1. Write/merge vault files FIRST (copy)
 *   2. Only then remove the promoted entries from hot memory
 * Copy-then-remove ordering guarantees no knowledge is ever lost: any child or
 * write failure leaves all entries untouched.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { PROMOTION_PROMPT, ENTRY_DELIMITER, DEFAULT_VAULT_PROMOTE_THRESHOLD } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { execChildPrompt } from "./pi-child-process.js";
import { ensureVault, vaultConfigured } from "./vault-notes.js";

export interface PromotionResult {
  promoted: number;
  removed: number;
  error?: string;
}

type Target = "memory" | "user" | "failure";

/** One pending promotion per store target (fire-and-forget dedupe). */
const pending = new Set<string>();

function limitFor(target: Target, config: MemoryConfig, project: boolean): number {
  if (target === "failure") return config.memoryCharLimit * 2;
  if (target === "user") return config.userCharLimit;
  return project ? config.projectCharLimit : config.memoryCharLimit;
}

function entriesFor(store: MemoryStore, target: Target): string[] {
  if (target === "user") return store.getUserEntries();
  if (target === "failure") return store.getAllFailureEntries();
  return store.getMemoryEntries();
}

/** Wire the threshold trigger onto the stores' mutation observers. */
export function setupVaultPromotion(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
): void {
  if (!vaultConfigured(config.vaultPath)) return;

  store.setMutationObserver(async (target, entries) => {
    scheduleIfOverThreshold(pi, store, target, config, false, entries);
    return null;
  });
  if (projectStore) {
    projectStore.setMutationObserver(async (target, entries) => {
      scheduleIfOverThreshold(pi, projectStore!, target, config, true, entries);
      return null;
    });
  }
}

function scheduleIfOverThreshold(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: Target,
  config: MemoryConfig,
  project: boolean,
  entries: string[],
): void {
  const threshold = config.vaultPromoteThreshold ?? DEFAULT_VAULT_PROMOTE_THRESHOLD;
  const total = entries.join(ENTRY_DELIMITER).length;
  if (total < limitFor(target, config, project) * threshold) return;

  const key = `${project ? "project:" : ""}${target}`;
  if (pending.has(key)) return;
  pending.add(key);
  void runVaultPromotion(pi, store, target, config, project).finally(() => pending.delete(key));
}

/**
 * Run one promotion pass: child selects stable entries, parent writes vault
 * files, then removes promoted entries from hot memory.
 */
export async function runVaultPromotion(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: Target,
  config: MemoryConfig,
  project = false,
): Promise<PromotionResult> {
  const vault = config.vaultPath;
  if (!vaultConfigured(vault)) return { promoted: 0, removed: 0, error: "Vault not configured." };

  const ready = await ensureVault(vault);
  if (!ready.success) return { promoted: 0, removed: 0, error: ready.error };

  const entries = entriesFor(store, target);
  if (entries.length === 0) return { promoted: 0, removed: 0 };

  const prompt = [
    PROMOTION_PROMPT,
    "",
    `--- Current ${target} entries (project: ${project}) ---`,
    entries.join(ENTRY_DELIMITER) || "(empty)",
  ].join("\n");

  let result: { code: number; stdout?: string; stderr?: string };
  try {
    result = await execChildPrompt(pi, prompt, {
      llmModelOverride: config.llmModelOverride,
      llmThinkingOverride: config.llmThinkingOverride,
      childExtensionPaths: config.childExtensionPaths,
    }, {
      timeoutMs: config.consolidationTimeoutMs,
      retryWithoutOverrides: true,
    });
  } catch (err) {
    return { promoted: 0, removed: 0, error: `Promotion child failed: ${String(err).slice(0, 200)}` };
  }

  if (result.code !== 0) {
    return {
      promoted: 0,
      removed: 0,
      error: `Promotion exited ${result.code}: ${(result.stderr ?? "").slice(0, 200)}`,
    };
  }

  let plan: { promote?: Array<{ file?: unknown; content?: unknown }>; remove?: unknown[] };
  try {
    plan = JSON.parse(result.stdout ?? "");
  } catch {
    return { promoted: 0, removed: 0, error: "Promotion child output was not valid JSON." };
  }

  const promote = Array.isArray(plan.promote) ? plan.promote : [];
  const remove = Array.isArray(plan.remove) ? plan.remove : [];

  // Phase 1: write vault files (copy). Failures here abort removals below.
  let promotedCount = 0;
  for (const item of promote) {
    if (!item || typeof item.file !== "string" || typeof item.content !== "string" || !item.content.trim()) continue;
    // Path-traversal guard: only vault-relative paths, no .., no absolute.
    if (path.isAbsolute(item.file)) continue;
    const safe = path.normalize(item.file).replace(/^([/\\])+/, "");
    if (!safe || safe.startsWith("..")) continue;
    const abs = path.join(vault, safe);
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const existing = await fs.readFile(abs, "utf-8").catch(() => "");
      await fs.writeFile(abs, existing ? existing.replace(/\s*$/, "\n") + "\n" + item.content : item.content, "utf-8");
      promotedCount++;
    } catch {
      // Skip this file; its entries must NOT be removed below.
    }
  }

  if (promote.length > 0 && promotedCount === 0) {
    return { promoted: 0, removed: 0, error: "Vault writes failed; nothing was removed." };
  }

  // Phase 2: remove promoted entries — only after vault writes succeeded.
  let removedCount = 0;
  for (const text of remove) {
    if (typeof text !== "string" || !text.trim()) continue;
    const r = await store.remove(target, text.trim());
    if (r.success) removedCount++;
  }

  return { promoted: promotedCount, removed: removedCount };
}
