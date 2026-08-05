/**
 * Recency-blended memory search ranking (#recency-blend).
 *
 * searchMemories ranks by (1-W)*bm25_relevance + W*recency, so neither a
 * keyword-perfect-but-dead entry nor a fresh-but-weak one always wins.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import { searchMemories, syncMemoryEntry } from '../../src/store/sqlite-memory-store.js';

describe('memory search recency blend', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-search-rank-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insert(content: string, lastReferenced: string): void {
    syncMemoryEntry(dbManager, { content, target: 'memory', lastReferenced });
  }

  const TODAY = new Date().toISOString().split('T')[0];
  const OLD = '2025-01-01';

  it('weight 1 ranks purely by recency', () => {
    insert('deploy the backend to staging', OLD);
    insert('deploy the frontend to production', TODAY);

    const results = searchMemories(dbManager, 'deploy', { recencyWeight: 1 });
    assert.strictEqual(results.length, 2);
    assert.match(results[0].content, /production/, 'fresh entry first under pure recency');
  });

  it('weight 0 ranks purely by FTS relevance, recency ignored', () => {
    insert('deploy', TODAY); // single occurrence
    insert('deploy deploy deploy deploy deploy', OLD); // high term frequency

    const results = searchMemories(dbManager, 'deploy', { recencyWeight: 0 });
    assert.strictEqual(results.length, 2);
    assert.match(results[0].content, /deploy deploy deploy/, 'higher tf wins under pure relevance even when old');
  });

  it('default weight prefers the fresh entry when relevance ties', () => {
    insert('deploy the backend', OLD);
    insert('deploy the frontend', TODAY);

    const results = searchMemories(dbManager, 'deploy');
    assert.strictEqual(results.length, 2);
    assert.match(results[0].content, /frontend/, 'equal relevance + recency tie-break');
  });

  it('a strong old match still beats a weak fresh one at low weight', () => {
    insert('deploy', TODAY);
    insert('deploy deploy deploy deploy deploy deploy deploy deploy deploy deploy to staging at midnight', OLD);

    const results = searchMemories(dbManager, 'deploy', { recencyWeight: 0.1 });
    assert.strictEqual(results.length, 2);
    assert.match(results[0].content, /midnight/, 'relevance dominates at weight 0.1');
  });

  it('respects limit and returns nothing for an empty query', () => {
    insert('deploy the backend', TODAY);
    insert('deploy the frontend', TODAY);

    assert.strictEqual(searchMemories(dbManager, 'deploy', { limit: 1 }).length, 1);
    assert.deepStrictEqual(searchMemories(dbManager, '   '), []);
  });
});
