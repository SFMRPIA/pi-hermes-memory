/**
 * Vault aging — archive stale living-file sections so System/Assistant stays
 * bounded.
 *
 * Living files (context.md / preferences.md / environment.md) grow without
 * limit as promotion keeps adding and refreshing sections. A section stamped
 * with `<!-- updated=YYYY-MM-DD -->` by mergeVaultContent is provably stale
 * once its stamp is older than vaultRetentionDays (default 90); aging moves
 * such sections to System/Archive/<same-file>.md — non-destructive, so nothing
 * is ever lost, only demoted out of the always-loaded living files.
 *
 * Sections WITHOUT a stamp are never archived: staleness must be provable,
 * and pre-stamp sections predate this feature. logs/issues-fixes-log.md is
 * excluded by design — it is an append-only timeline, not a living reference.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { vaultConfigured, todayStr, appendLogEntry } from "./vault-notes.js";

/** Living reference files that aging manages. Log timelines are excluded. */
export const AGING_FILES = [
  "System/Assistant/context.md",
  "System/Assistant/preferences.md",
  "System/Assistant/environment.md",
];

export interface VaultSection {
  title: string;
  body: string;
  /** `<!-- updated=YYYY-MM-DD -->` stamp inside the section, if any. */
  updated: string | null;
}

export interface VaultAgingResult {
  archived: number;
  files: string[];
}

/** Split a living file into `## ` sections; the preamble before the first `## ` is dropped. */
export function splitVaultSections(content: string): VaultSection[] {
  const sections: VaultSection[] = [];
  let current: { title: string; body: string[] } | null = null;
  for (const line of content.split("\n")) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (current) sections.push(toSection(current));
      current = { title: m[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(toSection(current));
  return sections;
}

function toSection(current: { title: string; body: string[] }): VaultSection {
  return { title: current.title, body: current.body.join("\n"), updated: extractUpdated(current.body) };
}

function extractUpdated(body: string[]): string | null {
  for (const line of body) {
    const m = line.match(/<!--\s*updated=(\d{4}-\d{2}-\d{2})\s*-->/);
    if (m) return m[1];
  }
  return null;
}

export function serializeSection(section: VaultSection): string {
  return `## ${section.title}\n${section.body.trimEnd()}\n`;
}

function daysSince(dateStr: string, today: string): number {
  const d = Date.parse(`${dateStr}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.floor((t - d) / 86400000));
}

export async function runVaultAging(vaultPath: string, retentionDays: number): Promise<VaultAgingResult> {
  if (!vaultConfigured(vaultPath) || retentionDays <= 0) return { archived: 0, files: [] };

  const archiveDir = path.join(vaultPath, "System", "Archive");
  const today = todayStr();
  const archived: string[] = [];
  let archivedCount = 0;

  for (const rel of AGING_FILES) {
    const abs = path.join(vaultPath, rel);
    let content: string;
    try {
      content = await fs.readFile(abs, "utf-8");
    } catch {
      continue; // file does not exist yet — nothing to age
    }

    const sections = splitVaultSections(content);
    const staleTitles = new Set(
      sections
        .filter((s) => s.updated !== null && daysSince(s.updated, today) > retentionDays)
        .map((s) => s.title),
    );
    if (staleTitles.size === 0) continue;

    const kept = sections.filter((s) => !staleTitles.has(s.title));
    const stale = sections.filter((s) => staleTitles.has(s.title));

    await fs.mkdir(archiveDir, { recursive: true });
    const archiveAbs = path.join(archiveDir, path.basename(abs));
    const archiveExisting = await fs.readFile(archiveAbs, "utf-8").catch(() => "");
    const append = stale.map(serializeSection).join("\n");
    await fs.writeFile(archiveAbs, archiveExisting.trimEnd() ? `${archiveExisting.trimEnd()}\n\n${append}` : append, "utf-8");

    const rebuilt = kept.map(serializeSection).join("\n");
    await fs.writeFile(abs, rebuilt.trimEnd() ? `${rebuilt.trimEnd()}\n` : "", "utf-8");

    archivedCount += stale.length;
    archived.push(...stale.map((s) => `${path.basename(rel)}: ${s.title}`));
  }

  if (archivedCount > 0) {
    try {
      await appendLogEntry(
        vaultPath,
        `Archived ${archivedCount} stale vault section(s) older than ${retentionDays} days: ${archived.join("; ")}.`,
        "log",
      );
    } catch {
      // A failed log entry must not fail the aging itself.
    }
  }

  return { archived: archivedCount, files: archived };
}
