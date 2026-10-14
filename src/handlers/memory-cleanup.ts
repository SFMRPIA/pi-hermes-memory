// Manual cleanup apply pipeline (Task 5 of the memory-cleanup plan).
//
// Sequence (brief): begin maintenance → disable the scheduled sync → drain
// background writers → baseline union sync → inventory + plan → hash-verified
// backups + journal → apply per store (owner-authorized exact batch under the
// store's mutation lock) → forced SQLite reconcile → authorized apply sync →
// authorized verify sync → restore scheduler → end maintenance.
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
  planFn?: (inventories: InventoryInput[], opts?: { analyze?: GroupAnalyzer | null }) => Promise<CleanupPlan>;
  analyze?: GroupAnalyzer | null;
  drainTimeoutMs?: number;
  syncIdleTimeoutMs?: number;
  backupRoot?: string;
}

export interface CleanupRunOptions {
  /** Caller must have confirmed the other machine cannot sync mid-cleanup. */
  confirmSingleMachine: boolean;
}

export type CleanupRunResult =
  | {
      ok: true;
      token: string;
      appliedActions: number;
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

const defaultPlanFn = (
  inventories: InventoryInput[],
  opts?: { analyze?: GroupAnalyzer | null },
): Promise<CleanupPlan> => planCleanup(inventories, { analyze: opts?.analyze ?? null });

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

  if (!(await waitForJobsToDrain(drainTimeoutMs))) {
    return cleanAbort(originalState, "drain", `background memory jobs did not settle within ${drainTimeoutMs}ms`);
  }

  if (!(await deps.sync.waitForSyncIdle(syncIdleTimeoutMs))) {
    return cleanAbort(originalState, "sync-idle", "a scheduled sync is still running");
  }

  const baseline = await deps.sync.runAuthorizedSync(token, "baseline");
  if (!baseline.ok) {
    return cleanAbort(originalState, "baseline-sync", `baseline union sync failed (exit ${baseline.exitCode})`);
  }

  const cleaning = await updateMaintenance(token, { phase: "cleaning", progress: { step: "inventory" } });
  if (!cleaning.ok) {
    return cleanAbort(originalState, "inventory", `cannot update maintenance phase (${cleaning.reason})`);
  }

  const fingerprints = new Map<string, string>();
  let plan: CleanupPlan;
  try {
    const inventories: InventoryInput[] = [];
    for (const spec of deps.stores) {
      const entries = await spec.store.readInventory(spec.target);
      const fingerprint = await spec.store.storeFingerprint(spec.target);
      inventories.push({ store: spec.label, entries, fingerprint });
      fingerprints.set(spec.label, fingerprint);
    }
    plan = await (deps.planFn ?? defaultPlanFn)(inventories, { analyze: deps.analyze ?? null });
  } catch (error) {
    return cleanAbort(originalState, "inventory", errorText(error));
  }

  if (plan.actions.length === 0) {
    // Nothing to change: no backups, journal, or apply/verify stages needed.
    const restored = await deps.sync.restoreSyncTask(originalState);
    if (!restored.ok) {
      await flagRecoveryRequired(restored.note ?? "scheduler restore failed after no-op cleanup", { ownerToken: token });
      return fail("restore", restored.note ?? "scheduler restore failed", true, null);
    }
    const end = await endMaintenance(token);
    if (!end.ok) {
      return fail("end", end.detail ?? `cannot end maintenance (${end.reason})`, true, null);
    }
    return {
      ok: true,
      token,
      appliedActions: 0,
      needsReview: plan.needsReview.length,
      overCapStores: [],
      backupDir: null,
      skippedSyncStages: true,
    };
  }

  // Hash-verified backups + journal live under the maintenance state dir so
  // the recover path (Task 6) can find them next to the marker.
  const backupDir = path.join(deps.backupRoot ?? path.join(maintenanceStateDir(), "cleanup-backups"), token);
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const source of deps.backupSources) {
      const dest = path.join(backupDir, source.name);
      fs.copyFileSync(source.path, dest);
      if (sha256File(source.path) !== sha256File(dest)) {
        throw new Error(`backup hash mismatch for ${source.name}`);
      }
    }
  } catch (error) {
    return cleanAbort(originalState, "backup", errorText(error));
  }

  const journalPath = path.join(backupDir, "journal.json");
  const writeJournal = async (status: string, extra: Record<string, unknown> = {}): Promise<void> => {
    fs.writeFileSync(
      journalPath,
      JSON.stringify(
        {
          ownerToken: token,
          startedAt: plan.generatedAt,
          status,
          actions: plan.actions,
          needsReview: plan.needsReview,
          ...extra,
        },
        null,
        2,
      ),
      "utf-8",
    );
  };
  await writeJournal("planned");

  // Apply per store: each store's batch is atomic (all-or-nothing) inside its
  // own mutation lock; a later store's failure leaves an honest partial state
  // in the journal plus recovery-required — never a backup-overwrite.
  const byStore = new Map<CleanupStoreLabel, CleanupPlan["actions"]>();
  for (const action of plan.actions) {
    const list = byStore.get(action.store) ?? [];
    list.push(action);
    byStore.set(action.store, list);
  }
  const appliedStores: string[] = [];
  for (const spec of deps.stores) {
    const actions = byStore.get(spec.label);
    if (!actions || actions.length === 0) continue;
    const expectedFingerprint = fingerprints.get(spec.label);
    if (!expectedFingerprint) {
      await writeJournal("partial", { appliedStores, lastError: `no fingerprint captured for ${spec.label}` });
      return fail("apply", `no fingerprint captured for ${spec.label}`, true, backupDir);
    }
    const result = await spec.store.applyCleanupActions(spec.target, token, expectedFingerprint, actions);
    if (!result.success) {
      await writeJournal("partial", { appliedStores, lastError: result.error ?? "unknown apply error" });
      const reason = `apply failed for ${spec.label}: ${result.error ?? "unknown error"}`;
      await flagRecoveryRequired(reason, { ownerToken: token });
      return fail("apply", reason, true, backupDir);
    }
    appliedStores.push(spec.label);
  }
  await writeJournal("applied", { appliedStores });

  const overCapStores: string[] = [];
  for (const spec of deps.stores) {
    const entries = await spec.store.readInventory(spec.target);
    const total = entries.map((entry) => entry.raw).join(ENTRY_DELIMITER).length;
    if (total > spec.charLimit) overCapStores.push(spec.label);
  }

  let warnings: string[];
  try {
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
  const applySync = await deps.sync.runAuthorizedSync(token, "apply");
  if (!applySync.ok) {
    const reason = `apply sync failed (exit ${applySync.exitCode})`;
    await flagRecoveryRequired(reason, { ownerToken: token });
    return fail("apply-sync", reason, true, backupDir);
  }

  const verifySync = await deps.sync.runAuthorizedSync(token, "verify");
  if (!verifySync.ok) {
    const reason = `verification sync failed (exit ${verifySync.exitCode})`;
    await flagRecoveryRequired(reason, { ownerToken: token });
    return fail("verify-sync", reason, true, backupDir);
  }
  await writeJournal("complete", { appliedStores, overCapStores });

  const restored = await deps.sync.restoreSyncTask(originalState);
  if (!restored.ok) {
    const reason = restored.note ?? "scheduler restore failed after a successful cleanup";
    await flagRecoveryRequired(reason, { ownerToken: token });
    return fail("restore", reason, true, backupDir);
  }
  const end = await endMaintenance(token);
  if (!end.ok) {
    return fail("end", end.detail ?? `cannot end maintenance (${end.reason})`, true, backupDir);
  }

  return {
    ok: true,
    token,
    appliedActions: plan.actions.length,
    needsReview: plan.needsReview.length,
    overCapStores,
    backupDir,
    skippedSyncStages: false,
  };
}

type MaintenanceSyncOriginalState = import("./maintenance-sync.js").SyncTaskOriginalState;
