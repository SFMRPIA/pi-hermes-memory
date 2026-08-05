/**
 * Vault aging — stale living-file sections move to System/Archive, never lost.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGING_FILES,
  splitVaultSections,
  serializeSection,
  runVaultAging,
} from "../../src/handlers/vault-aging.js";

let vault = "";

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "pi-vault-aging-"));
});

afterEach(async () => {
  await fs.rm(vault, { recursive: true, force: true });
});

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().split("T")[0];
}

describe("splitVaultSections", () => {
  it("parses sections and updated stamps, dropping the preamble", () => {
    const content = [
      "vault preamble",
      "## Active",
      "- fact",
      "<!-- updated=2026-08-01 -->",
      "## Older",
      "- stale",
      "<!-- updated=2025-01-01 -->",
    ].join("\n");

    const sections = splitVaultSections(content);
    assert.deepStrictEqual(sections.map((s) => s.title), ["Active", "Older"]);
    assert.strictEqual(sections[0].updated, "2026-08-01");
    assert.strictEqual(sections[1].updated, "2025-01-01");
  });

  it("leaves updated null for unstamped sections", () => {
    const sections = splitVaultSections("## Unmarked\n- fact\n");
    assert.strictEqual(sections[0].updated, null);
  });
});

describe("runVaultAging", () => {
  it("archives stale sections and keeps fresh and unmarked ones", async () => {
    const living = path.join(vault, "System", "Assistant", "context.md");
    await fs.mkdir(path.dirname(living), { recursive: true });
    await fs.writeFile(living, [
      `## Fresh Topic`,
      `- current`,
      `<!-- updated=${daysAgo(2)} -->`,
      "",
      `## Dead Topic`,
      `- old`,
      `<!-- updated=${daysAgo(300)} -->`,
      "",
      `## Unmarked Topic`,
      `- no stamp, no proof`,
    ].join("\n"), "utf-8");

    const result = await runVaultAging(vault, 90);

    assert.strictEqual(result.archived, 1);
    assert.match(result.files[0], /Dead Topic/);

    const rebuilt = await fs.readFile(living, "utf-8");
    assert.match(rebuilt, /Fresh Topic/);
    assert.match(rebuilt, /Unmarked Topic/);
    assert.doesNotMatch(rebuilt, /Dead Topic/);

    const archive = await fs.readFile(path.join(vault, "System", "Archive", "context.md"), "utf-8");
    assert.match(archive, /## Dead Topic/);
    assert.match(archive, /old/);
  });

  it("is idempotent — a second run archives nothing", async () => {
    const living = path.join(vault, "System", "Assistant", "environment.md");
    await fs.mkdir(path.dirname(living), { recursive: true });
    await fs.writeFile(living, `## Dead Topic\n- old\n<!-- updated=${daysAgo(300)} -->\n`, "utf-8");

    assert.strictEqual((await runVaultAging(vault, 90)).archived, 1);
    assert.strictEqual((await runVaultAging(vault, 90)).archived, 0);
  });

  it("does nothing for a vault without living files", async () => {
    assert.deepStrictEqual(await runVaultAging(vault, 90), { archived: 0, files: [] });
  });

  it("only ages the configured living files, never log timelines", () => {
    assert.ok(AGING_FILES.includes("System/Assistant/context.md"));
    assert.ok(AGING_FILES.includes("System/Assistant/preferences.md"));
    assert.ok(AGING_FILES.includes("System/Assistant/environment.md"));
    assert.ok(!AGING_FILES.some((f) => f.includes("issues-fixes-log")), "logs are append-only timelines");
  });

  it("serializeSection round-trips a section", () => {
    const section = { title: "T", body: "- fact\n<!-- updated=2026-01-01 -->", updated: "2026-01-01" };
    assert.strictEqual(serializeSection(section), "## T\n- fact\n<!-- updated=2026-01-01 -->\n");
  });
});
