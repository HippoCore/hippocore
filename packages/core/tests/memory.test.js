import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addMemory, lexicalSimilarity, queryMemories } from '../src/services/memory.js';
import { closeDb } from '../src/db/sqlite.js';

function vector(text) {
  const lower = text.toLowerCase();
  return [lower.includes('mortgage') ? 1 : 0, lower.includes('dark') ? 1 : 0, 0.1];
}

function testConfig(dbPath) {
  return {
    dbPath,
    embedder: async text => vector(text),
    extractor: async content => ({ facts: [content], preferences: [], intent: '', entities: {} }),
  };
}

test('lexicalSimilarity rewards matching terms', () => {
  assert.equal(lexicalSimilarity('fixed mortgage rate', 'A fixed mortgage is preferred'), 2 / 3);
  assert.equal(lexicalSimilarity('unrelated', 'A fixed mortgage is preferred'), 0);
});

test('memory is namespaced, retrievable, and exactly deduplicated', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-core-'));
  const dbPath = join(dir, 'memory.db');
  const config = testConfig(dbPath);
  t.after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

  const first = await addMemory({ user_id: 'alice', agent_id: 'codex', org_id: 'acme', type: 'preference', content: 'Prefers a fixed mortgage rate' }, config);
  const duplicate = await addMemory({ user_id: 'alice', agent_id: 'codex', org_id: 'acme', type: 'preference', content: 'Prefers a fixed mortgage rate' }, config);
  await addMemory({ user_id: 'bob', agent_id: 'codex', org_id: 'acme', type: 'preference', content: 'Prefers dark mode' }, config);

  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicate, true);

  const results = await queryMemories({ user_id: 'alice', agent_id: 'codex', org_id: 'acme', query: 'mortgage preference', scope: 'user' }, config);
  assert.equal(results.length, 1);
  assert.match(results[0].content, /mortgage/);
  assert.ok(results[0].lexical > 0);
});
