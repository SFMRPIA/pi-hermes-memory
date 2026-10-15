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
const PAIR_A = "Each deployed release creates one reference file from the documentation command.";
const PAIR_B = "For every release that is deployed, the documentation command produces a single reference file.";

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
    assert.equal(action.type, "deduplicate");
    assert.equal(action.keep.index, 1); // newest lastReferenced
    assert.deepEqual(action.remove.map((r) => r.index), [2, 0]); // recency desc
    assert.equal("replacement" in action, false, "dedup must retain existing text, not generate a rewrite");
    assert.equal(h.calls, 0, "exact dups must not consume analysis budget");
  });

  it("ignores only embedded bookkeeping timestamps when finding exact duplicate facts", async () => {
    const fact = "The nightly index job rebuilds every search vector after each release tag.";
    const older = `${fact} <!-- created=2026-09-01, last=2026-09-03 -->`;
    const repeated = `${fact} <!-- created=2026-09-02, last=2026-09-04 --> <!-- created=2026-09-02, last=2026-09-04 -->`;
    const h = fakeAnalyzer([new Error("metadata-only duplicates must not call the analyzer")]);
    const plan = await planCleanup([inv("memory", [
      entry(older, { index: 0, lastReferenced: "2026-09-03" }),
      entry(repeated, { index: 1, lastReferenced: "2026-09-04" }),
    ])], { analyze: h.analyzer });
    assert.equal(plan.stats.exactDuplicateGroups, 1);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].keep.index, 1);
    assert.equal(h.calls, 0);
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

describe("planCleanup — semantic deduplication", () => {
  it("keeps the selected existing entry verbatim and removes only covered entries", async () => {
    const h = fakeAnalyzer([{ action: "deduplicate", keepIndex: 1, removeIndices: [0], rationale: "B contains A" }]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(h.calls, 1);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].type, "deduplicate");
    assert.equal(plan.actions[0].keep.index, 1);
    assert.deepEqual(plan.actions[0].remove.map((r) => r.index), [0]);
    assert.equal("replacement" in plan.actions[0], false);
    assert.equal(plan.actions[0].keep.hash, entry(PAIR_B, { index: 1 }).hash);
    assert.equal(plan.needsReview.length, 0);
  });

  it("records keep-both decisions as complete, not unresolved review", async () => {
    const h = fakeAnalyzer([{ action: "keep_both", rationale: "distinct facts" }]);
    const plan = await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer },
    );
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.needsReview.length, 0);
    assert.equal(plan.stats.analyzedGroups, 1);
  });

  it("rejects removal when a hard fact is absent from the keeper", async () => {
    const A = "The upload limit is set to 64 megabytes for php ini on this machine.";
    const B = "The upload limit for the php ini config on this machine is 32 megabytes.";
    const h = fakeAnalyzer([{ action: "deduplicate", keepIndex: 1, removeIndices: [0] }]);
    const plan = await planCleanup([inv("memory", [entry(A, { index: 0 }), entry(B, { index: 1 })])], {
      analyze: h.analyzer,
    });
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /hard fact/);
  });

  it("rejects removal when negation or conditions differ", async () => {
    const A = "The service never stores private values during scheduled retries.";
    const B = "The service always stores private values during scheduled retries.";
    const h = fakeAnalyzer([{ action: "deduplicate", keepIndex: 1, removeIndices: [0] }]);
    const plan = await planCleanup([inv("memory", [entry(A, { index: 0 }), entry(B, { index: 1 })])], {
      analyze: h.analyzer,
    });
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /qualifiers differ/);
  });

  it("does not deduplicate entries that name different projects in their text", async () => {
    const A = "In project Alpha, category filters may be single-select on all product pages.";
    const B = "In project Beta, category filters may be single-select on all product pages.";
    const h = fakeAnalyzer([{ action: "deduplicate", keepIndex: 1, removeIndices: [0] }]);
    const plan = await planCleanup([inv("memory", [entry(A, { index: 0 }), entry(B, { index: 1 })])], {
      analyze: h.analyzer,
    });
    assert.equal(plan.actions.length, 0);
    assert.match(plan.needsReview[0].reason, /qualifiers differ/);
  });

  it("does not auto-delete punctuation-normalized but nonidentical text", async () => {
    const A = "In project A, category filters may be single-select on all product pages.";
    const B = "In project A, category filters may be single-select on all product pages!";
    const h = fakeAnalyzer([{ action: "keep_both" }]);
    const plan = await planCleanup([inv("memory", [entry(A, { index: 0 }), entry(B, { index: 1 })])], {
      analyze: h.analyzer,
    });
    assert.equal(h.calls, 1);
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.needsReview.length, 0);
  });

  it("rejects invalid, duplicate, or keeper-overlapping member indices", async () => {
    for (const removeIndices of [[0, 0], [1], [9], []]) {
      const h = fakeAnalyzer([{ action: "deduplicate", keepIndex: 1, removeIndices }]);
      const plan = await planCleanup(
        [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
        { analyze: h.analyzer },
      );
      assert.equal(plan.actions.length, 0, JSON.stringify(removeIndices));
      assert.equal(plan.needsReview.length, 1);
    }
  });

  it("keeps candidate IDs stable when indexes and metadata dates change", async () => {
    const collect = async (entries: StoreInventoryEntry[]) => {
      const ids: string[] = [];
      const analyzer: GroupAnalyzer = async (group) => {
        ids.push(group.id);
        return { action: "keep_both" };
      };
      await planCleanup([inv("memory", entries)], { analyze: analyzer });
      return ids;
    };
    const first = await collect([entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })]);
    const second = await collect([
      entry(PAIR_A, { index: 7, lastReferenced: "2026-10-14" }),
      entry(PAIR_B, { index: 9, lastReferenced: "2026-10-15" }),
    ]);
    assert.deepEqual(second, first);
  });
});

