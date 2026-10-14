import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AGENT_ROOT } from "../paths.js";
import { AtomicLockCoordinator } from "./atomic-lock-coordinator.js";

/**
 * Maintenance coordinator — shared pause/drain/resume state for manual memory
 * cleanup (see docs/superpowers/plans/2026-10-14-manual-memory-cleanup.md, Task 1).
 *
 * One JSON document (`maintenance-state.json`) holds both halves of the protocol:
 *   { version: 1, maintenance: MaintenanceState | null, jobs: MaintenanceJob[] }
 * - `maintenance` is non-null only while a cleanup run owns the stores (or while
 *   an interrupted run waits in `recovery-required`).
 * - `jobs` records admitted background jobs (review, consolidation, promotion,
 *   flush, correction) so `beginMaintenance` can wait for them to settle before
 *   mutating content. Registration is bookkeeping only — the hard write gate is
 *   `isWriteAdmitted`, checked by memory-store inside the per-file mutation lock.
 *
 * All mutations run under a dedicated SQLite gate lock (`staleMs: 0` — takeover
 * by liveness proof only, never by elapsed time) so check-then-write stays
 * atomic across processes on this machine. This is local-machine coordination:
 * it makes no claim about the other PC (Task 3 handles sync-side gating).
 */

export type MaintenancePhase = "quiescing" | "cleaning" | "verifying" | "recovery-required";

export interface MaintenanceOwner {
  pid: number;
  token: string;
  startedAt: string;
}

export interface MaintenanceJob {
  id: string;
  kind: string;
  pid: number;
  registeredAt: string;
}

export interface MaintenanceOriginalState {
  syncTaskEnabled: boolean | null;
  syncTaskKnown: boolean;
  capturedAt: string;
}

export interface MaintenanceState {
  version: 1;
  phase: MaintenancePhase;
  owner: MaintenanceOwner;
  scopes: string[];
  originalState: MaintenanceOriginalState | null;
  backupDir: string | null;
  progress: { step: string; updatedAt: string } | null;
  recoveryReason: string | null;
  updatedAt: string;
}

interface MaintenanceDoc {
  version: 1;
  maintenance: MaintenanceState | null;
  jobs: MaintenanceJob[];
}

export type BeginResult =
  | { ok: true; state: MaintenanceState }
  | { ok: false; reason: "already-active" | "recovery-required" | "corrupt" | "gate-timeout"; detail?: string };

export type UpdateResult =
  | { ok: true; state: MaintenanceState }
  | { ok: false; reason: "not-owner" | "no-maintenance" | "corrupt" | "recovery-required" | "gate-timeout"; detail?: string };

export type JobRegistration =
  | { ok: true; id: string }
  | { ok: false; reason: "maintenance-active" | "recovery-required" | "gate-timeout"; detail?: string };

export type EndResult =
  | { ok: true; restored: MaintenanceState }
  | { ok: false; reason: "not-owner" | "no-maintenance" | "corrupt" | "jobs-outstanding" | "gate-timeout"; detail?: string };

export type RecoveryFlagResult =
  | { ok: true; state: MaintenanceState }
  | { ok: false; reason: "not-owner" | "no-maintenance" | "corrupt" | "gate-timeout"; detail?: string };

export type WriteAdmission =
  | { admitted: true }
  | { admitted: false; reason: "maintenance-active" | "recovery-required"; phase: MaintenancePhase };

const STATE_FILE_NAME = "maintenance-state.json";
const GATE_KEY = "maintenance-gate";
const GATE_WAIT_MS = 5000;
const GATE_POLL_MS = 25;
const WRITE_RETRIES = 3;

export function maintenanceStateDir(): string {
  const override = process.env.PI_HERMES_MAINTENANCE_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(AGENT_ROOT, "pi-hermes-memory");
}

export function maintenanceStatePath(): string {
  return path.join(maintenanceStateDir(), STATE_FILE_NAME);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type DocRead =
  | { kind: "ok"; doc: MaintenanceDoc }
  | { kind: "missing" }
  | { kind: "corrupt"; raw: string };

function readDoc(): DocRead {
  const statePath = maintenanceStatePath();
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as MaintenanceDoc;
    if (
      parsed === null
      || typeof parsed !== "object"
      || parsed.version !== 1
      || typeof parsed.jobs !== "object"
      || !Array.isArray(parsed.jobs)
    ) {
      return { kind: "corrupt", raw };
    }
    if (parsed.maintenance === null) return { kind: "ok", doc: parsed };
    if (
      typeof parsed.maintenance !== "object"
      || typeof parsed.maintenance.owner?.token !== "string"
      || typeof parsed.maintenance.phase !== "string"
    ) {
      return { kind: "corrupt", raw };
    }
    return { kind: "ok", doc: parsed };
  } catch {
    return { kind: "corrupt", raw };
  }
}

