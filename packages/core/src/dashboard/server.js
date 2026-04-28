// packages/core/src/dashboard/server.js
// Hippo Core — local developer monitoring dashboard
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
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

export async function startDashboard(config = {}) {
  const port = config.dashboardPort || process.env.HIPPO_DASHBOARD_PORT || 4444;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      return res.end();
    }

    // Serve dashboard UI
    if (req.method === 'GET' && url.pathname === '/') {
      const html = readFileSync(HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    // ── GET /metrics ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/metrics') {
      try {
        const db   = await getDb(config.dbPath);
        const metrics = await getMetrics(config);

        // Request log stats
        const logRows = [];
        db.exec({
          sql: `SELECT
                  COUNT(*)                    as total_requests,
                  AVG(retrieval_ms)           as avg_retrieval_ms,
                  AVG(memory_tokens_used)     as avg_memory_tokens,
                  AVG(total_tokens)           as avg_total_tokens,
                  SUM(memories_retrieved)     as total_retrievals
                FROM request_log`,
          callback: (row) => logRows.push(row),
        });

        const recentLog = [];
        db.exec({
          sql: `SELECT user_id, query, memories_retrieved, memory_tokens_used,
                       total_tokens, retrieval_ms, created_at
                FROM request_log ORDER BY created_at DESC LIMIT 20`,
          callback: (row) => recentLog.push({
            user_id:            row[0],
            query:              row[1],
            memories_retrieved: row[2],
            memory_tokens_used: row[3],
            total_tokens:       row[4],
            retrieval_ms:       row[5],
            created_at:         row[6],
          }),
        });

        const lr = logRows[0] || [];

        // Token savings estimate:
        // Baseline = avg 20-turn conversation * avg tokens per turn (~150)
        const baseline_tokens_per_request = 3000;
        const actual_tokens               = parseFloat((lr[3] || 0).toFixed(1));
        const reduction_pct               = actual_tokens > 0
          ? parseFloat(((baseline_tokens_per_request - actual_tokens) / baseline_tokens_per_request * 100).toFixed(1))
          : 0;

        return json(res, {
          ...metrics,
          request_log: {
            total_requests:      lr[0] || 0,
            avg_retrieval_ms:    parseFloat((lr[1] || 0).toFixed(1)),
            avg_memory_tokens:   parseFloat((lr[2] || 0).toFixed(1)),
            avg_total_tokens:    actual_tokens,
            total_retrievals:    lr[4] || 0,
          },
          token_savings: {
            baseline_per_request:  baseline_tokens_per_request,
            actual_per_request:    actual_tokens,
            reduction_percent:     reduction_pct,
            verdict: reduction_pct > 50 ? 'significantly reduced'
                   : reduction_pct > 10 ? 'slightly reduced'
                   : actual_tokens === 0 ? 'no data yet'
                   : 'unchanged',
          },
          recent_requests: recentLog,
        });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // ── GET /memory/list ──────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/memory/list') {
      try {
        const userId = url.searchParams.get('user_id');
        if (!userId) return json(res, { error: 'user_id required' }, 400);
        const profile = await getUserProfile(userId, config);
        return json(res, { user_id: userId, memories: profile, count: profile.length });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // ── POST /memory/query-debug ──────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/memory/query-debug') {
      try {
        const body    = await parseBody(req);
        const { user_id, query, limit = 5 } = body;
        if (!user_id || !query) return json(res, { error: 'user_id and query required' }, 400);

        const t0      = Date.now();
        const memories = await queryMemories({ user_id, query, limit }, config);
        const retrieval_ms = Date.now() - t0;

        return json(res, {
          query,
          retrieval_ms,
          memories: memories.map(m => ({
            id:               m.id,
            content:          m.content.slice(0, 200),
            type:             m.type,
            similarity:       m.similarity,
            importance_score: m.importance_score,
            blended_score:    m.blended,
            token_count:      m.token_count,
            why_selected:     buildWhySelected(m),
            structured:       m.structured,
          })),
        });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // ── POST /prompt/preview ──────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/prompt/preview') {
      try {
        const body = await parseBody(req);
        const {
          user_id,
          user_message,
          base_system_prompt = 'You are a helpful assistant.',
          session_history    = [],
          max_memory_tokens  = config.maxMemoryTokens || 500,
        } = body;

        if (!user_id || !user_message) return json(res, { error: 'user_id and user_message required' }, 400);

        const memories = await queryMemories({ user_id, query: user_message, limit: 5 }, config);
        const { systemPrompt, memoryContext, sessionMessages, tokenStats } = buildPrompt({
          memories,
          sessionHistory:   session_history,
          baseSystemPrompt: base_system_prompt,
          maxMemoryTokens:  max_memory_tokens,
        });

        return json(res, {
          prompt_structure: {
            system:          systemPrompt,
            session_history: sessionMessages,
            user_input:      user_message,
          },
          memory_context:   memoryContext,
          token_stats:      tokenStats,
          full_messages: [
            { role: 'system',  content: systemPrompt },
            ...sessionMessages,
            { role: 'user',    content: user_message },
          ],
        });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    // ── GET /users ────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/users') {
      try {
        const db   = await getDb(config.dbPath);
        const rows = [];
        db.exec({
          sql: `SELECT user_id, COUNT(*) as memory_count, MAX(created_at) as last_active
                FROM memories GROUP BY user_id ORDER BY memory_count DESC LIMIT 50`,
          callback: (row) => rows.push({ user_id: row[0], memory_count: row[1], last_active: row[2] }),
        });
        return json(res, { users: rows });
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    json(res, { error: 'Not found' }, 404);
  });

  server.listen(port, () => {
    console.log(`\n🦛 Hippo Core Dashboard`);
    console.log(`   Running at http://localhost:${port}\n`);
  });

  return server;
}

function buildWhySelected(m) {
  const reasons = [];
  if (m.similarity > 0.8)       reasons.push(`high semantic similarity (${m.similarity})`);
  else if (m.similarity > 0.5)  reasons.push(`moderate semantic similarity (${m.similarity})`);
  else                           reasons.push(`low similarity (${m.similarity}) — boosted by importance`);
  if (m.importance_score > 0.7) reasons.push(`high importance score (${m.importance_score})`);
  if (m.structured?.facts?.length) reasons.push(`contains ${m.structured.facts.length} extracted facts`);
  return reasons.join('; ');
}
