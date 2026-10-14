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

const mergeJson = (replacement: string) =>
  JSON.stringify({ action: "merge", replacement, rationale: "same facts" });

const DEPLOY_A = "Deploy workflow uses npm run build then rsync to host /var/www/app with pm2 reload after every release tag.";
const DEPLOY_B = "Deploy workflow uses npm run build then rsync to server /var/www/app with pm2 restart after every release tag.";
const DEPLOY_MERGE = DEPLOY_A + " server restart";

// ─── parseModelResponse ───

describe("parseModelResponse", () => {
  it("parses a valid fenced merge decision", () => {
    const text = "Here you go:\n```json\n" + mergeJson("merged text") + "\n```\ndone";
    const parsed = parseModelResponse(text);
    assert.equal(parsed.kind, "decision");
    if (parsed.kind === "decision") {
      assert.equal(parsed.decision.action, "merge");
      assert.equal(parsed.decision.replacement, "merged text");
      assert.equal(parsed.decision.rationale, "same facts");
    }
  });

  it("maps keep_separate and conflict to no-action, never a decision", () => {
    for (const action of ["keep_separate", "conflict"]) {
      const parsed = parseModelResponse(JSON.stringify({ action, rationale: "different facts" }));
      assert.equal(parsed.kind, "no-action");
      if (parsed.kind === "no-action") assert.equal(parsed.action, action);
    }
  });

  it("rejects garbage, unknown actions, and empty merge replacements", () => {
    assert.equal(parseModelResponse("not json at all").kind, "invalid");
    assert.equal(parseModelResponse('{"action":"replace_all","replacement":"x"}').kind, "invalid");
    assert.equal(parseModelResponse('{"action":"merge","replacement":"   "}').kind, "invalid");
    assert.equal(parseModelResponse('{"action":"supersede"}').kind, "invalid");
  });
});

// ─── buildGroupPrompt ───

