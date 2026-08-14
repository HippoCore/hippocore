import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { addMemory, addMemories, queryMemories, retractMemory } from '../src/services/memory.js';
import { closeDb } from '../src/db/sqlite.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = process.env.HIPPO_BENCHMARK_FIXTURES || join(here, 'fixtures.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function embedding(text, dimensions = 96) {
  const vector = Array(dimensions).fill(0);
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  for (const token of tokens) {
    let hash = 2166136261;
    for (const char of token) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
    vector[hash % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map(value => value / norm);
}

function evaluateQuery(query, results) {
  const text = results.map(result => result.content).join('\n');
  const checks = [];
  if (query.expected_count !== undefined) checks.push({ name: 'expected_count', passed: results.length === query.expected_count });
  if (query.expected_top_contains) checks.push({ name: 'expected_top_contains', passed: results[0]?.content.toLowerCase().includes(query.expected_top_contains.toLowerCase()) === true });
  if (query.forbidden_contains) checks.push({ name: 'forbidden_contains', passed: !text.toLowerCase().includes(query.forbidden_contains.toLowerCase()) });
  if (query.expected_key) checks.push({ name: 'expected_key', passed: results[0]?.memory_key === query.expected_key });
  if (query.expected_source_ref) checks.push({ name: 'expected_source_ref', passed: results[0]?.provenance?.source_ref === query.expected_source_ref });
  if (query.require_explanation) checks.push({ name: 'require_explanation', passed: Boolean(results[0]?.explanation?.signals && results[0]?.explanation?.evidence) });
  return { passed: checks.length > 0 && checks.every(check => check.passed), checks, top: results[0]?.content || null };
}

const outcomes = [];
for (const scenario of fixture.scenarios) {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-benchmark-'));
  const refs = new Map();
  let extraction = null;
  const config = {
    dbPath: join(dir, 'memory.db'),
    embeddingModel: 'hippo-benchmark-hash-v1',
    embedder: async text => embedding(text),
    extractor: async content => ({ should_remember: true, facts: [content], preferences: [], entities: {} }),
    itemExtractor: async () => extraction,
  };
  const checks = [];
  const details = [];
  try {
    for (const action of scenario.actions) {
      if (action.op === 'remember') {
        const result = await addMemory(action.params, config);
        if (action.as) refs.set(action.as, result.id);
      } else if (action.op === 'remember_many') {
        extraction = action.extraction;
        const result = await addMemories(action.params, config);
        const passed = result.memories.length === action.expected_stored;
        checks.push(passed);
        details.push({ operation: 'remember_many', passed, expected: action.expected_stored, actual: result.memories.length });
      } else if (action.op === 'retract') {
        await retractMemory(refs.get(action.ref), action.reason || '', config);
      } else {
        throw new Error(`Unknown benchmark action: ${action.op}`);
      }
    }
    for (const query of scenario.queries) {
      const results = await queryMemories(query, config);
      const evaluation = evaluateQuery(query, results);
      checks.push(evaluation.passed);
      details.push({ query: query.query, ...evaluation });
    }
    outcomes.push({ id: scenario.id, dimension: scenario.dimension, passed: checks.length > 0 && checks.every(Boolean), details });
  } catch (error) {
    outcomes.push({ id: scenario.id, dimension: scenario.dimension, passed: false, error: error.message });
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

const passed = outcomes.filter(outcome => outcome.passed).length;
const score = outcomes.length ? Math.round((passed / outcomes.length) * 1000) / 10 : 0;
const report = { fixture_version: fixture.version, scenarios: outcomes.length, passed, score, outcomes };

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log('\nHippo Core Memory Quality Benchmark\n');
  for (const outcome of outcomes) console.log(`${outcome.passed ? 'PASS' : 'FAIL'}  ${outcome.dimension.padEnd(20)} ${outcome.id}${outcome.error ? ` — ${outcome.error}` : ''}`);
  console.log(`\nScore: ${score}% (${passed}/${outcomes.length})\n`);
}

if (passed !== outcomes.length) process.exitCode = 1;
