/**
 * vault_log tool — append an event to the Obsidian-style memory vault.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { MemoryConfig } from "../types.js";
import { vaultConfigured, ensureDailyNote, appendLogEntry } from "../handlers/vault-notes.js";

export function registerVaultLogTool(pi: ExtensionAPI, config: MemoryConfig): void {
  pi.registerTool({
    name: "vault_log",
    label: "Vault Log",
    description: `Append an event to the Obsidian-style long-term memory vault (plain markdown at vaultPath — no Obsidian required).

Routing:
- type=log (default) → Daily/YYYY-MM-DD.md ## Log section
- type=win           → Daily/YYYY-MM-DD.md ## Wins section
- type=fix           → System/Assistant/logs/issues-fixes-log.md

Use for operational events, decisions, fixes, and wins that should survive in the searchable vault timeline.`,
    promptSnippet: "Log an event to the memory vault",
    parameters: Type.Object({
      content: Type.String({ description: "What happened — one concise line." }),
      type: Type.Optional(StringEnum(["log", "win", "fix"] as const, { description: "log (default), win, or fix." })),
    }),
    async execute(
      _toolCallId: string,
      params: { content: string; type?: "log" | "win" | "fix" },
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
      await ensureDailyNote(config.vaultPath!);
      const result = await appendLogEntry(config.vaultPath!, params.content, params.type ?? "log");
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: {},
        isError: !result.success,
      };
    },
  });
}