function emptyDoc(): MaintenanceDoc {
  return { version: 1, maintenance: null, jobs: [] };
}

function writeDoc(doc: MaintenanceDoc): void {
  const statePath = maintenanceStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2));
  for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
    try {
      fs.renameSync(tmpPath, statePath);
      return;
    } catch (error) {
      if (attempt === WRITE_RETRIES - 1) {
        try { fs.rmSync(tmpPath, { force: true }); } catch {}
        throw error;
      }
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class GateTimeoutError extends Error {
  constructor() {
    super(`maintenance gate busy for ${GATE_WAIT_MS}ms`);
  }
}

async function withGate<T>(fn: () => T | Promise<T>): Promise<T> {
  const coordinator = AtomicLockCoordinator.shared(
    path.join(maintenanceStateDir(), "maintenance-gate.sqlite"),
  );
  const deadline = Date.now() + GATE_WAIT_MS;
  for (;;) {
    const lease = coordinator.tryAcquire(GATE_KEY, { staleMs: 0 });
    if (lease) {
      try {
        return await fn();
      } finally {
        lease.release();
      }
    }
    if (Date.now() >= deadline) throw new GateTimeoutError();
    await delay(GATE_POLL_MS);
  }
}

function gateFailure(): { ok: false; reason: "gate-timeout"; detail: string } {
  return { ok: false, reason: "gate-timeout", detail: `maintenance gate busy for ${GATE_WAIT_MS}ms` };
}

export async function readMaintenanceState(): Promise<MaintenanceState | null> {
  const read = readDoc();
  return read.kind === "ok" ? read.doc.maintenance : null;
}

export async function readMaintenanceStateDetailed(): Promise<{
  exists: boolean;
  corrupt: boolean;
  state: MaintenanceState | null;
}> {
  const read = readDoc();
  if (read.kind === "missing") return { exists: false, corrupt: false, state: null };
  if (read.kind === "corrupt") return { exists: true, corrupt: true, state: null };
  return { exists: true, corrupt: false, state: read.doc.maintenance };
}

export async function isMaintenanceActive(): Promise<boolean> {
  const state = await readMaintenanceState();
  return state !== null && state.phase !== "recovery-required";
}

export async function isWriteAdmitted(ownerToken?: string): Promise<WriteAdmission> {
  const read = readDoc();
  if (read.kind !== "ok" || read.doc.maintenance === null) return { admitted: true };
  const maintenance = read.doc.maintenance;
  if (maintenance.phase === "recovery-required") {
    return { admitted: false, reason: "recovery-required", phase: maintenance.phase };
  }
  if (ownerToken && ownerToken === maintenance.owner.token) return { admitted: true };
  return { admitted: false, reason: "maintenance-active", phase: maintenance.phase };
}

export async function beginMaintenance(input: { scopes: string[] }): Promise<BeginResult> {
  try {
    return await withGate(async () => {
      const read = readDoc();
      if (read.kind === "corrupt") {
        return { ok: false as const, reason: "corrupt" as const, detail: "maintenance-state.json is unreadable; recovery required" };
      }
      const existing = read.kind === "ok" ? read.doc.maintenance : null;
      if (existing) {
        return existing.phase === "recovery-required"
          ? { ok: false as const, reason: "recovery-required" as const, detail: "an interrupted cleanup must be resolved via recovery first" }
          : { ok: false as const, reason: "already-active" as const, detail: `owner pid ${existing.owner.pid} since ${existing.owner.startedAt}` };
      }
      const now = new Date().toISOString();
      if (sealAcquirer) {
        // Hold every per-target markdown mutation lock (nested, fixed order)
        // while publishing the marker: in-flight writers drain first, and any
        // writer that starts later sees maintenance inside its own lock
        // (runTargetMutation checks isWriteAdmitted there). No check-then-write race.
        await sealAcquirer();
      }
      const doc: MaintenanceDoc = read.kind === "ok"
        ? { ...read.doc, jobs: [...read.doc.jobs] }
        : emptyDoc();
      const state: MaintenanceState = {
        version: 1,
        phase: "quiescing",
        owner: { pid: process.pid, token: randomUUID(), startedAt: now },
        scopes: [...input.scopes],
        originalState: null,
        backupDir: null,
        progress: null,
        recoveryReason: null,
        updatedAt: now,
      };
      writeDoc({ ...doc, maintenance: state });
      return { ok: true as const, state };
    });
  } catch (error) {
    if (error instanceof GateTimeoutError) return gateFailure();
    throw error;
  }
}

export interface MaintenanceUpdate {
  phase?: MaintenancePhase;
  scopes?: string[];
  originalState?: MaintenanceOriginalState;
  backupDir?: string | null;
  progress?: { step: string } | null;
  recoveryReason?: string | null;
}

export const MAINTENANCE_DEFERRED_MESSAGE =
  "Memory maintenance (cleanup) is in progress; this write was deferred. Retry after /memory-cleanup finishes.";

/**
 * Seal hook: memory-store registers a callback that acquires ALL per-target
 * markdown mutation locks (nested, fixed order memory→user→failure). Cleanup
 * writes still pass isWriteAdmitted() as the owner.
 */
type SealAcquirer = () => Promise<void>;
let sealAcquirer: SealAcquirer | null = null;

export function registerSealAcquirer(fn: SealAcquirer): void {
  sealAcquirer = fn;
}

export async function updateMaintenance(ownerToken: string, patch: MaintenanceUpdate): Promise<UpdateResult> {
  try {
    return await withGate(() => {
      const read = readDoc();
      if (read.kind === "corrupt") {
        return { ok: false as const, reason: "corrupt" as const, detail: "maintenance-state.json is unreadable; recovery required" };
      }
      if (read.kind === "missing") return { ok: false as const, reason: "no-maintenance" as const };
      const maintenance = read.doc.maintenance;
      if (!maintenance) return { ok: false as const, reason: "no-maintenance" as const };
      if (maintenance.owner.token !== ownerToken) {
        return { ok: false as const, reason: "not-owner" as const };
      }
      if (maintenance.phase === "recovery-required") {
        return { ok: false as const, reason: "recovery-required" as const, detail: "resolve recovery before updating the run" };
      }
      const now = new Date().toISOString();
      const next: MaintenanceState = {
        ...maintenance,
        phase: patch.phase ?? maintenance.phase,
        scopes: patch.scopes ? [...patch.scopes] : maintenance.scopes,
        originalState: patch.originalState !== undefined ? patch.originalState : maintenance.originalState,
        backupDir: patch.backupDir !== undefined ? patch.backupDir : maintenance.backupDir,
        progress: patch.progress === undefined ? maintenance.progress : patch.progress === null ? null : { step: patch.progress.step, updatedAt: now },
        recoveryReason: patch.recoveryReason !== undefined ? patch.recoveryReason : maintenance.recoveryReason,
        updatedAt: now,
      };
      writeDoc({ ...read.doc, maintenance: next });
      return { ok: true as const, state: next };
    });
  } catch (error) {
    if (error instanceof GateTimeoutError) return gateFailure();
    throw error;
  }
}

export async function registerJob(kind: string, opts: { ownerToken?: string } = {}): Promise<JobRegistration> {
  try {
    return await withGate(() => {
      const read = readDoc();
      const doc: MaintenanceDoc = read.kind === "ok" ? { ...read.doc, jobs: [...read.doc.jobs] } : emptyDoc();
      const maintenance = doc.maintenance;
      if (maintenance) {
        if (maintenance.phase === "recovery-required") {
          return { ok: false as const, reason: "recovery-required" as const };
        }
        if (!opts.ownerToken || opts.ownerToken !== maintenance.owner.token) {
          return { ok: false as const, reason: "maintenance-active" as const };
        }
      }
      const job: MaintenanceJob = {
        id: randomUUID(),
        kind,
        pid: process.pid,
        registeredAt: new Date().toISOString(),
      };
      doc.jobs.push(job);
      writeDoc(doc);
      return { ok: true as const, id: job.id };
    });
  } catch (error) {
    if (error instanceof GateTimeoutError) {
      return { ok: false, reason: "gate-timeout", detail: `maintenance gate busy for ${GATE_WAIT_MS}ms` };
    }
    throw error;
  }
}

export async function unregisterJob(id: string): Promise<void> {
  try {
    await withGate(() => {
      const read = readDoc();
      if (read.kind !== "ok") return;
      const remaining = read.doc.jobs.filter((job) => job.id !== id);
      if (remaining.length === read.doc.jobs.length) return;
      writeDoc({ ...read.doc, jobs: remaining });
    });
  } catch {
    // Best-effort bookkeeping: the hard write gate is isWriteAdmitted, so a
    // failed unregister only makes drain waits longer, never unsafer.
  }
}

/**
 * Remove job registrations whose owning process is dead (killed run, crashed
 * pi). Best-effort: only succeeds under the gate. A job with pid === this
 * process counts as alive (concurrent async work in THIS process).
 */
export async function pruneDeadJobs(): Promise<number> {
  try {
    return await withGate(() => {
      const read = readDoc();
      if (read.kind !== "ok" || read.doc.jobs.length === 0) return 0;
      const remaining = read.doc.jobs.filter((job) => job.pid === process.pid || processIsAlive(job.pid));
      if (remaining.length === read.doc.jobs.length) return 0;
      const removed = read.doc.jobs.length - remaining.length;
      writeDoc({ ...read.doc, jobs: remaining });
      return removed;
    });
  } catch {
    return 0;
  }
}

export async function waitForJobsToDrain(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const read = readDoc();
    if (read.kind !== "ok" || read.doc.jobs.length === 0) return true;
    // Dead-owner jobs would spin the drain forever — prune them each poll.
    await pruneDeadJobs();
    const reread = readDoc();
    if (reread.kind !== "ok" || reread.doc.jobs.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await delay(GATE_POLL_MS);
  }
}

export async function endMaintenance(
  ownerToken: string,
  opts: { force?: boolean } = {},
): Promise<EndResult> {
  try {
    return await withGate(() => {
      const read = readDoc();
      if (read.kind === "corrupt") {
        return { ok: false as const, reason: "corrupt" as const, detail: "maintenance-state.json is unreadable; recovery required" };
      }
      if (read.kind === "missing") return { ok: false as const, reason: "no-maintenance" as const };
      const maintenance = read.doc.maintenance;
      if (!maintenance) return { ok: false as const, reason: "no-maintenance" as const };
      if (maintenance.owner.token !== ownerToken) {
        return { ok: false as const, reason: "not-owner" as const };
      }
      if (read.doc.jobs.length > 0 && !opts.force) {
        return {
          ok: false as const,
          reason: "jobs-outstanding" as const,
          detail: `${read.doc.jobs.length} job(s) still registered; drain them or pass force`,
        };
      }
      writeDoc({ ...read.doc, maintenance: null, jobs: [] });
      return { ok: true as const, restored: maintenance };
    });
  } catch (error) {
    if (error instanceof GateTimeoutError) return gateFailure();
    throw error;
  }
}

export async function flagRecoveryRequired(
  reason: string,
  opts: { ownerToken?: string } = {},
): Promise<RecoveryFlagResult> {
  try {
    return await withGate(() => {
      const read = readDoc();
      if (read.kind === "corrupt") {
        return { ok: false as const, reason: "corrupt" as const, detail: "maintenance-state.json is unreadable; inspect and repair manually" };
      }
      if (read.kind === "missing") return { ok: false as const, reason: "no-maintenance" as const };
      const maintenance = read.doc.maintenance;
      if (!maintenance) return { ok: false as const, reason: "no-maintenance" as const };
      if (maintenance.phase === "recovery-required") {
        return { ok: true as const, state: maintenance };
      }
      const isOwner = opts.ownerToken === maintenance.owner.token;
      if (!isOwner && processIsAlive(maintenance.owner.pid)) {
        return { ok: false as const, reason: "not-owner" as const, detail: `owner pid ${maintenance.owner.pid} is alive` };
      }
      const now = new Date().toISOString();
      const next: MaintenanceState = {
        ...maintenance,
        phase: "recovery-required",
        recoveryReason: reason,
        updatedAt: now,
      };
      writeDoc({ ...read.doc, maintenance: next });
      return { ok: true as const, state: next };
    });
  } catch (error) {
    if (error instanceof GateTimeoutError) return gateFailure();
    throw error;
  }
}
