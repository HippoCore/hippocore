import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('memory quality benchmark remains at 100%', () => {
  const result = spawnSync(process.execPath, [join(here, '..', 'benchmarks', 'run.js'), '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.score, 100);
  assert.equal(report.passed, report.scenarios);
  assert.deepEqual(report.outcomes.map(outcome => outcome.dimension), [
    'temporal_accuracy', 'conflict_safety', 'privacy_isolation', 'user_control', 'atomicity',
  ]);
});
