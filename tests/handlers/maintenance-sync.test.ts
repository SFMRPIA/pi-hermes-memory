// Tests for maintenance-sync.ts — scheduler + sync coordination primitives.
// All process execution is injected; the real scheduler and PowerShell are
// never touched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMaintenanceSync, type MaintenanceSyncDeps } from "../../src/handlers/maintenance-sync.js";

interface FakeResponse {
  code: number;
  stdout: string;
  stderr: string;
}

interface FakeHarness extends MaintenanceSyncDeps {
  calls: string[][];
  sleepCalls: number[];
  responder: (args: string[]) => FakeResponse;
}

function makeHarness(responder: (args: string[]) => FakeResponse): FakeHarness {
  const harness: FakeHarness = {
    calls: [],
    sleepCalls: [],
    responder,
    run: async (args: string[]) => {
      harness.calls.push(args);
      const r = responder(args);
      if (r.code !== 0) {
        const err: NodeJS.ErrnoException & { stdout?: string; stderr?: string } = new Error(
          `Command failed with exit ${r.code}: ${r.stderr}`,
        );
        err.code = String(r.code);
        err.stdout = r.stdout;
        err.stderr = r.stderr;
        throw err;
      }
      return { stdout: r.stdout, stderr: r.stderr };
    },
    sleep: async (ms: number) => {
      harness.sleepCalls.push(ms);
    },
    scriptPath: "C:\\fake\\sync-memory.ps1",
  };
  return harness;
}

const isTaskQuery = (args: string[]) => args.some((a) => a.includes("Get-ScheduledTask"));
const isDisable = (args: string[]) => args.some((a) => a.includes("Disable-ScheduledTask"));
const isEnable = (args: string[]) => args.some((a) => a.includes("Enable-ScheduledTask"));
const isProcessQuery = (args: string[]) => args.some((a) => a.includes("Win32_Process"));

