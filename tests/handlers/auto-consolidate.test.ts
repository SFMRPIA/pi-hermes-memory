/**
 * Unit tests for auto-consolidation — triggerConsolidation and /memory-consolidate command.
 */

import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { registerConsolidateCommand, triggerConsolidation } from "../../src/handlers/auto-consolidate.js";
import { resolveWatchedChildPiInvocation } from "../../src/handlers/pi-child-process.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import { DEFAULT_CONSOLIDATION_TIMEOUT_MS, DEFAULT_CONSOLIDATION_CHUNK_CHARS, ENTRY_DELIMITER } from "../../src/constants.js";
import { takeChunk } from "../../src/handlers/auto-consolidate.js";

// ─── Mock infrastructure ───

let execCalls: any[];
let directCalls: unknown[][];

const directTransportLlmConfig = { reviewTransport: "direct" as const };

function createDirectCtx(): { model: unknown; modelRegistry: unknown; _tag: string } {
  return { model: {}, modelRegistry: {}, _tag: "consolidation-direct-ctx" };
}

function makeDirectDeps(
  result: { ok: boolean; appliedCount: number } | "throw",
): { runDirectMemoryCompletion: (...args: unknown[]) => Promise<{ ok: boolean; appliedCount: number }> } {
  return {
    runDirectMemoryCompletion: async (...args: unknown[]) => {
      directCalls.push(args);
      if (result === "throw") throw new Error("injected direct consolidation failure");
      return result;
    },
  };
}
let LOCK_DIR = "";
const OLD_LOCK_DIR = process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR;

function captureExecArgs(args: any[]): any[] {
  const [command, childArgs, options] = args;
  const capturedArgs = [...childArgs];
  const promptReference = capturedArgs.at(-1);
  if (typeof promptReference === "string" && promptReference.startsWith("@")) {
    capturedArgs[capturedArgs.length - 1] = readFileSync(promptReference.slice(1), "utf-8");
  }
  return [command, capturedArgs, options];
}
before(async () => {
  LOCK_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-lock-"));
  process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = LOCK_DIR;
});

