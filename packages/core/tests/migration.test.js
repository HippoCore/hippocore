import test from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queryMemories } from '../src/services/memory.js';
import { closeDb } from '../src/db/sqlite.js';

test('v0.7 databases migrate to active evidence without data loss', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-migrate-'));
  const dbPath = join(dir, 'memory.db');
  t.after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

  const SQL = await initSqlJs();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE memories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'default',
    org_id TEXT NOT NULL DEFAULT 'default', content TEXT NOT NULL, type TEXT NOT NULL,
    importance_score REAL NOT NULL DEFAULT 0.5, token_count INTEGER NOT NULL DEFAULT 0,
    access_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  legacy.run(`INSERT INTO memories
    (id, user_id, agent_id, org_id, content, type, importance_score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      'legacy-1', 'alex', 'default', 'default', 'Alex prefers keyboard shortcuts', 'preference', 0.7,
      '2025-01-02T03:04:05.000Z', '2025-01-02T03:04:05.000Z',
    ]);
  writeFileSync(dbPath, Buffer.from(legacy.export()));
  legacy.close();

  const results = await queryMemories({ user_id: 'alex', query: 'keyboard preferences' }, {
    dbPath, embedder: async () => [1, 0], embeddingModel: 'test',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'legacy-1');
  assert.equal(results[0].status, 'active');
  assert.equal(results[0].valid_from, '2025-01-02T03:04:05.000Z');
  assert.equal(results[0].provenance.source_kind, 'user');
});
