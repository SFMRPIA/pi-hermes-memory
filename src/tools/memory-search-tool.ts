import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats } from '../store/sqlite-memory-store.js';
import type { MemoryCategory, MemoryConfig } from '../types.js';
import { vaultConfigured } from "../handlers/vault-notes.js";

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

export function registerMemorySearchTool(pi: ExtensionAPI, dbManager: DatabaseManager, recencyWeight = 0.4, config?: MemoryConfig): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

Returns matching memory entries with project context and dates.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name. Pass null for global memories only.' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure'] as const, { description: 'Filter by target type (memory, user, or failure).' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; target?: string; category?: string; limit?: number }) => {
      const query = args.query;
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const limit = Math.min(args.limit || 10, 20);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use the memory tool with add action to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const results = searchMemories(dbManager, query, { project, target, category, limit, recencyWeight });

      if (results.length === 0) {
        // Hot had no hit — fall back warm → cold so squeezed history stays
        // auto-discoverable. Warm (System/Assistant + Daily) is recent promoted
        // context; cold (System/Archive) is 90-day aged — warm outranks cold.
        if (config && vaultConfigured(config.vaultPath)) {
          try {
            const cap = Math.min(limit, 10);
            const warmHits: Array<{ file: string; line: number; text: string }> = [];
            warmHits.push(...await searchVault(config.vaultPath!, query, cap, "System/Assistant"));
            if (warmHits.length < cap) {
              warmHits.push(...await searchVault(config.vaultPath!, query, cap - warmHits.length, "Daily"));
            }
            let vaultHits = warmHits;
            let tier: "warm" | "cold" = "warm";
            if (vaultHits.length === 0) {
              vaultHits = await searchVault(config.vaultPath!, query, cap, "System/Archive");
              tier = "cold";
            }
            if (vaultHits.length > 0) {
              let vaultOutput = `No hot memories matched "${query}" — found ${vaultHits.length} ${tier} vault hit(s):\n\n`;
              for (const h of vaultHits) vaultOutput += `📁 ${h.file}:${h.line} — ${h.text}\n`;
              const vr: SearchResult = { success: true, count: vaultHits.length, output: vaultOutput.trim() };
              return { content: [{ type: 'text' as const, text: vaultOutput.trim() }], details: vr };
            }
          } catch {}
        }
        const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}" (hot + warm + cold). Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let output = `Found ${results.length} memories matching "${query}":\n\n`;

      for (const entry of results) {
        const projectLabel = entry.project ? `[${entry.project}]` : '[global]';
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        output += `${targetLabel} ${projectLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: results.length, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}

async function searchVault(vaultPath: string, query: string, limit: number, subPath = ""): Promise<Array<{ file: string; line: number; text: string }>> {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const files: string[] = [];
  const SKIP = new Set([".git", ".obsidian", ".trash"]);
  async function walk(root: string, rel: string) {
    let entries: string[];
    try { entries = await fs.readdir(path.join(root, rel)); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e}` : e;
      const abs = path.join(root, childRel);
      let st; try { st = await fs.stat(abs); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP.has(e) && !e.startsWith(".")) await walk(root, childRel); }
      else if (st.isFile() && e.endsWith(".md")) files.push(childRel);
    }
  }
  await walk(vaultPath, subPath);
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    if (hits.length >= limit) break;
    let src: string; try { src = await fs.readFile(path.join(vaultPath, file), "utf-8"); } catch { continue; }
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (lines[i].toLowerCase().includes(q)) hits.push({ file, line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }
  return hits;
}
