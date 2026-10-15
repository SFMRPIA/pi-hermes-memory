/**
 * /memory-cleanup — the user-facing surface over the Task 5 cleanup runner.
 *
 * Modes (single-word, strict):
 *   /memory-cleanup           preview — read-only inventory + plan (default)
 *   /memory-cleanup apply     run the cleanup after an other-machine confirmation
 *   /memory-cleanup status    show the maintenance marker and sync-task state
 *   /memory-cleanup recover   clear a stuck / recovery-required marker, never
 *                             blindly: every mutation is confirmed, and the
 *                             scheduled sync task is only ever re-enabled when
 *                             the marker recorded it as enabled before cleanup.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  runMemoryCleanup,
  type CleanupRunnerDeps,
  type CleanupRunOptions,
  type CleanupRunResult,
  type CleanupStoreSpec,
} from "./memory-cleanup.js";
import { planCleanup, type InventoryInput } from "./memory-cleanup-plan.js";
import {
  createMaintenanceSync,
  type MaintenanceSync,
} from "./maintenance-sync.js";
import {
  endMaintenance,
  maintenanceStatePath,
  pruneDeadJobs,
  readMaintenanceStateDetailed,
  waitForJobsToDrain,
} from "../store/maintenance-coordinator.js";

export type MemoryCleanupMode = "preview" | "apply" | "status" | "recover" | "usage";

const MODES = ["preview", "apply", "status", "recover"] as const;
const CONFIRM_APPLY = "Yes — the other machine is off or paused";
const CONFIRM_RECOVER = "Yes — the owning process is gone";

export function parseCleanupArgs(input: string | undefined): MemoryCleanupMode {
  const trimmed = (input ?? "").trim().toLowerCase();
  if (trimmed === "") return "preview";
  if ((MODES as readonly string[]).includes(trimmed)) {
    return trimmed as (typeof MODES)[number];
  }
  return "usage";
}

export function formatCleanupUsage(): string {
  return [
    "",
    "  🧹 /memory-cleanup — deduplicate stored memory",
    "",
    "    /memory-cleanup           preview what would be cleaned (read-only)",
    "    /memory-cleanup apply     apply the cleanup (asks for other-machine confirmation)",
    "    /memory-cleanup status    show the maintenance marker and sync-task state",
    "    /memory-cleanup recover   recover a stuck or recovery-required cleanup",
    "",
  ].join("\n");
}

export interface MemoryCleanupCommandDeps {
  buildRunnerDeps: () => CleanupRunnerDeps;
  /** Default: the Task 5 runner. */
  runCleanup?: (deps: CleanupRunnerDeps, options: CleanupRunOptions) => Promise<CleanupRunResult>;
  /** Default: the real PowerShell-backed sync inspector/restorer. */
  sync?: Pick<MaintenanceSync, "getSyncTaskState" | "restoreSyncTask">;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatApplyResult(result: CleanupRunResult): string {
  const lines: string[] = [];
  if (result.ok) {
    lines.push("✅ Memory cleanup applied");
    lines.push(`  Actions applied: ${result.appliedActions} · Needs-review (untouched): ${result.needsReview}`);
    if (result.passes > 1) lines.push(`  Passes: ${result.passes}`);
    if (result.backupDir) lines.push(`  Backups: ${result.backupDir}`);
    lines.push(`  Maintenance token: ${result.token}`);
    if (result.skippedSyncStages) lines.push("  No-op run — nothing to clean; sync stages skipped.");
    if (result.overCapStores.length > 0) {
      lines.push(`  ⚠️ Over cap after cleanup: ${result.overCapStores.join(", ")}`);
    }
  } else {
    lines.push(`❌ Cleanup failed at stage: ${result.stage}`);
    lines.push(`  Reason: ${result.reason}`);
    if (result.backupDir) lines.push(`  Backups: ${result.backupDir}`);
    lines.push(
      result.recoveryRequired
        ? "  ⚠️ The marker is in recovery-required — run /memory-cleanup recover"
        : "  The marker was rolled back; no recovery needed.",
    );
  }
  return ["", ...lines, ""].join("\n");
}

async function formatSyncTaskLine(sync: NonNullable<MemoryCleanupCommandDeps["sync"]>): Promise<string> {
  const state = await sync.getSyncTaskState();
  if ("ok" in state) return `  Scheduled sync task: inspect failed — ${state.detail}`;
  if (state.exists === false) return "  Scheduled sync task: not installed";
  return `  Scheduled sync task: ${state.enabled ? "enabled" : "disabled"} (${state.rawState})`;
}

