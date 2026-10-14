/**
 * Integration tests: maintenance (cleanup) admission across writers.
 *
 * Covers Task 2 of the manual memory cleanup plan:
 * - runTargetMutation refuses ordinary writes during maintenance (maintenanceDeferred)
 * - registerJob is refused for non-owners during maintenance
 * - waitForJobsToDrain tracks registered jobs
 * - Long-running automatic writers (consolidation, vault promotion, memory
 *   review/flush) are deferred while maintenance is active
 *
 * Isolation: store via memoryDir config; maintenance state via
 * PI_HERMES_MAINTENANCE_STATE_DIR (single suite temp dir — Windows EPERM
 * lesson: don't recreate/remove per-test while gate SQLite handles are open).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import {
  beginMaintenance,
  endMaintenance,
  registerJob,
  unregisterJob,
  waitForJobsToDrain,
  MAINTENANCE_DEFERRED_MESSAGE,
} from "../../src/store/maintenance-coordinator.js";
import { triggerConsolidation } from "../../src/handlers/auto-consolidate.js";
import { runVaultPromotion } from "../../src/handlers/vault-promotion.js";
import { runDirectMemoryCompletion } from "../../src/handlers/review-memory-ops.js";
import { DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Helpers ───

let STATE_DIR = "";
let MEMORY_DIR = "";

function makeConfig(): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
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
    memoryDir: MEMORY_DIR,
  };
}

function makeStore(): MemoryStore {
  return new MemoryStore(makeConfig());
}

// ─── Tests ───

describe("maintenance admission across writers", () => {
  before(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-maint-int-"));
    STATE_DIR = path.join(base, "maintenance");
    MEMORY_DIR = path.join(base, "memory");
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.mkdir(MEMORY_DIR, { recursive: true });
    process.env.PI_HERMES_MAINTENANCE_STATE_DIR = STATE_DIR;
  });

  after(async () => {
    delete process.env.PI_HERMES_MAINTENANCE_STATE_DIR;
    // Best-effort: shared SQLite gate handles may still be open on Windows.
    try {
      await fs.rm(path.dirname(STATE_DIR), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(async () => {
    // Reset maintenance-state.json between tests (not the whole dir — the
    // gate SQLite file must stay stable for the suite).
    await fs.rm(path.join(STATE_DIR, "maintenance-state.json"), { force: true });
  });

  it("store.add is deferred during maintenance and succeeds after end", async () => {
    const store = makeStore();
    const begin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const token = begin.state.owner.token;

    const deferred = await store.add("memory", "[TI] should be deferred");
    assert.equal(deferred.success, false);
    assert.equal(deferred.maintenanceDeferred, true);
    assert.equal(deferred.error, MAINTENANCE_DEFERRED_MESSAGE);

    const end = await endMaintenance(token);
    assert.equal(end.ok, true);

    const after = await store.add("memory", "[TI] admitted after maintenance");
    assert.equal(after.success, true);
  });

  it("store.replace and store.remove are deferred during maintenance", async () => {
    const store = makeStore();
    // Seed one entry while idle.
    const seed = await store.add("user", "[PREF] seed entry for replace test");
    assert.equal(seed.success, true);

    const begin = await beginMaintenance({ scopes: ["user"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;

    const replaced = await store.replace("user", "seed entry for replace test", "[PREF] replaced");
    assert.equal(replaced.success, false);
    assert.equal(replaced.maintenanceDeferred, true);

    const removed = await store.remove("user", "seed entry for replace test");
    assert.equal(removed.success, false);
    assert.equal(removed.maintenanceDeferred, true);

    await endMaintenance(begin.state.owner.token);

    const replacedAfter = await store.replace("user", "seed entry for replace test", "[PREF] replaced");
    assert.equal(replacedAfter.success, true);
  });

  it("registerJob is refused during maintenance; the owner may register", async () => {
    const begin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;
    const token = begin.state.owner.token;

    const blocked = await registerJob("consolidation");
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "maintenance-active");

    const admitted = await registerJob("consolidation", { ownerToken: token });
    assert.equal(admitted.ok, true);
    if (admitted.ok) await unregisterJob(admitted.id);

    await endMaintenance(token);
  });

  it("waitForJobsToDrain reports outstanding jobs and drains after unregister", async () => {
    const job = await registerJob("consolidation");
    assert.equal(job.ok, true);
    if (!job.ok) return;

    assert.equal(await waitForJobsToDrain(50), false);
    await unregisterJob(job.id);
    assert.equal(await waitForJobsToDrain(1000), true);
  });

  it("triggerConsolidation is deferred during maintenance and leaves no job behind", async () => {
    const store = makeStore();
    const begin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;

    const result = await triggerConsolidation(null, store, "memory");
    assert.equal(result.consolidated, false);
    assert.equal(result.maintenanceDeferred, true);
    // The wrapper must unregister in finally even on the skip path.
    assert.equal(await waitForJobsToDrain(50), true);

    await endMaintenance(begin.state.owner.token);
  });

  it("runVaultPromotion is deferred during maintenance and passes through when idle", async () => {
    const store = makeStore();
    const begin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;

    const deferred = await runVaultPromotion(null, store, "memory", makeConfig());
    assert.equal(deferred.maintenanceDeferred, true);
    assert.equal(deferred.promoted, 0);
    assert.equal(deferred.removed, 0);

    await endMaintenance(begin.state.owner.token);

    // Idle: wrapper passes through to the inner run, which reports the
    // unconfigured vault (test config has no vaultPath).
    const idle = await runVaultPromotion(null, store, "memory", makeConfig());
    assert.equal(idle.maintenanceDeferred, undefined);
    assert.equal(idle.promoted, 0);
  });

  it("runDirectMemoryCompletion reports fallbackReason 'maintenance'", async () => {
    const store = makeStore();
    const begin = await beginMaintenance({ scopes: ["memory"] });
    assert.equal(begin.ok, true);
    if (!begin.ok) return;

    const result = await runDirectMemoryCompletion(
      {} as Parameters<typeof runDirectMemoryCompletion>[0],
      store,
      null,
      { systemPrompt: "", userPrompt: "", config: {} as MemoryConfig },
    );
    assert.equal(result.ok, false);
    assert.equal(result.appliedCount, 0);
    assert.equal(result.fallbackReason, "maintenance");
    // Registration released on the skip path.
    assert.equal(await waitForJobsToDrain(50), true);

    await endMaintenance(begin.state.owner.token);
  });
});
