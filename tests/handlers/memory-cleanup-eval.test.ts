// Tests for memory-cleanup-eval.ts — Luna-low DRY-RUN evaluation harness.
// Real MemoryStore fixtures on temp dirs + injected fake spawn functions.
// NOTHING here ever touches maintenance state, applyCleanupActions, the
// scheduler, or Drive sync — the module under test is read-only by contract.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import {
  buildGroupPrompt,
  parseModelResponse,
  compareFingerprints,
  createLunaAnalyzer,
  defaultSpawnLuna,
  runEvalDryRun,
} from "../../src/handlers/memory-cleanup-eval.js";
import type {
  CandidateGroup,
  GroupDecision,
  PlanningEntry,
  StoreLabel,
} from "../../src/handlers/memory-cleanup-plan.js";
import { ENTRY_DELIMITER, DEFAULT_MEMORY_CHAR_LIMIT, MEMORY_FILE } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Harness ───

let root = "";
let globalDir = "";
let memoryPath = "";
let previousMaintenanceDir: string | undefined;
let previousPiEnv: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cleanup-eval-"));
  globalDir = path.join(root, "global");
  await fs.mkdir(globalDir, { recursive: true });
  memoryPath = path.join(globalDir, MEMORY_FILE);
  previousMaintenanceDir = process.env.PI_HERMES_MAINTENANCE_STATE_DIR;
  previousPiEnv = process.env.PI_SESSION_ID;
  process.env.PI_HERMES_MAINTENANCE_STATE_DIR = path.join(root, "maintenance");
  process.env.PI_SESSION_ID = "should-not-reach-the-child";
});

