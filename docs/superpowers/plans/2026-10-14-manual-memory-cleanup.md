# Manual Memory Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-invoked cleanup that removes repeated and superseded memory entries while preserving useful knowledge, under a temporary maintenance pause of memory writers and sync.

**Architecture:** Extend the existing Hermes extension with a shared maintenance coordinator (pause/drain/resume, recovery state) respected by every automatic memory writer, plus a maintenance gate in `sync-memory.ps1`; a deterministic planner plus bounded LLM analysis drafts merge/supersede actions; an apply pipeline backs up, mutates, reconciles SQLite, syncs with tombstones, verifies, and restores original operational state.

**Tech Stack:** TypeScript (node:test, tsx), better-sqlite3 (existing AtomicLockCoordinator), PowerShell 5.1-compatible script changes, no new packages.

**Spec:** This document (approved by Fahmi in session 2026-10-14; requirements recap below).

## Approved behavior (spec recap)

- Cleanup runs **only when invoked manually** (`/memory-cleanup`).
- Equivalent entries in the **same scope** may merge without further approval.
- Explicit, unambiguous user corrections supersede the matching old fact immediately.
- Conflicting or ambiguous entries require review; age/low-recall/similar-wording alone never justify deletion.
- Cleanup must not silently archive entries merely to meet a character limit.
- Scheduler settings are restored after successful verification; interrupted cleanup leaves `recovery-required` and never auto-resumes.
- No package installation, live cleanup, or commits without separate permission.

## Global Constraints

- No new npm dependencies.
- PowerShell must run on Windows PowerShell 5.1.
- Maintenance state must be readable by both Node (JSON) and PowerShell.
- Ordinary memory reads and writes must keep working when no maintenance is active, even if the maintenance file is corrupt.
- Never kill in-flight writers; drain them.
- The coordinator is local-machine only; other-PC safety stays an explicit checklist step.

## Review Focus

- Ordinary write during maintenance → refused with `Memory maintenance in progress; retry after cleanup`, never lost silently.
- Corrupt maintenance file → cleanup blocked with recovery guidance, but ordinary writes keep working.
- Pi killed mid-cleanup → state stays `recovery-required`; nothing auto-resumes on elapsed time alone.
- Scheduler was already disabled before cleanup → restored to disabled, never force-enabled.
- Retired entry resurrects via Drive/sync → second verification sync must catch it and keep maintenance paused.

---

### Task 1 — Shared maintenance state and recovery ✅ DONE (2026-10-14)

**Files:**
- Create: `src/store/maintenance-coordinator.ts`
- Test: `tests/store/maintenance-coordinator.test.ts`

**Interfaces (produces):**
- `maintenanceStatePath(): string` — env `PI_HERMES_MAINTENANCE_STATE_DIR` overrides directory; file name `maintenance-state.json`.
- `readMaintenanceState(): Promise<MaintenanceState | null>`; `readMaintenanceStateDetailed(): Promise<{exists:boolean; corrupt:boolean; state:MaintenanceState|null}>`
- `beginMaintenance(input:{scopes:string[]}): Promise<BeginResult>` — phases start at `quiescing`; refuses when active (`already-active`) or corrupt (`corrupt`).
- `updateMaintenance(ownerToken, patch:{phase?;progress?;backupDir?;originalState?;scopes?;recoveryReason?}): Promise<UpdateResult>`
- `registerJob(kind, opts?:{ownerToken?}): Promise<{ok:true;id:string}|{ok:false;reason:string}>`; `unregisterJob(id): Promise<void>`
- `waitForJobsToDrain(timeoutMs): Promise<boolean>`
- `endMaintenance(ownerToken, opts?:{force?:boolean}): Promise<EndResult>` — refuses with `jobs-outstanding` unless `force`.
- `flagRecoveryRequired(reason, opts?:{ownerToken?})` — allowed for owner or provably-dead owner pid; refused for live foreign owner; refuses on corrupt file.
- `isWriteAdmitted(ownerToken?): Promise<{admitted:boolean; reason?:string; phase?:MaintenancePhase}>` — corrupt state ⇒ admitted (fail-open for ordinary writes).
- `MaintenancePhase = "quiescing" | "cleaning" | "verifying" | "recovery-required"`; state doc shape `{ version:1, maintenance: MaintenanceState|null, jobs: MaintenanceJob[] }`.

