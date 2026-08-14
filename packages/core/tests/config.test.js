import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { getConfigPath, getDefaultDbPath, getHippoHome, publicConfig } from '../src/config.js';

test('HIPPO_CORE_HOME provides one shared location', () => {
  const env = { HIPPO_CORE_HOME: join('tmp', 'hippo-test') };
  const home = getHippoHome(env);
  assert.equal(home, resolve(env.HIPPO_CORE_HOME));
  assert.equal(getConfigPath(env), join(home, 'config.json'));
  assert.equal(getDefaultDbPath(env), join(home, 'memory.db'));
});

test('publicConfig never persists API keys', () => {
  assert.deepEqual(
    publicConfig({ apiKey: 'secret', embeddingApiKey: 'also-secret', model: 'test' }),
    { model: 'test' },
  );
});
