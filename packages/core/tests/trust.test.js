import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addMemory, addMemories, getMemoryHistory, queryMemories, resolveConflict, retractMemory } from '../src/services/memory.js';
import { closeDb } from '../src/db/sqlite.js';

function harness(t, extractor = async content => ({ should_remember: true, facts: [content], preferences: [], entities: {} })) {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-trust-'));
  const config = {
    dbPath: join(dir, 'memory.db'),
    embedder: async text => [text.toLowerCase().includes('answer') ? 1 : 0, 0.2],
    extractor,
  };
  t.after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });
  return config;
}

test('new evidence supersedes old evidence without deleting history', async t => {
  const config = harness(t);
  const first = await addMemory({
    user_id: 'john', org_id: 'personal', type: 'preference', memory_key: 'preference.response_detail',
    content: 'I prefer concise answers', valid_from: '2026-01-01T00:00:00.000Z', source_ref: 'message-1',
  }, config);
  const second = await addMemory({
    user_id: 'john', org_id: 'personal', type: 'preference', memory_key: 'preference.response_detail',
    content: 'I prefer detailed answers now', valid_from: '2026-08-14T00:00:00.000Z', source_ref: 'message-2',
  }, config);

  assert.equal(second.supersedes, first.id);
  const current = await queryMemories({ user_id: 'john', org_id: 'personal', query: 'answer preference' }, config);
  assert.equal(current.length, 1);
  assert.equal(current[0].id, second.id);
  assert.equal(current[0].provenance.source_ref, 'message-2');
  assert.match(current[0].explanation.summary, /Selected as active/);

  const history = await getMemoryHistory({ user_id: 'john', org_id: 'personal', memory_key: 'preference.response_detail' }, config);
  assert.deepEqual(history.map(item => item.status), ['superseded', 'active']);
  assert.equal(history[0].valid_until, '2026-08-14T00:00:00.000Z');
  assert.ok(history[0].events.some(event => event.type === 'superseded'));
  assert.ok(history[1].relations.some(relation => relation.type === 'supersedes' && relation.to === first.id));
});

test('contradictions are withheld until explicitly resolved', async t => {
  const config = harness(t);
  const first = await addMemory({ user_id: 'sam', memory_key: 'profile.home_city', content: 'Sam lives in Toronto' }, config);
  const second = await addMemory({ user_id: 'sam', memory_key: 'profile.home_city', content: 'Sam lives in Montreal', conflict_mode: 'dispute' }, config);

  assert.equal(second.status, 'disputed');
  assert.deepEqual(await queryMemories({ user_id: 'sam', query: 'home city' }, config), []);

  await resolveConflict({ winner_id: second.id, loser_ids: [first.id], actor: 'sam' }, config);
  const resolved = await queryMemories({ user_id: 'sam', query: 'home city' }, config);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, second.id);
});

test('selective policy skips low-signal interactions before embedding', async t => {
  let embeds = 0;
  const config = harness(t, async () => ({ should_remember: false, reason: 'greeting' }));
  config.embedder = async () => { embeds++; return [1, 0]; };
  const result = await addMemory({ user_id: 'lee', type: 'conversation', content: 'Hello!' }, config);
  assert.deepEqual(result, { skipped: true, reason: 'greeting' });
  assert.equal(embeds, 0);
});

test('retraction removes a memory from normal recall but preserves history', async t => {
  const config = harness(t);
  const memory = await addMemory({ user_id: 'ria', memory_key: 'profile.favorite_color', content: 'Favorite color is blue' }, config);
  await retractMemory(memory.id, 'User removed this claim', config);
  assert.deepEqual(await queryMemories({ user_id: 'ria', query: 'favorite color' }, config), []);
  const history = await getMemoryHistory({ user_id: 'ria', memory_key: 'profile.favorite_color' }, config);
  assert.equal(history[0].status, 'retracted');
});

test('one interaction becomes independently governed atomic memories', async t => {
  const config = harness(t);
  config.itemExtractor = async () => ({
    should_remember: true,
    memories: [
      { content: 'Nora lives in Ottawa', type: 'long_term', memory_key: 'profile.home_city', confidence: 1, facts: ['Nora lives in Ottawa'] },
      { content: 'Nora prefers concise answers', type: 'preference', memory_key: 'preference.response_detail', confidence: 1, preferences: ['Nora prefers concise answers'] },
      { content: 'Nora uses Vim', type: 'preference', memory_key: 'preference.editor', confidence: 1, preferences: ['Nora uses Vim'] },
    ],
  });
  const result = await addMemories({ user_id: 'nora', source_ref: 'message-7', content: 'I live in Ottawa, prefer concise answers, and use Vim.' }, config);
  assert.equal(result.memories.length, 3);
  assert.deepEqual(result.memories.map(memory => memory.memory_key), [
    'profile.home_city', 'preference.response_detail', 'preference.editor',
  ]);

  await addMemory({ user_id: 'nora', memory_key: 'preference.editor', content: 'Nora now uses VS Code' }, config);
  const city = await queryMemories({ user_id: 'nora', query: 'home city Ottawa', limit: 1 }, config);
  const editor = await queryMemories({ user_id: 'nora', query: 'editor VS Code', limit: 1 }, config);
  assert.equal(city[0].memory_key, 'profile.home_city');
  assert.match(editor[0].content, /VS Code/);
  assert.equal(editor[0].provenance.source_kind, 'user');
});
