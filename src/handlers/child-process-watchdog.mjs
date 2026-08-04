import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Diagnostics go to the consolidation log file, not the terminal (the user
// wants the console clean; failures are greppable in the file).
const logFile = path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory", "logs", "consolidation.log");
function log(line) {
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${line}\n`);
  } catch {
    // Logging must never break the watchdog.
  }
}

const [timeoutValue, cancellationPath, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutValue);

if (!cancellationPath || !command || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  process.stderr.write("pi-hermes-memory watchdog: invalid invocation\n");
  process.exit(2);
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
});

const startedAt = Date.now();
log(`[hermes-memory] watchdog started pid=${child.pid ?? "?"} timeout=${timeoutMs}ms at ${new Date().toISOString()}`);

child.stdout?.pipe(process.stdout);
child.stderr?.pipe(process.stderr);

let timedOut = false;
let cancelled = false;
let terminating = false;
let forceTimer;

function signalTree(signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function terminateTree() {
  if (terminating) return;
  terminating = true;
  signalTree("SIGTERM");
  forceTimer = setTimeout(() => signalTree("SIGKILL"), 500);
  forceTimer.unref();
}

const timeout = setTimeout(() => {
  timedOut = true;
  log(`[hermes-memory] watchdog: child timed out after ${timeoutMs}ms (${Date.now() - startedAt}ms elapsed, pid=${child.pid ?? "?"}); terminating process tree`);
  terminateTree();
}, timeoutMs);
timeout.unref();

const cancellationPoll = cancellationPath === "-" ? undefined : setInterval(() => {
  if (!existsSync(cancellationPath)) return;
  cancelled = true;
  log("[pi-hermes-memory] child cancellation requested; terminating process tree");
  terminateTree();
}, 25);
cancellationPoll?.unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, terminateTree);
}

child.once("error", (error) => {
  clearTimeout(timeout);
  if (cancellationPoll) clearInterval(cancellationPoll);
  if (forceTimer) clearTimeout(forceTimer);
  process.stderr.write(`pi-hermes-memory watchdog: ${error.message}\n`);
  process.exitCode = timedOut ? 124 : cancelled ? 143 : 127;
});

child.once("close", (code, signal) => {
  clearTimeout(timeout);
  if (cancellationPoll) clearInterval(cancellationPoll);
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) {
    process.exitCode = 124;
  } else if (cancelled) {
    process.exitCode = 143;
  } else if (typeof code === "number") {
    process.exitCode = code;
  } else {
    process.exitCode = signal === "SIGTERM" ? 143 : 1;
  }
});