describe("buildGroupPrompt", () => {
  it("quotes every member text as data and demands the strict JSON schema", () => {
    const group = makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)]);
    const { system, user } = buildGroupPrompt(group);
    assert.match(system, /\bdata\b/i, "entries must be labelled untrusted data");
    assert.match(system, /merge/);
    assert.match(system, /supersede/);
    assert.match(system, /keep_separate/);
    for (const t of [DEPLOY_A, DEPLOY_B]) {
      assert.ok(user.includes(JSON.stringify(t)), "member text must appear JSON-quoted");
    }
    assert.match(system, /"action"/);
    assert.match(system, /"replacement"/);
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
  it("returns the parsed decision and records the outcome", async () => {
    const { spawnFn, calls } = fakeSpawn(() => mergeJson(DEPLOY_MERGE));
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    const group = makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-merge");
    const decision = await analyzer(group);
    assert.deepEqual(decision, { action: "merge", replacement: DEPLOY_MERGE, rationale: "same facts" });
    assert.equal(calls.length, 1);
    assert.equal(outcomes().length, 1);
    assert.equal(outcomes()[0].groupId, "g-merge");
    assert.equal(outcomes()[0].kind, "decision");
  });

  it("passes a PI_*-stripped environment to the spawn function", async () => {
    const { spawnFn, calls } = fakeSpawn(() => mergeJson(DEPLOY_MERGE));
    const { analyzer } = createLunaAnalyzer({ spawnFn });
    await analyzer(makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-env"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].env.PI_SESSION_ID, undefined, "session markers must be stripped");
    assert.ok(calls[0].args.some((a) => a.includes("--no-extensions")), "child must run --no-extensions");
  });

  it("returns null for keep_separate and records a no-action outcome", async () => {
    const { spawnFn } = fakeSpawn(() => JSON.stringify({ action: "keep_separate", rationale: "distinct" }));
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    const decision = await analyzer(makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-sep"));
    assert.equal(decision, null);
    assert.equal(outcomes()[0].kind, "no-action");
    if (outcomes()[0].kind === "no-action") assert.equal(outcomes()[0].action, "keep_separate");
  });

  it("returns null and records invalid on garbage model output", async () => {
    const { spawnFn } = fakeSpawn(() => "I cannot help with that.");
    const { analyzer, outcomes } = createLunaAnalyzer({ spawnFn });
    assert.equal(await analyzer(makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-bad")), null);
    assert.equal(outcomes()[0].kind, "invalid");
  });

  it("returns null when a supersede keepIndex is out of range", async () => {
    const { spawnFn } = fakeSpawn(() =>
      JSON.stringify({ action: "supersede", keepIndex: 5, rationale: "x" }),
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

  it("replays checkpointed groups without spawning again", async () => {
    const checkpointPath = path.join(root, "checkpoint.jsonl");
    const first = createLunaAnalyzer({ spawnFn: fakeSpawn(() => mergeJson(DEPLOY_MERGE)).spawnFn, checkpointPath });
    const group = makeGroup([makeEntry(DEPLOY_A), makeEntry(DEPLOY_B)], "g-cache");
    assert.deepEqual(await first.analyzer(group), { action: "merge", replacement: DEPLOY_MERGE, rationale: "same facts" });

    const { spawnFn, calls } = fakeSpawn(() => {
      throw new Error("must not spawn for a cached group");
    });
    const second = createLunaAnalyzer({ spawnFn, checkpointPath });
    assert.deepEqual(await second.analyzer(group), { action: "merge", replacement: DEPLOY_MERGE, rationale: "same facts" });
    assert.equal(calls.length, 0, "checkpointed groups must not hit the model");
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
  it("collects a validated LLM merge into plan actions and reports a stable snapshot", async () => {
    const store = await makeStore();
    await seedRaw(store, [DEPLOY_A, DEPLOY_B]);
    const { spawnFn } = fakeSpawn(() => mergeJson(DEPLOY_MERGE));
    const luna = createLunaAnalyzer({ spawnFn });

    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });

    assert.equal(report.plan.actions.length, 1, "the validated merge becomes the only action");
    assert.equal(report.plan.actions[0].type, "merge");
    assert.equal(report.plan.actions[0].replacement, DEPLOY_MERGE);
    assert.equal(report.snapshotStable, true);
    assert.ok(report.fingerprintsBefore.memory);
    assert.ok(report.elapsedMs >= 0);
    assert.equal(report.outcomes.filter((o) => o.kind === "decision").length, 1);
    assert.equal(report.plan.stats.actionsValidated, 1);
  });

  it("routes a fact-dropping merge replacement to needs-review, never to actions", async () => {
    const store = await makeStore();
    await seedRaw(store, [
      "CI pipeline runs 3 stages then deploys via webhook to staging every night.",
      "CI pipeline runs 3 stages then deploys via webhook to staging nightly after tests.",
    ]);
    // Omits the hard fact "3" ("three" spelled out) → planner must reject.
    const { spawnFn } = fakeSpawn(() =>
      mergeJson("CI pipeline runs three stages then deploys via webhook to staging every night."),
    );
    const luna = createLunaAnalyzer({ spawnFn });

    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });

    assert.equal(report.plan.actions.length, 0);
    assert.equal(report.plan.stats.rejectedToReview, 1);
  });

  it("keeps a supersede decision only when the planner validates the correction", async () => {
    const store = await makeStore();
    const survivor = "Build cache no longer uses host alpha since 2024; Redis moved to port 6379 on beta.";
    const victim = "Build cache uses Redis port 6379 on host alpha since 2024.";
    await seedRaw(store, [survivor, victim]); // member order = seed order → survivor is member 0
    const { spawnFn } = fakeSpawn(() =>
      JSON.stringify({ action: "supersede", keepIndex: 0, rationale: "explicit correction" }),
    );
    const luna = createLunaAnalyzer({ spawnFn });

    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });

    assert.equal(report.plan.actions.length, 1, "validated supersede becomes an action");
    assert.equal(report.plan.actions[0]?.type, "supersede");
    assert.equal(report.plan.stats.actionsValidated, 1);
  });

  it("never calls the analyzer for exact duplicates (planner contract)", async () => {
    const store = await makeStore();
    await seedRaw(store, [DEPLOY_A, DEPLOY_A, DEPLOY_B]); // exact pair + near pair
    const { spawnFn, calls } = fakeSpawn(() => mergeJson(DEPLOY_MERGE));
    const luna = createLunaAnalyzer({ spawnFn });

    const report = await runEvalDryRun({
      stores: [{ label: "memory", store, target: "memory" }],
      analyzer: luna,
      maxGroups: 10,
    });

    assert.equal(calls.length, 1, "only the near-duplicate group may reach the model");
    assert.ok(report.plan.actions.some((a) => a.rationale.includes("Exact duplicate")));
  });

  it("is read-only: store files and fingerprints are untouched by the dry run", async () => {
    const store = await makeStore();
    await seedRaw(store, [DEPLOY_A, DEPLOY_B]);
    const before = await fs.readFile(memoryPath, "utf-8");
    const { spawnFn } = fakeSpawn(() => mergeJson(DEPLOY_MERGE));
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
