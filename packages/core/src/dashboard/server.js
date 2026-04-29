// packages/core/src/dashboard/server.js
// Hippo Core v0.3.0 — developer monitoring dashboard
// Run: npx @hippo-core/core dashboard
// Opens at http://localhost:4444

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { getDb } from '../db/sqlite.js';
import { queryMemories, getUserProfile, getMetrics } from '../services/memory.js';
import { buildPrompt, estimateTokens } from '../services/ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'ui.html');

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
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
  });
}

export async function startDashboard(config = {}) {
  const port = config.dashboardPort || process.env.HIPPO_DASHBOARD_PORT || 4444;

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
        const db      = await getDb(config.dbPath);
        const metrics = await getMetrics(config);

        const logRows = [];
        db.exec({
          sql: `SELECT COUNT(*) as total_requests, AVG(retrieval_ms) as avg_retrieval_ms,
                       AVG(memory_tokens_used) as avg_memory_tokens, AVG(total_tokens) as avg_total_tokens,
                       SUM(memories_retrieved) as total_retrievals
                FROM request_log`,
          callback: (row) => logRows.push(row),
        });

        const recentLog = [];
        db.exec({
          sql: `SELECT user_id, agent_id, org_id, query, memories_retrieved, memory_tokens_used, total_tokens, retrieval_ms, created_at
                FROM request_log ORDER BY created_at DESC LIMIT 20`,
          callback: (row) => recentLog.push({
            user_id: row[0], agent_id: row[1], org_id: row[2], query: row[3],
            memories_retrieved: row[4], memory_tokens_used: row[5],
            total_tokens: row[6], retrieval_ms: row[7], created_at: row[8],
          }),
        });

        // Embedding model info
        const embModels = [];
        db.exec({
          sql: `SELECT embedding_model, COUNT(*) as count, AVG(dimensions) as avg_dims
                FROM memory_embeddings GROUP BY embedding_model ORDER BY count DESC`,
          callback: (row) => embModels.push({ model: row[0], count: row[1], dimensions: Math.round(row[2]) }),
        });

        const lr = logRows[0] || [];
        const baseline_tokens = 3000;
        const actual_tokens   = parseFloat((lr[3] || 0).toFixed(1));
        const reduction_pct   = actual_tokens > 0
          ? parseFloat(((baseline_tokens - actual_tokens) / baseline_tokens * 100).toFixed(1))
          : 0;

        return json(res, {
          ...metrics,
          embedding_models: embModels,
          request_log: {
            total_requests:    lr[0] || 0,
            avg_retrieval_ms:  parseFloat((lr[1] || 0).toFixed(1)),
            avg_memory_tokens: parseFloat((lr[2] || 0).toFixed(1)),
            avg_total_tokens:  actual_tokens,
            total_retrievals:  lr[4] || 0,
          },
          token_savings: {
            baseline_per_request: baseline_tokens,
            actual_per_request:   actual_tokens,
            reduction_percent:    reduction_pct,
            verdict: reduction_pct > 50 ? 'significantly reduced'
                   : reduction_pct > 10 ? 'slightly reduced'
                   : actual_tokens === 0 ? 'no data yet' : 'unchanged',
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
        const profile = await getUserProfile(userId, { ...config, agentId, orgId });
        return json(res, { user_id: userId, memories: profile, count: profile.length });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── GET /users ────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/users') {
      try {
        const db   = await getDb(config.dbPath);
        const rows = [];
        db.exec({
          sql: `SELECT user_id, agent_id, org_id, COUNT(*) as memory_count, MAX(created_at) as last_active
                FROM memories GROUP BY user_id, agent_id, org_id ORDER BY memory_count DESC LIMIT 50`,
          callback: (row) => rows.push({ user_id: row[0], agent_id: row[1], org_id: row[2], memory_count: row[3], last_active: row[4] }),
        });
        return json(res, { users: rows });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── GET /agents ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/agents') {
      try {
        const db   = await getDb(config.dbPath);
        const rows = [];
        db.exec({
          sql: `SELECT agent_id, org_id, COUNT(*) as memory_count,
                       COUNT(DISTINCT user_id) as user_count, MAX(created_at) as last_active
                FROM memories GROUP BY agent_id, org_id ORDER BY memory_count DESC LIMIT 50`,
          callback: (row) => rows.push({ agent_id: row[0], org_id: row[1], memory_count: row[2], user_count: row[3], last_active: row[4] }),
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
        const memories = await queryMemories({ user_id, agent_id, org_id, query, limit, scope }, config);
        const retrieval_ms = Date.now() - t0;

        return json(res, {
          query, retrieval_ms, scope,
          memories: memories.map(m => ({
            id:               m.id,
            content:          m.content.slice(0, 200),
            type:             m.type,
            agent_id:         m.agent_id,
            org_id:           m.org_id,
            similarity:       m.similarity,
            importance_score: m.importance_score,
            blended_score:    m.blended,
            token_count:      m.token_count,
            why_selected:     buildWhySelected(m),
            structured:       m.structured,
          })),
        });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    // ── POST /prompt/preview ──────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/prompt/preview') {
      try {
        const body = await parseBody(req);
        const {
          user_id, user_message,
          agent_id, org_id, scope = 'user',
          base_system_prompt = 'You are a helpful assistant.',
          session_history    = [],
          max_memory_tokens  = config.maxMemoryTokens || 500,
        } = body;

        if (!user_id || !user_message) return json(res, { error: 'user_id and user_message required' }, 400);

        const memories = await queryMemories({ user_id, agent_id, org_id, query: user_message, limit: 5, scope }, config);
        const { systemPrompt, memoryContext, sessionMessages, tokenStats } = buildPrompt({
          memories,
          sessionHistory:   session_history,
          baseSystemPrompt: base_system_prompt,
          maxMemoryTokens:  max_memory_tokens,
        });

        return json(res, {
          prompt_structure: { system: systemPrompt, session_history: sessionMessages, user_input: user_message },
          memory_context:   memoryContext,
          token_stats:      tokenStats,
          memories_used:    memories.length,
          scope,
          full_messages: [
            { role: 'system', content: systemPrompt },
            ...sessionMessages,
            { role: 'user',   content: user_message },
          ],
        });
      } catch (err) { return json(res, { error: err.message }, 500); }
    }

    json(res, { error: 'Not found' }, 404);
  });

  server.listen(port, () => {
    console.log(`\n🦛 Hippo Core Dashboard v0.3.0`);
    console.log(`   Running at http://localhost:${port}\n`);
  });

  return server;
}

function buildWhySelected(m) {
  const reasons = [];
  if (m.similarity > 0.8)       reasons.push(`high semantic similarity (${m.similarity})`);
  else if (m.similarity > 0.5)  reasons.push(`moderate similarity (${m.similarity})`);
  else                          reasons.push(`low similarity (${m.similarity}) — boosted by importance`);
  if (m.importance_score > 0.7) reasons.push(`high importance (${m.importance_score})`);
  if (m.agent_id && m.agent_id !== 'default') reasons.push(`from agent: ${m.agent_id}`);
  if (m.structured?.facts?.length) reasons.push(`${m.structured.facts.length} extracted facts`);
  return reasons.join('; ');
}