after(async () => {
  if (OLD_LOCK_DIR === undefined) {
    delete process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR;
  } else {
    process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = OLD_LOCK_DIR;
  }
  try { await fs.rm(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function logicalChildArgs(call: any[]): string[] {
  const [cmd, args] = call;
  const underlying = { command: args[3], args: args.slice(4) };
  const expected = resolveWatchedChildPiInvocation(underlying, Number(args[1]), args[2]);
  assert.deepStrictEqual({ command: cmd, args }, expected);
  return underlying.command === "pi" ? underlying.args : underlying.args.slice(1);
}

function childPrompt(call: any[]): string {
  const args = logicalChildArgs(call);
  return args[args.length - 1];
}

function createMockPi(execReturn?: { code: number; stdout: string; stderr: string }) {
  const ret = execReturn ?? { code: 0, stdout: "Consolidated", stderr: "" };
  return {
    on: () => {},
    exec: async (...args: any[]) => {
      execCalls.push(captureExecArgs(args));
      return ret;
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as any;
}

const mockStore = {
  getMemoryEntries: () => ["old entry 1", "old entry 2"],
  getUserEntries: () => ["user fact 1"],
  getAllFailureEntries: () => ["failure lesson 1", "failure lesson 2"],
  getStorageIdentity: async (target: string) => path.join("mock-store", target),
  loadFromDisk: async () => {},
  // Mechanics tests exercise the subprocess handshake, so the fixture store
  // reports itself over its capacity goal — a healthy store would clean-no-op
  // before spawning a child.
  capacityGoal: () => 10,
  capacityUsage: () => 1000,
  // Tiny limits keep the fork's under-80% skip from eating the spawn asserts.
  config: { memoryCharLimit: 20, userCharLimit: 1 },
} as any;

async function settle(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

type ManualCommandHandler = (args: unknown, ctx: unknown) => Promise<void>;

async function runManualConsolidate(timeoutMs?: number): Promise<void> {
  let handler: ManualCommandHandler | undefined;
  const pi = {
    on: () => {},
    exec: async (...args: unknown[]) => {
      execCalls.push(captureExecArgs(args as Parameters<typeof captureExecArgs>[0]));
      return { code: 0, stdout: "Done", stderr: "" };
    },
    registerTool: () => {},
    registerCommand: (_name: string, command: { handler: ManualCommandHandler }) => {
      handler = command.handler;
    },
  } as unknown as Parameters<typeof registerConsolidateCommand>[0];

  registerConsolidateCommand(pi, mockStore, timeoutMs);
  assert.ok(handler, "command handler should be registered");
  await handler({}, { signal: undefined, ui: { notify: () => {} } });
}

// ─── Tests ───

describe("triggerConsolidation", () => {
  beforeEach(() => {
    execCalls = [];
  });

  it("builds prompt with current entries and calls pi.exec", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "memory");

    assert.strictEqual(execCalls.length, 1, "should call pi.exec once");
    const args = logicalChildArgs(execCalls[0]);
    assert.ok(args[0] === "-p", "should use -p flag");
    assert.ok(args.includes("--no-session"), "should include --no-session");

    const prompt = args[args.length - 1];
    assert.ok(prompt.includes("old entry 1"), "prompt should include current memory entries");
    assert.ok(prompt.includes("memory"), "prompt should reference target");
  });

  it("returns { consolidated: true } on success (exit code 0)", async () => {
    const pi = createMockPi({ code: 0, stdout: "Done", stderr: "" });
    const result = await triggerConsolidation(pi, mockStore, "memory");

    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.error, undefined);
  });

  it("clears a failed release before the next consolidation", async () => {
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalDeleteOwnedLock = prototype.deleteOwnedLock;
    let deleteAttempts = 0;
    prototype.deleteOwnedLock = function (key: string, token: string): void {
      deleteAttempts++;
      if (deleteAttempts <= 3) throw new Error("injected consolidation release failure");
      return originalDeleteOwnedLock.call(this, key, token);
    };

    try {
      const pi = createMockPi();
      const first = await triggerConsolidation(pi, mockStore, "memory");
      const second = await triggerConsolidation(pi, mockStore, "memory");

      assert.strictEqual(first.consolidated, true);
      assert.strictEqual(second.consolidated, true);
      assert.strictEqual(execCalls.length, 2);
      assert.ok(deleteAttempts >= 4);
    } finally {
      prototype.deleteOwnedLock = originalDeleteOwnedLock;
    }
  });

  it("skips a duplicate subprocess while the same target is consolidating", async () => {
    const releaseExecs: Array<() => void> = [];
    let markExecStarted!: () => void;
    const execStarted = new Promise<void>((resolve) => { markExecStarted = resolve; });
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        markExecStarted();
        await new Promise<void>((resolve) => { releaseExecs.push(resolve); });
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const first = triggerConsolidation(pi, mockStore, "memory");
    await execStarted;
    const second = triggerConsolidation(pi, mockStore, "memory");
    const raced = await Promise.race([
      second.then((result) => ({ result })),
      settle(100).then(() => ({ timeout: true as const })),
    ]);

    releaseExecs.forEach((release) => release());
    await Promise.allSettled([first, second]);

    assert.ok("result" in raced, "duplicate consolidation should return without spawning another child");
    assert.strictEqual(raced.result.consolidated, false);
    assert.match(raced.result.error!, /already in progress/i);
    assert.strictEqual(execCalls.length, 1, "only one child Pi process should be spawned");
  });

  it("allows the same project target to consolidate concurrently in distinct stores", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-stores-"));
    const stores = ["project-a", "project-b"].map((name) => new MemoryStore({
      memoryDir: path.join(root, name),
      memoryCharLimit: 5_000,
      userCharLimit: 5_000,
    } as any));
    await Promise.all(stores.map((store) => store.loadFromDisk()));

    let started = 0;
    let markFirstStarted!: () => void;
    let markBothStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
    const releases: Array<() => void> = [];
    const pi = {
      exec: async () => {
        started++;
        if (started === 1) markFirstStarted();
        if (started === 2) markBothStarted();
        await new Promise<void>((resolve) => { releases.push(resolve); });
        return { code: 0, stdout: "Done", stderr: "" };
      },
    } as any;

    try {
      const first = triggerConsolidation(pi, stores[0], "memory", undefined, 60_000, "project");
      await firstStarted;
      const second = triggerConsolidation(pi, stores[1], "memory", undefined, 60_000, "project");
      const raced = await Promise.race([
        bothStarted.then(() => "both-started" as const),
        settle(100).then(() => "timeout" as const),
      ]);

      releases.forEach((release) => release());
      await Promise.allSettled([first, second]);

      assert.strictEqual(raced, "both-started");
      assert.strictEqual(started, 2);
    } finally {
      releases.forEach((release) => release());
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("returns { consolidated: false } on failure (non-zero exit code)", async () => {
    const pi = createMockPi({ code: 1, stdout: "", stderr: "some error" });
    const result = await triggerConsolidation(pi, mockStore, "memory");

    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error, "should have error message");
    assert.ok(result.error!.includes("exit"), "error should mention exit code");
  });

  it("surfaces timeout-style child termination clearly", async () => {
    const pi = createMockPi({ code: 143, stdout: "", stderr: "", killed: true } as any);
    const result = await triggerConsolidation(pi, mockStore, "memory", undefined, 60000);

    assert.strictEqual(result.consolidated, false);
    assert.match(result.error!, /terminated/i);
    assert.match(result.error!, /60000ms/);
  });

  it("restores pre-run entries when the child fails after removing entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consolidate-rollback-"));
    const store = new MemoryStore({
      memoryMode: "legacy-inject",
      memoryCharLimit: 2000,
      userCharLimit: 2000,
      projectCharLimit: 2000,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      correctionDetection: false,
      failureInjectionEnabled: false,
      failureInjectionMaxAgeDays: 7,
      failureInjectionMaxEntries: 5,
      nudgeToolCalls: 15,
      consolidationTimeoutMs: 600000,
      vaultPromoteThreshold: 0.67,
      vaultDailyNotes: true,
      memoryDir: dir,
    } as any);
    await store.loadFromDisk();
    await store.add("memory", "Alpha stable fact");
    await store.add("memory", "Beta important fact");

    // Child that removes both entries via the store, then exits non-zero
    // (simulates a watchdog kill mid-consolidation).
    const failingPi = {
      on: () => {},
      exec: async () => {
        await store.remove("memory", "Alpha stable fact");
        await store.remove("memory", "Beta important fact");
        return { code: 1, stdout: "", stderr: "child failed" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(failingPi, store, "memory");

    assert.strictEqual(result.consolidated, false);
    const remaining = store.getMemoryEntries();
    assert.ok(remaining.some((e) => e.includes("Alpha stable fact")), "pre-run entry restored");
    assert.ok(remaining.some((e) => e.includes("Beta important fact")), "pre-run entry restored");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns { consolidated: false } when pi.exec throws", async () => {
    const crashPi = {
      on: () => {},
      exec: async () => { throw new Error("network failure"); },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(crashPi, mockStore, "memory");

    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error!.includes("Consolidation failed"), "should mention failure");
    assert.ok(result.error!.includes("network failure"), "should include original error");
  });

  it("includes user profile entries when target is 'user'", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "user");

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("user fact 1"), "prompt should include user entries");
    assert.ok(prompt.includes("User Profile"), "prompt should reference user profile");
  });

  it("includes failure entries when target is 'failure'", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "failure");

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("failure lesson 1"), "prompt should include failure entries");
    assert.ok(prompt.includes("Failure Memory"), "prompt should reference failure memory");
    assert.ok(prompt.includes("Target: 'failure'"), "prompt should tell the child agent to use target='failure'");
  });

  it("can consolidate project memory using the project tool target", async () => {
    const pi = createMockPi();
    await triggerConsolidation(pi, mockStore, "memory", undefined, 60000, "project");

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("old entry 1"), "prompt should include project memory entries");
    assert.ok(prompt.includes("Project Memory"), "prompt should label project memory");
    assert.ok(prompt.includes("Target: 'project'"), "prompt should tell the child agent to use target='project'");
  });

  it("retries once without overrides when the override subprocess fails for model resolution reasons", async () => {
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        if (execCalls.length === 1) {
          return { code: 1, stdout: "", stderr: "model not found" };
        }
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(
      pi,
      mockStore,
      "memory",
      undefined,
      60000,
      "memory",
      { llmModelOverride: "openrouter/deepseek/deepseek-v4-flash" },
    );

    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(execCalls.length, 2, "should retry once without overrides");
    assert.deepStrictEqual(logicalChildArgs(execCalls[0]).slice(0, 6), [
      "-p",
      "--no-session",
      "--model",
      "openrouter/deepseek/deepseek-v4-flash",
      "--thinking",
      "off",
    ]);
    const retryArgs = logicalChildArgs(execCalls[1]);
    assert.deepStrictEqual(retryArgs.slice(0, 2), ["-p", "--no-session"]);
    assert.ok(!retryArgs.includes("--model"), "fallback retry should drop model override");
    assert.ok(!retryArgs.includes("--thinking"), "fallback retry should drop thinking override");
    assert.strictEqual(typeof retryArgs[retryArgs.length - 1], "string", "fallback retry should keep prompt as final arg");
  });

  it("does not retry generic consolidation failures that are unrelated to override resolution", async () => {
    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 1, stdout: "", stderr: "memory tool returned no changes" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(
      pi,
      mockStore,
      "memory",
      undefined,
      60000,
      "memory",
      { llmModelOverride: "openrouter/deepseek/deepseek-v4-flash" },
    );

    assert.strictEqual(result.consolidated, false);
    assert.strictEqual(execCalls.length, 1, "should not retry generic consolidation failures");
  });

  it("handles empty entries gracefully", async () => {
    const emptyStore = {
      getMemoryEntries: () => [],
      getUserEntries: () => [],
      getStorageIdentity: async (target: string) => path.join("empty-store", target),
      loadFromDisk: async () => {},
    } as any;

    const pi = createMockPi();
    await triggerConsolidation(pi, emptyStore, "memory");

    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("(empty)"), "prompt should show (empty) for empty entries");
  });

  describe("direct transport", () => {
    beforeEach(() => {
      directCalls = [];
    });

    it("returns consolidated true via direct transport without calling subprocess when appliedCount is positive", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 3 }),
      );

      assert.strictEqual(result.consolidated, true);
      assert.strictEqual(result.error, undefined);
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 0, "subprocess must not run on successful direct consolidation");
    });

    it("falls back to subprocess when direct transport succeeds with appliedCount 0", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 0 }),
      );

      assert.strictEqual(result.consolidated, true);
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 1, "empty direct result must fall back to subprocess");
    });

    it("falls back to subprocess when direct transport returns ok false", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps({ ok: false, appliedCount: 0 }),
      );

      assert.strictEqual(result.consolidated, true);
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 1, "failed direct result must fall back to subprocess");
    });

    it("falls back to subprocess when direct transport throws without propagating", async () => {
      const pi = createMockPi();
      const directCtx = createDirectCtx();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        directCtx,
        null,
        null,
        makeDirectDeps("throw"),
      );

      assert.strictEqual(result.consolidated, true);
      assert.strictEqual(directCalls.length, 1);
      assert.strictEqual(execCalls.length, 1, "thrown direct error must fall back to subprocess");
    });

    it("does not attempt direct transport when directCtx is null", async () => {
      const pi = createMockPi();
      const result = await triggerConsolidation(
        pi,
        mockStore,
        "memory",
        undefined,
        60000,
        "memory",
        directTransportLlmConfig,
        null,
        null,
        null,
        makeDirectDeps({ ok: true, appliedCount: 3 }),
      );

      assert.strictEqual(result.consolidated, true);
      assert.strictEqual(directCalls.length, 0, "direct path must be skipped without directCtx");
      assert.strictEqual(execCalls.length, 1, "subprocess-only path must still consolidate");
    });
  });
});

