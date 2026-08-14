import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMemory, estimateEligibleMemoryTokens } from '../src/services/memory.js';
import { calculateTokenSavings } from '../src/dashboard/metrics.js';
import { closeDb, getDb } from '../src/db/sqlite.js';

test('token savings are the conservative non-negative context difference', () => {
  assert.deepEqual(calculateTokenSavings(1000, 240), {
    tokens_without_hippo: 1000,
    tokens_injected: 240,
    tokens_saved: 760,
    reduction_percent: 76,
  });
  assert.equal(calculateTokenSavings(100, 120).tokens_saved, 0);
  assert.equal(calculateTokenSavings(0, 0).reduction_percent, 0);
});

test('eligible-token baseline follows user and agent recall scope', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-savings-'));
  const config = { dbPath: join(home, 'memory.db'), offline: true };
  try {
    await addMemory({ user_id: 'u1', agent_id: 'a1', content: 'Alpha preference with enough words to count.', structured: { facts: [] } }, config);
    await addMemory({ user_id: 'u1', agent_id: 'a2', content: 'Beta project decision with several useful words.', structured: { facts: [] } }, config);
    await addMemory({ user_id: 'u2', agent_id: 'a1', content: 'Unrelated user memory must remain outside scope.', structured: { facts: [] } }, config);

    const userTokens = await estimateEligibleMemoryTokens({ user_id: 'u1', org_id: 'default', scope: 'user' }, config);
    const agentTokens = await estimateEligibleMemoryTokens({ user_id: 'u1', agent_id: 'a1', org_id: 'default', scope: 'user+agent' }, config);
    assert.ok(userTokens > agentTokens);
    assert.ok(agentTokens > 0);

    const columns = [];
    const db = await getDb(config.dbPath);
    db.exec({ sql: 'PRAGMA table_info(request_log)', callback: row => columns.push(row[1]) });
    assert.ok(columns.includes('tokens_without_hippo'));
  } finally {
    closeDb();
    rmSync(home, { recursive: true, force: true });
  }
});
