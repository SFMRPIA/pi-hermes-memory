// Manual cleanup apply pipeline (Task 5 of the memory-cleanup plan).
//
// Sequence (brief): begin maintenance → disable the scheduled sync → drain
// background writers → baseline union sync → multi-pass [inventory + plan →
// hash-verified backups (once) → apply per store (owner-authorized exact batch
// under the store's mutation lock)] until a pass plans nothing or maxPasses →
// forced SQLite reconcile → authorized apply sync → authorized verify sync →
// restore scheduler → end maintenance.
//
// Failure routing:
//   - Anything BEFORE the first content mutation aborts cleanly: scheduler
//     restored, maintenance ended (force, so a stuck drain cannot wedge the
//     marker), no recovery flag, stores untouched.
//   - Anything AFTER content mutated (apply / reconcile / apply-sync /
//     verify-sync / restore) flags `recovery-required` and LEAVES maintenance
//     active; the /memory-cleanup recover path (Task 6) inspects the journal
//     and backups. Backups are never applied automatically over newer data.
//
// The maintenance owner token is minted by beginMaintenance and used for
// every owner-authorized step (store writes and the baseline/apply/verify
// sync stages); the sync gate refuses replays and out-of-order stages.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { MemoryStore } from "../store/memory-store.js";
import {
  beginMaintenance,
  endMaintenance,
  flagRecoveryRequired,
  maintenanceStateDir,
  updateMaintenance,
  waitForJobsToDrain,
  type MaintenanceOriginalState,
} from "../store/maintenance-coordinator.js";
import type { MaintenanceSync } from "./maintenance-sync.js";
import {
  DEFAULT_MAX_GROUPS,
  planCleanup,
  type CleanupPlan,
  type GroupAnalyzer,
  type InventoryInput,
} from "./memory-cleanup-plan.js";
import { ENTRY_DELIMITER } from "../constants.js";

export type CleanupStoreLabel = "memory" | "user" | "failure" | "project";

export interface CleanupStoreSpec {
  /** Plan label; groups actions per store instance. */
  label: CleanupStoreLabel;
  store: MemoryStore;
  /** Which markdown target inside the store this spec cleans. */
  target: "memory" | "user" | "failure";
  /** Character cap used only for post-cleanup over-cap reporting. */
  charLimit: number;
}

export interface BackupSource {
  path: string;
  /** File name inside the backup dir. */
  name: string;
}

export interface CleanupRunnerDeps {
  stores: CleanupStoreSpec[];
  sync: MaintenanceSync;
  /** Forced SQLite reconcile; non-empty warnings count as failure. */
  reconcile: () => Promise<{ warnings: string[] }>;
  backupSources: BackupSource[];
  /** Default: the Task 4 planner with no analyzer. */
  planFn?: (inventories: InventoryInput[], opts?: {
    analyze?: GroupAnalyzer | null;
    onProgress?: (completed: number, total: number) => void;
    maxGroups?: number;
  }) => Promise<CleanupPlan>;
  analyze?: GroupAnalyzer | null;
  drainTimeoutMs?: number;
  syncIdleTimeoutMs?: number;
  backupRoot?: string;
}

export interface CleanupRunOptions {
  /** Caller must have confirmed the other machine cannot sync mid-cleanup. */
  confirmSingleMachine: boolean;
  /** Best-effort status text; exceptions never affect cleanup. */
  onProgress?: (message: string) => void;
  /** Upper bound on plan→apply passes (default DEFAULT_MAX_PASSES, min 1). */
  maxPasses?: number;
  /** Maximum fresh semantic analyses across all passes; cache hits do not count. */
  maxGroups?: number;
}

export type CleanupRunResult =
  | {
      ok: true;
      token: string;
      appliedActions: number;
      /** Planning passes executed (applied passes + the final empty one). */
      passes: number;
      needsReview: number;
      overCapStores: string[];
      backupDir: string | null;
      skippedSyncStages: boolean;
    }
  | {
      ok: false;
      stage: string;
      reason: string;
      recoveryRequired: boolean;
      backupDir: string | null;
    };

const DEFAULT_MAX_PASSES = 3;

