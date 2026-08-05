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
import { ensureVault, vaultConfigured, todayStr } from "./vault-notes.js";

export interface PromotionResult {
  promoted: number;
  removed: number;
  error?: string;
}

type Target = "memory" | "user" | "failure";

/** Vault files whose existing section titles are shown to the promotion child. */
const VAULT_TITLE_FILES = [
  "System/Assistant/context.md",
  "System/Assistant/preferences.md",
  "System/Assistant/environment.md",
  "System/Assistant/logs/issues-fixes-log.md",
];

/**
 * Merge promoted content into an existing vault file.
 *
 * If the new content starts with a `## Section` header and the file already has
 * a section with the same normalized title, that section is REPLACED (up to the
 * next `## ` header or EOF). Otherwise the content is appended. This prevents
 * duplicate sections when the same topic is promoted again later.
 *
 * When `updated` (YYYY-MM-DD) is given and the content is a `## ` section, the
 * merged section is stamped with `<!-- updated=... -->` so vault aging can
 * prove how fresh a section is. Log-style appends without a section header are
 * never stamped.
 */
export function mergeVaultContent(existing: string, content: string, updated?: string): string {
  const norm = content.trimEnd() + "\n";
  const header = content.match(/^##\s+(.+)$/m);
  const stamp = header && updated ? `<!-- updated=${updated} -->\n` : "";
  if (!header) {
    return existing.trimEnd() ? existing.trimEnd() + "\n\n" + norm : norm;
  }

  const title = header[1].trim().toLowerCase().replace(/\s+/g, " ");
  const lines = existing.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m && m[1].trim().toLowerCase().replace(/\s+/g, " ") === title) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    return existing.trimEnd() ? existing.trimEnd() + "\n\n" + norm + stamp : norm + stamp;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const head = lines.slice(0, start).join("\n").trimEnd();
  const tail = lines.slice(end).join("\n").trimStart();
  return (head ? head + "\n" : "") + norm + stamp + (tail ? tail : "");
}

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

  // Collect existing vault section titles so the child can reuse titles and
  // avoid creating duplicate sections for topics already in the vault.
  const existingTitles: string[] = [];
  for (const rel of VAULT_TITLE_FILES) {
    const abs = path.join(vault, rel);
    const text = await fs.readFile(abs, "utf-8").catch(() => "");
    const titles = text.split("\n").filter((l) => /^##\s+/.test(l)).map((l) => l.trim());
    if (titles.length) {
      existingTitles.push(rel + ":\n" + titles.join("\n"));
    }
  }

  const prompt = [
    PROMOTION_PROMPT,
    "",
    `--- Current ${target} entries (project: ${project}) ---`,
    entries.join(ENTRY_DELIMITER) || "(empty)",
    "",
    "--- Existing vault sections (do NOT create duplicates; reuse exact titles when updating) ---",
    existingTitles.join("\n\n") || "(vault empty)",
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
      await fs.writeFile(
        abs,
        existing ? mergeVaultContent(existing, item.content, todayStr()) : mergeVaultContent("", item.content, todayStr()),
        "utf-8",
      );
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
