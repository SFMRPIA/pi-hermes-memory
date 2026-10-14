/**
 * /memory-cleanup — command surface over the Task 5 cleanup runner.
 *
 * Covered contract:
 *   - parseCleanupArgs: strict single-word modes; anything unknown ⇒ usage
 *   - preview (default): read-only inventory + plan, no writes, no marker
 *   - apply: other-machine confirmation gate before runCleanup
 *   - status: idle / recovery-required / corrupt marker reporting
 *   - recover: never blindly clears state or enables the sync task
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  beginMaintenance,
  flagRecoveryRequired,
  readMaintenanceStateDetailed,
  updateMaintenance,
  maintenanceStatePath,
} from "../../src/store/maintenance-coordinator.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import {
  registerMemoryCleanupCommand,
  parseCleanupArgs,
} from "../../src/handlers/memory-cleanup-command.js";
import type { CleanupRunnerDeps, CleanupRunResult } from "../../src/handlers/memory-cleanup.js";
import { ENTRY_DELIMITER, DEFAULT_MEMORY_CHAR_LIMIT, MEMORY_FILE } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Harness ───

let root = "";
let globalDir = "";
let memoryPath = "";
let previousMaintenanceDir: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cleanup-cmd-"));
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

const OK_RESULT: CleanupRunResult = {
  ok: true,
  token: "tok-1",
  appliedActions: 2,
  needsReview: 1,
  overCapStores: [],
  backupDir: path.join(root, "backups", "tok-1"),
  skippedSyncStages: false,
};

function makeCfg(): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
  } as MemoryConfig;
}

async function makeStore(): Promise<MemoryStore> {
  const store = new MemoryStore({ ...makeCfg(), memoryDir: globalDir });
  await store.loadFromDisk();
  return store;
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

function makePi() {
  const commands: { name: string; conf: any }[] = [];
  const pi = {
    registerCommand: (name: string, conf: any) => {
      commands.push({ name, conf });
    },
  } as any;
  return { commands, pi };
}

interface UiHandle {
  ctx: { ui: { notify: (message: string, severity: string) => void; select: (title: string, items: string[]) => Promise<string | null> } };
  notifyCalls: { message: string; severity: string }[];
  selectCalls: { title: string; items: string[] }[];
  lastMessage: () => { message: string; severity: string };
}

function makeCtx(selectAnswers: (string | null)[] = []): UiHandle {
  const notifyCalls: { message: string; severity: string }[] = [];
  const selectCalls: { title: string; items: string[] }[] = [];
  const ctx = {
    ui: {
      notify: (message: string, severity: string) => {
        notifyCalls.push({ message, severity });
      },
      select: async (title: string, items: string[]) => {
        selectCalls.push({ title, items });
        return selectAnswers.length > 0 ? (selectAnswers.shift() as string | null) : null;
      },
    },
  };
  return {
    ctx,
    notifyCalls,
    selectCalls,
    lastMessage: () => notifyCalls.at(-1)!,
  };
}

interface SetupOptions {
  runnerResult?: CleanupRunResult;
  selectAnswers?: (string | null)[];
}

async function setup(opts: SetupOptions = {}) {
  const { commands, pi } = makePi();
  const ui = makeCtx(opts.selectAnswers ?? []);
  const store = await makeStore();
  const runnerCalls: { confirmSingleMachine: boolean }[] = [];
  const restoreCalls: string[] = [];
  const syncFake = {
    getSyncTaskState: async () => ({ exists: false, enabled: false, rawState: "Disabled" }),
    restoreSyncTask: async (originalState: string) => {
      restoreCalls.push(originalState);
      return { ok: true, action: originalState === "enabled" ? ("enabled" as const) : ("none" as const) };
    },
  };
  registerMemoryCleanupCommand(pi, {
    buildRunnerDeps: () =>
      ({
        stores: [{ label: "memory", store, target: "memory", charLimit: DEFAULT_MEMORY_CHAR_LIMIT }],
        sync: {} as CleanupRunnerDeps["sync"],
        reconcile: async () => ({ warnings: [] }),
        backupSources: [{ path: memoryPath, name: MEMORY_FILE }],
      }) as CleanupRunnerDeps,
    runCleanup: async (_deps, options) => {
      runnerCalls.push({ confirmSingleMachine: options.confirmSingleMachine });
      return opts.runnerResult ?? OK_RESULT;
    },
    sync: syncFake,
  });
  const command = commands[0]!;
  return { command, store, runnerCalls, restoreCalls, ...ui };
}

async function seedRecoveryMarker(originalState: {
  syncTaskEnabled: boolean | null;
  syncTaskKnown: boolean;
}): Promise<string> {
  const begin = await beginMaintenance({ scopes: ["memory"] });
  assert.ok(begin.ok);
  const token = begin.state.owner.token;
  await updateMaintenance(token, {
    originalState: { ...originalState, capturedAt: new Date().toISOString() },
  });
  await flagRecoveryRequired("apply sync failed (exit 4)", { ownerToken: token });
  return token;
}

// ─── parseCleanupArgs ───

describe("parseCleanupArgs", () => {
  it("defaults empty input to preview", () => {
    assert.equal(parseCleanupArgs(undefined), "preview");
    assert.equal(parseCleanupArgs(""), "preview");
    assert.equal(parseCleanupArgs("   "), "preview");
  });

  it("accepts the four subcommands case-insensitively", () => {
    assert.equal(parseCleanupArgs("preview"), "preview");
    assert.equal(parseCleanupArgs("APPLY"), "apply");
    assert.equal(parseCleanupArgs("Status"), "status");
    assert.equal(parseCleanupArgs("recover"), "recover");
  });

  it("sends unknown or multi-word input to usage", () => {
    assert.equal(parseCleanupArgs("bogus"), "usage");
    assert.equal(parseCleanupArgs("apply now"), "usage");
    assert.equal(parseCleanupArgs("--force"), "usage");
  });
});

// ─── registration ───

describe("registerMemoryCleanupCommand", () => {
  it("registers /memory-cleanup with argument completions", async () => {
    const { command } = await setup();
    assert.equal(command.name, "memory-cleanup");
    assert.match(command.conf.description, /memory/i);
    const completions = command.conf.getArgumentCompletions("a");
    assert.ok(completions.some((c: { value: string }) => c.value === "apply"));
  });
});

// ─── preview ───

describe("preview", () => {
  it("is read-only: reports duplicates without touching stores or the marker", async () => {
    const { command, store, ctx, lastMessage } = await setup();
    await seedRaw(store, ["Dup fact alpha.", "Dup fact alpha.", "Unique beta fact."]);
    const before = await fs.readFile(memoryPath);

    await command.conf.handler(undefined, ctx);

    const after = await fs.readFile(memoryPath);
    assert.ok(before.equals(after), "preview must not rewrite the store file");
    const detailed = await readMaintenanceStateDetailed();
    assert.equal(detailed.exists, false, "preview must not create a maintenance marker");
    assert.match(lastMessage().message, /duplicate/i);
    assert.equal(lastMessage().severity, "info");
  });

  it("reports a store read failure without crashing or writing", async () => {
    const { commands, pi } = makePi();
    const ui = makeCtx();
    const boom = {
      readInventory: async () => {
        throw new Error("disk gone");
      },
    };
    registerMemoryCleanupCommand(pi, {
      buildRunnerDeps: () =>
        ({
          stores: [{ label: "memory", store: boom, target: "memory", charLimit: 100 }],
          sync: {},
          reconcile: async () => ({ warnings: [] }),
          backupSources: [],
        }) as unknown as CleanupRunnerDeps,
      sync: {
        getSyncTaskState: async () => ({ exists: false }),
        restoreSyncTask: async () => ({ ok: true, action: "none" }),
      },
    });
    await commands[0]!.conf.handler("preview", ui.ctx);
    assert.match(ui.lastMessage().message, /disk gone/);
  });
});

// ─── apply ───

describe("apply", () => {
  it("runs the runner only after the other-machine confirmation", async () => {
    const { command, runnerCalls, selectCalls, ctx } = await setup({
      selectAnswers: ["Yes — the other machine is off or paused"],
    });
    await command.conf.handler("apply", ctx);
    assert.deepEqual(runnerCalls, [{ confirmSingleMachine: true }]);
    assert.equal(selectCalls.length, 1);
    assert.match(selectCalls[0]!.title, /other machine/i);
  });

  it("aborts without running the runner when the user cancels", async () => {
    const { command, runnerCalls, lastMessage, ctx } = await setup({ selectAnswers: [null] });
    await command.conf.handler("apply", ctx);
    assert.equal(runnerCalls.length, 0);
    assert.match(lastMessage().message, /abort/i);
    assert.equal(lastMessage().severity, "info");
  });

  it("aborts when the user picks the explicit cancel option", async () => {
    const { command, runnerCalls, selectCalls, ctx } = await setup({ selectAnswers: ["Cancel"] });
    await command.conf.handler("apply", ctx);
    assert.equal(runnerCalls.length, 0);
    assert.ok(selectCalls[0]!.items.length >= 2);
    assert.ok(selectCalls[0]!.items.some((item) => /cancel/i.test(item)));
  });

  it("summarizes a successful run including backup dir and token", async () => {
    const { command, lastMessage, ctx } = await setup({
      selectAnswers: ["Yes — the other machine is off or paused"],
      runnerResult: OK_RESULT,
    });
    await command.conf.handler("apply", ctx);
    assert.equal(lastMessage().severity, "info");
    assert.match(lastMessage().message, /2/);
    assert.match(lastMessage().message, /tok-1/);
    assert.match(lastMessage().message, /backup/i);
  });

  it("notes the no-op short-circuit when sync stages were skipped", async () => {
    const { command, lastMessage, ctx } = await setup({
      selectAnswers: ["Yes — the other machine is off or paused"],
      runnerResult: { ...OK_RESULT, skippedSyncStages: true, appliedActions: 0, backupDir: null },
    });
    await command.conf.handler("apply", ctx);
    assert.match(lastMessage().message, /no-op|nothing to (change|clean)/i);
  });

  it("directs the user to recover when the run flags recovery-required", async () => {
    const { command, lastMessage, ctx } = await setup({
      selectAnswers: ["Yes — the other machine is off or paused"],
      runnerResult: {
        ok: false,
        stage: "apply-store",
        reason: "store changed during cleanup (fingerprint mismatch)",
        recoveryRequired: true,
        backupDir: null,
      },
    });
    await command.conf.handler("apply", ctx);
    assert.equal(lastMessage().severity, "warning");
    assert.match(lastMessage().message, /apply-store/);
    assert.match(lastMessage().message, /fingerprint mismatch/);
    assert.match(lastMessage().message, /memory-cleanup recover/);
  });

  it("reports a plain failure without the recover hint", async () => {
    const { command, lastMessage, ctx } = await setup({
      selectAnswers: ["Yes — the other machine is off or paused"],
      runnerResult: {
        ok: false,
        stage: "preflight",
        reason: "confirmation missing",
        recoveryRequired: false,
        backupDir: null,
      },
    });
    await command.conf.handler("apply", ctx);
    assert.equal(lastMessage().severity, "warning");
    assert.match(lastMessage().message, /preflight/);
    assert.doesNotMatch(lastMessage().message, /memory-cleanup recover/);
  });
});

// ─── status ───

describe("status", () => {
  it("reports idle with the sync task state when no marker exists", async () => {
    const { command, lastMessage, ctx } = await setup();
    await command.conf.handler("status", ctx);
    assert.match(lastMessage().message, /idle|no cleanup/i);
    assert.match(lastMessage().message, /sync task/i);
  });

  it("reports a recovery-required marker with its reason", async () => {
    const { command, lastMessage, ctx } = await setup();
    await seedRecoveryMarker({ syncTaskEnabled: true, syncTaskKnown: true });
    await command.conf.handler("status", ctx);
    assert.match(lastMessage().message, /recovery-required/i);
    assert.match(lastMessage().message, /apply sync failed \(exit 4\)/);
    assert.match(lastMessage().message, /memory-cleanup recover/);
  });

  it("reports a corrupt marker with a manual-fix hint and never deletes it", async () => {
    const { command, lastMessage, ctx } = await setup();
    await fs.mkdir(path.dirname(maintenanceStatePath()), { recursive: true });
    await fs.writeFile(maintenanceStatePath(), "{ definitely not json", "utf-8");
    await command.conf.handler("status", ctx);
    assert.match(lastMessage().message, /corrupt/i);
    assert.match(lastMessage().message, /maintenance-state\.json/);
    // The corrupt marker file must still exist afterwards (status never deletes).
    await fs.access(maintenanceStatePath());
  });
});

// ─── recover ───

describe("recover", () => {
  it("does nothing when no marker exists", async () => {
    const { command, restoreCalls, lastMessage, ctx } = await setup();
    await command.conf.handler("recover", ctx);
    assert.match(lastMessage().message, /nothing to recover/i);
    assert.deepEqual(restoreCalls, []);
  });

  it("force-ends a recovery-required marker after confirmation and restores an enabled task", async () => {
    const { command, restoreCalls, lastMessage, ctx } = await setup({
      selectAnswers: ["Yes — the owning process is gone"],
    });
    await seedRecoveryMarker({ syncTaskEnabled: true, syncTaskKnown: true });
    await command.conf.handler("recover", ctx);
    assert.deepEqual(restoreCalls, ["enabled"]);
    const after = await readMaintenanceStateDetailed();
    assert.equal(after.state, null, "recovery must clear the marker (tombstone)");
    assert.match(lastMessage().message, /recover/i);
    assert.equal(lastMessage().severity, "info");
  });

  it("keeps the marker when the user declines", async () => {
    const { command, restoreCalls, ctx } = await setup({ selectAnswers: [null] });
    await seedRecoveryMarker({ syncTaskEnabled: true, syncTaskKnown: true });
    await command.conf.handler("recover", ctx);
    const after = await readMaintenanceStateDetailed();
    assert.equal(after.exists, true);
    assert.equal(after.state?.phase, "recovery-required");
    assert.deepEqual(restoreCalls, []);
  });

  it("never re-enables the sync task when it was recorded disabled", async () => {
    const { command, restoreCalls, ctx } = await setup({
      selectAnswers: ["Yes — the owning process is gone"],
    });
    await seedRecoveryMarker({ syncTaskEnabled: false, syncTaskKnown: true });
    await command.conf.handler("recover", ctx);
    assert.deepEqual(restoreCalls, [], "a recorded-disabled task must not be enabled");
    const after = await readMaintenanceStateDetailed();
    assert.equal(after.state, null, "a recorded-disabled task must still clear the marker");
  });

  it("leaves the sync task untouched when the original state is unknown", async () => {
    const { command, restoreCalls, lastMessage, ctx } = await setup({
      selectAnswers: ["Yes — the owning process is gone"],
    });
    await seedRecoveryMarker({ syncTaskEnabled: null, syncTaskKnown: false });
    await command.conf.handler("recover", ctx);
    assert.deepEqual(restoreCalls, []);
    const after = await readMaintenanceStateDetailed();
    assert.equal(after.state, null);
    assert.match(lastMessage().message, /unknown|not touched|manual/i);
  });

  it("requires explicit confirmation before recovering an active marker", async () => {
    const { command, selectCalls, ctx } = await setup({
      selectAnswers: ["Yes — the owning process is gone"],
    });
    await beginMaintenance({ scopes: ["memory"] });
    await command.conf.handler("recover", ctx);
    assert.equal(selectCalls.length, 1);
    const after = await readMaintenanceStateDetailed();
    assert.equal(after.state, null, "confirmed dead-owner recovery clears the marker (tombstone)");
  });

  it("aborts active-marker recovery when the user declines", async () => {
    const { command, ctx } = await setup({ selectAnswers: [null] });
    await beginMaintenance({ scopes: ["memory"] });
    await command.conf.handler("recover", ctx);
    const after = await readMaintenanceStateDetailed();
    assert.equal(after.exists, true);
    assert.equal(after.state?.phase, "quiescing");
  });
});

// ─── usage ───

describe("usage", () => {
  it("prints the four forms for unknown arguments without side effects", async () => {
    const { command, runnerCalls, lastMessage, ctx } = await setup();
    await command.conf.handler("bogus", ctx);
    assert.match(lastMessage().message, /\/memory-cleanup apply/);
    assert.match(lastMessage().message, /\/memory-cleanup status/);
    assert.match(lastMessage().message, /\/memory-cleanup recover/);
    assert.equal(runnerCalls.length, 0);
  });
});
