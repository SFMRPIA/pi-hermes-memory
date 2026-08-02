/**
 * Tests for vault-notes — daily notes, log routing, scaffolding.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import {
  ensureVault,
  ensureDailyNote,
  appendLogEntry,
  vaultConfigured,
} from "../../src/handlers/vault-notes.js";

let VAULT = "";

before(async () => {
  VAULT = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vault-notes-")), "Vault");
});

after(async () => {
  await fs.rm(VAULT, { recursive: true, force: true });
});

describe("vaultConfigured", () => {
  it("accepts non-empty strings and rejects empty/undefined", () => {
    assert.equal(vaultConfigured("D:\\Vault"), true);
    assert.equal(vaultConfigured(""), false);
    assert.equal(vaultConfigured(undefined), false);
    assert.equal(vaultConfigured("   "), false);
  });
});

describe("ensureVault", () => {
  it("creates the structure and scaffold files idempotently", async () => {
    const first = await ensureVault(VAULT);
    assert.equal(first.success, true);
    const second = await ensureVault(VAULT);
    assert.equal(second.success, true);

    for (const rel of [
      "Daily",
      "System/Assistant/logs",
      "People",
      "Inbox",
      "System/Assistant/context.md",
      "System/Assistant/logs/issues-fixes-log.md",
    ]) {
      await fs.access(path.join(VAULT, rel));
    }
  });
});

describe("ensureDailyNote", () => {
  it("creates today's note with frontmatter, then is a no-op", async () => {
    const date = new Date().toISOString().split("T")[0];
    const first = await ensureDailyNote(VAULT);
    assert.equal(first.success, true);
    const content = await fs.readFile(path.join(VAULT, "Daily", `${date}.md`), "utf-8");
    assert.match(content, /^---\ndate: /);
    assert.match(content, /## Log/);
    assert.match(content, /## Wins/);

    const second = await ensureDailyNote(VAULT);
    assert.equal(second.success, true);
    assert.match(second.message ?? "", /exists/);
  });
});

describe("appendLogEntry", () => {
  it("appends log entries to today's ## Log section", async () => {
    const result = await appendLogEntry(VAULT, "Decided to use the vault pipeline");
    assert.equal(result.success, true);
    const date = new Date().toISOString().split("T")[0];
    const content = await fs.readFile(path.join(VAULT, "Daily", `${date}.md`), "utf-8");
    assert.match(content, /## Log\n\n- \d{1,2}:\d{2}( [ap]m)? -- Decided to use the vault pipeline/);
  });

  it("appends win entries to ## Wins", async () => {
    const result = await appendLogEntry(VAULT, "Fixed the timeout error", "win");
    assert.equal(result.success, true);
    const date = new Date().toISOString().split("T")[0];
    const content = await fs.readFile(path.join(VAULT, "Daily", `${date}.md`), "utf-8");
    assert.match(content, /## Wins\n\n- \d{1,2}:\d{2}( [ap]m)? -- Fixed the timeout error/);
  });

  it("appends fix entries to the issues-fixes log", async () => {
    const result = await appendLogEntry(VAULT, "Consolidation timeout — async overflow path", "fix");
    assert.equal(result.success, true);
    const content = await fs.readFile(
      path.join(VAULT, "System/Assistant/logs/issues-fixes-log.md"),
      "utf-8",
    );
    assert.match(content, /- \d{4}-\d{2}-\d{2} \d{1,2}:\d{2}( [ap]m)? -- Consolidation timeout/);
  });

  it("rejects empty content", async () => {
    const result = await appendLogEntry(VAULT, "   ");
    assert.equal(result.success, false);
  });
});