describe("maintenance-sync getSyncTaskState", () => {
  it("reports an enabled task for Ready state", async () => {
    const h = makeHarness((args) =>
      isTaskQuery(args) ? { code: 0, stdout: "Ready\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const ms = createMaintenanceSync(h);
    const state = await ms.getSyncTaskState();
    assert.equal(state.exists, true);
    assert.equal(state.enabled, true);
    assert.equal(state.rawState, "Ready");
  });

  it("reports a disabled task for Disabled state", async () => {
    const h = makeHarness((args) =>
      isTaskQuery(args) ? { code: 0, stdout: "Disabled\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const ms = createMaintenanceSync(h);
    const state = await ms.getSyncTaskState();
    assert.equal(state.exists, true);
    assert.equal(state.enabled, false);
  });

  it("reports a missing task when the scheduler cannot find it", async () => {
    const h = makeHarness(() => ({ code: 1, stdout: "", stderr: "No MSFT ScheduledTask objects found." }));
    const ms = createMaintenanceSync(h);
    const state = await ms.getSyncTaskState();
    assert.deepEqual(state, { exists: false });
  });

  it("reports inspect-failed for unexpected scheduler errors", async () => {
    const h = makeHarness(() => ({ code: 1, stdout: "", stderr: "Access is denied." }));
    const ms = createMaintenanceSync(h);
    const state = await ms.getSyncTaskState();
    assert.ok(!state.exists || !("enabled" in state) ? !("exists" in state) || (state as { ok?: boolean }).ok === false : false);
    assert.equal((state as { ok?: boolean }).ok, false);
    if ("reason" in state) assert.equal(state.reason, "inspect-failed");
  });
});

describe("maintenance-sync disableSyncTask", () => {
  it("records enabled as the original state, then disables", async () => {
    const h = makeHarness((args) => {
      if (isTaskQuery(args)) return { code: 0, stdout: "Ready\n", stderr: "" };
      if (isDisable(args)) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const ms = createMaintenanceSync(h);
    const result = await ms.disableSyncTask();
    assert.deepEqual(result, { ok: true, originalState: "enabled" });
    const queryIdx = h.calls.findIndex(isTaskQuery);
    const disableIdx = h.calls.findIndex(isDisable);
    assert.ok(queryIdx >= 0 && disableIdx > queryIdx, "state must be recorded BEFORE disabling");
  });

  it("records disabled as the original state and still issues the disable", async () => {
    const h = makeHarness((args) =>
      isTaskQuery(args) ? { code: 0, stdout: "Disabled\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const ms = createMaintenanceSync(h);
    const result = await ms.disableSyncTask();
    assert.deepEqual(result, { ok: true, originalState: "disabled" });
    assert.ok(h.calls.some(isDisable));
  });

  it("treats a missing task as nothing to disable", async () => {
    const h = makeHarness(() => ({ code: 1, stdout: "", stderr: "No MSFT ScheduledTask objects found." }));
    const ms = createMaintenanceSync(h);
    const result = await ms.disableSyncTask();
    assert.deepEqual(result, { ok: true, originalState: "missing" });
    assert.ok(!h.calls.some(isDisable), "must not disable a nonexistent task");
  });

  it("fails cleanly when the disable command errors", async () => {
    const h = makeHarness((args) => {
      if (isTaskQuery(args)) return { code: 0, stdout: "Ready\n", stderr: "" };
      if (isDisable(args)) return { code: 1, stdout: "", stderr: "Access denied" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const ms = createMaintenanceSync(h);
    const result = await ms.disableSyncTask();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "disable-failed");
  });
});

describe("maintenance-sync restoreSyncTask", () => {
  it("re-enables only when the recorded original state was enabled", async () => {
    const h = makeHarness((args) =>
      isEnable(args) ? { code: 0, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const ms = createMaintenanceSync(h);
    const result = await ms.restoreSyncTask("enabled");
    assert.deepEqual(result, { ok: true, action: "enabled" });
    assert.ok(h.calls.some(isEnable));
  });

  it("leaves the task untouched for any other recorded state", async () => {
    for (const original of ["disabled", "missing", "unknown"] as const) {
      const h = makeHarness(() => ({ code: 0, stdout: "", stderr: "" }));
      const ms = createMaintenanceSync(h);
      const result = await ms.restoreSyncTask(original);
      assert.equal(result.ok, true);
      assert.equal(result.action, "none");
      assert.ok(!h.calls.some(isEnable), `must not touch the task for original state ${original}`);
    }
  });

  it("reports failure so the caller can flag recovery-required", async () => {
    const h = makeHarness((args) =>
      isEnable(args) ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" },
    );
    const ms = createMaintenanceSync(h);
    const result = await ms.restoreSyncTask("enabled");
    assert.equal(result.ok, false);
    assert.match(result.note ?? "", /failed to re-enable/);
  });
});

describe("maintenance-sync isSyncRunning / waitForSyncIdle", () => {
  it("detects a running sync via the self-excluding process pattern", async () => {
    const h = makeHarness((args) =>
      isProcessQuery(args) ? { code: 0, stdout: "1\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const ms = createMaintenanceSync(h);
    assert.equal(await ms.isSyncRunning(), true);
    const script = h.calls[0][h.calls[0].length - 1];
    assert.ok(script.includes("('sync' + '-memory\\.ps1')"), "pattern must be split to avoid self-matching");
  });

  it("waits for the sync to finish within the timeout", async () => {
    let polls = 0;
    const h = makeHarness((args) => {
      if (isProcessQuery(args)) {
        polls++;
        return { code: 0, stdout: polls < 3 ? "2" : "0", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const ms = createMaintenanceSync(h);
    assert.equal(await ms.waitForSyncIdle(10_000, 5), true);
    assert.equal(polls, 3);
    assert.equal(h.sleepCalls.length, 2);
  });

  it("returns false when the sync never goes idle", async () => {
    const h = makeHarness((args) =>
      isProcessQuery(args) ? { code: 0, stdout: "1", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const ms = createMaintenanceSync(h);
    assert.equal(await ms.waitForSyncIdle(50, 10), false);
  });

  it("treats inspection errors as idle (the script gate is the real protection)", async () => {
    const h = makeHarness((args) =>
      isProcessQuery(args) ? { code: 1, stdout: "", stderr: "cim error" } : { code: 0, stdout: "", stderr: "" },
    );
    const ms = createMaintenanceSync(h);
    assert.equal(await ms.isSyncRunning(), false);
  });
});

describe("maintenance-sync runAuthorizedSync", () => {
  it("invokes the script with the owner token", async () => {
    const h = makeHarness(() => ({ code: 0, stdout: "[sync-memory] owner-authorized sync\n", stderr: "" }));
    const ms = createMaintenanceSync(h);
    const result = await ms.runAuthorizedSync("tok-owner-1");
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    const args = h.calls[0];
    assert.ok(args.includes("-File"));
    assert.ok(args.includes("C:\\fake\\sync-memory.ps1"));
    const tokenIdx = args.indexOf("-AuthorizedOwnerToken");
    assert.equal(args[tokenIdx + 1], "tok-owner-1");
  });

  it("surfaces a blocked (exit 4) run without throwing", async () => {
    const h = makeHarness(() => ({
      code: 4,
      stdout: "[sync-memory] memory maintenance in progress - sync skipped\n",
      stderr: "",
    }));
    const ms = createMaintenanceSync(h);
    const result = await ms.runAuthorizedSync("wrong-token");
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 4);
    assert.match(result.stdout, /maintenance in progress/);
  });
});
