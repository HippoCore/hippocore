import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function vector(text, dimensions = 64) {
  const result = Array(dimensions).fill(0);
  for (const token of (text.toLowerCase().match(/[a-z0-9]+/g) || [])) {
    let hash = 0;
    for (const char of token) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
    result[hash % dimensions] += 1;
  }
  return result;
}

async function startMockProvider() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/embeddings')) {
        return res.end(JSON.stringify({ data: [{ embedding: vector(String(request.input || '')) }] }));
      }
      if (req.url.endsWith('/chat/completions')) {
        const source = String(request.messages?.at(-1)?.content || '');
        const claim = /vim/i.test(source)
          ? { content: 'Dana uses Vim', type: 'preference', memory_key: 'preference.editor', preferences: ['Dana uses Vim'] }
          : /tea/i.test(source)
            ? { content: 'Dana drinks tea', type: 'preference', memory_key: 'preference.beverage', preferences: ['Dana drinks tea'] }
            : { content: 'Dana prefers dark mode', type: 'preference', memory_key: 'preference.ui_theme', preferences: ['Dana prefers dark mode'] };
        const extraction = {
          should_remember: true,
          reason: 'Durable preference',
          memories: [{
            ...claim, confidence: 1, facts: [], intent: '', entities: { person: 'Dana' },
          }],
        };
        return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(extraction) } }] }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function startMcp(env) {
  const child = spawn(process.execPath, [join(here, '..', 'src', 'mcp', 'server.js')], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter.resolve(message); }
  });
  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}\n${stderr}`)); }, 10000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function stop() {
    if (child.exitCode !== null) return Promise.resolve();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end();
    return exited;
  }
  return { child, send, stop };
}

test('two live MCP processes share one vault while preserving agent boundaries', async t => {
  const home = mkdtempSync(join(tmpdir(), 'hippo-cross-agent-'));
  const provider = await startMockProvider();
  const port = provider.address().port;
  const env = {
    HIPPO_CORE_HOME: home,
    HIPPO_CORE_API_KEY: 'test',
    HIPPO_CORE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    HIPPO_CORE_MODEL: 'mock',
    HIPPO_CORE_EMBEDDING_MODEL: 'mock-embedding',
  };
  const agentA = startMcp(env);
  const agentB = startMcp(env);
  t.after(async () => {
    await Promise.all([agentA.stop(), agentB.stop()]);
    await new Promise(resolve => provider.close(resolve));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await agentA.send('initialize');
  await agentB.send('initialize');

  // Agent B opens and caches its connection before Agent A writes.
  await agentB.send('tools/call', { name: 'hippo_status', arguments: {} });
  const stored = await agentA.send('tools/call', { name: 'hippo_remember', arguments: {
    user_id: 'dana', agent_id: 'agent-a', org_id: 'team', source_ref: 'agent-a-message-1',
    type: 'preference', content: 'Dana told Agent A that she prefers dark mode.',
  } });
  assert.match(stored.result.content[0].text, /Stored 1 atomic memory/);

  const privateRecall = await agentB.send('tools/call', { name: 'hippo_recall', arguments: {
    user_id: 'dana', agent_id: 'agent-b', org_id: 'team', scope: 'user+agent', query: 'display mode preference',
  } });
  assert.match(privateRecall.result.content[0].text, /No relevant memories found/);

  const sharedRecall = await agentB.send('tools/call', { name: 'hippo_recall', arguments: {
    user_id: 'dana', agent_id: 'agent-b', org_id: 'team', scope: 'user', query: 'display mode preference',
  } });
  assert.match(sharedRecall.result.content[0].text, /Dana prefers dark mode/);

  const history = await agentB.send('tools/call', { name: 'hippo_history', arguments: {
    user_id: 'dana', org_id: 'team', memory_key: 'preference.ui_theme',
  } });
  const evidence = JSON.parse(history.result.content[0].text);
  assert.equal(evidence[0].source_ref, 'agent-a-message-1');
  assert.ok(evidence[0].events.some(event => event.actor === 'agent-a'));

  // Concurrent writes from already-open processes must serialize without loss.
  await Promise.all([
    agentA.send('tools/call', { name: 'hippo_remember', arguments: {
      user_id: 'dana', agent_id: 'agent-a', org_id: 'team', content: 'Dana uses Vim.',
    } }),
    agentB.send('tools/call', { name: 'hippo_remember', arguments: {
      user_id: 'dana', agent_id: 'agent-b', org_id: 'team', content: 'Dana drinks tea.',
    } }),
  ]);
  const [editorHistory, beverageHistory] = await Promise.all([
    agentB.send('tools/call', { name: 'hippo_history', arguments: { user_id: 'dana', org_id: 'team', memory_key: 'preference.editor' } }),
    agentA.send('tools/call', { name: 'hippo_history', arguments: { user_id: 'dana', org_id: 'team', memory_key: 'preference.beverage' } }),
  ]);
  assert.equal(JSON.parse(editorHistory.result.content[0].text)[0].content, 'Dana uses Vim');
  assert.equal(JSON.parse(beverageHistory.result.content[0].text)[0].content, 'Dana drinks tea');
});