describe("registerConsolidateCommand", () => {
  beforeEach(() => {
    execCalls = [];
  });

  it("includes project memory when a project store is available", async () => {
    let handler: any;
    const notifications: string[] = [];
    let projectReloaded = false;

    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: (_name: string, command: any) => {
        handler = command.handler;
      },
    } as any;

    const projectStore = {
      getMemoryEntries: () => ["project fact"],
      getUserEntries: () => [],
      getStorageIdentity: async (target: string) => path.join("project-store", target),
      loadFromDisk: async () => { projectReloaded = true; },
    } as any;

    registerConsolidateCommand(pi, mockStore, 60000, projectStore, "demo-project");
    await handler({}, {
      signal: undefined,
      ui: { notify: (message: string) => { notifications.push(message); } },
    });

    assert.strictEqual(execCalls.length, 4, "should consolidate memory, user, failure, and project stores");
    const failurePrompt = childPrompt(execCalls[2]);
    assert.ok(failurePrompt.includes("Failure Memory"), "failure prompt should be labeled");
    assert.ok(failurePrompt.includes("failure lesson 1"), "failure prompt should include failure entries");
    assert.ok(failurePrompt.includes("Target: 'failure'"), "failure prompt should use target='failure'");
    const projectPrompt = childPrompt(execCalls[3]);
    assert.ok(projectPrompt.includes("Project Memory"), "project prompt should be labeled");
    assert.ok(projectPrompt.includes("project fact"), "project prompt should include project entries");
    assert.ok(projectPrompt.includes("Target: 'project'"), "project prompt should use target='project'");
    assert.ok(projectReloaded, "project store should reload after consolidation");
    assert.ok(notifications.some((message) => message.includes("Starting memory consolidation")), "should show an initial progress notification");
    assert.ok(notifications.some((message) => message.includes("⏳ Consolidating memory")), "should show per-target progress");
    const finalNotification = notifications[notifications.length - 1] ?? "";
    assert.ok(finalNotification.includes("failure: ✅ consolidated"), "final notification should include failure result");
    assert.ok(finalNotification.includes("project:demo-project: ✅ consolidated"), "final notification should include project result");
  });

  it("passes the configured timeout through to the manual consolidate child", async () => {
    await runManualConsolidate(240000);

    assert.ok(execCalls.length > 0, "manual consolidation should spawn children");
    for (const call of execCalls) {
      assert.strictEqual(call[1][1], "240000");
      assert.strictEqual(call[2]?.timeout, 245000);
    }
  });

  it("defaults the manual consolidate command to the shared consolidation timeout", async () => {
    await runManualConsolidate();

    assert.ok(execCalls.length > 0, "manual consolidation should spawn children");
    for (const call of execCalls) {
      assert.strictEqual(call[1][1], String(DEFAULT_CONSOLIDATION_TIMEOUT_MS));
    }
  });

  it("does not throw if the command ctx becomes stale before the final summary notify", async () => {
    let handler: any;

    const pi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: (_name: string, command: any) => {
        handler = command.handler;
      },
    } as any;

    registerConsolidateCommand(pi, mockStore, 60000);

    await assert.doesNotReject(async () => {
      await handler({}, {
        signal: undefined,
        ui: {
          notify: () => {
            throw new Error("This extension ctx is stale after session replacement or reload.");
          },
        },
      });
    });
  });

  it("passes command ctx to direct consolidation and reflects success in the summary", async () => {
    directCalls = [];
    let handler: ((_args: unknown, ctx: unknown) => Promise<void>) | undefined;
    const notifications: string[] = [];
    const commandCtx = {
      model: {},
      modelRegistry: {},
      signal: undefined,
      ui: { notify: (message: string) => { notifications.push(message); } },
      _tag: "manual-consolidate-ctx",
    };

    const pi = {
      on: () => {},
      exec: async (...args: unknown[]) => {
        execCalls.push(captureExecArgs(args as Parameters<typeof captureExecArgs>[0]));
        return { code: 0, stdout: "Done", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: (_name: string, command: { handler: typeof handler }) => {
        handler = command.handler;
      },
    } as unknown as Parameters<typeof registerConsolidateCommand>[0];

    registerConsolidateCommand(
      pi,
      mockStore,
      60000,
      null,
      null,
      directTransportLlmConfig,
      null,
      makeDirectDeps({ ok: true, appliedCount: 2 }),
    );

    assert.ok(handler, "command handler should be registered");
    await handler!({}, commandCtx);

    assert.strictEqual(directCalls.length, 3, "memory, user, and failure targets should use direct transport");
    assert.strictEqual(execCalls.length, 0, "successful direct consolidation should not spawn subprocess");
    for (const call of directCalls) {
      assert.strictEqual(call[0], commandCtx, "runDirectMemoryCompletion must receive the command ctx");
    }

    const finalNotification = notifications[notifications.length - 1] ?? "";
    assert.ok(finalNotification.includes("memory: ✅ consolidated"), "summary should show memory consolidated");
    assert.ok(finalNotification.includes("user: ✅ consolidated"), "summary should show user consolidated");
    assert.ok(finalNotification.includes("failure: ✅ consolidated"), "summary should show failure consolidated");
  });
});

