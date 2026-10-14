import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  beginMaintenance,
  endMaintenance,
  flagRecoveryRequired,
  isMaintenanceActive,
  isWriteAdmitted,
  maintenanceStatePath,
  readMaintenanceState,
  readMaintenanceStateDetailed,
  registerJob,
  unregisterJob,
  updateMaintenance,
  waitForJobsToDrain,
  pruneDeadJobs,
  type MaintenanceState,
} from "../../src/store/maintenance-coordinator.js";

let stateDir = "";

function handWrittenState(overrides: Partial<MaintenanceState>): unknown {
  return {
    version: 1,
    phase: "cleaning",
    owner: { pid: process.pid, token: "hand-token", startedAt: new Date().toISOString() },
    scopes: ["memory"],
    originalState: null,
    backupDir: null,
    progress: null,
    recoveryReason: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeStateFile(maintenance: unknown, jobs: unknown[] = []): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    maintenanceStatePath(),
    JSON.stringify({ version: 1, maintenance, jobs }),
  );
}

function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 20000 });
  assert.ok(result.pid, "spawnSync returned a pid");
  return result.pid;
}

describe("maintenance coordinator", () => {
  // One temp dir per suite: the gate's SQLite connection stays open in the
  // shared-coordinator cache for the process lifetime, so Windows cannot
  // delete the directory mid-suite. Reset the state JSON between tests and
  // treat directory cleanup at the end as best-effort.
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-coordinator-test-"));
  process.env.PI_HERMES_MAINTENANCE_STATE_DIR = stateDir;

  after(() => {
    delete process.env.PI_HERMES_MAINTENANCE_STATE_DIR;
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // Gate connection still open — leave the temp dir for OS cleanup.
    }
  });

  beforeEach(() => {
    fs.rmSync(maintenanceStatePath(), { force: true });
  });

  afterEach(() => {
    fs.rmSync(maintenanceStatePath(), { force: true });
  });

  it("reports no maintenance when the state file is absent", async () => {
    assert.equal(await readMaintenanceState(), null);
    assert.equal(await isMaintenanceActive(), false);
    assert.deepEqual(await isWriteAdmitted(), { admitted: true });
    assert.deepEqual(await readMaintenanceStateDetailed(), {
      exists: false,
      corrupt: false,
      state: null,
    });
    assert.ok(maintenanceStatePath().startsWith(stateDir));
  });

  it("activates maintenance, blocks non-owner writes, and refuses a second owner", async () => {
    const begin = await beginMaintenance({ scopes: ["memory", "user"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    assert.equal(begin.state.phase, "quiescing");
    assert.deepEqual(begin.state.scopes, ["memory", "user"]);
    assert.ok(begin.state.owner.token);
    assert.equal(begin.state.owner.pid, process.pid);

    assert.deepEqual(await isWriteAdmitted(), {
      admitted: false,
      reason: "maintenance-active",
      phase: "quiescing",
    });
    assert.deepEqual(await isWriteAdmitted(begin.state.owner.token), { admitted: true });
    assert.equal(await isMaintenanceActive(), true);

    const second = await beginMaintenance({ scopes: ["failure"] });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason, "already-active");

    const wrongEnd = await endMaintenance("wrong-token");
    assert.equal(wrongEnd.ok, false);
    if (wrongEnd.ok) return;
    assert.equal(wrongEnd.reason, "not-owner");

    const end = await endMaintenance(begin.state.owner.token);
    assert.equal(end.ok, true);
    if (!end.ok) return;
    assert.deepEqual(end.restored.scopes, ["memory", "user"]);
    assert.equal(await readMaintenanceState(), null);
    assert.deepEqual(await isWriteAdmitted(), { admitted: true });
  });

  it("updates state only for the owner and persists progress, phase, backup, original state", async () => {
    const begin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const token = begin.state.owner.token;

    const wrong = await updateMaintenance("wrong-token", { phase: "cleaning" });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) return;
    assert.equal(wrong.reason, "not-owner");

    const originalState = { syncTaskEnabled: true, syncTaskKnown: true, capturedAt: "2026-10-14T00:00:00Z" };
    const update = await updateMaintenance(token, {
      phase: "cleaning",
      progress: { step: "backing-up" },
      backupDir: path.join(stateDir, "backup"),
      originalState,
    });
    assert.equal(update.ok, true);
    if (!update.ok) return;
    assert.equal(update.state.phase, "cleaning");
    assert.equal(update.state.progress?.step, "backing-up");
    assert.equal(update.state.backupDir, path.join(stateDir, "backup"));
    assert.deepEqual(update.state.originalState, originalState);

    const reread = await readMaintenanceState();
    assert.ok(reread);
    assert.equal(reread.phase, "cleaning");
    assert.equal(reread.owner.token, token);
  });

  it("prunes jobs from dead processes and drains them, keeping live pids", async () => {
    const liveJob = await registerJob("live-thing");
    assert.equal(liveJob.ok, true);
    if (!liveJob.ok) return;

    // Plant TWO orphaned registrations from killed runs (dead pids) by
    // patching the state file directly — those pids are not live here.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const statePath = process.env.PI_HERMES_MAINTENANCE_STATE_DIR + "/maintenance-state.json";
    const doc = JSON.parse(readFileSync(statePath, "utf-8"));
    doc.jobs.push(
      { id: "dead-1", kind: "consolidation", pid: 999999, registeredAt: new Date().toISOString() },
      { id: "dead-2", kind: "memory-review", pid: 999998, registeredAt: new Date().toISOString() },
    );
    writeFileSync(statePath, JSON.stringify(doc, null, 2));

    // Drain prunes the dead-pid jobs inline and keeps ours.
    assert.equal(await waitForJobsToDrain(2000), false);
    const after = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.equal(after.jobs.length, 1);
    assert.equal(after.jobs[0].id, liveJob.id);
    // Explicit prune is idempotent — nothing left to remove.
    assert.equal(await pruneDeadJobs(), 0);

    await unregisterJob(liveJob.id);
    assert.equal(await waitForJobsToDrain(1000), true);
  });

  it("tracks jobs, refuses non-owner registration, and requires drain or force to end", async () => {
    const preMaintenance = await registerJob("review");
    assert.equal(preMaintenance.ok, true);
    assert.equal(await waitForJobsToDrain(150), false);
    if (preMaintenance.ok) await unregisterJob(preMaintenance.id);
    assert.equal(await waitForJobsToDrain(2000), true);

    const begin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const token = begin.state.owner.token;

    const refused = await registerJob("consolidation");
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.reason, "maintenance-active");

    const ownerJob = await registerJob("cleanup-llm", { ownerToken: token });
    assert.equal(ownerJob.ok, true);

    const blockedEnd = await endMaintenance(token);
    assert.equal(blockedEnd.ok, false);
    if (blockedEnd.ok) return;
    assert.equal(blockedEnd.reason, "jobs-outstanding");

    const forcedEnd = await endMaintenance(token, { force: true });
    assert.equal(forcedEnd.ok, true);
  });

  it("moves an owned run to recovery-required and blocks even owner writes there", async () => {
    const begin = await beginMaintenance({ scopes: ["memory", "user"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const token = begin.state.owner.token;

    const flagged = await flagRecoveryRequired("owner crashed mid-apply", { ownerToken: token });
    assert.equal(flagged.ok, true);
    if (!flagged.ok) return;
    assert.equal(flagged.state.phase, "recovery-required");
    assert.equal(flagged.state.recoveryReason, "owner crashed mid-apply");
    assert.deepEqual(flagged.state.scopes, ["memory", "user"]);

    assert.deepEqual(await isWriteAdmitted(token), {
      admitted: false,
      reason: "recovery-required",
      phase: "recovery-required",
    });
    assert.equal(await isMaintenanceActive(), false);

    const rebegin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(rebegin.ok, false);
    if (rebegin.ok) return;
    assert.equal(rebegin.reason, "recovery-required");

    const resolved = await endMaintenance(token);
    assert.equal(resolved.ok, true);
  });

  it("lets a provably dead owner be flagged without its token and refuses a live foreign owner", async () => {
    writeStateFile({
      version: 1,
      phase: "cleaning",
      owner: { pid: deadPid(), token: "dead-owner", startedAt: new Date().toISOString() },
      scopes: ["memory"],
      originalState: null,
      backupDir: null,
      progress: null,
      recoveryReason: null,
      updatedAt: new Date().toISOString(),
    });
    const flagged = await flagRecoveryRequired("owner process is gone");
    assert.equal(flagged.ok, true);
    if (!flagged.ok) return;
    assert.equal(flagged.state.phase, "recovery-required");
    assert.equal(flagged.state.owner.token, "dead-owner");

    writeStateFile(handWrittenState({}));
    const foreign = await flagRecoveryRequired("should not happen");
    assert.equal(foreign.ok, false);
    if (foreign.ok) return;
    assert.equal(foreign.reason, "not-owner");
  });

  it("blocks cleanup on a corrupt state file but keeps ordinary writes admitted", async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(maintenanceStatePath(), "{ this is not json");

    assert.deepEqual(await readMaintenanceStateDetailed(), {
      exists: true,
      corrupt: true,
      state: null,
    });
    assert.equal(await readMaintenanceState(), null);
    assert.deepEqual(await isWriteAdmitted(), { admitted: true });

    const begin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(begin.ok, false);
    if (begin.ok) return;
    assert.equal(begin.reason, "corrupt");

    const flagged = await flagRecoveryRequired("corrupt state");
    assert.equal(flagged.ok, false);
    if (flagged.ok) return;
    assert.equal(flagged.reason, "corrupt");

    const job = await registerJob("review");
    assert.equal(job.ok, true);
  });
});
