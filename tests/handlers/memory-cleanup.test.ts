// Tests for memory-cleanup.ts — Task 5 apply pipeline orchestration.
// Real MemoryStore instances on temp dirs (real planning, real backups, real
// maintenance state under an isolated PI_HERMES_MAINTENANCE_STATE_DIR); the
// sync script, scheduler, and SQLite reconcile are injected fakes.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import {
  maintenanceStatePath,
  readMaintenanceStateDetailed,
  registerJob,
  unregisterJob,
} from "../../src/store/maintenance-coordinator.js";
import { runMemoryCleanup, type CleanupRunnerDeps } from "../../src/handlers/memory-cleanup.js";
import { createMaintenanceSync } from "../../src/handlers/maintenance-sync.js";
import type { GroupAnalyzer, InventoryInput, CleanupPlan } from "../../src/handlers/memory-cleanup-plan.js";
import { ENTRY_DELIMITER, DEFAULT_MEMORY_CHAR_LIMIT, MEMORY_FILE } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ─── Harness ───

let root = "";
let globalDir = "";
let memoryPath = "";
let previousMaintenanceDir: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cleanup-run-"));
  globalDir = path.join(root, "global");
  await fs.mkdir(globalDir, { recursive: true });
  memoryPath = path.join(globalDir, MEMORY_FILE);
  previousMaintenanceDir = process.env.PI_HERMES_MAINTENANCE_STATE_DIR;
  process.env.PI_HERMES_MAINTENANCE_STATE_DIR = path.join(root, "maintenance");
});

afterEach(async () => {
  if (previousMaintenanceDir === undefined) delete process.env.PI_HERMES_MAINTENANCE_STATE_DIR;
  else process.env.PI_HERMES_MAINTENANCE_STATE_DIR = previousMaintenanceDir;
  // Best-effort: the maintenance gate sqlite may keep handles open on Windows.
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function makeCfg(charLimit?: number): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: charLimit ?? DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: globalDir,
  };
}

interface FakeResponse {
  code: number;
  stdout: string;
  stderr: string;
}

function makeSync(responder: (args: string[]) => FakeResponse) {
  const calls: string[][] = [];
  const sync = createMaintenanceSync({
    run: async (args: string[]) => {
      calls.push(args);
      const r = responder(args);
      if (r.code !== 0) {
        const err: NodeJS.ErrnoException & { stdout?: string; stderr?: string } = new Error(
          `Command failed with exit ${r.code}`,
        );
        err.code = String(r.code);
        err.stdout = r.stdout;
        err.stderr = r.stderr;
        throw err;
      }
      return { stdout: r.stdout, stderr: r.stderr };
    },
    sleep: async () => {},
    scriptPath: "C:\\fake\\sync-memory.ps1",
  });
  return { sync, calls };
}

const isTaskQuery = (args: string[]) => args.some((a) => a.includes("Get-ScheduledTask"));
const isEnable = (args: string[]) => args.some((a) => a.includes("Enable-ScheduledTask"));
const isProcessQuery = (args: string[]) => args.some((a) => a.includes("Win32_Process"));
const authorizedStages = (calls: string[][]): string[] =>
  calls
    .filter((args) => args.includes("-AuthorizedSyncStage"))
    .map((args) => args[args.indexOf("-AuthorizedSyncStage") + 1]);
const allAuthorizedCallsUseToken = (calls: string[][], token: string): boolean =>
  calls
    .filter((args) => args.includes("-AuthorizedSyncStage"))
    .every((args) => args[args.indexOf("-AuthorizedOwnerToken") + 1] === token);

