/**
 * Lean extension entry for consolidation/review subprocess children.
 *
 * The full src/index.ts boot — skills, vault, session backfill, migration
 * checks, correction/review/promotion/flush handlers, commands — is pure
 * overhead for a child whose only job is: load the stores, expose the memory
 * tool, let the LLM apply remove/replace ops. Trimming it cuts child startup
 * from seconds to milliseconds, which matters at thinking=off where the LLM
 * pass itself is short.
 *
 * The SQLite mirror is still maintained (DatabaseManager + the memory tool's
 * mutation observer), so memory_search stays consistent after child writes.
 */
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { AGENT_ROOT } from "./paths.js";
import { MemoryStore } from "./store/memory-store.js";
import { DatabaseManager } from "./store/db.js";
import { detectProject } from "./project.js";
import { registerMemoryTool } from "./tools/memory-tool.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  // Same global-dir resolution as src/index.ts: a configured memoryDir wins,
  // and the legacy "memory/" alias resolves to the default pi-hermes-memory
  // dir so the child never writes to a different store than the parent.
  const legacyGlobalDir = path.join(AGENT_ROOT, "memory");
  const defaultGlobalDir = path.join(AGENT_ROOT, "pi-hermes-memory");
  const configuredMemoryDir = config.memoryDir?.trim();
  const globalDir = !configuredMemoryDir || path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
    ? defaultGlobalDir
    : configuredMemoryDir;

  const store = new MemoryStore({ ...config, memoryDir: globalDir });
  const project = detectProject(config.projectsMemoryDir);
  const projectName = project.name ?? "";
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir ? new MemoryStore(projectConfig) : null;
  const dbManager = new DatabaseManager(globalDir);

  // Load both stores from disk before the child's LLM turn starts. The
  // session_start hook fires before before_agent_start, same as index.ts.
  pi.on("session_start", async () => {
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();
  });

  registerMemoryTool(pi, store, projectStore, dbManager, projectName);
}
