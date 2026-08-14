import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AMBIENT_POLICY, installAmbientPolicy } from '../src/cli/ambient.js';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'hippo-ambient-'));
}

test('ambient policy encodes automatic recall, selective remember, and secret safety', () => {
  assert.match(AMBIENT_POLICY, /start of every meaningful task/);
  assert.match(AMBIENT_POLICY, /hippo_recall/);
  assert.match(AMBIENT_POLICY, /hippo_remember/);
  assert.match(AMBIENT_POLICY, /Do not ask for permission/);
  assert.match(AMBIENT_POLICY, /Never store passwords, API keys, access tokens/);
  assert.match(AMBIENT_POLICY, /Skip greetings, casual chat/);
});

test('Codex ambient policy preserves global instructions and upgrades idempotently', () => {
  const home = tempHome();
  try {
    const path = join(home, '.codex', 'AGENTS.md');
    mkdirSync(join(home, '.codex'));
    writeFileSync(path, '# My instructions\n\nAlways run tests.\n');
    const first = installAmbientPolicy('codex', { home, dryRun: false });
    assert.equal(first.changed, true);
    assert.ok(existsSync(`${path}.hippo-backup`));
    const content = readFileSync(path, 'utf8');
    assert.match(content, /# My instructions/);
    assert.equal(content.match(/>>> hippo-core ambient memory/g).length, 1);

    const second = installAmbientPolicy('codex', { home, dryRun: false });
    assert.equal(second.changed, false);
    assert.equal(readFileSync(path, 'utf8'), content);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Codex uses a non-empty global override because it takes precedence', () => {
  const home = tempHome();
  try {
    const directory = join(home, '.codex');
    const path = join(directory, 'AGENTS.override.md');
    mkdirSync(directory);
    writeFileSync(path, '# Override\n');
    const result = installAmbientPolicy('codex', { home, dryRun: false });
    assert.equal(result.path, path);
    assert.match(readFileSync(path, 'utf8'), /Hippo Core ambient memory/);
    assert.equal(existsSync(join(directory, 'AGENTS.md')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Claude Code and Cursor receive their native global instruction formats', () => {
  const home = tempHome();
  try {
    const claude = installAmbientPolicy('claude-code', { home, dryRun: false });
    const cursor = installAmbientPolicy('cursor', { home, dryRun: false });
    assert.equal(claude.path, join(home, '.claude', 'CLAUDE.md'));
    assert.match(readFileSync(claude.path, 'utf8'), /hippo_recall/);
    assert.equal(cursor.path, join(home, '.cursor', 'rules', 'hippo-core.mdc'));
    const rule = readFileSync(cursor.path, 'utf8');
    assert.match(rule, /alwaysApply: true/);
    assert.match(rule, /hippo_remember/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ambient dry-run reports changes without touching instruction files', () => {
  const home = tempHome();
  try {
    const result = installAmbientPolicy('codex', { home, dryRun: true });
    assert.equal(result.changed, true);
    assert.equal(existsSync(result.path), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
