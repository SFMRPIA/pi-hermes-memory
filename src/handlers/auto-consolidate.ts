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
  CONSOLIDATION_CHUNK_CHARS_MIN,
  DEFAULT_CONSOLIDATION_CHUNK_CHARS,
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
  MAX_CONSOLIDATION_ROUNDS,
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
type ConsolidationLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride" | "reviewTransport" | "consolidationChunking" | "consolidationChunkChars">;

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

// ─── Auto-run TUI helpers (pure, exported for tests) ───
// The automatic over-capacity path is silent by design (failures go to the
// consolidation log file), so index.ts surfaces it via a footer status line
// and — on real failure — a single warning toast. These helpers keep the
// strings/classification testable without touching triggerConsolidation.

/** Footer status text while a consolidation run is in flight. */
export function consolidationStatusText(
  toolTarget: ToolMemoryTarget,
): string {
  return `🧹 memory consolidating — ${toolTarget}…`;
}

/** True when the run was skipped because another run holds the lock. A skip is
 * benign (the waiter observes it in the log); it must never toast as failure. */
export function isConsolidationSkipError(result: ConsolidationResult): boolean {
  return (result.error ?? "").startsWith("Consolidation still in progress for target");
}

/** Failure reason short enough for one toast line: newlines and whitespace
 * runs collapsed, hard-capped at 120 chars, empty → "no reason reported". */
export function shortConsolidationFailureReason(reason?: string): string {
  const collapsed = String(reason ?? "").replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return collapsed.slice(0, 120) || "no reason reported";
}

/** A round shorter than this cannot plausibly boot a child and merge anything. */
const MIN_ROUND_MS = 10_000;