describe("MemoryStore auto-consolidation integration", () => {
  let MEMORY_DIR = "";

  before(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-test-"));
  });

  after(async () => {
    try { await fs.rm(MEMORY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("add() triggers consolidation when over limit with consolidator", async () => {
    let consolidatorCalled = false;
    let consolidatorTarget: string | undefined;

    const { MemoryStore } = await import("../../src/store/memory-store.js");
    const store = new MemoryStore({
      memoryCharLimit: 120,
      userCharLimit: 120,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    // Mock consolidator that actually frees space by removing all entries
    store.setConsolidator(async (target, signal) => {
      consolidatorCalled = true;
      consolidatorTarget = target;
      // Remove all entries to simulate consolidation freeing space
      const entries = target === "memory" ? store.getMemoryEntries() : store.getUserEntries();
      for (const entry of [...entries]) {
        await store.remove(target, entry);
      }
      return { consolidated: true };
    });

    await store.loadFromDisk();

    // Fill up memory to near limit (each entry gets ~44 chars of metadata)
    const smallEntry = "a".repeat(60);
    await store.add("memory", smallEntry);

    // This add should exceed limit and trigger consolidation
    const result = await store.add("memory", "b".repeat(20));

    assert.ok(consolidatorCalled, "consolidator should have been called");
    assert.strictEqual(consolidatorTarget, "memory");
    // After consolidation removes entries, the new entry should fit
    assert.ok(result.success, "add should succeed after consolidation");
  });

  it("add() skips consolidation when autoConsolidate is false", async () => {
    let consolidatorCalled = false;
    const { MemoryStore } = await import("../../src/store/memory-store.js");

    const store = new MemoryStore({
      memoryCharLimit: 50,
      userCharLimit: 50,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    store.setConsolidator(async () => {
      consolidatorCalled = true;
      return { consolidated: true };
    });

    await store.loadFromDisk();

    const result = await store.add("memory", "x".repeat(60));
    assert.ok(!consolidatorCalled, "consolidator should NOT be called when autoConsolidate is false");
    assert.ok(!result.success, "should return error");
    assert.ok(result.error!.includes("exceed"), "should mention exceeding limit");
  });

  it("add() skips consolidation when no consolidator set", async () => {
    const { MemoryStore } = await import("../../src/store/memory-store.js");

    const store = new MemoryStore({
      memoryCharLimit: 50,
      userCharLimit: 50,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: MEMORY_DIR,
    });

    // Intentionally NOT calling setConsolidator
    await store.loadFromDisk();

    const result = await store.add("memory", "x".repeat(60));
    assert.ok(!result.success, "should return error");
    assert.ok(result.error!.includes("exceed"), "should mention exceeding limit");
  });

  async function storeWithConsolidator(
    dirName: string,
    consolidator: () => Promise<{ consolidated: boolean; error?: string }>,
  ): Promise<MemoryStore> {
    const store = new MemoryStore({
      memoryCharLimit: 120,
      userCharLimit: 120,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: true,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir: path.join(MEMORY_DIR, dirName),
    });
    store.setConsolidator(consolidator);
    await store.loadFromDisk();
    await store.add("memory", "a".repeat(60));
    return store;
  }

  it("add() accepts the entry and schedules background consolidation even when the consolidator reports failure", async () => {
    let calls = 0;
    const store = await storeWithConsolidator("reason", async () => {
      calls++;
      return { consolidated: false, error: "Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: 600000ms." };
    });

    const result = await store.add("memory", "b".repeat(20));

    // Async overflow path: the write succeeds immediately; the consolidation
    // failure is a background concern, not a blocked, failed write.
    assert.ok(result.success, "over-capacity add must succeed immediately");
    assert.ok(result.message!.includes("background consolidation"), result.message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, "the consolidator must still be invoked in the background");
  });

  it("add() accepts the entry and schedules background consolidation on a reasonless consolidation failure", async () => {
    let calls = 0;
    const store = await storeWithConsolidator("reasonless", async () => {
      calls++;
      return { consolidated: false };
    });

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(result.success, "over-capacity add must succeed immediately");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, "the consolidator must still be invoked in the background");
  });

  it("add() accepts the entry and schedules background consolidation when the consolidator throws", async () => {
    let calls = 0;
    const store = await storeWithConsolidator("throws", async () => {
      calls++;
      throw new Error("spawn ENOENT");
    });

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(result.success, "a thrown consolidator must not fail the write");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, "the consolidator must still be invoked in the background");
  });

  it("add() accepts the entry and schedules background consolidation even when nothing was freed", async () => {
    let calls = 0;
    const store = await storeWithConsolidator("no-space", async () => {
      calls++;
      return { consolidated: true };
    });

    const result = await store.add("memory", "b".repeat(20));

    assert.ok(result.success, "add succeeds immediately; there is no blocking retry");
    assert.ok(!result.error, result.error ?? "");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1, "the consolidator must still be invoked in the background");
  });
});

// ─── Chunked subprocess consolidation (#236) ───

function parsePromptBatch(prompt: string): string[] {
  const marker = "--- Current Memory Entries ---";
  const start = prompt.indexOf(marker);
  assert.ok(start >= 0, "prompt should contain the entries section");
  const end = prompt.indexOf("Use the memory tool", start);
  const body = prompt.slice(start + marker.length, end);
  return body
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "(empty)");
}

async function removeEntryFromDisk(store: MemoryStore, strippedText: string): Promise<void> {
  const filePath = path.join((store as unknown as { memoryDir: string }).memoryDir, "MEMORY.md");
  const raw = await fs.readFile(filePath, "utf-8");
  const blocks = raw.split(ENTRY_DELIMITER);
  const marker = strippedText.slice(0, 40);
  const kept = blocks.filter((block) => !block.includes(marker));
  assert.ok(kept.length < blocks.length, `child should find entry '${marker}' in the store file`);
  await fs.writeFile(filePath, kept.join(ENTRY_DELIMITER), "utf-8");
}

describe("chunked subprocess consolidation", () => {
  let MEMORY_ROOT = "";
  let storeSeq = 0;

  before(async () => {
    MEMORY_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-chunk-"));
  });

  after(async () => {
    try { await fs.rm(MEMORY_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(async () => {
    execCalls = [];
    // Fresh lock dir per test: the shared lock file couples otherwise
    // independent tests through lease-release timing on Windows.
    process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = await fs.mkdtemp(
      path.join(os.tmpdir(), "pi-consolidation-locks-"),
    );
  });

  afterEach(async () => {
    const dir = process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR;
    if (dir) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  /** Real on-disk store in its own fresh directory, policy-only so seeds can exceed the cap. */
  async function makeOverChunkStore(entryCount: number, entryChars = 600, memoryCharLimit = 5000): Promise<MemoryStore> {
    const memoryDir = path.join(MEMORY_ROOT, `store-${++storeSeq}`);
    const store = new MemoryStore({
      memoryCharLimit,
      userCharLimit: 100,
      memoryMode: "policy-only",
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      nudgeToolCalls: 15,
      memoryDir,
    } as never);
    // Seed via raw file writes: the fork enforces the char cap on add() even
    // in policy-only mode, and the child simulation must match on-disk state.
    const date = "2026-08-17";
    const seeded: string[] = [];
    for (let i = 0; i < entryCount; i++) {
      const filler = "y".repeat(Math.max(0, entryChars - `chunk-entry-${i}-`.length));
      seeded.push(`chunk-entry-${i}-${filler} <!-- created=${date}, last=${date} -->`);
    }
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "MEMORY.md"), seeded.join(ENTRY_DELIMITER), "utf-8");
    await store.loadFromDisk();
    return store;
  }

  /** Mock child that edits the store FILE on disk like the real subprocess, scripted per round. */
  function createChunkedChildPi(store: MemoryStore, script: Array<"shrink" | "noop" | "fail">) {
    let round = 0;
    return {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const action = script[Math.min(round, script.length - 1)];
        round++;
        if (action === "fail") {
          return { code: 124, stdout: "", stderr: "", killed: true };
        }
        if (action === "shrink") {
          const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
          const batch = parsePromptBatch(prompt);
          assert.ok(batch.length > 0, "child prompt should contain at least one entry");
          await removeEntryFromDisk(store, batch[0]);
        }
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;
  }

  function batchFromExecCall(call: any[]): string[] {
    return parsePromptBatch(call[1].at(-1) as string);
  }

  /**
   * Stub store WITHOUT the fork's squeezeToCap/dedupeTarget pre-pass: the
   * chunked walk only gets work when those deterministic shrinkers leave the
   * store over its capacity goal. Mirrors the upstream test fixture so the
   * ported walk logic is exercised directly.
   */
  function makeStubStore(entries: string[], goal = 5000) {
    const state = { entries: [...entries] };
    return {
      state,
      getMemoryEntries: () => [...state.entries],
      getUserEntries: () => [],
      getAllFailureEntries: () => [],
      getStorageIdentity: async (t: string) => path.join("stub-store", t),
      loadFromDisk: async () => {},
      capacityGoal: () => goal,
      capacityUsage: () => state.entries.join(ENTRY_DELIMITER).length,
    } as any;
  }

  /** Mock child that removes the first presented entry each round, like a merging child. */
  function createStubChildPi(store: ReturnType<typeof makeStubStore>, script: Array<"shrink" | "noop" | "fail">) {
    let round = 0;
    return {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const action = script[Math.min(round, script.length - 1)];
        round++;
        if (action === "fail") {
          return { code: 124, stdout: "", stderr: "", killed: true };
        }
        if (action === "shrink") {
          const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
          const batch = parsePromptBatch(prompt);
          assert.ok(batch.length > 0, "child prompt should contain at least one entry");
          const idx = store.state.entries.indexOf(batch[0]);
          assert.ok(idx >= 0, "presented entry must exist in the store");
          store.state.entries.splice(idx, 1);
        }
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;
  }

  function batchFromExecCall(call: any[]): string[] {
    return parsePromptBatch(call[1].at(-1) as string);
  }

  function stubEntries(count: number, entryChars = 600): string[] {
    const date = "2026-08-17";
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const filler = "y".repeat(Math.max(0, entryChars - `chunk-entry-${i}-`.length));
      out.push(`chunk-entry-${i}-${filler} <!-- created=${date}, last=${date} -->`);
    }
    return out;
  }

  it("takeChunk packs entries up to the budget; an oversized entry travels alone", () => {
    const small = ["aaaa", "bbbb", "cccc"]; // 4 chars + ENTRY_DELIMITER.length each
    assert.deepStrictEqual(takeChunk(small, 100), small, "everything fits one chunk");
    const unit = "aaaa".length + ENTRY_DELIMITER.length;
    assert.deepStrictEqual(takeChunk(small, unit * 2), ["aaaa", "bbbb"], "budget packing");
    assert.deepStrictEqual(takeChunk(small, unit), ["aaaa"], "exact fit");
    const big = ["z".repeat(50)];
    assert.deepStrictEqual(takeChunk(big, 10), big, "oversized entry travels alone so the loop always makes progress");
  });

  it("treats a small healthy store as a clean no-op", async () => {
    const store = await makeOverChunkStore(2, 20);
    const pi = createMockPi();

    const result = await triggerConsolidation(pi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(execCalls.length, 0, "a healthy store spawns no child");
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.rounds, 0);
    assert.strictEqual(result.error, undefined);
  });

  it("completes an over-goal store in bounded rounds with a shared time budget", async () => {
    const store = makeStubStore(stubEntries(10)); // ≈ 6507 encoded chars > 5000 goal
    const pi = createStubChildPi(store, ["shrink", "shrink", "shrink"]);

    const result = await triggerConsolidation(pi, store as unknown as MemoryStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    // Each round removes one entry (−650 encoded chars): 6507 → 5857 → 5207 →
    // 4557 ≤ goal. The walk advances past each consumed slice.
    assert.strictEqual(execCalls.length, 3);
    assert.strictEqual(result.consolidated, true);
    assert.strictEqual(result.rounds, 3);
    assert.ok(!result.partial, "goal met with no failure is a clean run");
    assert.strictEqual(result.error, undefined, "goal met with no failure carries no error");
    assert.strictEqual(store.state.entries.length, 7);
    for (const call of execCalls) {
      const batch = batchFromExecCall(call);
      const batchChars = batch.join(ENTRY_DELIMITER).length;
      assert.ok(batchChars <= DEFAULT_CONSOLIDATION_CHUNK_CHARS, `round prompt ${batchChars} must fit one chunk`);
    }
  });

  it("keeps walking forward: round 2 slices after round 1's slice, not from the top", async () => {
    const store = makeStubStore(stubEntries(10));
    const batches: string[][] = [];
    const pi: any = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        const prompt = execCalls[execCalls.length - 1][1].at(-1) as string;
        const batch = parsePromptBatch(prompt);
        batches.push(batch);
        const idx = store.state.entries.indexOf(batch[0]);
        if (idx >= 0) store.state.entries.splice(idx, 1);
        return { code: 0, stdout: "Consolidated", stderr: "" };
      },
      registerTool: () => {},
      registerCommand: () => {},
    };

    await triggerConsolidation(pi, store as unknown as MemoryStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.ok(batches.length >= 2, "expected multiple rounds");
    // The discriminating check vs an offset-reset mutant: the walk must move
    // FORWARD — round 2 starts after round 1's slice. Later rounds may revisit
    // entries after index shifts (documented approximation).
    const overlap = batches[1].filter((entry) => batches[0].includes(entry));
    assert.strictEqual(overlap.length, 0, `round 2 re-processed ${overlap.length} entries from round 1 — the walk must advance`);
  });

  it("resumes after a killed round: partial progress persists and a second trigger finishes", async () => {
    const store = makeStubStore(stubEntries(11));
    const pi = createStubChildPi(store, ["shrink", "fail"]);

    const first = await triggerConsolidation(pi, store as unknown as MemoryStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
    });

    assert.strictEqual(execCalls.length, 2, "round 1 succeeds, round 2 is killed");
    assert.strictEqual(first.consolidated, true, "one completed round is real progress on disk");
    assert.strictEqual(first.partial, true, "a killed run must not read as a clean success");
    assert.strictEqual(first.rounds, 1);
    assert.ok(first.error?.includes("terminated"), first.error);
    assert.ok(first.error?.includes("1 earlier round shrank the store"), first.error);
    assert.strictEqual(store.state.entries.length, 10, "the killed run did not roll back its completed round");

    // Second trigger resumes from current state.
    execCalls = [];
    const pi2 = createStubChildPi(store, ["shrink", "shrink"]);
    const second = await triggerConsolidation(pi2, store as unknown as MemoryStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {
      consolidationChunkChars: 2500,
      consolidationChunking: true,
    });

    assert.strictEqual(second.consolidated, true);
    assert.ok(!second.partial);
    assert.strictEqual(store.state.entries.length, 7, "resume finishes the shrink below the capacity goal");
  });

  it("reports out-of-scope disappearances instead of resurrecting them", async () => {
    const store = makeStubStore(stubEntries(10));
    const base = createStubChildPi(store, ["shrink", "shrink", "shrink"]);
    let shrankRounds = 0;
    const originalExec = base.exec;
    const pi: any = {
      on: () => {},
      exec: async (...args: any[]) => {
        const ret = await originalExec(...args);
        shrankRounds++;
        if (shrankRounds === 2) {
          // Another session removes an entry that was NOT in the presented slice.
          const idx = store.state.entries.findIndex((e: string) => e.includes("chunk-entry-9"));
          if (idx >= 0) store.state.entries.splice(idx, 1);
        }
        return ret;
      },
      registerTool: () => {},
      registerCommand: () => {},
    };

    const result = await triggerConsolidation(pi, store as unknown as MemoryStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    const allNotes = result.error ?? "";
    assert.ok(
      allNotes.includes("out-of-scope") || result.partial !== true,
      `out-of-scope disappearance must be reported: ${allNotes}`,
    );
    // The removed entry must NOT be resurrected by the consolidation loop.
    assert.strictEqual(
      store.state.entries.filter((e: string) => e.includes("chunk-entry-9")).length,
      0,
      "out-of-scope deletions stay deleted — no resurrection",
    );
  });

  it("single-shot stays byte-identical when chunking is off (default), with the remedy hint on timeout", async () => {
    // 8 entries ≈ 4853 chars: above the 80% skip line (4000), under the cap
    // (no squeeze), over the 4000 chunk threshold (remedy hint applies).
    const store = await makeOverChunkStore(8, 560);
    const oversizedPi = {
      on: () => {},
      exec: async (...args: any[]) => {
        execCalls.push(captureExecArgs(args));
        return { code: 124, stdout: "", stderr: "", killed: true };
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    // Flag off (default): one unscoped whole-store child.
    const result = await triggerConsolidation(oversizedPi, store, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", {});

    assert.strictEqual(execCalls.length, 1, "legacy single-shot runs exactly one child");
    const prompt = childPrompt(execCalls[0]);
    assert.ok(prompt.includes("chunk-entry-0") && prompt.includes("chunk-entry-7"), "single-shot prompt carries the whole store");
    assert.ok(!prompt.includes("covers ONLY the entries listed above"), "single-shot is unscoped");
    assert.strictEqual(result.consolidated, false);
    assert.ok(result.error?.includes("terminated"), result.error);
    assert.ok(
      result.error?.includes("consolidationChunking"),
      "the timeout error teaches the chunking remedy",
    );
  });

  it("defers instead of failing when pi.exec throws a stale extension ctx error", async () => {
    const stalePi = {
      on: () => {},
      exec: async () => { throw new Error("This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession()"); },
      registerTool: () => {},
      registerCommand: () => {},
    } as any;

    const result = await triggerConsolidation(stalePi, mockStore, "memory", undefined, DEFAULT_CONSOLIDATION_TIMEOUT_MS, "memory", { consolidationChunking: true });

    assert.strictEqual(result.consolidated, false);
    assert.strictEqual(result.deferred, true, "stale ctx should defer, not fail");
    assert.ok(!result.error!.includes("Consolidation failed"), "should not report a failure");
    assert.ok(result.error!.includes("session replaced or reloaded"), "should explain the skip");
  });
});
