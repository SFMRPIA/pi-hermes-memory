// Tests for the knowledge-preserving cleanup planner (Task 4).
// The analyzer is always a fake — no LLM is ever invoked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planCleanup,
  type InventoryInput,
  type GroupAnalyzer,
  type GroupDecision,
} from "../../src/handlers/memory-cleanup-plan.js";
import type { StoreInventoryEntry } from "../../src/store/memory-store.js";

function entry(text: string, opts: Partial<StoreInventoryEntry> = {}): StoreInventoryEntry {
  const index = opts.index ?? 0;
  return {
    index,
    raw: `${text} <!-- created=2026-10-01, last=${opts.lastReferenced ?? "2026-10-01"} -->`,
    text,
    created: "2026-10-01",
    lastReferenced: opts.lastReferenced ?? "2026-10-01",
    project: opts.project ?? null,
    hash: `hash-${index}-${text.length}-${opts.project ?? ""}`,
  };
}

function inv(store: InventoryInput["store"], entries: StoreInventoryEntry[], fingerprint = "fp"): InventoryInput {
  return { store, entries: entries.map((e, i) => ({ ...e, index: e.index ?? i })), fingerprint };
}

const NO_ANALYZER: GroupAnalyzer | null = null;

function fakeAnalyzer(decisions: Array<GroupDecision | null | Error>): {
  analyzer: GroupAnalyzer;
  readonly calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    analyzer: async () => {
      const d = decisions[calls];
      calls++;
      if (d instanceof Error) throw d;
      return d ?? null;
    },
  };
}

// Lexically-close reworded pair (Jaccard over significant tokens ≈ 0.62).
const PAIR_A = "Consolidation runs at most once per cooldown window per store.";
const PAIR_B = "Consolidation runs one time per cooldown window for every store.";

describe("planCleanup — no candidates", () => {
  it("returns a no-op plan without calling the analyzer", async () => {
    const h = fakeAnalyzer([new Error("must not be called")]);
    const plan = await planCleanup(
      [
        inv("memory", [
          entry("Use pnpm for the pi-hermes-memory workspace installs.", { index: 0 }),
          entry("Fahmi prefers concise answers with file paths.", { index: 1 }),
        ]),
      ],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.needsReview.length, 0);
    assert.equal(h.calls, 0);
    assert.equal(plan.stats.entriesScanned, 2);
  });

  it("handles an empty store", async () => {
    const plan = await planCleanup([inv("memory", [])], { analyze: NO_ANALYZER });
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.stats.entriesScanned, 0);
  });
});

describe("planCleanup — exact duplicates", () => {
  it("merges byte-identical entries deterministically, keeping the newest, no analyzer call", async () => {
    const h = fakeAnalyzer([new Error("must not be called")]);
    const text = "Always run npm run build after editing vue files.";
    const plan = await planCleanup(
      [
        inv("memory", [
          entry(text, { index: 0, lastReferenced: "2026-10-01" }),
          entry(text, { index: 1, lastReferenced: "2026-10-10" }),
          entry(text, { index: 2, lastReferenced: "2026-10-05" }),
        ]),
      ],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 1);
    const action = plan.actions[0];
    assert.equal(action.type, "merge");
    assert.equal(action.keep.index, 1); // newest lastReferenced
    assert.deepEqual(action.remove.map((r) => r.index), [2, 0]); // recency desc
    assert.equal(action.replacement, text);
    assert.equal(h.calls, 0, "exact dups must not consume analysis budget");
  });

  it("never merges identical texts from different project scopes", async () => {
    const plan = await planCleanup(
      [
        inv("failure", [
          entry("Migration failed: column users.email missing.", { index: 0, project: "mynews" }),
          entry("Migration failed: column users.email missing.", { index: 1, project: "otherapp" }),
        ]),
      ],
      { analyze: NO_ANALYZER },
    );
    assert.equal(plan.actions.length, 0);
  });

  it("never merges identical texts across stores", async () => {
    const text = "The consolidation child needs a strict JSON response contract.";
    const plan = await planCleanup(
      [inv("memory", [entry(text, { index: 0 })]), inv("user", [entry(text, { index: 0 })])],
      { analyze: NO_ANALYZER },
    );
    assert.equal(plan.actions.length, 0);
  });
});

