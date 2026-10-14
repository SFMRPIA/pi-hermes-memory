/**
 * Luna-low full DRY-RUN evaluation over all candidate groups.
 *
 * Read-only: inventories + planCleanup + Luna decisions + planner validation.
 * NEVER applies actions, never starts maintenance, never syncs.
 *
 * Output:
 *   - stdout summary
 *   - full report: .superpowers/luna-dry-run-report.json
 *   - resume checkpoint: .superpowers/luna-dry-run-checkpoint.jsonl
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { loadConfig } from "../src/config.js";
import { AGENT_ROOT } from "../src/paths.js";
import { detectProject } from "../src/project.js";
import { MemoryStore } from "../src/store/memory-store.js";
import {
  createLunaAnalyzer,
  runEvalDryRun,
  type EvalStoreSpec,
} from "../src/handlers/memory-cleanup-eval.js";

const checkpointPath = path.resolve(".superpowers", "luna-dry-run-checkpoint.jsonl");
const reportPath = path.resolve(".superpowers", "luna-dry-run-report.json");

const config = loadConfig();
const globalDir = path.join(AGENT_ROOT, "pi-hermes-memory");
const globalStore = new MemoryStore({ ...config, memoryDir: globalDir });
await globalStore.loadFromDisk();

const project = detectProject(config.projectsMemoryDir);
const stores: EvalStoreSpec[] = [
  { label: "memory", store: globalStore, target: "memory" },
  { label: "user", store: globalStore, target: "user" },
  { label: "failure", store: globalStore, target: "failure" },
];
if (project.memoryDir) {
  const projectStore = new MemoryStore({
    ...config,
    memoryCharLimit: config.projectCharLimit,
    memoryDir: project.memoryDir,
  });
  await projectStore.loadFromDisk();
  stores.push({ label: "project", store: projectStore, target: "memory" });
}

console.log(`[eval] stores: ${stores.map((s) => s.label).join(", ")}`);
const luna = createLunaAnalyzer({ checkpointPath });

// Full pass: lift the planner's default budget (DEFAULT_MAX_GROUPS = 25) so
// every candidate group is analyzed. The checkpoint replays finished groups
// for free, so re-running after an interruption only bills the remainder.
const report = await runEvalDryRun({ stores, analyzer: luna, maxGroups: 100_000 });

const byKind: Record<string, number> = {};
for (const outcome of report.outcomes) {
  byKind[outcome.kind] = (byKind[outcome.kind] ?? 0) + 1;
}
const summary = {
  entriesScanned: report.plan.stats.entriesScanned,
  exactDuplicateGroups: report.plan.stats.exactDuplicateGroups,
  candidateGroups: report.plan.stats.candidateGroups,
  analyzedGroups: report.plan.stats.analyzedGroups,
  actionsValidated: report.plan.stats.actionsValidated,
  rejectedToReview: report.plan.stats.rejectedToReview,
  needsReview: report.plan.needsReview.length,
  outcomeKinds: byKind,
  snapshotStable: report.snapshotStable,
  snapshotChanged: report.snapshotChanged,
  elapsedMs: report.elapsedMs,
  checkpointPath,
};

await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify({ summary, report }, null, 2), "utf-8");

console.log(JSON.stringify(summary, null, 2));
console.log(`[eval] full report written to ${reportPath}`);