describe("planCleanup — progress", () => {
  it("reports the completed analyzer group count without progress for zero candidates", async () => {
    const progress: Array<[number, number]> = [];
    const h = fakeAnalyzer([{ action: "keep_both" }]);
    await planCleanup(
      [inv("memory", [entry(PAIR_A, { index: 0 }), entry(PAIR_B, { index: 1 })])],
      { analyze: h.analyzer, onProgress: (completed, total) => progress.push([completed, total]) },
    );
    assert.deepEqual(progress, [[0, 1], [1, 1]]);

    const none: Array<[number, number]> = [];
    await planCleanup([inv("memory", [])], { onProgress: (completed, total) => none.push([completed, total]) });
    assert.deepEqual(none, []);
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

  it("rejects deduplication that does not identify a keeper", async () => {
    const h = fakeAnalyzer([{ action: "deduplicate", keepIndex: 9, removeIndices: [0] }]);
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
        return { action: "keep_both" };
      },
      maxGroups: 2,
    });
    assert.equal(calls, 2, "budget caps analyzer calls");
    assert.equal(plan.stats.candidateGroups, 3);
    const overflow = plan.needsReview.filter((r) => r.reason.includes("budget"));
    assert.equal(overflow.length, 1);
  });

  it("processes cached groups without spending the fresh-analysis budget", async () => {
    const pairs: Array<[string, string]> = [
      ["Deploy workflow runs npm build and ships package after every release tag.", "Every release tag triggers the deploy workflow to build npm and ship the package."],
      ["Database backup writes a postgres dump nightly to the encrypted bucket.", "The encrypted bucket receives a nightly postgres database backup dump."],
      ["Index worker rebuilds search vectors weekly under the maintenance lease.", "Weekly search vectors are rebuilt by the index worker under the maintenance lease."],
    ];
    const cachedIds = new Set<string>();
    let freshCalls = 0;
    const analyzer: GroupAnalyzer = async (group) => {
      if (!cachedIds.has(group.id)) freshCalls++;
      return { action: "keep_both" };
    };
    analyzer.isCached = async (group) => cachedIds.has(group.id);
    analyzer.recordValidatedDecision = async (group) => { cachedIds.add(group.id); };
    const makeEntries = (groupIndexes: number[], start: number) => groupIndexes.flatMap((groupIndex, i) => {
      const [a, b] = pairs[groupIndex];
      return [
        entry(a, { index: start + i * 2, lastReferenced: "2026-10-01" }),
        entry(b, { index: start + i * 2 + 1, lastReferenced: "2026-10-01" }),
      ];
    });

    const first = await planCleanup([inv("memory", makeEntries([0, 1], 0))], { analyze: analyzer, maxGroups: 2 });
    assert.equal(first.stats.freshGroupsAnalyzed, 2);
    const refreshedEntries = makeEntries([0, 1], 20).reverse().concat(makeEntries([2], 30));
    const second = await planCleanup([inv("memory", refreshedEntries)], { analyze: analyzer, maxGroups: 1 });
    assert.equal(second.stats.cachedGroups, 2);
    assert.equal(second.stats.freshGroupsAnalyzed, 1);
    assert.equal(freshCalls, 3, "only the newly changed group should consume fresh analysis");
    assert.equal(second.needsReview.length, 0);
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
