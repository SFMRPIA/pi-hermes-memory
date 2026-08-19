/**
 * Focused tests for the deterministic near-duplicate dedup:
 *  - add() merges a reworded near-duplicate instead of appending
 *  - dedupeTarget() collapses storm-style duplicates across a store
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

  it("add() merges a reworded near-duplicate instead of appending", async () => {
    const store = new MemoryStore(makeConfig());
    const a = "Fahmi prefers dedicated per-platform service classes over sharing; every platform gets its own service.";
    const b = "Fahmi prefers dedicated per-platform service classes — each platform gets its own service class.";
    await store.add("memory", a);
    await store.add("memory", b);
    const entries = store.getMemoryEntries();
    assert.ok(entries.length === 1, `expected 1 entry after merge, got ${entries.length}`);
    assert.ok(entries[0].length >= a.length, `kept entry should be >= longer input (${entries[0].length} < ${a.length})`);
  });

  it("add() still appends genuinely distinct entries", async () => {
    const store = new MemoryStore(makeConfig());
    await store.add("memory", "Fahmi prefers dedicated per-platform service classes over sharing.");
    await store.add("memory", "The Intel Arc A770 freezes the whole pc with gemma models.");
    assert.ok(store.getMemoryEntries().length === 2, "distinct entries must both be kept");
  });

  it("dedupeTarget() collapses near-identical and reworded duplicates", async () => {
    const file = path.join(DIR, MEMORY_FILE);
    const t = "2026-08-17";
    const e1 = "Fahmi never stores ssh keys or hostnames in memory; access is fresh per session." + meta(t);
    const e2 = "Fahmi never stores ssh keys or hostnames in memory — access is fresh per session." + meta(t);
    const e3 = "Qwen family runs clean on intel arc a770; gemma freezes the pc." + meta(t);
    await fs.writeFile(file, [e1, e2, e3].join(ENTRY_DELIMITER));
    const store = new MemoryStore(makeConfig());
    await store.loadFromDisk();
    assert.ok(store.getMemoryEntries().length === 3, `seeded 3 entries, got ${store.getMemoryEntries().length}`);
    const removed = await store.dedupeTarget("memory");
    assert.ok(removed === 1, `expected 1 removed, got ${removed}`);
    assert.ok(store.getMemoryEntries().length === 2, `expected 2 after dedupe, got ${store.getMemoryEntries().length}`);
  });
});