async function runPreview(
  deps: MemoryCleanupCommandDeps,
  ui: { notify: (m: string, s: string) => void; progress: (message?: string) => void },
): Promise<void> {
  const runnerDeps = deps.buildRunnerDeps();
  const failures: string[] = [];
  const inventories: InventoryInput[] = [];
  const fingerprints: string[] = [];

  ui.progress("Reading stores");
  try {
    for (const [index, spec] of (runnerDeps.stores as CleanupStoreSpec[]).entries()) {
      ui.progress(`Reading store ${index + 1} / ${runnerDeps.stores.length} (${spec.label})`);
      try {
        const entries = await spec.store.readInventory(spec.target);
        const fingerprint = await spec.store.storeFingerprint(spec.target);
        inventories.push({ store: spec.label, entries, fingerprint });
        fingerprints.push(`  ${spec.label}: ${fingerprint.slice(0, 12)} (${entries.length} entries)`);
      } catch (error) {
        failures.push(`  ❌ ${spec.label}: ${errorText(error)}`);
      }
    }

    const lines: string[] = ["", "  🧹 Memory cleanup preview (read-only)", ""];
    let plan: Awaited<ReturnType<typeof planCleanup>> | null = null;
    if (inventories.length > 0) {
      try {
        plan = await planCleanup(inventories, {
          analyze: runnerDeps.analyze ?? null,
          onProgress: (completed, total) => ui.progress(`Checking duplicate groups ${completed} / ${total}`),
        });
      } catch (error) {
        failures.push(`  ❌ planner: ${errorText(error)}`);
      }
    }
    if (plan) {
      const redundantEntries = plan.actions.reduce((total, action) => total + action.remove.length, 0);
      lines.push(`  Redundant entries to remove: ${redundantEntries}`);
      lines.push(`  Exact duplicate groups: ${plan.stats.exactDuplicateGroups}`);
      lines.push(`  Candidate groups: ${plan.stats.candidateGroups} (fresh: ${plan.stats.freshGroupsAnalyzed}, cached: ${plan.stats.cachedGroups})`);
      lines.push(`  Candidates left untouched: ${plan.needsReview.length}`);
      lines.push(
        `  Outcomes: keep-both ${plan.stats.keepBothGroups}, safety-rejected ${plan.stats.safetyRejectedGroups}, failed/invalid ${plan.stats.analyzerFailedGroups}, deferred ${plan.stats.deferredGroups}`,
      );
      if (redundantEntries === 0 && plan.needsReview.length === 0) {
        lines.push("  No duplicate facts found in this scan.");
      }
    }
    if (fingerprints.length > 0) lines.push(...fingerprints);
    lines.push(...failures);
    lines.push("  Run /memory-cleanup apply to execute (requires confirmation).", "");
    ui.notify(lines.join("\n"), "info");
  } finally {
    ui.progress();
  }
}

async function runStatus(deps: MemoryCleanupCommandDeps, ui: { notify: (m: string, s: string) => void }): Promise<void> {
  const detailed = await readMaintenanceStateDetailed();
  const syncLine = await formatSyncTaskLine(deps.sync ?? createMaintenanceSync());
  const lines: string[] = ["", "  🧹 /memory-cleanup status", ""];

  // A completed end leaves a tombstone doc (maintenance: null) — that is idle too.
  if (detailed.corrupt) {
    lines.push("  ⚠️ maintenance-state.json is corrupt — fix or delete it manually.");
    lines.push(`  File: ${maintenanceStatePath()}`);
  } else if (!detailed.exists || !detailed.state) {
    lines.push("  No maintenance marker — idle. No cleanup is running.");
  } else {
    const state = detailed.state!;
    lines.push(`  Phase: ${state.phase}${state.recoveryReason ? ` — ${state.recoveryReason}` : ""}`);
    lines.push(`  Owner: pid ${state.owner.pid} (started ${state.owner.startedAt})`);
    lines.push(`  Scopes: ${state.scopes.join(", ") || "(none)"}`);
    if (state.progress) lines.push(`  Progress: ${state.progress.step} (at ${state.progress.updatedAt})`);
    if (state.backupDir) lines.push(`  Backups: ${state.backupDir}`);
    if (state.originalState) {
      lines.push(
        `  Original sync task: ${state.originalState.syncTaskKnown ? (state.originalState.syncTaskEnabled ? "enabled" : "disabled") : "unknown"}`,
      );
    }
    if (state.phase === "recovery-required") {
      lines.push("  → run /memory-cleanup recover");
    }
  }
  lines.push(syncLine, "");
  ui.notify(lines.join("\n"), "info");
}

