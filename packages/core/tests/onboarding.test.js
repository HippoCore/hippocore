import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectClients, install, uninstall } from '../src/cli/onboarding.js';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'hippo-onboarding-'));
}

test('detects installed clients from user-owned directories', () => {
  const home = tempHome();
  try {
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.cursor'));
    assert.deepEqual(detectClients(home), ['codex', 'cursor']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('installs one shared vault into Codex, Claude Code, and Cursor safely', async () => {
  const home = tempHome();
  const hippoHome = join(home, 'shared-hippo');
  try {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ theme: 'dark' }));
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } } }));

    const result = await install({
      home,
      env: { HIPPO_CORE_HOME: hippoHome },
      clients: ['codex', 'claude-code', 'cursor'],
    });

    assert.equal(result.clients.length, 3);
    assert.ok(existsSync(join(hippoHome, 'memory.db')));
    assert.ok(existsSync(join(home, '.codex', 'config.toml.hippo-backup')));
    const codex = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(codex, /model = "gpt-5"/);
    assert.match(codex, /\[mcp_servers\.hippo-core\]/);
    assert.match(codex, /command = "npx"/);

    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.theme, 'dark');
    assert.deepEqual(claude.mcpServers['hippo-core'].args, ['-y', '@hippo-core/core@1.3.0', 'mcp']);

    const cursor = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.equal(cursor.mcpServers.existing.command, 'keep-me');
    assert.equal(cursor.mcpServers['hippo-core'].command, 'npx');
    assert.match(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), /hippo_recall/);
    assert.match(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'), /hippo_remember/);
    assert.match(readFileSync(join(home, '.cursor', 'rules', 'hippo-core.mdc'), 'utf8'), /alwaysApply: true/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('dry-run writes nothing and repeat installs are idempotent', async () => {
  const home = tempHome();
  const hippoHome = join(home, 'hippo');
  try {
    mkdirSync(join(home, '.codex'));
    const preview = await install({ home, env: { HIPPO_CORE_HOME: hippoHome }, clients: ['codex'], dryRun: true });
    assert.equal(preview.clients[0].changed, true);
    assert.equal(existsSync(join(home, '.codex', 'config.toml')), false);
    assert.equal(existsSync(hippoHome), false);

    await install({ home, env: { HIPPO_CORE_HOME: hippoHome }, clients: ['codex'] });
    const again = await install({ home, env: { HIPPO_CORE_HOME: hippoHome }, clients: ['codex'] });
    assert.equal(again.clients[0].changed, false);
    assert.equal(again.clients[0].ambient.changed, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('preflight rejects malformed client JSON before writing anything', async () => {
  const home = tempHome();
  const hippoHome = join(home, 'hippo');
  try {
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{not-json');
    await assert.rejects(
      install({ home, env: { HIPPO_CORE_HOME: hippoHome }, clients: ['codex', 'cursor'] }),
      /Unexpected token|JSON/,
    );
    assert.equal(existsSync(join(home, '.codex', 'config.toml')), false);
    assert.equal(existsSync(hippoHome), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('preserves an unmanaged existing Codex hippo-core entry without duplication', async () => {
  const home = tempHome();
  const hippoHome = join(home, 'hippo');
  try {
    mkdirSync(join(home, '.codex'));
    const existing = '[mcp_servers.hippo-core]\ncommand = "custom-hippo"\n';
    const path = join(home, '.codex', 'config.toml');
    writeFileSync(path, existing);
    const result = await install({ home, env: { HIPPO_CORE_HOME: hippoHome }, clients: ['codex'] });
    assert.equal(readFileSync(path, 'utf8'), existing);
    assert.match(result.clients[0].note, /preserved/);
    assert.equal(existsSync(`${path}.hippo-backup`), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('uninstall removes only managed connections and preserves the vault', async () => {
  const home = tempHome();
  const hippoHome = join(home, 'hippo');
  try {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ theme: 'dark' }));
    await install({ home, env: { HIPPO_CORE_HOME: hippoHome }, clients: ['codex', 'claude-code'] });
    const vault = join(hippoHome, 'memory.db');
    assert.ok(existsSync(vault));

    const result = uninstall({ home, clients: ['codex', 'claude-code'] });
    assert.equal(result.vaultPreserved, true);
    assert.ok(existsSync(vault));
    assert.doesNotMatch(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), /hippo-core managed/);
    assert.match(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'), /model = "gpt-5"/);
    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    assert.equal(claude.theme, 'dark');
    assert.equal(claude.mcpServers, undefined);
    assert.doesNotMatch(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), /hippo-core ambient/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