const defaultPlanFn = (
  inventories: InventoryInput[],
  opts?: { analyze?: GroupAnalyzer | null; onProgress?: (completed: number, total: number) => void; maxGroups?: number },
): Promise<CleanupPlan> => planCleanup(inventories, {
  analyze: opts?.analyze ?? null,
  onProgress: opts?.onProgress,
  maxGroups: opts?.maxGroups,
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export async function runMemoryCleanup(
  deps: CleanupRunnerDeps,
  options: CleanupRunOptions,
): Promise<CleanupRunResult> {
  const fail = (
    stage: string,
    reason: string,
    recoveryRequired: boolean,
    backupDir: string | null,
  ): CleanupRunResult => ({ ok: false, stage, reason, recoveryRequired, backupDir });
  const progress = (message: string) => {
    try {
      options.onProgress?.(message);
    } catch {
      // A UI status failure must never change cleanup or recovery behavior.
    }
  };

  if (!options.confirmSingleMachine) {
    return fail(
      "preflight",
      "Confirm the other machine cannot run a sync during cleanup (single-machine safety) before applying.",
      false,
      null,
    );
  }

  const drainTimeoutMs = deps.drainTimeoutMs ?? 10_000;
  const syncIdleTimeoutMs = deps.syncIdleTimeoutMs ?? 30_000;

  progress("Preparing cleanup");
  const begin = await beginMaintenance({ scopes: deps.stores.map((spec) => spec.label) });
  if (!begin.ok) {
    return fail("begin", begin.detail ?? `cannot begin maintenance (${begin.reason})`, false, null);
  }
  const token = begin.state.owner.token;

  // Clean abort: no content mutated yet — restore what was touched and end.
  const cleanAbort = async (
    originalState: MaintenanceSyncOriginalState | null,
    stage: string,
    reason: string,
  ): Promise<CleanupRunResult> => {
    let finalReason = reason;
    if (originalState) {
      const restored = await deps.sync.restoreSyncTask(originalState);
      if (!restored.ok) finalReason = `${reason}; scheduler restore also failed: ${restored.note ?? "unknown"}`;
    }
    // force: a drain timeout leaves live job records; the registry is
    // bookkeeping only — the write gate reopens once the marker clears.
    await endMaintenance(token, { force: true });
    return fail(stage, finalReason, false, null);
  };

  progress("Disabling scheduled sync");
  const disabled = await deps.sync.disableSyncTask();
  if (!disabled.ok) {
    await endMaintenance(token, { force: true });
    return fail("scheduler", `cannot disable ${"the scheduled sync"}: ${disabled.detail}`, false, null);
  }
  const originalState = disabled.originalState;
  const recordedOriginal: MaintenanceOriginalState = {
    syncTaskEnabled: originalState === "enabled" ? true : originalState === "disabled" ? false : null,
    syncTaskKnown: originalState === "enabled" || originalState === "disabled",
    capturedAt: new Date().toISOString(),
  };
  const recorded = await updateMaintenance(token, { originalState: recordedOriginal });
  if (!recorded.ok) {
    return cleanAbort(originalState, "scheduler", `cannot record the original scheduler state (${recorded.reason})`);
  }

  progress("Waiting for background jobs");
  if (!(await waitForJobsToDrain(drainTimeoutMs))) {
    return cleanAbort(originalState, "drain", `background memory jobs did not settle within ${drainTimeoutMs}ms`);
  }

  progress("Waiting for scheduled sync to finish");
  if (!(await deps.sync.waitForSyncIdle(syncIdleTimeoutMs))) {
    return cleanAbort(originalState, "sync-idle", "a scheduled sync is still running");
  }

  progress("Running baseline sync");
  const baseline = await deps.sync.runAuthorizedSync(token, "baseline");
  if (!baseline.ok) {
    return cleanAbort(originalState, "baseline-sync", `baseline union sync failed (exit ${baseline.exitCode})`);
  }

  const cleaning = await updateMaintenance(token, { phase: "cleaning", progress: { step: "inventory" } });
  if (!cleaning.ok) {
    return cleanAbort(originalState, "inventory", `cannot update maintenance phase (${cleaning.reason})`);
  }

  // Multi-pass: plan → apply repeats from fresh inventory until a pass finds
  // nothing left (or maxPasses). Every applied action strictly shrinks the
  // entry count, so the loop always terminates; maxPasses only bounds the
  // analyzer cost of pathological churn. Backups/journal are created once,
  // before the first mutating apply, and reflect the pre-cleanup state.
  const maxPasses = Math.max(1, Math.floor(options.maxPasses ?? DEFAULT_MAX_PASSES));
  const requestedMaxGroups = options.maxGroups ?? DEFAULT_MAX_GROUPS;
  const maxGroups = Number.isFinite(requestedMaxGroups)
    ? Math.max(0, Math.floor(requestedMaxGroups))
    : DEFAULT_MAX_GROUPS;
  let freshGroupsRemaining = maxGroups;
  let backupDir: string | null = null;
  let firstPlanAt: string | null = null;
  let lastPlan: CleanupPlan | null = null;
  let appliedActionCount = 0;
  const appliedStores: string[] = [];
  const passHistory: Array<{ pass: number; planned: number; applied: number; needsReview: number }> = [];
  const writeJournal = async (status: string, extra: Record<string, unknown> = {}): Promise<void> => {
    fs.writeFileSync(
      path.join(backupDir!, "journal.json"),
      JSON.stringify(
        {
          ownerToken: token,
          startedAt: firstPlanAt,
          status,
          actions: lastPlan?.actions ?? [],
          needsReview: lastPlan?.needsReview ?? [],
          passHistory,
          ...extra,
        },
        null,
        2,
      ),
      "utf-8",
    );
  };

  for (let pass = 1; pass <= maxPasses; pass++) {
    let inventories: InventoryInput[];
    let plan: CleanupPlan;
    try {
      progress(`Pass ${pass} · Planning cleanup`);
      inventories = [];
      for (const [index, spec] of deps.stores.entries()) {
        progress(`Pass ${pass} · Reading store ${index + 1} / ${deps.stores.length} (${spec.label})`);
        const entries = await spec.store.readInventory(spec.target);
        const fingerprint = await spec.store.storeFingerprint(spec.target);
        inventories.push({ store: spec.label, entries, fingerprint });
      }
      plan = await (deps.planFn ?? defaultPlanFn)(inventories, {
        analyze: deps.analyze ?? null,
        onProgress: (completed, total) => progress(`Pass ${pass} · Checking duplicate groups ${completed} / ${total}`),
        maxGroups: freshGroupsRemaining,
      });
      freshGroupsRemaining = Math.max(0, freshGroupsRemaining - plan.stats.freshGroupsAnalyzed);
    } catch (error) {
      if (backupDir) {
        // A previous pass already mutated content — mid-run failure, not a
        // clean abort: keep the marker and point at the backups.
        const reason = `pass ${pass} planning failed: ${errorText(error)}`;
        await flagRecoveryRequired(reason, { ownerToken: token });
        return fail("plan", reason, true, backupDir);
      }
      return cleanAbort(originalState, "inventory", errorText(error));
    }
    if (!firstPlanAt) firstPlanAt = plan.generatedAt;
    lastPlan = plan;

    if (plan.actions.length === 0) {
      passHistory.push({ pass, planned: 0, applied: 0, needsReview: plan.needsReview.length });
      break;
    }

    const fingerprints = new Map(inventories.map((inv) => [inv.store, inv.fingerprint]));

    if (!backupDir) {
      const dir = path.join(deps.backupRoot ?? path.join(maintenanceStateDir(), "cleanup-backups"), token);
      try {
        progress(deps.backupSources.length > 0 ? `Backing up stores 0 / ${deps.backupSources.length}` : "Backing up stores");
        fs.mkdirSync(dir, { recursive: true });
        for (const [index, source] of deps.backupSources.entries()) {
          const dest = path.join(dir, source.name);
          fs.copyFileSync(source.path, dest);
          if (sha256File(source.path) !== sha256File(dest)) {
            throw new Error(`backup hash mismatch for ${source.name}`);
          }
          progress(`Backing up stores ${index + 1} / ${deps.backupSources.length}`);
        }
      } catch (error) {
        return cleanAbort(originalState, "backup", errorText(error));
      }
      backupDir = dir;
    }

    await writeJournal("planned", { pass });

    // Apply per store: each store's batch is atomic (all-or-nothing) inside its
    // own mutation lock; a later store's failure leaves an honest partial state
    // in the journal plus recovery-required — never a backup-overwrite.
    const byStore = new Map<CleanupStoreLabel, CleanupPlan["actions"]>();
    for (const action of plan.actions) {
      const list = byStore.get(action.store) ?? [];
      list.push(action);
      byStore.set(action.store, list);
    }
    let passApplied = 0;
    progress(`Pass ${pass} · Applying actions 0 / ${plan.actions.length}`);
    for (const spec of deps.stores) {
      const actions = byStore.get(spec.label);
      if (!actions || actions.length === 0) continue;
      const expectedFingerprint = fingerprints.get(spec.label);
      if (!expectedFingerprint) {
        await writeJournal("partial", { pass, appliedStores, lastError: `no fingerprint captured for ${spec.label}` });
        return fail("apply", `no fingerprint captured for ${spec.label}`, true, backupDir);
      }
      const result = await spec.store.applyCleanupActions(spec.target, token, expectedFingerprint, actions);
      if (!result.success) {
        await writeJournal("partial", { pass, appliedStores, lastError: result.error ?? "unknown apply error" });
        const reason = `apply failed for ${spec.label}: ${result.error ?? "unknown error"}`;
        await flagRecoveryRequired(reason, { ownerToken: token });
        return fail("apply", reason, true, backupDir);
      }
      if (!appliedStores.includes(spec.label)) appliedStores.push(spec.label);
      passApplied += actions.length;
      appliedActionCount += actions.length;
      progress(`Pass ${pass} · Applying actions ${passApplied} / ${plan.actions.length}`);
    }
    passHistory.push({ pass, planned: plan.actions.length, applied: passApplied, needsReview: plan.needsReview.length });
    await writeJournal("applied", { pass, appliedStores });
    if (plan.needsReview.length > 0) break; // Leave deferred groups for a later run; never retry them in another pass now.
  }

  if (appliedActionCount === 0) {
    // Nothing to change: no backups, journal, or apply/verify stages needed.
    progress("Restoring scheduled sync");
    const restored = await deps.sync.restoreSyncTask(originalState);
    if (!restored.ok) {
      await flagRecoveryRequired(restored.note ?? "scheduler restore failed after no-op cleanup", { ownerToken: token });
      return fail("restore", restored.note ?? "scheduler restore failed", true, null);
    }
    progress("Finishing cleanup");
    const end = await endMaintenance(token);
    if (!end.ok) {
      return fail("end", end.detail ?? `cannot end maintenance (${end.reason})`, true, null);
    }
    return {
      ok: true,
      token,
      appliedActions: 0,
      passes: passHistory.length,
      needsReview: lastPlan?.needsReview.length ?? 0,
      overCapStores: [],
      backupDir: null,
      skippedSyncStages: true,
    };
  }

  const overCapStores: string[] = [];
  for (const spec of deps.stores) {
    const entries = await spec.store.readInventory(spec.target);
    const total = entries.map((entry) => entry.raw).join(ENTRY_DELIMITER).length;
    if (total > spec.charLimit) overCapStores.push(spec.label);
  }

  let warnings: string[];
  try {
    progress("Reconciling SQLite");
    warnings = (await deps.reconcile()).warnings;
  } catch (error) {
    const reason = `SQLite reconciliation failed: ${errorText(error)}`;
    await flagRecoveryRequired(reason, { ownerToken: token });
    return fail("reconcile", reason, true, backupDir);
  }
  if (warnings.length > 0) {
    const reason = `SQLite reconciliation reported warnings: ${warnings.join("; ")}`;
    await flagRecoveryRequired(reason, { ownerToken: token });
    return fail("reconcile", reason, true, backupDir);
  }

  await updateMaintenance(token, { phase: "verifying", progress: { step: "apply-sync" } });
  progress("Applying sync");
  const applySync = await deps.sync.runAuthorizedSync(token, "apply");
  if (!applySync.ok) {
    const reason = `apply sync failed (exit ${applySync.exitCode})`;
    await flagRecoveryRequired(reason, { ownerToken: token });
    return fail("apply-sync", reason, true, backupDir);
  }

  progress("Verifying sync");
  const verifySync = await deps.sync.runAuthorizedSync(token, "verify");
  if (!verifySync.ok) {
    const reason = `verification sync failed (exit ${verifySync.exitCode})`;
    await flagRecoveryRequired(reason, { ownerToken: token });
    return fail("verify-sync", reason, true, backupDir);
  }
  await writeJournal("complete", { pass: passHistory.length, appliedStores, overCapStores });

  progress("Restoring scheduled sync");
  const restored = await deps.sync.restoreSyncTask(originalState);
  if (!restored.ok) {
    const reason = restored.note ?? "scheduler restore failed after a successful cleanup";
    await flagRecoveryRequired(reason, { ownerToken: token });
    return fail("restore", reason, true, backupDir);
  }
  progress("Finishing cleanup");
  const end = await endMaintenance(token);
  if (!end.ok) {
    return fail("end", end.detail ?? `cannot end maintenance (${end.reason})`, true, backupDir);
  }

  return {
    ok: true,
    token,
    appliedActions: appliedActionCount,
    passes: passHistory.length,
    needsReview: lastPlan?.needsReview.length ?? 0,
    overCapStores,
    backupDir,
    skippedSyncStages: false,
  };
}

type MaintenanceSyncOriginalState = import("./maintenance-sync.js").SyncTaskOriginalState;