afterEach(async () => {
  if (previousMaintenanceDir === undefined) delete process.env.PI_HERMES_MAINTENANCE_STATE_DIR;
  else process.env.PI_HERMES_MAINTENANCE_STATE_DIR = previousMaintenanceDir;
  if (previousPiEnv === undefined) delete process.env.PI_SESSION_ID;
  else process.env.PI_SESSION_ID = previousPiEnv;
  // Best-effort: sqlite/lock handles may keep directories busy on Windows.
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function makeCfg(): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
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

async function makeStore(): Promise<MemoryStore> {
  const store = new MemoryStore(makeCfg());
  await store.loadFromDisk();
  return store;
}

/** Seed entries bypassing add()'s duplicate/near-duplicate refusal. */
async function seedRaw(store: MemoryStore, texts: string[]): Promise<void> {
  const base = new Date();
  const content = texts
    .map((t, i) => {
      const lastDate = new Date(base);
      lastDate.setDate(lastDate.getDate() - i);
      return `${t} <!-- created=${base.toISOString().split("T")[0]}, last=${lastDate.toISOString().split("T")[0]} -->`;
    })
    .join(ENTRY_DELIMITER) + "\n";
  await fs.writeFile(memoryPath, content, "utf-8");
  await store.loadFromDisk();
}

let entryCounter = 0;
function makeEntry(text: string, overrides: Partial<PlanningEntry> = {}): PlanningEntry {
  entryCounter++;
  return {
    index: overrides.index ?? entryCounter,
    raw: overrides.raw ?? text,
    text,
    created: overrides.created ?? "2026-10-14T00:00:00.000Z",
    lastReferenced: overrides.lastReferenced ?? "2026-10-14T00:00:00.000Z",
    project: overrides.project ?? null,
    hash: overrides.hash ?? `hash-${entryCounter}`,
    store: overrides.store ?? "memory",
  };
}

function makeGroup(members: PlanningEntry[], id = "g-test", similarity = 0.9): CandidateGroup {
  return { id, members, similarity };
}

interface FakeSpawnCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

function fakeSpawn(responder: (args: string[]) => string | Promise<never>) {
  const calls: FakeSpawnCall[] = [];
  const spawnFn = async (invocation: { command: string; args: string[] }, opts: { env: NodeJS.ProcessEnv }) => {
    calls.push({ args: invocation.args, env: opts.env });
    return responder(invocation.args);
  };
  return { spawnFn, calls };
}

const dedupeJson = (keepIndex = 1, removeIndices = [0]) =>
  JSON.stringify({ action: "deduplicate", keepIndex, removeIndices, rationale: "same facts" });
const keepBothJson = () => JSON.stringify({ action: "keep_both", rationale: "distinct facts" });

const DEPLOY_A = "Deploy workflow runs npm build and ships package after every release tag.";
const DEPLOY_B = "Deploy workflow runs npm build and ships package after every release tag and records the checksum.";

// ─── parseModelResponse ───

describe("parseModelResponse", () => {
  it("parses selection-only deduplicate decisions", () => {
    const text = `Here you go:\n\`\`\`json\n${dedupeJson(1, [0])}\n\`\`\`\ndone`;
    assert.deepEqual(parseModelResponse(text), {
      kind: "decision",
      decision: { action: "deduplicate", keepIndex: 1, removeIndices: [0], rationale: "same facts" },
    });
  });

  it("parses keep_both as a non-mutating decision", () => {
    assert.deepEqual(parseModelResponse(keepBothJson()), {
      kind: "decision",
      decision: { action: "keep_both", rationale: "distinct facts" },
    });
  });

  it("rejects rewrite actions and invalid member selections", () => {
    assert.equal(parseModelResponse("not json at all").kind, "invalid");
    assert.equal(parseModelResponse('{"action":"replace_all","replacement":"x"}').kind, "invalid");
    assert.equal(parseModelResponse('{"action":"merge","replacement":"new text"}').kind, "invalid");
    assert.equal(parseModelResponse('{"action":"supersede","keepIndex":0}').kind, "invalid");
    assert.equal(parseModelResponse('{"action":"deduplicate","keepIndex":0,"removeIndices":[]}').kind, "invalid");
    assert.equal(parseModelResponse('{"action":"deduplicate","keepIndex":0,"removeIndices":[0]}').kind, "invalid");
  });

  it("rejects responses above the byte budget", () => {
    assert.equal(parseModelResponse(`${" ".repeat(4097)}${keepBothJson()}`).kind, "invalid");
  });
});

// ─── buildGroupPrompt ───

describe("buildGroupPrompt", () => {
  it("quotes every member text as data and demands the strict JSON schema", () => {
    const group = makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)]);
    const { system, user } = buildGroupPrompt(group);
    assert.match(system, /\bdata\b/i, "entries must be labelled untrusted data");
    assert.match(system, /deduplicate/);
    assert.match(system, /keep_both/);
    assert.doesNotMatch(system, /merge|supersede|replacement/);
    for (const t of [DEPLOY_A, DEPLOY_B]) {
      assert.ok(user.includes(JSON.stringify(t)), "member text must appear JSON-quoted");
    }
    assert.match(system, /"action"/);
    assert.match(system, /"keepIndex"/);
    assert.match(system, /"removeIndices"/);
  });

  it("omits only recognized embedded bookkeeping comments from candidate text", () => {
    const fact = "The nightly index job rebuilds every search vector after each release tag.";
    const group = makeGroup([
      makeEntry(`${fact} <!-- created=2026-09-01, last=2026-09-03 -->`),
      makeEntry(`${fact} <!-- created=2026-09-02, last=2026-09-04 -->`),
    ]);
    const { user } = buildGroupPrompt(group);
    assert.ok(user.includes(JSON.stringify(fact)));
    assert.doesNotMatch(user, /created=|last=/);
  });
});

// ─── compareFingerprints ───

describe("compareFingerprints", () => {
  it("detects stable, changed, and vanished stores", () => {
    assert.deepEqual(compareFingerprints({ memory: "a" }, { memory: "a" }), { stable: true, changed: [] });
    assert.deepEqual(
      compareFingerprints({ memory: "a", user: "u1" }, { memory: "b", user: "u1" }),
      { stable: false, changed: ["memory"] },
    );
    assert.deepEqual(
      compareFingerprints({ memory: "a" }, { memory: "a", user: undefined as unknown as string }),
      { stable: true, changed: [] },
    );
  });
});

// ─── createLunaAnalyzer ───