describe("planCleanup — near-duplicate semantic analysis", () => {
  it("routes same-scope similar entries to the analyzer and applies a validated merge", async () => {
    const replacement = `${PAIR_A}, one time for every store.`;
    const h = fakeAnalyzer([{ action: "merge", replacement }]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(h.calls, 1);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "merge");
    assert.equal(plan.stats.analyzedGroups, 1);
    assert.equal(plan.needsReview.length, 0);
  });

  it("rejects a merge whose replacement drops a hard fact", async () => {
    const A = "The upload limit is set to 64 megabytes for php ini on this machine.";
    const B = "The upload limit for the php ini config on this machine is 64 megabytes.";
    const h = fakeAnalyzer([
      { action: "merge", replacement: "The upload limit for the php ini config on this machine is generous." },
    ]);
    const plan = await planCleanup([inv("memory", [entry(A, { index: 0 }), entry(B, { index: 1 })])], {
      analyze: h.analyzer,
    });
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.needsReview.length, 1);
    assert.match(plan.needsReview[0].reason, /hard fact "64"/);
  });

  it("rejects a merge whose replacement loses a member's content", async () => {
    const h = fakeAnalyzer([{ action: "merge", replacement: PAIR_A }]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /loses content/);
  });

  it("rejects a merge introducing unsupported new facts", async () => {
    const h = fakeAnalyzer([
      {
        action: "merge",
        replacement:
          "Consolidation runs at most once per cooldown window per store, one time for every store, and the vault compactor rewrites tombstone indexes nightly.",
      },
    ]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /unsupported facts/);
  });

  it("applies a supersede backed by an explicit correction cue and recency", async () => {
    const OLD = "Deploy uses npm run build for production output today.";
    const NEW = "Deploy no longer uses npm run build; vite build is used for production output today.";
    const h = fakeAnalyzer([{ action: "supersede", keepIndex: 1, rationale: "explicit no-longer correction" }]);
    const plan = await planCleanup(
      [
        inv("memory", [
          entry(OLD, { index: 0, lastReferenced: "2026-09-01" }),
          entry(NEW, { index: 1, lastReferenced: "2026-10-10" }),
        ]),
      ],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 1);
    const action = plan.actions[0];
    assert.equal(action.type, "supersede");
    assert.equal(action.keep.index, 1);
    assert.deepEqual(action.remove.map((r) => r.index), [0]);
    assert.equal(action.replacement, NEW);
  });

  it("downgrades timestamp-only supersession (no cue) to needs-review", async () => {
    const NEW = `${PAIR_A} as of the new policy today.`;
    const h = fakeAnalyzer([{ action: "supersede", keepIndex: 1 }]);
    const plan = await planCleanup(
      [
        inv("memory", [
          entry(PAIR_A, { index: 0, lastReferenced: "2026-09-01" }),
          entry(NEW, { index: 1, lastReferenced: "2026-10-10" }),
        ]),
      ],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /not correction evidence/);
  });

  it("treats a hypothetical upgrade ('might') as a proposal, not supersession", async () => {
    const OLD = "The memory store backend uses markdown files and the sqlite mirror.";
    const NEW = "The memory store backend uses markdown files and might upgrade the sqlite mirror someday.";
    const h = fakeAnalyzer([{ action: "supersede", keepIndex: 1 }]);
    const plan = await planCleanup([inv("memory", [entry(OLD, { index: 0 }), entry(NEW, { index: 1 })])], {
      analyze: h.analyzer,
    });
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.needsReview.length, 1);
  });

  it("blocks supersession when the survivor drops a victim hard fact", async () => {
    const OLD = "The upload limit is set to 64 megabytes for php ini on this machine.";
    const NEW = "The upload limit was corrected for php ini on this machine — fewer megabytes now.";
    const h = fakeAnalyzer([{ action: "supersede", keepIndex: 1 }]);
    const plan = await planCleanup(
      [
        inv("memory", [
          entry(OLD, { index: 0, lastReferenced: "2026-09-01" }),
          entry(NEW, { index: 1, lastReferenced: "2026-10-10" }),
        ]),
      ],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /conflicting details/);
  });

  it("does not let an older entry act as the surviving correction (recency guard)", async () => {
    const NEWER = "Config uses vite build output now instead of the old pipeline.";
    const OLDER = "Config was corrected to use the vite build output pipeline instead.";
    const h = fakeAnalyzer([{ action: "supersede", keepIndex: 1 }]);
    const plan = await planCleanup(
      [
        inv("memory", [
          entry(NEWER, { index: 0, lastReferenced: "2026-10-10" }),
          entry(OLDER, { index: 1, lastReferenced: "2026-09-01" }),
        ]),
      ],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /older than victim/);
  });
});

describe("planCleanup — analyzer robustness", () => {
  it("treats a throwing analyzer as no decision", async () => {
    const h = fakeAnalyzer([new Error("llm exploded")]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /no usable decision/);
  });

  it("treats garbage actions as no decision", async () => {
    const h = fakeAnalyzer([{ action: "delete-everything" } as unknown as GroupDecision]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /Unknown action/);
  });

  it("treats an empty replacement as no decision", async () => {
    const h = fakeAnalyzer([{ action: "merge", replacement: "   " }]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /empty replacement/);
  });

  it("rejects a supersede that does not identify a survivor", async () => {
    const h = fakeAnalyzer([{ action: "supersede", keepIndex: 9 }]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /surviving member/);
  });
});