async function runRecover(deps: MemoryCleanupCommandDeps, ui: { notify: (m: string, s: string) => void }, select: (title: string, items: string[]) => Promise<string | null>): Promise<void> {
  const detailed = await readMaintenanceStateDetailed();
  // Corrupt first — a corrupt read also has no state.
  if (detailed.corrupt) {
    ui.notify(
      [
        "",
        "  ⚠️ maintenance-state.json is corrupt — recovery cannot act on it.",
        `  File: ${maintenanceStatePath()}`,
        "  Fix or delete the file manually, then check /memory-cleanup status.",
        "",
      ].join("\n"),
      "warning",
    );
    return;
  }
  // A completed end leaves a tombstone doc (maintenance: null) — nothing to recover there.
  if (!detailed.exists || !detailed.state) {
    ui.notify("\n  🧹 Nothing to recover — no maintenance marker exists.\n", "info");
    return;
  }

  const state = detailed.state!;
  const answer = await select(
    `Recovery force-clears the maintenance marker (phase: ${state.phase}). Continue only if the owning process is gone.`,
    [CONFIRM_RECOVER, "Cancel"],
  );
  if (answer !== CONFIRM_RECOVER) {
    ui.notify("\n  🧹 Recovery aborted — marker left intact.\n", "info");
    return;
  }

  await pruneDeadJobs();
  if (!(await waitForJobsToDrain(5000))) {
    ui.notify(
      "\n  ⚠️ Background memory jobs are still alive — recovery aborted, marker kept.\n",
      "warning",
    );
    return;
  }

  const end = await endMaintenance(state.owner.token, { force: true });
  if (!end.ok) {
    ui.notify(
      [
        "",
        `  ❌ Recovery failed: cannot end maintenance (${end.reason}).`,
        "  The marker was kept — check /memory-cleanup status.",
        "",
      ].join("\n"),
      "warning",
    );
    return;
  }

  const original = state.originalState;
  let schedulerLine: string;
  if (original?.syncTaskKnown && original.syncTaskEnabled === true) {
    const restored = await (deps.sync ?? createMaintenanceSync()).restoreSyncTask("enabled");
    schedulerLine = restored.ok
      ? "  Scheduled sync task re-enabled."
      : `  ⚠️ Scheduled sync task could NOT be re-enabled: ${restored.note ?? "unknown"}`;
  } else if (original?.syncTaskKnown && original.syncTaskEnabled === false) {
    schedulerLine = "  Scheduled sync task left disabled (as recorded before cleanup).";
  } else {
    schedulerLine = "  ⚠️ Original scheduler state unknown — the sync task was not touched; check it manually.";
  }

  ui.notify(
    ["", "  🧹 Recovery complete — maintenance marker cleared.", schedulerLine, `  Marker reason was: ${state.recoveryReason ?? "n/a"}`, ""].join("\n"),
    "info",
  );
}

export function registerMemoryCleanupCommand(pi: ExtensionAPI, deps: MemoryCleanupCommandDeps): void {
  pi.registerCommand("memory-cleanup", {
    description: "Preview and apply knowledge-preserving memory dedup (maintenance-aware)",

    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart().toLowerCase();
      if (trimmed.includes(" ")) return null;
      return MODES.filter((mode) => mode.startsWith(trimmed)).map((name) => ({ value: name, label: name }));
    },

    handler: async (args, ctx) => {
      const ui = {
        notify: (message: string, severity: string) => ctx.ui.notify(message, severity as "info" | "warning" | "error"),
        progress: (message?: string) => {
          if (!ctx.hasUI) return;
          try {
            ctx.ui.setStatus("memory-cleanup", message ? `🧹 Memory cleanup · ${message}` : undefined);
          } catch {
            // Status is best-effort; UI failures must not affect cleanup.
          }
        },
      };
      const mode = parseCleanupArgs(args);

      if (mode === "usage") {
        ui.notify(formatCleanupUsage(), "info");
        return;
      }
      if (mode === "preview") {
        await runPreview(deps, ui);
        return;
      }
      if (mode === "status") {
        await runStatus(deps, ui);
        return;
      }
      if (mode === "recover") {
        await runRecover(deps, ui, (title, items) => ctx.ui.select(title, items, {}).then((answer) => answer ?? null));
        return;
      }

      // apply — mutation gate: explicit other-machine confirmation first.
      const answer = await ctx.ui.select(
        "Other-machine check: is the other machine off, or its sync paused, for the whole cleanup?",
        [CONFIRM_APPLY, "Cancel"],
        {},
      );
      if (answer !== CONFIRM_APPLY) {
        ui.notify("\n  🧹 Cleanup aborted — nothing was changed.\n", "info");
        return;
      }
      try {
        const result = await (deps.runCleanup ?? runMemoryCleanup)(deps.buildRunnerDeps(), {
          confirmSingleMachine: true,
          onProgress: ui.progress,
        });
        ui.notify(formatApplyResult(result), result.ok ? "info" : "warning");
      } finally {
        ui.progress();
      }
    },
  });
}