**Guard clauses & edge cases:** second concurrent owner → `already-active`; corrupt → `corrupt`; non-owner write admission refused; dead-owner state never auto-resumes (only `flagRecoveryRequired` + `/memory-cleanup recover` path); gate lock uses `staleMs: 0` (no time-based takeover, liveness only).

**Verification:** new suite `tests/store/maintenance-coordinator.test.ts` covers admission races, competing sessions, owner-only admission, corrupt state, dead owner, drain timeout, and restore-of-recorded-state; `npm run check` clean.

### Task 2 — Integrate every memory writer ✅ DONE (2026-10-14)

**Files:**
- Modify: `src/store/memory-store.ts`, `src/index.ts`, `src/handlers/auto-consolidate.ts`, `src/handlers/vault-promotion.ts`, `src/handlers/background-review.ts`, `src/handlers/correction-detector.ts`, `src/handlers/session-flush.ts`

**Approach:** enforce `isWriteAdmitted` at `runTargetMutation` (inside the per-file mutation lock); register/unregister LLM jobs around snapshots and final writes; cleanup writes present the owner token; correction deferral is reported, never silently swallowed; shutdown flush defers under maintenance.

**Verification:** regression tests per handler suite: direct + subprocess paths, queued consolidation, two sessions sharing a store, shutdown flush deferral.

### Task 3 — Coordinate sync and scheduler state ✅ DONE (2026-10-14)

Note: PS gate tests live in `scripts/tests/sync-memory-maintenance-gate.tests.ps1` (sibling of the tombstones suite, same self-contained harness style) rather than inside sync-memory-tombstones.tests.ps1.

**Files:**
- Modify: `C:\Users\User\.pi\agent\scripts\sync-memory.ps1`, `C:\Users\User\.pi\agent\scripts\tests\sync-memory-tombstones.tests.ps1`
- Create: `src/handlers/maintenance-sync.ts`, Test: `tests/handlers/maintenance-sync.test.ts`

**Approach:** PowerShell gate reads `maintenance-state.json` (phase `quiescing`/`cleaning`/`verifying` ⇒ exit 0 with maintenance message, no writes); TypeScript helper records `PiHermesMemorySyncDaily` original state, disables it, waits out a running sync, authorizes cleanup sync stages, restores recorded state.

**Task 5 integration refinement (approved 2026-10-14):** owner-authorized sync is staged exactly once in order: `baseline` → `apply` → `verify`. Stage replay protection binds to the stable owner token, not mutable `updatedAt`; PowerShell persists authorization before data writes and preserves the ledger when loading/saving sync state.

**Guard clauses:** task missing ⇒ record `syncTaskKnown:false`; task uninspectable ⇒ abort pre-mutation; manual sync during maintenance ⇒ no-write exit; Drive missing ⇒ abort or recovery-required; >50%/empty-file safeguards unchanged; restore failure ⇒ report + recovery info.

**Verification:** sandboxed PowerShell tests; mocked scheduler in TS tests (never touch the real task or Drive).

### Task 4 — Knowledge-preserving cleanup planner ✅ DONE (2026-10-14)

**Files:**
- Create: `src/handlers/memory-cleanup-plan.ts`, Test: `tests/handlers/memory-cleanup-plan.test.ts`
- Modify: `src/store/memory-store.ts` (conservative handling for near-duplicates; do NOT reuse `squeezeToCap`)

**Approach:** discovery vs permission separation; exact duplicates deterministic; token similarity only nominates candidates; bounded LLM analysis per candidate group; actions `merge | supersede | needs-review` with original entry identities + replacement; preserve versions, negation, scope qualifiers, unrelated details.

**Guard clauses:** empty/no candidates ⇒ no-op, no LLM call; cross-scope ⇒ never merge; version/date/quantity/negation diff ⇒ conflict unless explicit correction evidence; hypothetical ("might upgrade") ⇒ proposal only; timestamp alone ⇒ insufficient; replacement omitting/adding facts ⇒ rejected; invalid LLM JSON ⇒ no application.

**Verification:** tests pin the PHP-version correction example, env differences, "not" polarity, partial overlap, hypothetical upgrades, invalid output, no-candidate no-op.

