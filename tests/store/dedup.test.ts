/**
 * Focused tests for conservative deduplication:
 *  - exact repeats are ignored at add time
 *  - similar entries remain until cleanup can establish redundancy
 *  - dedupeTarget removes exact repeats but not token-overlap candidates
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../src/store/memory-store.js";
import { ENTRY_DELIMITER, MEMORY_FILE } from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

let DIR = "";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
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
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: DIR,
    ...overrides,
  };
}

const meta = (d: string) => `<!-- created=${d}, last=${d} -->`;

describe("deterministic dedup", () => {
  beforeEach(async () => {
    DIR = path.join(os.tmpdir(), `dedup-test-${randomUUID()}`);
    await fs.mkdir(DIR, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true });
  });

  it("add() preserves a near-duplicate candidate instead of choosing by token overlap", async () => {
    const store = new MemoryStore(makeConfig());
    const a = "The production build uses 24 workers and enables nightly database replication.";
    const b = "The production build uses 48 workers and enables nightly database replication.";
    await store.add("memory", a);
    await store.add("memory", b);
    const entries = await store.readInventory("memory");
    assert.deepEqual(entries.map((entry) => entry.text), [a, b]);
  });

  it("add() still ignores an exact repeat", async () => {
    const store = new MemoryStore(makeConfig());
    const text = "Fahmi prefers dedicated per-platform service classes.";
    await store.add("memory", text);
    await store.add("memory", text);
    const entries = await store.readInventory("memory");
    assert.deepEqual(entries.map((entry) => entry.text), [text]);
  });

  it("add() still appends genuinely distinct entries", async () => {
    const store = new MemoryStore(makeConfig());
    await store.add("memory", "Fahmi prefers dedicated per-platform service classes over sharing.");
    await store.add("memory", "The Intel Arc A770 freezes the whole pc with gemma models.");
    assert.ok(store.getMemoryEntries().length === 2, "distinct entries must both be kept");
  });

  it("dedupeTarget() removes exact repeats but preserves punctuation-different candidates", async () => {
    const file = path.join(DIR, MEMORY_FILE);
    const t = "2026-08-17";
    const text = "Fahmi never stores ssh keys or hostnames in memory; access is fresh per session.";
    const e1 = text + meta(t);
    const exactRepeat = text + meta("2026-08-18");
    const candidate = "Fahmi never stores ssh keys or hostnames in memory — access is fresh per session." + meta(t);
    await fs.writeFile(file, [e1, exactRepeat, candidate].join(ENTRY_DELIMITER));
    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();
    const removed = await store.dedupeTarget("memory");
    assert.equal(removed, 1, "only the exact same fact text should be removed");
    const entries = await store.readInventory("memory");
    assert.deepEqual(entries.map((entry) => entry.text), [text, "Fahmi never stores ssh keys or hostnames in memory — access is fresh per session."]);
  });
});