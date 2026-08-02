/**
 * vault_search tool — search the Obsidian-style memory vault for context
 * promoted out of hot memory. Plain recursive markdown scan, no dependencies.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryConfig } from "../types.js";
import { vaultConfigured } from "../handlers/vault-notes.js";

const MAX_RESULTS = 50;
const SKIP_DIRS = new Set([".git", ".obsidian", ".trash"]);

async function walk(root: string, rel: string, files: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(root, rel));
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry}` : entry;
    const abs = path.join(root, childRel);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry) && !entry.startsWith(".")) await walk(root, childRel, files);
    } else if (st.isFile() && entry.endsWith(".md")) {
      files.push(childRel);
    }
  }
}

export function registerVaultSearchTool(pi: ExtensionAPI, config: MemoryConfig): void {
  pi.registerTool({
    name: "vault_search",
    label: "Vault Search",
    description: `Search the Obsidian-style memory vault (plain markdown at vaultPath) for long-term context that was promoted out of hot memory. Case-insensitive substring search across all .md files, with an optional vault-relative path filter.`,
    promptSnippet: "Search the memory vault",
    parameters: Type.Object({
      query: Type.String({ description: "Text to search for (case-insensitive)." }),
      path: Type.Optional(Type.String({ description: "Optional vault-relative path filter, e.g. System/Assistant or Daily." })),
    }),
    async execute(
      _toolCallId: string,
      params: { query: string; path?: string },
      _signal: AbortSignal,
      _onUpdate: (update: unknown) => void,
      _ctx: unknown,
    ) {
      if (!vaultConfigured(config.vaultPath)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "Vault not configured. Set vaultPath in hermes-memory-config.json." }) }],
          details: {},
          isError: true,
        };
      }
      const root = config.vaultPath!;
      const q = params.query.toLowerCase().trim();
      if (!q) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "Query cannot be empty." }) }],
          details: {},
          isError: true,
        };
      }

      const files: string[] = [];
      await walk(root, (params.path ?? "").trim(), files);

      const hits: Array<{ file: string; line: number; text: string }> = [];
      for (const file of files) {
        if (hits.length >= MAX_RESULTS) break;
        let source: string;
        try {
          source = await fs.readFile(path.join(root, file), "utf-8");
        } catch {
          continue;
        }
        const lines = source.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < MAX_RESULTS; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            hits.push({ file, line: i + 1, text: lines[i].trim().slice(0, 160) });
          }
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, count: hits.length, results: hits }) }],
        details: {},
      };
    },
  });
}
