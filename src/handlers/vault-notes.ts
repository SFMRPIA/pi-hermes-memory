/**
 * Vault notes — Obsidian-style long-term memory layer.
 *
 * The vault is a plain-markdown directory (config: vaultPath). It holds:
 *   Daily/YYYY-MM-DD.md          — append-only timeline (Tasks/Schedule/Log/Wins/Context)
 *   System/Assistant/            — stable reference living files
 *   System/Assistant/logs/       — issues & fixes log
 *   People/, Inbox/              — PKM structure
 *
 * No Obsidian installation is required — it is just files on disk.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface VaultResult {
  success: boolean;
  message?: string;
  error?: string;
}

/** True when a vault path is configured (non-empty string). */
export function vaultConfigured(vaultPath: string | undefined): vaultPath is string {
  return typeof vaultPath === "string" && vaultPath.trim().length > 0;
}

/** Local date in YYYY-MM-DD. */
export function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

const DAILY_TEMPLATE = (date: string): string => `---
date: ${date}
type: daily
tags: [daily]
---

## Tasks

## Schedule

## Log

## Wins

## Context

- People:
- Decisions:
- Files:
`;

/** Minimal scaffold files created once per vault. */
const SCAFFOLD: Record<string, string> = {
  "System/Assistant/context.md": "# Assistant — Context\n\n## Operations\n\n## Health\n\n## Family\n\n## Work Dependencies\n\n## Location & Timezone\n",
  "System/Assistant/preferences.md": "# Assistant — Preferences\n\n## Communication\n\n## Session Style\n",
  "System/Assistant/environment.md": "# Assistant — Environment & Technical Setup\n\n## Hardware\n\n## Services\n\n## Key Paths\n\n## Known Issues & Patterns\n",
  "System/Assistant/logs/issues-fixes-log.md": "# Issues & Fixes Log\n\nSymptom | Root Cause | Fix | Status\n--- | --- | --- | ---\n",
};

/** Create the vault directory structure + scaffold files (idempotent). */
export async function ensureVault(vaultPath: string): Promise<VaultResult> {
  try {
    await fs.mkdir(path.join(vaultPath, "Daily"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "System", "Assistant", "logs"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "People"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Inbox"), { recursive: true });
    for (const [rel, content] of Object.entries(SCAFFOLD)) {
      const abs = path.join(vaultPath, rel);
      try {
        await fs.access(abs);
      } catch {
        await fs.writeFile(abs, content, "utf-8");
      }
    }
    return { success: true, message: "Vault ready." };
  } catch (err) {
    return { success: false, error: `Vault setup failed: ${String(err)}` };
  }
}

/** Ensure today's daily note exists (idempotent). */
export async function ensureDailyNote(vaultPath: string): Promise<VaultResult> {
  const base = await ensureVault(vaultPath);
  if (!base.success) return base;

  const date = todayStr();
  const abs = path.join(vaultPath, "Daily", `${date}.md`);
  try {
    await fs.access(abs);
    return { success: true, message: `Daily note exists: Daily/${date}.md` };
  } catch {
    try {
      await fs.writeFile(abs, DAILY_TEMPLATE(date), "utf-8");
      return { success: true, message: `Daily note created: Daily/${date}.md` };
    } catch (err) {
      return { success: false, error: `Daily note failed: ${String(err)}` };
    }
  }
}

/**
 * Insert a line under a markdown section header: after the header line,
 * before the next "## " section or EOF.
 */
function insertUnderSection(markdown: string, section: string, line: string): string {
  const header = `## ${section}`;
  const idx = markdown.indexOf(header);
  if (idx === -1) {
    return markdown.replace(/\s*$/, "\n") + `\n${header}\n\n${line}\n`;
  }
  const afterHeader = markdown.indexOf("\n", idx);
  if (afterHeader === -1) return markdown + "\n" + line + "\n";
  const nextSection = markdown.indexOf("\n## ", afterHeader + 1);
  const insertAt = nextSection === -1 ? markdown.length : nextSection + 1;
  const prefix = markdown.slice(0, insertAt);
  const suffix = markdown.slice(insertAt);
  const sep = prefix.endsWith("\n") ? "" : "\n";
  return prefix + sep + line + "\n" + (suffix.startsWith("\n") ? "" : "\n") + suffix;
}

/**
 * Append an event to the vault.
 * - type=log (default) → today's Daily note, ## Log section
 * - type=win           → today's Daily note, ## Wins section
 * - type=fix           → System/Assistant/logs/issues-fixes-log.md
 */
export async function appendLogEntry(
  vaultPath: string,
  content: string,
  type: "log" | "win" | "fix" = "log",
): Promise<VaultResult> {
  if (!vaultConfigured(vaultPath)) return { success: false, error: "Vault not configured." };

  const cleaned = content.trim().replace(/\s+/g, " ");
  if (!cleaned) return { success: false, error: "Content cannot be empty." };

  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = todayStr();
  const line = `- ${time} -- ${cleaned}`;

  if (type === "fix") {
    const rel = "System/Assistant/logs/issues-fixes-log.md";
    const abs = path.join(vaultPath, rel);
    try {
      await ensureVault(vaultPath);
      const existing = await fs.readFile(abs, "utf-8").catch(() => "");
      await fs.writeFile(abs, existing.replace(/\s*$/, "\n") + `- ${date} ${time} -- ${cleaned}\n`, "utf-8");
      return { success: true, message: `Logged to ${rel}` };
    } catch (err) {
      return { success: false, error: `Fix log failed: ${String(err)}` };
    }
  }

  const daily = await ensureDailyNote(vaultPath);
  if (!daily.success) return daily;

  const section = type === "win" ? "Wins" : "Log";
  const abs = path.join(vaultPath, "Daily", `${date}.md`);
  try {
    const existing = await fs.readFile(abs, "utf-8");
    await fs.writeFile(abs, insertUnderSection(existing, section, line), "utf-8");
    return { success: true, message: `Logged to Daily/${date}.md ## ${section}` };
  } catch (err) {
    return { success: false, error: `Daily note append failed: ${String(err)}` };
  }
}