describe("MemoryStore.readInventory / storeFingerprint", () => {
  it("decodes entries with hashes and changes fingerprint after writes", async () => {
    const { MemoryStore } = await import("../../src/store/memory-store.js");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-inv-"));
    const config = {
      memoryMode: "legacy-inject" as const,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      projectCharLimit: 5000,
      nudgeInterval: 10,
      reviewEnabled: false,
      flushOnCompact: false,
      flushOnShutdown: false,
      flushMinTurns: 6,
      autoConsolidate: false,
      correctionDetection: false,
      failureInjectionEnabled: false,
      failureInjectionMaxAgeDays: 7,
      failureInjectionMaxEntries: 5,
      nudgeToolCalls: 15,
      memoryDir: dir,
    };
    const store = new MemoryStore(config);
    await store.add("memory", "Inventory entry one for cleanup planning.");
    await store.add("user", "Fahmi runs the housekeeping from the vault directory.");

    const invMem = await store.readInventory("memory");
    assert.equal(invMem.length, 1);
    assert.equal(invMem[0].index, 0);
    assert.match(invMem[0].text, /Inventory entry one/);
    assert.equal(invMem[0].project, null);
    assert.match(invMem[0].created, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(invMem[0].hash, /^[0-9a-f]{64}$/);

    const fpBefore = await store.storeFingerprint("memory");
    assert.match(fpBefore, /^[0-9a-f]{64}$/);
    await store.add("memory", "Inventory entry two changes the fingerprint.");
    const fpAfter = await store.storeFingerprint("memory");
    assert.notEqual(fpBefore, fpAfter);

    // Cleanup: best-effort (Windows may hold handles briefly).
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

describe("planCleanup — bounds and grouping", () => {
  it("never groups entries across scopes or stores", async () => {
    const h = fakeAnalyzer([new Error("must not be called")]);
    const text1 = "The deploy pipeline runs through the build queue every morning.";
    const text2 = "The deploy pipeline passes through the build queue each morning.";
    const plan = await planCleanup(
      [
        inv("memory", [entry(text1, { index: 0 })]),
        inv("user", [entry(text2, { index: 0 })]),
        inv("failure", [entry(text1, { index: 3, project: "a" }), entry(text2, { index: 4, project: "b" })]),
      ],
      { analyze: h.analyzer },
    );
    assert.equal(h.calls, 0);
    assert.equal(plan.actions.length, 0);
  });

  it("respects the analysis budget and reports overflow groups", async () => {
    const entries: StoreInventoryEntry[] = [];
    const groupPairs: Array<[string, string]> = [
      [
        "Group alpha: the deploy pipeline runs through the build queue every morning.",
        "Group alpha: each morning the deploy pipeline passes through the build queue.",
      ],
      [
        "The memory consolidation writes snapshots during the cooldown interval.",
        "During the cooldown interval the memory consolidation writes its snapshots.",
      ],
      [
        "The vault promotion copies entries into daily notes at midnight.",
        "At midnight the vault promotion copies its entries into the daily notes.",
      ],
    ];
    let idx = 0;
    for (const [base, reword] of groupPairs) {
      entries.push(entry(base, { index: idx++ }));
      entries.push(entry(reword, { index: idx++ }));
    }
    let calls = 0;
    const plan = await planCleanup([inv("memory", entries)], {
      analyze: async () => {
        calls++;
        return { action: "merge", replacement: PAIR_A };
      },
      maxGroups: 2,
    });
    assert.equal(calls, 2, "budget caps analyzer calls");
    assert.equal(plan.stats.candidateGroups, 3);
    const overflow = plan.needsReview.filter((r) => r.reason.includes("budget"));
    assert.equal(overflow.length, 1);
  });

  it("reports candidate groups when no analyzer is configured", async () => {
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: NO_ANALYZER },
    );
    assert.equal(plan.actions.length, 0, "no analyzer: near-dups are never mutated");
    assert.equal(plan.needsReview.length, 1);
    assert.match(plan.needsReview[0].reason, /no analyzer is configured/);
  });

  it("records fingerprints for every inventory", async () => {
    const plan = await planCleanup(
      [inv("memory", [], "fp-mem"), inv("user", [], "fp-user")],
      { analyze: NO_ANALYZER },
    );
    assert.equal(plan.fingerprints.memory, "fp-mem");
    assert.equal(plan.fingerprints.user, "fp-user");
  });
});
