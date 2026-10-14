// Manual cleanup ↔ sync coordination (Task 3 of the memory-cleanup plan).
//
// Primitives for the cleanup flow to coordinate with the scheduled
// PiHermesMemorySyncDaily task and the sync-memory.ps1 gate:
//   - getSyncTaskState(): inspect the task (exists? enabled?)
//   - disableSyncTask(): record the original state, then disable future runs
//   - restoreSyncTask(): restore the RECORDED original state (never assumes
//     "enabled"), reporting failure so the caller can flag recovery-required
//   - isSyncRunning() / waitForSyncIdle(): wait for an already-running sync
//   - runAuthorizedSync(): one owner-authorized baseline/apply/verify stage
//     permitted by the sync-memory.ps1 maintenance gate
//
// The PowerShell side of this contract lives in sync-memory.ps1
// (Test-MaintenanceGate + -AuthorizedOwnerToken/-AuthorizedSyncStage). All
// process invocation is injected so tests never touch the real scheduler or spawn PowerShell.
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { AGENT_ROOT } from "../paths.js";

const execFile = promisify(execFileCb);

export const SYNC_SCRIPT_PATH = join(AGENT_ROOT, "scripts", "sync-memory.ps1");
const POWERSHELL = "powershell.exe";
const SYNC_TASK_NAME = "PiHermesMemorySyncDaily";

export type SyncTaskOriginalState = "enabled" | "disabled" | "missing" | "unknown";
export type AuthorizedSyncStage = "baseline" | "apply" | "verify";

export interface SyncTaskState {
  exists: boolean;
  enabled: boolean;
  rawState: string;
}

export type SyncTaskResult =
  | { ok: true; originalState: SyncTaskOriginalState }
  | { ok: false; reason: "missing" | "inspect-failed" | "disable-failed" | "enable-failed"; detail: string };

export interface RestoreResult {
  ok: boolean;
  action: "enabled" | "none";
  note?: string;
}

export interface AuthorizedSyncResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface MaintenanceSyncDeps {
  run?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  sleep?: (ms: number) => Promise<void>;
  scriptPath?: string;
}

export function createMaintenanceSync(deps: MaintenanceSyncDeps = {}) {
  const run =
    deps.run ??
    ((args: string[]) => execFile(POWERSHELL, args));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const scriptPath = deps.scriptPath ?? SYNC_SCRIPT_PATH;

  function psCommand(script: string): string[] {
    return ["-NoProfile", "-NonInteractive", "-Command", script];
  }

  async function getSyncTaskState(): Promise<SyncTaskState | { exists: false } | { ok: false; reason: "inspect-failed"; detail: string }> {
    const script = `$t = Get-ScheduledTask -TaskName '${SYNC_TASK_NAME}' -ErrorAction Stop; $t.State`;
    try {
      const { stdout } = await run(psCommand(script));
      const rawState = stdout.trim();
      return { exists: true, enabled: rawState !== "Disabled", rawState };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string };
      const detail = error instanceof Error ? `${error.message} ${String(err.stderr ?? "")}` : String(error);
      if (/no MSFT|cannot find|not find|does not exist/i.test(detail)) {
        return { exists: false };
      }
      return { ok: false, reason: "inspect-failed", detail };
    }
  }

  async function disableSyncTask(): Promise<SyncTaskResult> {
    const before = await getSyncTaskState();
    if (!("exists" in before) || !before.exists) {
      if ("ok" in before && before.ok === false) {
        return { ok: false, reason: "inspect-failed", detail: before.detail };
      }
      return { ok: true, originalState: "missing" };
    }
    const originalState: SyncTaskOriginalState = before.enabled ? "enabled" : "disabled";
    const script = `Disable-ScheduledTask -TaskName '${SYNC_TASK_NAME}' | Out-Null`;
    try {
      await run(psCommand(script));
      return { ok: true, originalState };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: "disable-failed", detail };
    }
  }

  async function restoreSyncTask(originalState: SyncTaskOriginalState): Promise<RestoreResult> {
    if (originalState !== "enabled") {
      return {
        ok: true,
        action: "none",
        note: `recorded original state "${originalState}"; task left untouched`,
      };
    }
    const script = `Enable-ScheduledTask -TaskName '${SYNC_TASK_NAME}' | Out-Null`;
    try {
      await run(psCommand(script));
      return { ok: true, action: "enabled" };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, action: "none", note: `failed to re-enable ${SYNC_TASK_NAME}: ${detail}` };
    }
  }

  async function isSyncRunning(): Promise<boolean> {
    // The pattern is assembled at runtime so this query process's own command
    // line (which contains 'sync' + '-memory\.ps1' as separate literals)
    // cannot match itself.
    const script =
      "(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | " +
      "Where-Object { $_.CommandLine -match ('sync' + '-memory\\.ps1') } | " +
      "Measure-Object).Count";
    try {
      const { stdout } = await run(psCommand(script));
      return Number.parseInt(stdout.trim(), 10) > 0;
    } catch {
      // Cannot inspect: assume idle. The gate in the script is the real
      // protection; this is only a courtesy wait.
      return false;
    }
  }

  async function waitForSyncIdle(timeoutMs: number, pollMs = 1000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await isSyncRunning())) return true;
      if (Date.now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  async function runAuthorizedSync(ownerToken: string, stage: AuthorizedSyncStage): Promise<AuthorizedSyncResult> {
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-AuthorizedOwnerToken",
      ownerToken,
      "-AuthorizedSyncStage",
      stage,
    ];
    try {
      const { stdout, stderr } = await run(args);
      return { ok: true, exitCode: 0, stdout, stderr };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const code = err.code !== undefined && /^\d+$/.test(String(err.code)) ? Number(err.code) : null;
      return {
        ok: false,
        exitCode: code,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? err.message ?? ""),
      };
    }
  }

  return { getSyncTaskState, disableSyncTask, restoreSyncTask, isSyncRunning, waitForSyncIdle, runAuthorizedSync };
}

export type MaintenanceSync = ReturnType<typeof createMaintenanceSync>;
