import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMemories, queryMemories } from '../src/services/memory.js';
import { closeDb } from '../src/db/sqlite.js';
import { embed, embeddingModelName } from '../src/services/ai.js';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'hippo-offline-'));
  return { home, config: { dbPath: join(home, 'memory.db'), offline: true } };
}

test('fresh installs remember and recall locally without a model provider', async () => {
  const { home, config } = fixture();
  try {
    const stored = await addMemories({
      user_id: 'ambient-user',
      content: 'John prefers dark mode for every developer tool.',
      source_kind: 'user',
    }, config);
    assert.equal(stored.memories.length, 1);
    assert.equal(embeddingModelName(config), 'hippo-local-hash-v1');

    const recalled = await queryMemories({
      user_id: 'ambient-user',
      query: 'developer tool dark mode preference',
      scope: 'user',
    }, config);
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].content, /prefers dark mode/);
  } finally {
    closeDb();
    rmSync(home, { recursive: true, force: true });
  }
});

test('local embeddings are deterministic and reject secrets before persistence', async () => {
  const { home, config } = fixture();
  try {
    assert.deepEqual(await embed('same words', config), await embed('same words', config));
    const stored = await addMemories({
      user_id: 'ambient-user',
      content: 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
    }, config);
    assert.equal(stored.skipped, true);
    assert.match(stored.reason, /Sensitive content/);
    const recalled = await queryMemories({ user_id: 'ambient-user', query: 'api key', scope: 'user' }, config);
    assert.equal(recalled.length, 0);
  } finally {
    closeDb();
    rmSync(home, { recursive: true, force: true });
  }
});
