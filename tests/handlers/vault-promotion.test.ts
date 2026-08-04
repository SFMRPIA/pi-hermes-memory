/**
 * Tests for vault-promotion — child JSON plan execution, safety guards,
 * and the threshold trigger.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, before, after, beforeEach } from "node:test";

import { MemoryStore } from "../../src/store/memory-store.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";
import { runVaultPromotion, setupVaultPromotion, mergeVaultContent } from "../../src/handlers/vault-promotion.js";

let MEMORY_DIR = "";
let VAULT = "";
let store: MemoryStore;

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
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
    consolidationTimeoutMs: 600000,
    vaultPromoteThreshold: 0.67,
    vaultDailyNotes: true,
    memoryDir: MEMORY_DIR,
    ...overrides,
  };
}

/** Fake pi.exec — returns canned child output. */
function fakePi(stdout: string, code = 0) {
  return {
    exec: async () => ({ code, stdout, stderr: code === 0 ? "" : "boom" }),
  } as any;
}

before(async () => {
  MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "vault-promo-mem-"));
  VAULT = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vault-promo-")), "Vault");
});

after(async () => {
  await fs.rm(MEMORY_DIR, { recursive: true, force: true });
  await fs.rm(VAULT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(MEMORY_DIR, { recursive: true, force: true });
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  store = new MemoryStore(makeConfig());
  await store.loadFromDisk();
});

describe("runVaultPromotion", () => {
  it("writes vault files then removes promoted entries", async () => {
    await store.add("memory", "Alpha stable fact about the environment");
    await store.add("memory", "Beta transient session detail");
    const entries = store.getMemoryEntries();
    const alpha = entries.find((e) => e.includes("Alpha stable fact"))!;

    const config = makeConfig({ vaultPath: VAULT });
    const plan = JSON.stringify({
      promote: [{ file: "System/Assistant/environment.md", content: "## Environment\n- Alpha stable fact\n" }],
      remove: [alpha],
    });

    const result = await runVaultPromotion(fakePi(plan), store, "memory", config);

    assert.equal(result.promoted, 1);
    assert.equal(result.removed, 1);
    const vaultContent = await fs.readFile(path.join(VAULT, "System/Assistant/environment.md"), "utf-8");
    assert.match(vaultContent, /Alpha stable fact/);
    const remaining = store.getMemoryEntries();
    assert.equal(remaining.some((e) => e.includes("Alpha stable fact")), false, "promoted entry removed from hot memory");
    assert.equal(remaining.some((e) => e.includes("Beta transient")), true, "unpromoted entry kept");
  });

  it("keeps everything when the child output is not JSON", async () => {
    await store.add("memory", "Alpha stable fact");
    const result = await runVaultPromotion(fakePi("not json at all"), store, "memory", makeConfig({ vaultPath: VAULT }));
    assert.equal(result.promoted, 0);
    assert.equal(result.removed, 0);
    assert.match(result.error ?? "", /not valid JSON/);
    assert.equal(store.getMemoryEntries().length, 1, "entries untouched");
  });

  it("keeps everything when the child exits non-zero", async () => {
    await store.add("memory", "Alpha stable fact");
    const result = await runVaultPromotion(fakePi("", 1), store, "memory", makeConfig({ vaultPath: VAULT }));
    assert.equal(result.removed, 0);
    assert.match(result.error ?? "", /exited 1/);
    assert.equal(store.getMemoryEntries().length, 1);
  });

  it("blocks path traversal in promoted file names", async () => {
    await store.add("memory", "Alpha stable fact");
    const entries = store.getMemoryEntries();
    const plan = JSON.stringify({
      promote: [
        { file: "../escape.md", content: "evil" },
        { file: "/abs/path.md", content: "evil" },
        { file: "System/Assistant/context.md", content: "## OK\n- fine\n" },
      ],
      remove: [entries[0]],
    });
    const result = await runVaultPromotion(fakePi(plan), store, "memory", makeConfig({ vaultPath: VAULT }));
    assert.equal(result.promoted, 1, "only the safe file was written");
    await assert.rejects(fs.access(path.join(path.dirname(VAULT), "escape.md")));
    await assert.rejects(fs.access("/abs/path.md"));
  });

  it("is a no-op without a configured vault", async () => {
    const result = await runVaultPromotion(fakePi("{}"), store, "memory", makeConfig());
    assert.equal(result.promoted, 0);
    assert.match(result.error ?? "", /not configured/);
  });
});

describe("setupVaultPromotion", () => {
  it("schedules a background promotion when a mutation crosses the threshold", async () => {
    let called = 0;
    const config = makeConfig({ vaultPath: VAULT, memoryCharLimit: 200 });
    const store2 = new MemoryStore(config);
    await store2.loadFromDisk();
    setupVaultPromotion(
      {
        exec: async () => {
          called++;
          return { code: 0, stdout: JSON.stringify({ promote: [], remove: [] }) };
        },
      } as any,
      store2,
      null,
      config,
    );

    // Fill past 67% of the 200-char limit.
    await store2.add("memory", "x".repeat(150));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(called, 1, "promotion child ran after threshold crossing");
    assert.equal(store2.getMemoryEntries().length, 1, "empty plan leaves entries alone");
  });

  it("does not schedule below the threshold", async () => {
    let called = 0;
    const config = makeConfig({ vaultPath: VAULT, memoryCharLimit: 2000 });
    const store2 = new MemoryStore(config);
    await store2.loadFromDisk();
    setupVaultPromotion(
      {
        exec: async () => {
          called++;
          return { code: 0, stdout: JSON.stringify({ promote: [], remove: [] }) };
        },
      } as any,
      store2,
      null,
      config,
    );

    await store2.add("memory", "small entry");
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(called, 0, "no promotion below the threshold");
  });
});

describe("mergeVaultContent", () => {
  it("replaces a section with the same normalized title", () => {
    const existing = "Intro line\n## Foo Bar\n- old fact\n- old detail\n## Baz\n- keep me\n";
    const updated = mergeVaultContent(existing, "## Foo Bar\n- new fact\n");
    assert.equal(updated, "Intro line\n## Foo Bar\n- new fact\n## Baz\n- keep me\n");
    assert.equal((updated.match(/## Foo Bar/g) ?? []).length, 1, "no duplicate section");
  });

  it("appends when the title does not exist yet", () => {
    const existing = "## Foo\n- fact\n";
    const updated = mergeVaultContent(existing, "## Bar\n- other\n");
    assert.equal(updated, "## Foo\n- fact\n\n## Bar\n- other\n");
    assert.equal((updated.match(/## Bar/g) ?? []).length, 1);
  });

  it("appends plain content without a header", () => {
    const existing = "## Foo\n- fact\n";
    const updated = mergeVaultContent(existing, "- bare bullet\n");
    assert.equal(updated, "## Foo\n- fact\n\n- bare bullet\n");
  });

  it("handles an empty existing file", () => {
    const updated = mergeVaultContent("", "## Foo\n- fact\n");
    assert.equal(updated, "## Foo\n- fact\n");
  });
});

describe("promotion dedupe end-to-end", () => {
  it("promoting the same topic twice keeps a single section", async () => {
    const config = makeConfig({ vaultPath: VAULT });
    await store.add("memory", "Alpha stable fact about the environment");
    const plan = JSON.stringify({
      promote: [{ file: "System/Assistant/context.md", content: "## Topic X\n- fact 1\n" }],
      remove: [],
    });

    const r1 = await runVaultPromotion(fakePi(plan), store, "memory", config);
    const r2 = await runVaultPromotion(fakePi(plan), store, "memory", config);

    assert.equal(r1.promoted, 1);
    assert.equal(r2.promoted, 1);
    const vaultContent = await fs.readFile(path.join(VAULT, "System/Assistant/context.md"), "utf-8");
    assert.equal((vaultContent.match(/## Topic X/g) ?? []).length, 1, "one section despite two promotions");
  });
});
