/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Default transport: in-process direct completion (same mechanism as
 * background review — see review-memory-ops.ts), used only when a caller
 * supplies model/modelRegistry access (the manual `/memory-consolidate`
 * command has it; the automatic over-capacity consolidator registered on
 * MemoryStore does not, since MemoryStore itself has no extension-runtime
 * access, so that path stays subprocess-only). Falls back to a `pi -p`
 * subprocess when direct mode is unavailable, declines, or fails.
 *
 * The subprocess child process modifies files on disk, so the parent MUST
 * reload from disk after a subprocess-based consolidation completes.
 *
 * IMPORTANT: subprocess children consolidate via the memory tool, which writes
 * Markdown only — the SQLite search mirror (used by memory_search) is never
 * updated by the subprocess. We reconcile it after consolidation completes so
 * memory_search doesn't keep serving stale pre-consolidation rows.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  CONSOLIDATION_PROMPT,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
} from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";
import { AGENT_ROOT } from "../paths.js";
import { appendConsolidationLog } from "./consolidation-log.js";
import { execChildPrompt } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport } from "./review-memory-ops.js";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";
import { syncMarkdownMemoriesToSqlite } from "./sync-markdown-memories.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";
type ConsolidationLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride" | "reviewTransport">;

const CONSOLIDATION_LOCK_STALE_GRACE_MS = 30000;
const CONSOLIDATION_LOCK_ENV = "PI_HERMES_CONSOLIDATION_LOCK_DIR";

interface ConsolidationLock {
  release: () => Promise<void>;
}

function consolidationLockRoot(): string {
  return process.env[CONSOLIDATION_LOCK_ENV]?.trim()
    || path.join(AGENT_ROOT, "pi-hermes-memory", ".consolidation-locks");
}

function sanitizeLockPart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80) || "unknown";
}

function consolidationLockKey(target: MemoryTarget, toolTarget: ToolMemoryTarget, storageIdentity: string): string {
  const storageHash = createHash("sha256").update(storageIdentity).digest("hex");
  return `${sanitizeLockPart(toolTarget)}:${sanitizeLockPart(target)}:${storageHash}`;
}

async function tryAcquireConsolidationLock(
  store: MemoryStore,
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  timeoutMs: number,
): Promise<ConsolidationLock | null> {
  const storageIdentity = await store.getStorageIdentity(target);
  const root = consolidationLockRoot();
  await fs.mkdir(root, { recursive: true });
  const coordinator = AtomicLockCoordinator.shared(path.join(root, "locks.sqlite"));
  const lease = coordinator.tryAcquire(
    consolidationLockKey(target, toolTarget, storageIdentity),
    { staleMs: Math.max(timeoutMs, 0) + CONSOLIDATION_LOCK_STALE_GRACE_MS },
  );
  return lease ? { release: async () => lease.release() } : null;
}

function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  if (target === "user") return store.getUserEntries();
  if (target === "failure") return store.getAllFailureEntries();
  return store.getMemoryEntries();
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === "project") return "Project Memory";
  if (target === "user") return "User Profile";
  if (target === "failure") return "Failure Memory";
  return "Memory";
}