function happyResponder(args: string[]): FakeResponse {
  if (isTaskQuery(args)) return { code: 0, stdout: "Ready\n", stderr: "" };
  if (isProcessQuery(args)) return { code: 0, stdout: "0\n", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
}

async function setup(
  overrides: Partial<CleanupRunnerDeps> = {},
  opts: { charLimit?: number } = {},
) {
  const store = new MemoryStore(makeCfg(opts.charLimit));
  await store.loadFromDisk();
  const { sync, calls } = makeSync(happyResponder);
  const deps: CleanupRunnerDeps = {
    stores: [{ label: "memory", store, target: "memory", charLimit: opts.charLimit ?? DEFAULT_MEMORY_CHAR_LIMIT }],
    sync,
    reconcile: async () => ({ warnings: [] }),
    backupSources: [{ path: memoryPath, name: MEMORY_FILE }],
    drainTimeoutMs: 2000,
    syncIdleTimeoutMs: 2000,
    ...overrides,
  };
  return { store, deps, calls };
}

function emptyPlan(
  actions: CleanupPlan["actions"] = [],
  needsReview: CleanupPlan["needsReview"] = [],
): CleanupPlan {
  return {
    generatedAt: "2026-10-14T00:00:00.000Z",
    fingerprints: {},
    actions,
    needsReview,
    stats: {
      entriesScanned: 0,
      exactDuplicateGroups: 0,
      candidateGroups: 0,
      analyzedGroups: 0,
      actionsValidated: 0,
      rejectedToReview: 0,
    },
  };
}

async function readMarkerPhase(): Promise<string | null> {
  const detail = await readMaintenanceStateDetailed();
  return detail.state?.phase ?? null;
}

async function assertStoreTexts(store: MemoryStore, expected: string[]): Promise<void> {
  const inventory = await store.readInventory("memory");
  assert.deepEqual(inventory.map((entry) => entry.text), expected);
}

/** Seed entries bypassing add()'s duplicate/near-duplicate refusal. */
async function seedRaw(store: MemoryStore, texts: string[]): Promise<void> {
  const base = new Date();
  const content = texts
    .map((t, i) => {
      // Vary `last` per copy: loadFromDisk() Set-dedupes byte-identical raw
      // entries, while real-world exact duplicates differ only in metadata.
      const lastDate = new Date(base);
      lastDate.setDate(lastDate.getDate() - i);
      return `${t} <!-- created=${base.toISOString().split("T")[0]}, last=${lastDate.toISOString().split("T")[0]} -->`;
    })
    .join(ENTRY_DELIMITER) + "\n";
  await fs.writeFile(memoryPath, content, "utf-8");
  await store.loadFromDisk();
}

// ─── Tests ───

describe("runMemoryCleanup", () => {
  it("refuses to start without single-machine confirmation and touches nothing", async () => {
    const { deps, calls } = await setup();
    const result = await runMemoryCleanup(deps, { confirmSingleMachine: false });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "preflight");
      assert.equal(result.recoveryRequired, false);
      assert.equal(result.backupDir, null);
    }
    assert.equal(await readMarkerPhase(), null);
    assert.equal(calls.length, 0, "no scheduler or sync process may be launched");
  });

  it("performs a no-op run: baseline only, scheduler restored, maintenance ended", async () => {
    const { store, deps, calls } = await setup();
    await store.add("memory", "First distinct fact.");
    await store.add("memory", "Second distinct fact.");

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.equal(result.appliedActions, 0);
      assert.equal(result.skippedSyncStages, true);
      assert.deepEqual(result.overCapStores, []);
    }
    assert.deepEqual(authorizedStages(calls), ["baseline"]);
    assert.ok(calls.some(isEnable), "original enabled task must be restored");
    assert.equal(await readMarkerPhase(), null);
    await assertStoreTexts(store, ["First distinct fact.", "Second distinct fact."]);
  });

  it("merges an exact duplicate end-to-end with backups, journal, reconcile, and staged syncs", async () => {
    const { store, deps, calls } = await setup();
    await seedRaw(store, ["Shared duplicate fact.", "Shared duplicate fact."]);
    const diskBefore = await fs.readFile(memoryPath, "utf-8");
    let reconcileCalls = 0;
    deps.reconcile = async () => {
      reconcileCalls++;
      return { warnings: [] };
    };

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (!result.ok) return;
    assert.equal(result.appliedActions, 1);
    assert.equal(result.needsReview, 0);
    assert.equal(result.skippedSyncStages, false);
    assert.deepEqual(result.overCapStores, []);

    // Backups: hash-verified copy of the pre-apply markdown + a complete journal.
    assert.ok(result.backupDir);
    const backupFile = path.join(result.backupDir!, MEMORY_FILE);
    assert.equal(sha256(await fs.readFile(backupFile, "utf-8")), sha256(diskBefore));
    const journal = JSON.parse(await fs.readFile(path.join(result.backupDir!, "journal.json"), "utf-8")) as {
      status: string;
    };
    assert.equal(journal.status, "complete");

    // Staged syncs: baseline -> apply -> verify, all with the maintenance owner token.
    assert.deepEqual(authorizedStages(calls), ["baseline", "apply", "verify"]);
    assert.ok(result.ok && allAuthorizedCallsUseToken(calls, result.token));
    assert.equal(reconcileCalls, 1);

    // Scheduler restored only after the verification sync.
    const enableIdx = calls.findIndex(isEnable);
    const verifyIdx = calls.findIndex((args) => args.includes("verify"));
    assert.ok(enableIdx > verifyIdx, "task must be re-enabled only after the verify sync");

    assert.equal(await readMarkerPhase(), null);
    await assertStoreTexts(store, ["Shared duplicate fact."]);
  });

  it("reports an over-cap store after cleanup without failing the run", async () => {
    const { store, deps } = await setup({}, { charLimit: 60 });
    await seedRaw(store, ["Shared duplicate fact.", "Shared duplicate fact."]);

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assert.equal(result.appliedActions, 1);
      assert.deepEqual(result.overCapStores, ["memory"]);
    }
  });

  it("flags recovery-required when an action is stale, keeping maintenance and the disabled task", async () => {
    const { store, deps, calls } = await setup({
      planFn: async () =>
        emptyPlan([
          {
            id: "stale",
            type: "merge",
            store: "memory",
            keep: { index: 0, hash: "0".repeat(64) },
            remove: [{ index: 1, hash: "0".repeat(64) }],
            replacement: "Merged.",
            rationale: "test fixture",
          },
        ]),
    });
    await store.add("memory", "First distinct fact.");
    await store.add("memory", "Second distinct fact.");

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "apply");
      assert.equal(result.recoveryRequired, true);
    }
    assert.equal(await readMarkerPhase(), "recovery-required");
    assert.deepEqual(authorizedStages(calls), ["baseline"], "apply/verify syncs must not run after an apply failure");
    assert.ok(!calls.some(isEnable), "task must stay disabled while recovery is pending");
    await assertStoreTexts(store, ["First distinct fact.", "Second distinct fact."]);
  });

  it("aborts cleanly when the baseline sync fails", async () => {
    const { store, deps, calls } = await setup();
    await store.add("memory", "First distinct fact.");
    await store.add("memory", "Second distinct fact.");
    const baselineFailSync = makeSync((args) => {
      if (args.includes("-AuthorizedSyncStage") && args[args.indexOf("-AuthorizedSyncStage") + 1] === "baseline") {
        return { code: 4, stdout: "", stderr: "blocked" };
      }
      return happyResponder(args);
    });
    deps.sync = baselineFailSync.sync;

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "baseline-sync");
      assert.equal(result.recoveryRequired, false);
    }
    assert.equal(await readMarkerPhase(), null, "pre-mutation aborts must end maintenance");
    assert.ok(baselineFailSync.calls.some(isEnable), "scheduler must be restored on a clean abort");
    await assertStoreTexts(store, ["First distinct fact.", "Second distinct fact."]);
  });

  it("aborts cleanly when a backup source cannot be copied", async () => {
    const { store, deps, calls } = await setup({
      backupSources: [{ path: path.join(globalDir, "missing.md"), name: "missing.md" }],
    });
    // Seed a plan-producing pair so the run reaches the backup stage.
    await seedRaw(store, ["Shared duplicate fact.", "Shared duplicate fact."]);

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "backup");
      assert.equal(result.recoveryRequired, false);
    }
    assert.equal(await readMarkerPhase(), null);
    assert.ok(calls.some(isEnable));
    // Abort happens before apply: both seeded duplicates must remain.
    await assertStoreTexts(store, ["Shared duplicate fact.", "Shared duplicate fact."]);
  });

  it("aborts when background jobs fail to drain, keeping the live job registered", async () => {
    const { deps, calls } = await setup({ drainTimeoutMs: 150 });
    const job = await registerJob("review");
    assert.ok(job.ok);

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });
    await unregisterJob((job as { id: string }).id);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "drain");
      assert.equal(result.recoveryRequired, false);
    }
    assert.equal(await readMarkerPhase(), null, "drain abort must end maintenance so writers resume");
    assert.ok(calls.some(isEnable));
  });

  it("flags recovery-required when the scheduler cannot be re-enabled after success", async () => {
    const { store, deps, calls } = await setup();
    await seedRaw(store, ["Shared duplicate fact.", "Shared duplicate fact."]);
    const enableFailSync = makeSync((args) => {
      if (isEnable(args)) return { code: 1, stdout: "", stderr: "access denied" };
      return happyResponder(args);
    });
    deps.sync = enableFailSync.sync;

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "restore");
      assert.equal(result.recoveryRequired, true);
    }
    assert.equal(await readMarkerPhase(), "recovery-required");
    assert.deepEqual(authorizedStages(enableFailSync.calls), ["baseline", "apply", "verify"], "content work completed");
  });

  it("flags recovery-required when SQLite reconciliation reports warnings", async () => {
    const { store, deps, calls } = await setup({
      reconcile: async () => ({ warnings: ["global/memory: boom"] }),
    });
    await seedRaw(store, ["Shared duplicate fact.", "Shared duplicate fact."]);

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "reconcile");
      assert.equal(result.recoveryRequired, true);
    }
    assert.deepEqual(authorizedStages(calls), ["baseline"], "no apply sync after a failed reconcile");
    assert.ok(!calls.some(isEnable));
    assert.equal(await readMarkerPhase(), "recovery-required");
  });

  it("flags recovery-required when the apply sync fails", async () => {
    const { store, deps, calls } = await setup();
    await seedRaw(store, ["Shared duplicate fact.", "Shared duplicate fact."]);
    const applyFailSync = makeSync((args) => {
      if (args.includes("-AuthorizedSyncStage") && args[args.indexOf("-AuthorizedSyncStage") + 1] === "apply") {
        return { code: 4, stdout: "", stderr: "blocked" };
      }
      return happyResponder(args);
    });
    deps.sync = applyFailSync.sync;

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "apply-sync");
      assert.equal(result.recoveryRequired, true);
    }
    assert.deepEqual(authorizedStages(applyFailSync.calls), ["baseline", "apply"]);
    assert.equal(await readMarkerPhase(), "recovery-required");
  });

  it("flags recovery-required when the verification sync fails", async () => {
    const { store, deps, calls } = await setup();
    await seedRaw(store, ["Shared duplicate fact.", "Shared duplicate fact."]);
    const verifyFailSync = makeSync((args) => {
      if (args.includes("-AuthorizedSyncStage") && args[args.indexOf("-AuthorizedSyncStage") + 1] === "verify") {
        return { code: 4, stdout: "", stderr: "blocked" };
      }
      return happyResponder(args);
    });
    deps.sync = verifyFailSync.sync;

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "verify-sync");
      assert.equal(result.recoveryRequired, true);
    }
    assert.deepEqual(authorizedStages(verifyFailSync.calls), ["baseline", "apply", "verify"]);
    assert.equal(await readMarkerPhase(), "recovery-required");
  });

  it("passes a custom analyzer through to the default planner", async () => {
    const { store, deps } = await setup();
    const similarA = "The runner uses pnpm version 9 for builds";
    const similarB = "The runner uses pnpm version 9 for all builds";
    await seedRaw(store, [similarA, similarB]);
    const analyze: GroupAnalyzer = async () => ({
      action: "merge",
      replacement: "The runner uses pnpm version 9 for builds and all builds",
      rationale: "fixture merge",
    });
    deps.analyze = analyze;

    const result = await runMemoryCleanup(deps, { confirmSingleMachine: true });

    assert.ok(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    if (result.ok) assert.equal(result.appliedActions, 1);
    await assertStoreTexts(store, ["The runner uses pnpm version 9 for builds and all builds"]);
  });
});
