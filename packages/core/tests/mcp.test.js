import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('MCP advertises the shared-vault surface at v1.3.0', () => {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n');
  const result = spawnSync(process.execPath, [join(here, '..', 'src', 'mcp', 'server.js')], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages[0].result.serverInfo.version, '1.3.0');
  const tools = messages[1].result.tools.map(tool => tool.name);
  assert.deepEqual(tools, ['hippo_recall', 'hippo_remember', 'hippo_status', 'hippo_history', 'hippo_resolve', 'hippo_retract']);
});
