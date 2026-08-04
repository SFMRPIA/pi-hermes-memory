/**
 * Consolidation diagnostics log — all `[hermes-memory]` stage lines are
 * appended to ~/.pi/agent/pi-hermes-memory/logs/consolidation.log instead of
 * the terminal (the user asked to keep the console clean; failures land in
 * the log file, greppable by the `[hermes-memory]` tag).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AGENT_ROOT } from "../paths.js";

const logFile = path.join(AGENT_ROOT, "pi-hermes-memory", "logs", "consolidation.log");

export function appendConsolidationLog(line: string): void {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    // Logging must never break consolidation.
  }
}
