# Pi Hermes Memory Extension — Fork (SFMRPIA)

Persistent memory + learning loop for Pi, extended with the Obsidian-style three-tier vault pipeline. Fork of `chandra447/pi-hermes-memory`, wired into the user's Pi via `settings.json` (NOT the npm package).

## How the agent should use this system

### The three tiers (memory architecture)

1. **Tier 1 — Hot memory** (injected every turn): `~/.pi/agent/pi-hermes-memory/{MEMORY,USER,failures}.md` + `~/.pi/agent/projects-memory/<project>/MEMORY.md`. Transient facts, corrections, preferences, active state. Keep entries compact — the stores are capacity-capped (5K/5K/10K).
2. **Tier 2 — Vault** (long-term): plain markdown at `vaultPath` (config, default `D:\PiHermesMemoryVault`). Stable knowledge auto-promotes at ~67% capacity. Living files: `System/Assistant/{context,preferences,environment}.md`, `logs/issues-fixes-log.md`.
3. **Tier 3 — Daily notes**: `Daily/YYYY-MM-DD.md` (frontmatter + Tasks/Schedule/Log/Wins/Context), auto-created per session, append-only.

### Tools

| Tool | Use |
|---|---|
| `memory` | add/search/replace/remove hot memory (targets: memory, user, failure, project) |
| `vault_log` | append events: `type=log` → daily ## Log, `win` → ## Wins, `fix` → issues-fixes-log |
| `vault_search` | search the vault for promoted long-term context (use when hot memory lacks depth) |

### Filing rules (agent discipline)

- Operational events / decisions → `vault_log` (daily Log)
- System issues / fixes → `vault_log type=fix`
- Learned corrections / preferences → hot memory (vault if stable)
- Recurring workflows → skills

### What is automatic (never run manually)

- Daily note creation (session start)
- Promotion at 67% capacity (background LLM pass; copy-then-remove = no knowledge loss)
- Consolidation at 100% (async — writes always succeed instantly, store may briefly exceed cap)
- Recovery-snapshot pruning (≤64 files steady state)

## Reference / inspiration

The three-tier vault design was inspired by:
- **How I use Obsidian as the long-term memory backbone for my AI assistant** (r/hermesagent): https://www.reddit.com/r/hermesagent/comments/1stz6gd/how_i_use_obsidian_as_the_longterm_memory/

## Fork features (beyond upstream)

- **Async overflow consolidation**: capacity writes never block or fail (`addWithConsolidation` async path in `src/store/memory-store.ts`)
- **Vault pipeline**: `src/handlers/vault-notes.ts` (scaffold, daily notes, log routing) + `src/handlers/vault-promotion.ts` (threshold trigger via mutation observer, child `pi -p` returns strict JSON, parent writes vault first then removes entries; path-traversal guard)
- **Recovery caps**: `RECOVERY_ACTIVE_MAX_COUNT=32` / `8MB` active phase, 7-day grace retained
- **Timeout**: `DEFAULT_CONSOLIDATION_TIMEOUT_MS=600000` (background headroom — max thinking is fine)

## Config (`~/.pi/agent/hermes-memory-config.json`, per machine)

```json
{ "vaultPath": "D:\\PiHermesMemoryVault" }
```
`vaultPath` (empty = disabled) · `vaultPromoteThreshold` (0.67) · `vaultDailyNotes` (true) · `consolidationTimeoutMs` (600000) · `memoryCharLimit`/`userCharLimit`/`projectCharLimit`.

## Architecture

- **Language**: TypeScript, loaded directly by Pi (no compile step); tsconfig covers `src/**` only — **test files are NOT typechecked**
- **Entry point**: `src/index.ts` — registers tools, hooks, commands
- **Storage**: markdown stores (`§`-delimited entries) + SQLite (`sessions.db` search index) + lock DBs
- **Key modules**: `store/memory-store.ts` (CRUD, overflow strategies, atomic writes, recovery pruning) · `handlers/auto-consolidate.ts` (LLM consolidation child) · `handlers/vault-*.ts` · `tools/*.ts`

## Design decisions (fork)

1. Over-capacity writes are ACCEPTED then trimmed in background (never reject, never block)
2. Copy-then-remove ordering in promotion — vault write must succeed before entries leave hot memory
3. Child `pi -p` processes are subprocess-only for auto paths (no extension-runtime access from the store); failures surface as `console.warn`, never on the critical path
4. Recovery files are both age- AND count/bytes-bounded

## Development

```bash
npm run check          # tsc --noEmit (src only)
npm test               # runs tests/run-all.sh (per-file tsx --test)
npx tsx --test tests/store/memory-store.test.ts   # single suite
```
Quirks: `tsx -e` with top-level await prints nothing — use a temp `.ts` file. Pre-existing env failures (db/sqlite-native/pi-child-process) are unrelated to the fork.

## Commits

Lowercase conventional commits (`feat:`/`fix:`/`perf:`/`docs:`).
