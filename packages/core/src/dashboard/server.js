// packages/core/src/dashboard/server.js
// Hippo Core Dashboard v0.6.0

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { createServer } from 'http';
import { getFreshDb, resetDb } from '../db/sqlite.js';
import { queryMemories, getUserProfile, getMetrics } from '../services/memory.js';
import { buildPrompt } from '../services/ai.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const HTML_PATH    = join(__dirname, 'ui.html');
const HOME         = homedir();
const DEFAULT_DB   = join(HOME, '.hippo-core', 'memory.db');
const CONFIG_PATH  = join(HOME, '.hippo-core', 'config.json');

function loadConfig(override = {}) {
  let cfg = { dbPath: DEFAULT_DB };
  if (existsSync(CONFIG_PATH)) {
    try { cfg = { ...cfg, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
  }
  return { ...cfg, ...override, dbPath: cfg.dbPath || DEFAULT_DB };
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

export async function startDashboard(configOverride = {}) {
  const port   = configOverride.dashboardPort || process.env.HIPPO_DASHBOARD_PORT || 4444;
  const config = loadConfig(configOverride);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    // ── GET /metrics ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/metrics') {
      try {
        const db = await getFreshDb(config.dbPath);
        resetDb();
        const metrics = await getMetrics(config);

        // Real request log stats
        const logRows = [];
        db.exec({
          sql: `SELECT
                  COUNT(*) as total_requests,
                  COALESCE(AVG(retrieval_ms), 0) as avg_ms,
                  COALESCE(SUM(tokens_injected), 0) as total_tokens_injected,
                  COALESCE(AVG(tokens_injected), 0) as avg_tokens_injected,
                  COALESCE(SUM(memories_retrieved), 0) as total_memories_retrieved,
                  COALESCE(AVG(memories_retrieved), 0) as avg_memories_retrieved
                FROM request_log`,
          callback: row => logRows.push(row),
        });

        // Recent requests
        const recentLog = [];
        db.exec({
          sql: `SELECT user_id, agent_id, org_id, framework, query, memories_retrieved,
                       tokens_injected, retrieval_ms, created_at
                FROM request_log ORDER BY created_at DESC LIMIT 20`,
          callback: row => recentLog.push({
            user_id: row[0], agent_id: row[1], org_id: row[2], framework: row[3],
            query: row[4], memories_retrieved: row[5], tokens_injected: row[6],
            retrieval_ms: row[7], created_at: row[8],
          }),
        });

        // Embedding models
        const embModels = [];
        db.exec({
          sql: `SELECT embedding_model, COUNT(*) as count, AVG(dimensions) as avg_dims
                FROM memory_embeddings GROUP BY embedding_model ORDER BY count DESC`,
          callback: row => embModels.push({ model: row[0], count: row[1], dimensions: Math.round(row[2]) }),
        });

        const lr = logRows[0] || [0,0,0,0,0,0];
        const total_requests       = lr[0] || 0;
        const avg_retrieval_ms     = parseFloat((lr[1] || 0).toFixed(1));
        const total_tokens_injected = lr[2] || 0;
        const avg_tokens_injected  = parseFloat((lr[3] || 0).toFixed(1));
        const total_recalls        = lr[4] || 0;
        const avg_memories         = parseFloat((lr[5] || 0).toFixed(1));

        return json(res, {
          ...metrics,
          embedding_models: embModels,
          request_log: {
            total_requests,
            avg_retrieval_ms,
            total_tokens_injected,
            avg_tokens_injected,
            total_recalls,
            avg_memories_per_recall: avg_memories,
          },
          recent_requests: recentLog,
        });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── GET /memory/list ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/memory/list') {
      try {
        const userId  = url.searchParams.get('user_id');
        const agentId = url.searchParams.get('agent_id') || undefined;
        const orgId   = url.searchParams.get('org_id')   || undefined;
        if (!userId) return json(res, { error: 'user_id required' }, 400);
        resetDb();
        const profile = await getUserProfile(userId, { ...config, agentId, orgId });
        return json(res, { user_id: userId, memories: profile, count: profile.length });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── GET /users ────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/users') {
      try {
        const db = await getFreshDb(config.dbPath);
        const rows = [];
        db.exec({
          sql: `SELECT user_id, agent_id, org_id, COUNT(*) as memory_count, MAX(created_at) as last_active
                FROM memories GROUP BY user_id, agent_id, org_id ORDER BY memory_count DESC LIMIT 50`,
          callback: row => rows.push({ user_id: row[0], agent_id: row[1], org_id: row[2], memory_count: row[3], last_active: row[4] }),
        });
        return json(res, { users: rows });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── GET /agents ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/agents') {
      try {
        const db = await getFreshDb(config.dbPath);
        const rows = [];
        db.exec({
          sql: `SELECT agent_id, org_id, COUNT(*) as memory_count,
                       COUNT(DISTINCT user_id) as user_count, MAX(created_at) as last_active
                FROM memories GROUP BY agent_id, org_id ORDER BY memory_count DESC LIMIT 50`,
          callback: row => rows.push({ agent_id: row[0], org_id: row[1], memory_count: row[2], user_count: row[3], last_active: row[4] }),
        });
        return json(res, { agents: rows });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── POST /memory/query-debug ──────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/memory/query-debug') {
      try {
        const body = await parseBody(req);
        const { user_id, agent_id, org_id, query, limit = 5, scope = 'user' } = body;
        if (!user_id || !query) return json(res, { error: 'user_id and query required' }, 400);
        const t0 = Date.now();
        resetDb();
        const memories = await queryMemories({ user_id, agent_id, org_id, query, limit, scope }, config);
        return json(res, {
          query, retrieval_ms: Date.now() - t0, scope,
          memories: memories.map(m => ({
            id: m.id, content: m.content.slice(0, 200), type: m.type,
            agent_id: m.agent_id, org_id: m.org_id,
            similarity: m.similarity, importance_score: m.importance_score,
            blended_score: m.blended, token_count: m.token_count,
            structured: m.structured,
          })),
        });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── POST /prompt/preview ──────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/prompt/preview') {
      try {
        const body = await parseBody(req);
        const { user_id, user_message, agent_id, org_id, scope = 'user', base_system_prompt = 'You are a helpful assistant.', session_history = [], max_memory_tokens = 500 } = body;
        if (!user_id || !user_message) return json(res, { error: 'user_id and user_message required' }, 400);
        resetDb();
        const memories = await queryMemories({ user_id, agent_id, org_id, query: user_message, limit: 5, scope }, config);
        const { systemPrompt, memoryContext, sessionMessages, tokenStats } = buildPrompt({ memories, sessionHistory: session_history, baseSystemPrompt: base_system_prompt, maxMemoryTokens: max_memory_tokens });
        return json(res, { prompt_structure: { system: systemPrompt, session_history: sessionMessages, user_input: user_message }, memory_context: memoryContext, token_stats: tokenStats, memories_used: memories.length, scope });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── Connections ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/connections') {
      try {
        const { getAllConnectionStatuses } = await import('./connections.js');
        return json(res, getAllConnectionStatuses());
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/connections/') && url.pathname.endsWith('/connect')) {
      const framework = url.pathname.split('/')[2];
      try {
        const conn = await import('./connections.js');
        const map = { openclaw: conn.connectOpenClaw, paperclip: conn.connectPaperclip, hermes: conn.connectHermes, claude_desktop: conn.connectClaudeDesktop, claude_code: conn.connectClaudeCode, cursor: conn.connectCursor, codex: conn.connectCodex };
        if (!map[framework]) return json(res, { error: 'Unknown framework' }, 400);
        return json(res, await map[framework]());
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    if (req.method === 'POST' && url.pathname.startsWith('/connections/') && url.pathname.endsWith('/disconnect')) {
      const framework = url.pathname.split('/')[2];
      try {
        const conn = await import('./connections.js');
        const map = { openclaw: conn.disconnectOpenClaw, hermes: conn.disconnectHermes, claude_desktop: conn.disconnectClaudeDesktop, claude_code: conn.disconnectClaudeCode, cursor: conn.disconnectCursor, codex: conn.disconnectCodex };
        if (!map[framework]) return json(res, { error: 'Unknown framework' }, 400);
        return json(res, await map[framework]());
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    json(res, { error: 'Not found' }, 404);
  });

  server.listen(port, () => {
    console.log(`\n🦛 Hippo Core Dashboard v0.6.0`);
    console.log(`   Running at http://localhost:${port}\n`);
  });

  return server;
}
