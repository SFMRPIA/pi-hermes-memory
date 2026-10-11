import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory, getMemoryUsageSignals } from '../../src/store/sqlite-memory-store.js';
import { registerMemorySearchTool } from '../../src/tools/memory-search-tool.js';

let ROOT_DIR = '';

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = '';
});

function makeDbManager(): DatabaseManager {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-search-tool-test-'));
  return new DatabaseManager(ROOT_DIR);
}

describe('registerMemorySearchTool', () => {
  it('returns a broader natural-language match when strict term matching misses', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "user's name is Naruto", 'user');

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;

    registerMemorySearchTool(mockPi, dbManager);

    const result = await captured.execute('tc-1', { query: 'name identity Naruto', target: 'user' });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /Naruto/);

    dbManager.close();
  });
  // Ported from upstream #213 — adapted to the fork's own result format
  // (emoji + [project] labels) instead of upstream's scope=/[target=] format.
  it('accepts target "project" as a filter', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'project deployment convention', 'memory', 'project-a');
    addMemory(dbManager, 'global deployment convention');
    addMemory(dbManager, 'project failure deployment lesson', 'failure', 'project-a');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    assert.ok(captured.parameters.properties.target.enum.includes('project'));

    const result = await captured.execute('tc-1', { query: 'deployment', target: 'project' });
    const text = result.content[0].text;

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(text, /🧠 \[project-a\] project deployment convention/);
    assert.doesNotMatch(text, /\[global\]/);

    dbManager.close();
  });

  // ─── Usage-hit recording (upstream #262) ───

  it('records a usage hit for every returned entry', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'recallable volcano note', 'memory');
    addMemory(dbManager, 'recallable tide note', 'memory');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    await captured.execute('tc-1', { query: 'recallable' });
    await captured.execute('tc-2', { query: 'volcano' });

    const signals = getMemoryUsageSignals(dbManager, { target: 'memory', project: null });
    assert.strictEqual(signals.get('recallable volcano note')?.hits, 2);
    assert.strictEqual(signals.get('recallable tide note')?.hits, 1);

    dbManager.close();
  });

  it('records nothing when the search returns no results (vault fallback stays uncounted)', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'unmatched entry', 'memory');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    const result = await captured.execute('tc-1', { query: 'zzz-no-match-q' });
    assert.strictEqual(result.details.count, 0);
    assert.strictEqual(getMemoryUsageSignals(dbManager, { target: 'memory', project: null }).size, 0);

    dbManager.close();
  });

  it('skips recording when usage tracking is disabled', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'tracked-off entry', 'memory');

    let captured: any;
    registerMemorySearchTool(
      { registerTool: (def: any) => { captured = def; } } as any,
      dbManager,
      0.4,
      { usageHitTrackingEnabled: false } as any,
    );

    const result = await captured.execute('tc-1', { query: 'tracked-off' });
    assert.strictEqual(result.details.count, 1);
    assert.strictEqual(getMemoryUsageSignals(dbManager, { target: 'memory', project: null }).size, 0);

    dbManager.close();
  });

  it('never breaks the search when hit recording fails (fail-open)', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'resilient entry', 'memory');

    let getDbCalls = 0;
    const realGetDb = dbManager.getDb.bind(dbManager);
    const flaky = Object.create(dbManager) as DatabaseManager;
    flaky.getDb = () => {
      getDbCalls++;
      if (getDbCalls > 2) throw new Error('injected recording failure');
      return realGetDb();
    };

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, flaky);

    // getDb calls: getMemoryStats(1) + searchMemories(1) + recordSearchHits(1, throws).
    const result = await captured.execute('tc-1', { query: 'resilient' });
    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /resilient entry/);
    // The hit did NOT land (recording failed) but the search succeeded.
    assert.strictEqual(getMemoryUsageSignals(dbManager, { target: 'memory', project: null }).size, 0);

    dbManager.close();
  });

  it('clamps the limit: omitted/invalid defaults to 10, values above 20 cap at 20', async () => {
    const dbManager = makeDbManager();
    for (let i = 0; i < 25; i++) addMemory(dbManager, `bounded entry ${String(i).padStart(2, '0')} searchable`, 'memory');

    let captured: any;
    registerMemorySearchTool({ registerTool: (def: any) => { captured = def; } } as any, dbManager);

    const omitted = await captured.execute('tc-1', { query: 'bounded' });
    assert.strictEqual(omitted.details.count, 10, 'omitted limit defaults to 10');

    const capped = await captured.execute('tc-2', { query: 'bounded', limit: 99 });
    assert.strictEqual(capped.details.count, 20, 'limit above 20 caps at 20');

    const negative = await captured.execute('tc-3', { query: 'bounded', limit: -5 });
    assert.strictEqual(negative.details.count, 10, 'a negative limit must not disable LIMIT');

    const valid = await captured.execute('tc-4', { query: 'bounded', limit: 3 });
    assert.strictEqual(valid.details.count, 3, 'a valid 1-20 limit is honored verbatim');

    dbManager.close();
  });
});