describe("createLunaAnalyzer", () => {
  it("returns a selection-only decision and records the outcome", async () => {
    const { spawnFn, calls } = fakeSpawn(() => dedupeJson(1, [0]));
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    const group = makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-dedup");
    const decision = await analyzer(group);
    assert.deepEqual(decision, { action: "deduplicate", keepIndex: 1, removeIndices: [0], rationale: "same facts" });
    assert.equal(calls.length, 1);
    assert.equal(outcomes().length, 1);
    assert.equal(outcomes()[0].groupId, "g-dedup");
    assert.equal(outcomes()[0].kind, "decision");
  });

  it("passes a PI_*-stripped environment to the spawn function", async () => {
    const { spawnFn, calls } = fakeSpawn(() => dedupeJson());
    const { analyzer } = createLunaAnalyzer({ spawnFn });
    await analyzer(makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-env"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.PI_SESSION_ID, undefined, "session markers must be stripped");
    assert.ok(calls[0].args.some((a) => a.includes("--no-extensions")), "child must run --no-extensions");
    assert.equal(
      calls[0].args.filter((a) => a === "--no-session").length,
      1,
      "child must run exactly once with --no-session",
    );
  });

  it("returns keep_both without proposing replacement text", async () => {
    const { spawnFn } = fakeSpawn(() => keepBothJson());
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    const decision = await analyzer(makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-both"));
    assert.deepEqual(decision, { action: "keep_both", rationale: "distinct facts" });
    assert.equal(outcomes()[0].kind, "decision");
  });

  it("does not spawn when a candidate prompt exceeds the byte budget", async () => {
    const { spawnFn, calls } = fakeSpawn(() => {
      throw new Error("oversized prompts must not reach the model");
    });
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    const large = "long but useful memory entry ".repeat(300);
    assert.equal(await analyzer(makeGroup([makeEntry(large), makeEntry(`${large} distinct fact`)], "g-large")), null);
    assert.equal(calls.length, 0);
    assert.equal(outcomes()[0].kind, "invalid");
    assert.match(outcomes()[0].reason ?? "", /prompt.*budget/i);
  });

  it("returns null and records invalid on garbage model output", async () => {
    const { spawnFn } = fakeSpawn(() => "I cannot help with that.");
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    assert.equal(await analyzer(makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-bad")), null);
    assert.equal(outcomes()[0].kind, "invalid");
  });

  it("returns null when a dedup member index is out of range", async () => {
    const { spawnFn } = fakeSpawn(() =>
      JSON.stringify({ action: "deduplicate", keepIndex: 5, removeIndices: [0], rationale: "x" }),
    );
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    assert.equal(await analyzer(makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-oob")), null);
    assert.equal(outcomes()[0].kind, "invalid");
  });

  it("returns null and records spawn-failed when the child fails", async () => {
    const spawnFn = async () => {
      throw new Error("child exited 1");
    };
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    assert.equal(await analyzer(makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-fail")), null);
    assert.equal(outcomes()[0].kind, "spawn-failed");
  });

  it("replays successful checkpointed groups without spawning again", async () => {
    const checkpointPath = path.join(root, "checkpoint.jsonl");
    const first = createLunaAnalyzer({ spawnFn: fakeSpawn(() => dedupeJson()).spawnFn, checkpointPath });
    const group = makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-cache");
    const firstDecision = await first.analyzer(group);
    assert.deepEqual(firstDecision, { action: "deduplicate", keepIndex: 1, removeIndices: [0], rationale: "same facts" });
    await first.analyzer.recordValidatedDecision?.(group, firstDecision!);

    const { spawnFn, calls } = fakeSpawn(() => {
      throw new Error("must not spawn for a cached group");
    });
    const second = createLunaAnalyzer({ spawnFn, checkpointPath });
    assert.deepEqual(await second.analyzer(group), { action: "deduplicate", keepIndex: 1, removeIndices: [0] });
    const saved = JSON.parse((await fs.readFile(checkpointPath, "utf-8")).trim());
    assert.equal("rationale" in saved.decision, false, "checkpoint must omit untrusted free-form rationale");
    assert.equal(await second.analyzer.isCached?.(group), true);
    assert.equal(calls.length, 0, "checkpointed groups must not hit the model");
  });

  it("does not reuse checkpoint decisions without the current policy version", async () => {
    const checkpointPath = path.join(root, "legacy-checkpoint.jsonl");
    const group = makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-legacy");
    await fs.writeFile(checkpointPath, `${JSON.stringify({
      groupId: group.id,
      kind: "decision",
      action: "keep_both",
      decision: { action: "keep_both", rationale: "old policy" },
    })}\n`, "utf-8");
    const { spawnFn, calls } = fakeSpawn(() => keepBothJson());
    const luna = createLunaAnalyzer({ spawnFn, checkpointPath });
    assert.equal(await luna.analyzer.isCached?.(group), false);
    assert.deepEqual(await luna.analyzer(group), { action: "keep_both", rationale: "distinct facts" });
    assert.equal(calls.length, 1, "pre-policy judgments must be recomputed");
  });
});

// ─── defaultSpawnLuna ───

describe("defaultSpawnLuna", () => {
  it("resolves stdout of a quick child", async () => {
    const stdout = await defaultSpawnLuna(
      { command: process.execPath, args: ["-e", "process.stdout.write('spawn-ok')"] },
      { env: {}, timeoutMs: 30_000 },
    );
    assert.equal(stdout, "spawn-ok");
  });

  it("terminates and rejects a child that exceeds the stdout byte budget", async () => {
    await assert.rejects(
      defaultSpawnLuna(
        { command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(10000))"] },
        { env: {}, timeoutMs: 30_000 },
      ),
      /output exceeded .*byte budget/i,
    );
  });

  it("rejects when the child exceeds the timeout", async () => {
    await assert.rejects(
      defaultSpawnLuna(
        { command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] },
        { env: {}, timeoutMs: 300 },
      ),
      /timed out|timeout/i,
    );
  });
});

// ─── runEvalDryRun (read-only, end to end) ───

describe("runEvalDryRun", () => {
  it("keeps an existing complete entry unchanged and removes only its duplicate", async () => {
    const store = await makeStore();
    await seedRaw(store, [DEPLOY_A, DEPLOY_B]);
    const keeperIndex = [DEPLOY_A, DEPLOY_B].sort((a, b) => a.localeCompare(b)).indexOf(DEPLOY_B);
    const { spawnFn } = fakeSpawn(() => dedupeJson(keeperIndex, [1 - keeperIndex]));
    const luna = createLunaAnalyzer({ spawnFn });

    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });

    assert.equal(report.plan.actions.length, 1, "the redundant entry becomes the only action");
    assert.equal(report.plan.actions[0].type, "deduplicate");
    const inventory = await store.readInventory("memory");
    const expectedKeeper = inventory.find((entry) => entry.text === DEPLOY_B);
    assert.equal(report.plan.actions[0].keep.hash, expectedKeeper?.hash);
    assert.equal("replacement" in report.plan.actions[0], false);
    assert.equal(report.plan.stats.freshGroupsAnalyzed, 1);
    assert.equal(report.snapshotStable, true);
    assert.ok(report.fingerprintsBefore.memory);
    assert.ok(report.elapsedMs >= 0);
    assert.equal(report.outcomes.filter((o) => o.kind === "decision").length, 1);
    assert.equal(report.plan.stats.actionsValidated, 1);
  });

  it("rejects a selected removal that would lose a hard fact", async () => {
    const store = await makeStore();
    await seedRaw(store, [
      "Cache policy uses version 2 during nightly retries after validation completes.",
      "Cache policy uses version 3 during nightly retries after validation completes.",
    ]);
    const checkpointPath = path.join(root, "safety-rejected.jsonl");
    const { spawnFn } = fakeSpawn(() => dedupeJson(0, [1]));
    const luna = createLunaAnalyzer({ spawnFn, checkpointPath });

    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });

    assert.equal(report.plan.actions.length, 0);
    assert.equal(report.plan.stats.rejectedToReview, 1);
    assert.equal(report.plan.stats.safetyRejectedGroups, 1);
    const checkpoint = (await fs.readFile(checkpointPath, "utf-8")).trim().split("\n").map(JSON.parse);
    assert.equal(checkpoint.at(-1).kind, "safety-rejected");
    assert.equal(checkpoint.at(-1).reasonCode, "hard-fact-missing");
    assert.doesNotMatch(JSON.stringify(checkpoint.at(-1)), /Cache policy uses version/);
  });

  it("keeps a conservative keep_both decision without reporting unresolved review", async () => {
    const store = await makeStore();
    await seedRaw(store, [DEPLOY_A, DEPLOY_B]);
    const checkpointPath = path.join(root, "keep-both.jsonl");
    const { spawnFn } = fakeSpawn(() => keepBothJson());
    const luna = createLunaAnalyzer({ spawnFn, checkpointPath });
    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });
    assert.equal(report.plan.actions.length, 0);
    assert.equal(report.plan.needsReview.length, 0);
    assert.equal(report.plan.stats.analyzedGroups, 1);
    assert.equal(report.plan.stats.keepBothGroups, 1);
    const checkpoint = (await fs.readFile(checkpointPath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(checkpoint.at(-1).kind, "decision");
    assert.equal(checkpoint.at(-1).action, "keep_both");
  });

  it("persists failed and deferred outcome codes without entry text", async () => {
    for (const item of [
      {
        kind: "invalid",
        spawnFn: fakeSpawn(() => "not json").spawnFn,
        expectedKind: "invalid",
        expectedCode: "invalid-output",
      },
      {
        kind: "spawn-failed",
        spawnFn: async () => { throw new Error("child exited 1"); },
        expectedKind: "spawn-failed",
        expectedCode: "spawn-failed",
      },
    ]) {
      const store = await makeStore();
      await seedRaw(store, [DEPLOY_A, DEPLOY_B]);
      const checkpointPath = path.join(root, `${item.kind}.jsonl`);
      const report = await runEvalDryRun({
        stores: [{ label: "memory", store, target: "memory" }],
        analyzer: createLunaAnalyzer({ spawnFn: item.spawnFn, checkpointPath }),
      });
      assert.equal(report.plan.stats.analyzerFailedGroups, 1);
      const checkpoint = (await fs.readFile(checkpointPath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(checkpoint.at(-1).kind, item.expectedKind);
      assert.equal(checkpoint.at(-1).reasonCode, item.expectedCode);
      assert.doesNotMatch(JSON.stringify(checkpoint.at(-1)), /Deploy worker|deploy worker/i);
    }

    const store = await makeStore();
    await seedRaw(store, [DEPLOY_A, DEPLOY_B]);
    const checkpointPath = path.join(root, "deferred.jsonl");
    const { spawnFn, calls } = fakeSpawn(() => { throw new Error("budgeted group must not spawn"); });
    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: createLunaAnalyzer({ spawnFn, checkpointPath }),
      maxGroups: 0,
    });
    assert.equal(calls.length, 0);
    assert.equal(report.plan.stats.deferredGroups, 1);
    const checkpoint = (await fs.readFile(checkpointPath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(checkpoint.at(-1).kind, "deferred");
    assert.equal(checkpoint.at(-1).reasonCode, "analysis-budget");
    assert.doesNotMatch(JSON.stringify(checkpoint.at(-1)), /Deploy worker|deploy worker/i);
  });

  it("never calls the analyzer for exact duplicates (planner contract)", async () => {
    const store = await makeStore();
    await seedRaw(store, [DEPLOY_A, DEPLOY_A, DEPLOY_B]); // exact pair + near pair
    const { spawnFn, calls } = fakeSpawn(() => dedupeJson());
    const luna = createLunaAnalyzer({ spawnFn });

    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });

    assert.equal(calls.length, 1, "only the near-duplicate group may reach the model");
    assert.ok(report.plan.actions.some((a) => a.rationale.includes("Exact fact duplicate")));
  });

  it("is read-only: store files and fingerprints are untouched by the dry run", async () => {
    const store = await makeStore();
    await seedRaw(store, [DEPLOY_A, DEPLOY_B]);
    const before = await fs.readFile(memoryPath, "utf-8");
    const { spawnFn } = fakeSpawn(() => dedupeJson());
    const luna = createLunaAnalyzer({ spawnFn });

    await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });

    assert.equal(await fs.readFile(memoryPath, "utf-8"), before, "store file must be byte-identical");
  });
});

// ─── Safety: the module must not contain mutation paths ───

describe("module safety", () => {
  it("memory-cleanup-eval.ts contains no mutation, sync, or maintenance APIs", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "src", "handlers", "memory-cleanup-eval.ts"),
      "utf-8",
    );
    for (const forbidden of [
      "applyCleanupActions",
      "beginMaintenance",
      "endMaintenance",
      "runMemoryCleanup",
      "runAuthorizedSync",
      "restoreSyncTask",
      ".add(",
      "addFailure(",
    ]) {
      assert.ok(!source.includes(forbidden), `forbidden mutation API in eval module: ${forbidden}`);
    }
  });
});