function describeConsolidationFailure(
  result: { code: number; stdout?: string; stderr?: string; killed?: boolean },
  timeoutMs: number,
): string {
  const stderr = result.stderr?.trim();
  const terminated = result.killed || result.code === 124 || result.code === 143;
  const tail = (s: string | undefined): string => s?.trim().slice(-500) ?? "";

  if (terminated) {
    const details = [
      tail(result.stdout) ? `stdout tail: ${tail(result.stdout)}` : "",
      tail(result.stderr) ? `stderr tail: ${tail(result.stderr)}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
    return `Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: ${timeoutMs}ms. Raise consolidationTimeoutMs if consolidation legitimately needs longer.${details ? ` Child output: ${details}` : ""}`;
  }

  return `Consolidation process exited with code ${result.code}: ${stderr?.slice(0, 200) || "unknown error"}`;
}

/**
 * Roll back a failed consolidation: re-add any pre-run entries the child
 * removed before it died/failed, so a killed consolidation never leaves the
 * store half-empty. Idempotent — store.add skips entries that still exist.
 */
async function restorePreRunEntries(
  store: MemoryStore,
  target: MemoryTarget,
  entries: string[],
): Promise<void> {
  for (const entry of entries) {
    if (!entry.trim()) continue;
    try {
      await store.add(target, entry);
    } catch {
      // Best-effort rollback; the recovery snapshots remain the final backstop.
    }
  }
}

/**
 * Run one consolidation pass: child LLM merges entries via the memory tool.
 * On failure (non-zero exit, timeout/kill, or exception) the pre-run entries
 * are restored so a partial run cannot leave the store empty.
 */
export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: ConsolidationLlmConfig = {},
  directCtx: Pick<ExtensionContext, "model" | "modelRegistry"> | null = null,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion } = {},
): Promise<ConsolidationResult> {
  let entries = entriesForTarget(store, target);
  if (store && typeof (store as unknown as { dedupeTarget?: (t: string) => Promise<number> }).dedupeTarget === "function") {
    try {
      const removed = await (store as unknown as { dedupeTarget: (t: string) => Promise<number> }).dedupeTarget(target);
      if (removed > 0) {
        appendConsolidationLog(`[hermes-memory] pre-chunk deterministic dedup removed ${removed} for ${toolTarget}`);
      }
    } catch (dedupErr) {
      appendConsolidationLog(`[hermes-memory] pre-chunk dedup skipped: ${String(dedupErr).slice(0, 200)}`);
    }
  }
  if (store && typeof (store as unknown as { squeezeToCap?: (t: string) => Promise<number> }).squeezeToCap === "function") {
    try {
      const squeezed = await (store as unknown as { squeezeToCap: (t: string) => Promise<number> }).squeezeToCap(target);
      if (squeezed > 0) {
        appendConsolidationLog(`[hermes-memory] cap squeeze archived ${squeezed} for ${toolTarget}`);
      }
    } catch (squeezeErr) {
      appendConsolidationLog(`[hermes-memory] cap squeeze skipped: ${String(squeezeErr).slice(0, 200)}`);
    }
  }
  entries = entriesForTarget(store, target);
  const currentContent = entries.join(ENTRY_DELIMITER);
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;

  appendConsolidationLog(
    `[hermes-memory] consolidate start target=${toolTarget} entries=${entries.length} chars=${currentContent.length} timeout=${timeoutMs} transport=${directCtx && usesDirectTransport(llmConfig) ? "direct" : "subprocess"} model=${llmConfig.llmModelOverride?.trim() || "(default)"} thinking=${llmConfig.llmThinkingOverride ?? "(inherit)"} ts=${new Date().toISOString()}`,
  );

  // ─── Single-flight lock: acquire ONCE up front so BOTH the direct
  // (in-process) transport and the subprocess transport are mutually
  // exclusive per target. Previously the direct transport bypassed this lock
  // entirely, so a direct run could overlap an auto-consolidation subprocess —
  // the storm where two children read+write the same store and merged or
  // duplicated entries.
  // With many concurrent sessions (global memory shared across projects),
  // waiting is more thorough than skipping: the waiter re-checks after the
  // holder finishes and squeezes if still over cap.
  let lock = await tryAcquireConsolidationLock(store, target, toolTarget, timeoutMs);
  if (!lock) {
    const waitStart = Date.now();
    const waitBudgetMs = Math.min(120000, Math.max(10000, Math.floor(timeoutMs / 3)));
    while (!lock && Date.now() - waitStart < waitBudgetMs) {
      await new Promise((r) => setTimeout(r, 500));
      lock = await tryAcquireConsolidationLock(store, target, toolTarget, timeoutMs);
    }
    if (!lock) {
      return {
        consolidated: false,
        error: `Consolidation still in progress for target '${toolTarget}' after wait, skipping.`,
      };
    }
  }
  const runStartedAt = Date.now();

  // Direct transport runs under the same lock; it is only successful if it
  // both runs AND frees space, otherwise we fall through to the subprocess
  // below (still under this lock, so never concurrent with another run).
  const directOk = await (async () => {
    if (!(directCtx && usesDirectTransport(llmConfig))) return false;
    try {
      const directResult = await runDirect(
        directCtx,
        store,
        toolTarget === "project" ? store : null,
        {
          systemPrompt: DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
          userPrompt: [
            `--- Current ${labelForTarget(target, toolTarget)} Entries (target: '${toolTarget}') ---`,
            currentContent || "(empty)",
            "",
            `Only emit operations with "target": "${toolTarget}".`,
          ].join("\n"),
          config: llmConfig,
          timeoutMs,
          signal,
        },
        dbManager,
        projectName,
      );
      return directResult.ok && directResult.appliedCount > 0;
    } catch {
      return false;
    }
  })();
  if (directOk) {
    await resyncSqliteAfterConsolidation(dbManager);
    await lock.release().catch(() => {});
    return { consolidated: true };
  }

  try {

    // Chunked consolidation: one giant prompt over a huge store times out
    // (the LLM cannot summarize 100k+ chars in one pass). Split the entries
    // into small chunks so every child finishes quickly; the children run
    // sequentially under the same lock and each removes only its own slice.
    const CHUNK_CHARS = 8000;
    const chunks: string[][] = [];
    let chunk: string[] = [];
    let chunkChars = 0;
    for (const entry of entries) {
      if (chunk.length > 0 && chunkChars + entry.length > CHUNK_CHARS) {
        chunks.push(chunk);
        chunk = [];
        chunkChars = 0;
      }
      chunk.push(entry);
      chunkChars += entry.length + ENTRY_DELIMITER.length;
    }
    if (chunk.length > 0) chunks.push(chunk);
    // Preserve legacy behavior: even an empty store runs one (no-op) child.
    if (chunks.length === 0) chunks.push([]);

    let ok = false;
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i].join(ENTRY_DELIMITER);
      const chunkPrompt = [
        CONSOLIDATION_PROMPT,
        "",
        `--- Current ${labelForTarget(target, toolTarget)} Entries (chunk ${i + 1}/${chunks.length}) ---`,
        chunkContent || "(empty)",
        "",
        `Use the memory tool to consolidate. Target: '${toolTarget}'`,
      ].join("\n");
      const result = await execChildPrompt(pi, chunkPrompt, llmConfig, {
        signal,
        timeoutMs,
        retryWithoutOverrides: true,
      }) as { code: number; stdout?: string; stderr?: string; killed?: boolean };
      const elapsedMs = Date.now() - runStartedAt;
      appendConsolidationLog(
        `[hermes-memory] consolidate child done target=${toolTarget} chunk=${i + 1}/${chunks.length} code=${result.code} killed=${result.killed ?? false} elapsed=${elapsedMs}ms ts=${new Date().toISOString()}`,
      );
      if (result.code !== 0) {
        await restorePreRunEntries(store, target, entries);
        appendConsolidationLog(`[hermes-memory] consolidate rollback restored ${entries.length} pre-run entries for ${toolTarget}`);
        return {
          consolidated: false,
          error: describeConsolidationFailure(result, timeoutMs),
        };
      }
      ok = true;
    }
    if (ok) {
      await resyncSqliteAfterConsolidation(dbManager);
      return { consolidated: true };
    }
    return { consolidated: false, error: "no chunks to consolidate" };
  } catch (err) {
    await restorePreRunEntries(store, target, entries);
    appendConsolidationLog(`[hermes-memory] consolidate rollback restored ${entries.length} pre-run entries for ${toolTarget} (exception)`);
    return {
      consolidated: false,
      error: `Consolidation failed: ${String(err).slice(0, 200)}`,
    };
  } finally {
    if (lock) {
      try { await lock.release(); } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * Best-effort reconciliation of the SQLite search mirror after consolidation.
 *
 * Consolidation children (subprocess AND direct-transport memory-tool writes)
 * only persist to Markdown; the FTS5 mirror backing memory_search is left stale.
 * This re-syncs it so subsequent searches don't surface pre-consolidation rows.
 * Idempotent — a clean mirror reconciles to import=0/removed=0, so double-sync
 * on the direct path is harmless. Never throws to the consolidation caller.
 */
async function resyncSqliteAfterConsolidation(
  dbManager: DatabaseManager | null,
): Promise<void> {
  if (!dbManager) return;
  try {
    await syncMarkdownMemoriesToSqlite(
      dbManager,
      path.join(AGENT_ROOT, "pi-hermes-memory"),
      "projects-memory",
      AGENT_ROOT,
    );
  } catch (syncErr) {
    appendConsolidationLog(
      `[hermes-memory] post-consolidation sqlite resync skipped: ${String(syncErr).slice(0, 200)}`,
    );
  }
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
  llmConfig: ConsolidationLlmConfig = {},
  dbManager: DatabaseManager | null = null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion } = {},
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const results: string[] = [];
      const targets: Array<{
        label: string;
        store: MemoryStore;
        target: MemoryTarget;
        toolTarget: ToolMemoryTarget;
      }> = [
        { label: "memory", store, target: "memory", toolTarget: "memory" },
        { label: "user", store, target: "user", toolTarget: "user" },
        { label: "failure", store, target: "failure", toolTarget: "failure" },
      ];

      if (projectStore) {
        targets.push({
          label: projectName ? `project:${projectName}` : "project",
          store: projectStore,
          target: "memory",
          toolTarget: "project",
        });
      }

      try {
        ctx.ui.notify(
          `🔄 Starting memory consolidation for ${targets.length} target${targets.length === 1 ? "" : "s"}...`,
          "info",
        );
      } catch {
        // Best-effort only. If the command context is already stale, continue
        // with the consolidation work rather than failing before it starts.
      }

      for (const item of targets) {
        const entries = entriesForTarget(item.store, item.target);

        if (entries.length === 0) {
          results.push(`${item.label}: (empty, nothing to consolidate)`);
          continue;
        }

        try {
          ctx.ui.notify(
            `⏳ Consolidating ${item.label}...`,
            "info",
          );
        } catch {
          // Best-effort progress feedback only.
        }

        const result = await triggerConsolidation(
          pi,
          item.store,
          item.target,
          ctx.signal,
          timeoutMs,
          item.toolTarget,
          llmConfig,
          ctx,
          dbManager,
          projectName,
          deps,
        );

        if (result.consolidated) {
          await item.store.loadFromDisk();
          results.push(`${item.label}: ✅ consolidated`);
        } else {
          results.push(`${item.label}: ❌ ${result.error}`);
        }
      }

      const summary = `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`;

      try {
        ctx.ui.notify(summary, "info");
      } catch {
        // Child consolidation can indirectly trigger a runtime reload/session
        // replacement. If that happens, the original command ctx is stale by
        // the time we reach the final summary, so the command should exit
        // quietly instead of surfacing a stale-ctx error.
      }
    },
  });
}