### Task 5 — Apply cleanup with backups and verification

**Files:**
- Modify: `src/store/memory-store.ts`, `src/handlers/maintenance-sync.ts`, `tests/store/memory-store.test.ts`, `tests/handlers/maintenance-sync.test.ts`
- Modify external: `C:\Users\User\.pi\agent\scripts\sync-memory.ps1`, `C:\Users\User\.pi\agent\scripts\tests\sync-memory-maintenance-gate.tests.ps1`
- Create: `src/handlers/memory-cleanup.ts`, Test: `tests/handlers/memory-cleanup.test.ts`

**Approach:** begin maintenance → drain → baseline union sync (`baseline`, no cleanup) → inventory fingerprints → hash-verified backups → journal → apply all actions per store in one owner-authorized mutation under its lock, verifying the expected store fingerprint and every planned index+SHA-256 reference before any write → reconcile SQLite scopes → authorized `apply` sync → authorized `verify` sync → restore original state only on success. Preserve the keeper's metadata; never route cleanup through substring-based replace/remove.

The sync gate accepts only one ordered `baseline` → `apply` → `verify` stage per stable owner token. It records the stage before sync data writes; marker `updatedAt` changes do not reset authorization, and loading state preserves previously consumed stages.

**Guard clauses:** missing baseline ⇒ establish without historical deletion inference, then re-inventory; another-machine safety not confirmed or writers fail to drain ⇒ abort before cleanup; backup hash mismatch ⇒ stop; inventory fingerprint mismatch, missing/mismatched entry reference, overlapping action, or invalid replacement ⇒ reject the entire affected store batch without writing; missing/wrong owner token, replayed/out-of-order stage, or corrupt authorization ledger ⇒ fail closed; index reconciliation failure ⇒ recovery-required; replica mismatch post-sync ⇒ stay paused; partial application ⇒ preserve journal+backups and inspect before resuming, never blindly overwrite newer data from backup; over-cap store post-cleanup ⇒ report that consolidation may re-run.

**Verification:** end-to-end sandbox: no-op, merge, supersede, stale fingerprint/hash, duplicate/overlapping refs, unauthorized owner, ordered sync stages and replay refusal despite marker updates, partial failure, index repair, resurrection prevention, crash recovery.

**Status: DONE (2026-10-14).** `runMemoryCleanup` in `src/handlers/memory-cleanup.ts`; 13 handler tests green (tests/handlers/memory-cleanup.test.ts); full targeted suites 120/120, `npm run check` clean. Runner order refined: scheduler disabled before job drain so a drain abort can restore it. Fixture note: `loadFromDisk()` Set-dedupes byte-identical raw entries, so seeded exact duplicates vary metadata dates with identical decoded text.

### Task 6 — Command surface and skill update

**Status: DONE (2026-10-14).** 24/24 command tests; `npm run check` clean; 144 pass / 4 pre-existing env-skips across the five targeted suites; wired into `src/index.ts` (deps = live stores, `capacityGoal()` caps, full-sweep reconcile, per-store backup sources). Implementation notes: cleared markers are tombstones (`state === null`), so status/recover treat corrupt before idle; project backup source uses `project.memoryDir` (store's `memoryDir` is private).

**Files:**
- Create: `src/handlers/memory-cleanup-command.ts`, Test: `tests/handlers/memory-cleanup-command.test.ts`
- Modify: `src/index.ts`, `README.md`, skill `project:pi-hermes-memory:weekly-memory-housekeeping`

**Interface:** `/memory-cleanup` (preview, read-only) · `/memory-cleanup apply` · `/memory-cleanup status` · `/memory-cleanup recover`.

**Guard clauses:** unknown args ⇒ usage, no changes; apply requires other-machine confirmation before mutation; conflicts reported separately, entries untouched; recover never blindly clears state or enables tasks; re-invocation skips journaled actions.

**Verification:** argument parsing, preview read-only, status, recovery, no-op output tests.

---

## Execution notes

- Per task: failing tests → minimal implementation → targeted tests → diff review. Final: `npm run check`, targeted suites, `npm test` (separate pre-existing env failures), sandbox crash/simulated-writer runs. Restart Pi before any authorized live smoke test.
- No package installation, live cleanup, or commits without separate permission.