function buildConsolidationPrompt(
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  entries: string[],
  scoped = false,
): string {
  const lines = [
    CONSOLIDATION_PROMPT,
    "",
    `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
    entries.join(ENTRY_DELIMITER) || "(empty)",
    "",
    `Use the memory tool to consolidate. Target: '${toolTarget}'`,
  ];
  if (scoped) {
    // Chunked rounds present a slice of the store, but the child's memory tools
    // can see everything. Without an explicit scope the model may modify entries
    // it was never shown — observed in real upstream runs (a round wiped 11
    // out-of-scope entries).
    lines.push(
      "This pass covers ONLY the entries listed above — they are one slice of a larger store being consolidated in rounds.",
      "Do NOT add, modify, or remove any entry that is not listed above.",
    );
  }
  return lines.join("\n");
}

function chunkCharsFor(config: ConsolidationLlmConfig): number {
  const value = config.consolidationChunkChars;
  return typeof value === "number" && Number.isFinite(value) && value >= CONSOLIDATION_CHUNK_CHARS_MIN
    ? value
    : DEFAULT_CONSOLIDATION_CHUNK_CHARS;
}

/**
 * Head entries worth up to chunkChars of prompt text. Whole entries only; an
 * entry larger than chunkChars travels alone so the loop always makes progress.
 */
export function takeChunk(entries: string[], chunkChars: number): string[] {
  const batch: string[] = [];
  let length = 0;
  for (const entry of entries) {
    const entryLength = entry.length + ENTRY_DELIMITER.length;
    if (batch.length > 0 && length + entryLength > chunkChars) break;
    batch.push(entry);
    length += entryLength;
  }
  return batch;
}

/**
 * Run one consolidation pass: child LLM merges entries via the memory tool.
 * On failure (non-zero exit, timeout/kill, or exception) there is no rollback:
 * the round keeps its on-disk progress (re-adding removed rows would fight
 * legitimate dedup and ping-pong across triggers) and the store's `.recovery`
 * snapshots are the repair backstop.
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
  let currentContent = entries.join(ENTRY_DELIMITER);
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;

  // ponytail: skip LLM when already well under cap after cheap dedupe+squeeze — keeps IDs verbatim, saves 120s
  const cfg = (store as unknown as { config?: { memoryCharLimit?: number; userCharLimit?: number } }).config;
  const limitForSkip = target === "failure" ? (cfg?.memoryCharLimit ?? 5000) * 2 : target === "user" ? (cfg?.userCharLimit ?? 5000) : (cfg?.memoryCharLimit ?? 5000);
  if (currentContent.length > 0 && currentContent.length < limitForSkip * 0.8) {
    appendConsolidationLog(`[hermes-memory] consolidate skip — under 80% cap (${currentContent.length}/${limitForSkip}) for ${toolTarget}, dedupe+squeeze already tidy`);
    await resyncSqliteAfterConsolidation(dbManager);
    return { consolidated: true, rounds: 0 };
  }

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
  const directAttempt = await (async () => {
    if (!(directCtx && usesDirectTransport(llmConfig))) return null;
    try {
      return await runDirect(
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
    } catch {
      return null;
    }
  })();
  const directOk = directAttempt !== null && directAttempt.ok && directAttempt.appliedCount > 0;
  if (directOk) {
    await resyncSqliteAfterConsolidation(dbManager);
    await lock.release().catch(() => {});
    return { consolidated: true };
  }

  // An empty completion is terminal (#235): the direct model answered with
  // nothing in either channel, so the subprocess child would run the same
  // model against the same server-side thinking default and fail the same
  // way (#197). The success criterion is unchanged — it must actually shrink
  // — but this case reports instead of spawning the child. (Inert in the
  // fork today: directCtx is always null here, so consolidation stays
  // subprocess-only — kept for upstream parity.)
  if (directAttempt?.ok && directAttempt.fallbackReason === "empty_response") {
    const modelRef = directCtx?.model?.provider
      ? `${directCtx.model.provider}/${directCtx.model.id}`
      : "model";
    await lock.release().catch(() => {});
    return {
      consolidated: false,
      error: `${modelRef} returned an empty completion; no consolidation attempted`,
    };
  }
  const chunkChars = chunkCharsFor(llmConfig);
  const chunkingEnabled = llmConfig.consolidationChunking === true;
  const hasUsage = typeof (store as unknown as { capacityUsage?: (t: string) => number }).capacityUsage === "function";
  const usageOf = (list: string[]): number =>
    hasUsage
      ? (store as unknown as { capacityUsage: (t: string) => number }).capacityUsage(target)
      : list.join(ENTRY_DELIMITER).length;
  const goal = typeof (store as unknown as { capacityGoal?: (t: string) => number }).capacityGoal === "function"
    ? (store as unknown as { capacityGoal: (t: string) => number }).capacityGoal(target)
    : chunkChars;

  try {
    if (!chunkingEnabled) {
      // Legacy single-shot path — the flag default. Byte-identical to
      // pre-chunking releases for stores of any size. When an oversized
      // store times out, the error names the remedy keys so the failure
      // teaches the fix.
      const result = await execChildPrompt(pi, buildConsolidationPrompt(target, toolTarget, entries), llmConfig, {
        signal,
        timeoutMs,
        retryWithoutOverrides: true,
      }) as { code: number; stdout?: string; stderr?: string; killed?: boolean };
      const elapsedMs = Date.now() - runStartedAt;
      appendConsolidationLog(
        `[hermes-memory] consolidate child done target=${toolTarget} chunk=1/1 code=${result.code} killed=${result.killed ?? false} elapsed=${elapsedMs}ms ts=${new Date().toISOString()}`,
      );
      if (result.code === 0) {
        await resyncSqliteAfterConsolidation(dbManager);
        return { consolidated: true };
      }
      let error = describeConsolidationFailure(result, timeoutMs);
      const terminated = result.killed || result.code === 124 || result.code === 143;
      if (terminated && entries.join(ENTRY_DELIMITER).length > chunkChars) {
        error += ` This store exceeds consolidationChunkChars (${chunkChars}) — enabling consolidationChunking splits consolidation into bounded rounds.`;
      }
      appendConsolidationLog(`[hermes-memory] consolidate child failed target=${toolTarget} code=${result.code} killed=${result.killed ?? false}`);
      return { consolidated: false, error };
    }

    if (entries.length === 0 || usageOf(entries) <= goal) {
      // Within the target's capacity goal (encoded units, same as the cap):
      // nothing needs to shrink toward the goal — a clean no-op, not a
      // failure. Covers healthy stores of any size, the failure tier, and
      // manual triggers on stores that do not need consolidation.
      await resyncSqliteAfterConsolidation(dbManager);
      return { consolidated: true, rounds: 0 };
    }

    const deadline = Date.now() + timeoutMs;

    // Chunked path — the store exceeds one child run's prompt budget, and a
    // single whole-store LLM merge is what produced the observed "subprocess
    // terminated (likely timeout)" failures at cap scale. Rounds share the
    // overall budget (deadline): each consolidates a slice, then reloads from
    // disk (the child modified files) and re-evaluates. A store that fits one
    // prompt runs a single UNSCOPED decisive round. Resume needs no cursor:
    // partial progress is already on disk.
    // ponytail: topic-sort before chunking — lexicographic sort of normalized entries clusters BiPOS/Session together (80% of lane benefit, 0 storm)
    {
      const normForSort = (s: string) => s.replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      entries.sort((a, b) => normForSort(a).localeCompare(normForSort(b)));
      currentContent = entries.join(ENTRY_DELIMITER);
    }

    let completedRounds = 0;
    let progressRounds = 0;
    const notes: string[] = [];
    let offset = 0;

    while (completedRounds < MAX_CONSOLIDATION_ROUNDS) {
      if (entries.length === 0) break; // everything merged away
      const promptTotal = entries.join(ENTRY_DELIMITER).length;
      if (promptTotal <= chunkChars && usageOf(entries) <= goal) break; // capacity goal met
      if (signal?.aborted) {
        notes.push("aborted between consolidation rounds");
        break;
      }
      const remaining = deadline - Date.now();
      if (remaining < MIN_ROUND_MS) {
        notes.push(`consolidation time budget (${timeoutMs}ms) exhausted; retrigger consolidation to continue from current state`);
        break;
      }

      // Removals in earlier rounds shift indices left; the walk offset may
      // point past the (now shorter) store — wrap it instead of slicing an
      // empty batch.
      if (offset >= entries.length) offset = 0;

      const fitsOneChunk = promptTotal <= chunkChars;
      const usageBefore = usageOf(entries);
      const batch = fitsOneChunk ? entries : takeChunk(entries.slice(offset), chunkChars);
      const batchSet = new Set(batch);
      const beforeRound = entries;
      const result = await execChildPrompt(
        pi,
        buildConsolidationPrompt(target, toolTarget, batch, !fitsOneChunk),
        llmConfig,
        { signal, timeoutMs: Math.min(timeoutMs, remaining), retryWithoutOverrides: true },
      ) as { code: number; stdout?: string; stderr?: string; killed?: boolean };

      // Reload FIRST — even a failed round may have shrunk the store before
      // dying, and the recount below decides how the failure is reported.
      try {
        await store.loadFromDisk();
        entries = entriesForTarget(store, target);
      } catch {
        notes.push("could not reload memory after a consolidation round");
        break;
      }

      const currentRound = completedRounds + 1;
      const elapsedMs = Date.now() - runStartedAt;
      appendConsolidationLog(
        `[hermes-memory] consolidate child done target=${toolTarget} chunk=${currentRound}/${MAX_CONSOLIDATION_ROUNDS} code=${result.code} killed=${result.killed ?? false} elapsed=${elapsedMs}ms ts=${new Date().toISOString()}`,
      );

      // Out-of-scope changes: entries that vanished this round without being
      // part of the presented slice. The child can see the whole store through
      // its tools, and a concurrent session may delete entries in this window
      // too — the parent cannot tell a rogue deletion from a legitimate
      // cross-slice dedup or a concurrent one, so out-of-scope disappearances
      // are REPORTED, never resurrected (resurrection would fight legitimate
      // dedup and ping-pong across triggers; the store's recovery snapshots
      // remain the repair path for real damage). Reported on failed rounds too.
      const outOfScope = beforeRound.filter(
        (entry) => !batchSet.has(entry) && !entries.includes(entry),
      );
      if (outOfScope.length > 0) {
        notes.push(`round ${currentRound} coincided with ${outOfScope.length} out-of-scope entr${outOfScope.length === 1 ? "y" : "ies"} disappearing (by the child or a concurrent writer) — inspect memory if that was not intended`);
      }

      const usageAfter = usageOf(entries);
      const shrank = usageAfter < usageBefore;

      if (result.code !== 0) {
        if (shrank) {
          // The round shrank the store and THEN died (killed mid-merge). The
          // shrink is real and on disk — report it as partial progress instead
          // of a total failure, and let the next trigger resume.
          progressRounds++;
          notes.push(describeConsolidationFailure(result, Math.min(timeoutMs, remaining))
            + ` The failing round still shrank the store by ${usageBefore - usageAfter} chars; retrigger consolidation to continue.`);
        } else {
          notes.push(describeConsolidationFailure(result, Math.min(timeoutMs, remaining))
            + (completedRounds > 0
              ? ` ${completedRounds} earlier round${completedRounds === 1 ? "" : "s"} shrank the store; retrigger consolidation to continue.`
              : ""));
        }
        break;
      }

      completedRounds++;

      if (!shrank) {
        // This round shrank nothing. Walk to the next slice rather than
        // repeating it; when nothing in the walk yields, the round-cap exit
        // below reports the store as still over its goal.
        if (fitsOneChunk) {
          notes.push(`consolidation could not shrink the remaining ${promptTotal} chars (capacity goal ${goal}); entries may be distinct facts worth keeping — consider manual pruning`);
          break;
        }
        offset = (offset + batch.length) % Math.max(entries.length, 1);
        continue;
      }

      progressRounds++;
      // Progress: keep walking forward past the slice this round consumed
      // (removals shift indices left, so this is approximate) — resetting to
      // the top would let a store whose head always yields a little progress
      // starve the tail forever.
      offset = (offset + batch.length) % Math.max(entries.length, 1);
      if (usageAfter <= goal) break; // capacity goal met
      if (fitsOneChunk) break; // decisive round done; the next trigger starts a fresh pass
    }

    if (progressRounds > 0) {
      const roundNotes = [...notes];
      const usageEnd = usageOf(entries);
      if (usageEnd > goal) {
        roundNotes.push(`store still ${usageEnd - goal} chars over its ${goal}-char capacity goal; entries may be distinct facts worth keeping — consider manual pruning or raising the limit`);
      }
      appendConsolidationLog(`[hermes-memory] consolidate partial target=${toolTarget} rounds=${completedRounds}${roundNotes.length ? ` notes=${roundNotes.join(" | ").slice(0, 400)}` : ""}`);
      await resyncSqliteAfterConsolidation(dbManager);
      return {
        consolidated: true,
        partial: roundNotes.length > 0,
        rounds: completedRounds,
        ...(roundNotes.length ? { error: roundNotes.join("; ") } : {}),
      };
    }
    notes.push(`consolidation could not shrink the store toward its ${goal}-char capacity goal (${usageOf(entries)} chars); entries may be distinct facts worth keeping — consider manual pruning or raising the limit`);
    return {
      consolidated: false,
      error: notes.join("; "),
    };
  } catch (err) {
    // No rollback: a failed/exception round keeps its on-disk progress
    // (upstream #236 — re-adds fight legitimate dedup and ping-pong across
    // triggers); the store's .recovery snapshots are the repair backstop.
    const message = String(err);
    if (message.includes("extension ctx is stale")) {
      appendConsolidationLog(`[hermes-memory] consolidate deferred (stale ctx) target=${toolTarget}`);
      return {
        consolidated: false,
        deferred: true,
        error: "session replaced or reloaded during consolidation — will consolidate on next write",
      };
    }
    return {
      consolidated: false,
      error: `Consolidation failed: ${message.slice(0, 200)}`,
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
    const syncResult = await syncMarkdownMemoriesToSqlite(
      dbManager,
      path.join(AGENT_ROOT, "pi-hermes-memory"),
      "projects-memory",
      AGENT_ROOT,
    );
    appendConsolidationLog(
      `[hermes-memory] sqlite mirror synced imported=${syncResult.imported} removed=${syncResult.removed} skipped=${syncResult.skipped} warnings=${syncResult.warnings.length}`,
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
          const roundsNote = typeof result.rounds === "number" && result.rounds > 0 ? ` (${result.rounds} round${result.rounds === 1 ? "" : "s"})` : "";
          const partialNote = result.partial ? ` ⚠️ partial: ${result.error ?? "incomplete"}` : "";
          results.push(`${item.label}: ✅ consolidated${roundsNote}${partialNote}`);
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
