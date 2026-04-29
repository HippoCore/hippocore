// packages/core/src/services/memory.js
// Hippo Core v0.3.0
//
// Multi-agent namespacing: { user_id, agent_id, org_id }
// - user_id  — the end user (required)
// - agent_id — which agent stored/retrieves this memory (optional, default: 'default')
// - org_id   — organisation/team namespace (optional, default: 'default')
//
// Retrieval scope options:
//   scope: 'user'         — only this user's memories (default)
//   scope: 'agent'        — only memories from this specific agent
//   scope: 'org'          — all memories in the org (shared team memory)
//   scope: 'user+agent'   — memories for this user from this agent only

import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from '../db/sqlite.js';
import { embed, extractStructured, summarizeMemories, estimateTokens } from './ai.js';

function computeImportance({ recencyDays = 0, accessCount = 0, explicit = 0.5 }) {
  const DECAY   = 30;
  const recency   = Math.max(0, 1 - recencyDays / DECAY);
  const frequency = Math.min(1, accessCount / 20);
  const exp       = Math.max(0, Math.min(1, explicit));
  return recency * 0.3 + frequency * 0.4 + exp * 0.3;
}

const VALID_TYPES = new Set(['conversation','event','preference','short_term','long_term','behavioral']);

function normalizeType(t) {
  if (VALID_TYPES.has(t)) return t;
  return { chat:'conversation', action:'behavioral', fact:'long_term' }[t] || 'conversation';
}

function safeJsonParse(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Normalise namespace — all three fields always present
function ns(params) {
  return {
    user_id:  params.user_id  || params.userId  || 'anonymous',
    agent_id: params.agent_id || params.agentId || 'default',
    org_id:   params.org_id   || params.orgId   || 'default',
  };
}

// ── Add memory ────────────────────────────────────────────────────────────────
export async function addMemory(params, config = {}) {
  const { user_id, agent_id, org_id } = ns(params);
  const { type, content } = params;
  const db         = await getDb(config.dbPath);
  const memoryType = normalizeType(type);
  const id         = uuidv4();
  const structId   = uuidv4();

  const [embedding, structured] = await Promise.all([
    embed(content, config),
    extractStructured(content, config),
  ]);

  const importance   = computeImportance({ recencyDays: 0, accessCount: 0 });
  const tokenCount   = estimateTokens(content);
  const now          = new Date().toISOString();
  const embModel     = config.embeddingModel || 'text-embedding-3-small';
  const dimensions   = embedding.length;

  db.exec({
    sql: `INSERT INTO memories
            (id, user_id, agent_id, org_id, content, type, importance_score, token_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [id, user_id, agent_id, org_id, content, memoryType, importance, tokenCount, now, now],
  });

  db.exec({
    sql:  `INSERT INTO memory_embeddings (memory_id, embedding, embedding_model, dimensions) VALUES (?, ?, ?, ?)`,
    bind: [id, JSON.stringify(embedding), embModel, dimensions],
  });

  db.exec({
    sql: `INSERT INTO structured_memory (id, memory_id, facts, preferences, intent, entities, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bind: [
      structId, id,
      JSON.stringify(structured.facts       || []),
      JSON.stringify(structured.preferences || []),
      structured.intent || '',
      JSON.stringify(structured.entities    || {}),
      now,
    ],
  });

  saveDb();
  return { id, user_id, agent_id, org_id, type: memoryType, importance_score: importance, created_at: now, structured };
}

// ── Query memories ────────────────────────────────────────────────────────────
export async function queryMemories(params, config = {}) {
  const { user_id, agent_id, org_id } = ns(params);
  const {
    query,
    limit          = 5,
    type_filter,
    scope          = 'user',       // 'user' | 'agent' | 'org' | 'user+agent'
    retrievalLimit = 100,
  } = params;

  const db        = await getDb(config.dbPath);
  const safeLimit = Math.min(Math.max(1, limit), 20);
  const candidates = Math.min(retrievalLimit, config.retrievalLimit || 100);

  const queryEmbedding = await embed(query, config);

  // Build WHERE clause based on scope
  let scopeClause;
  let scopeBinds;
  switch (scope) {
    case 'agent':
      scopeClause = 'agent_id = ? AND org_id = ?';
      scopeBinds  = [agent_id, org_id];
      break;
    case 'org':
      scopeClause = 'org_id = ?';
      scopeBinds  = [org_id];
      break;
    case 'user+agent':
      scopeClause = 'user_id = ? AND agent_id = ? AND org_id = ?';
      scopeBinds  = [user_id, agent_id, org_id];
      break;
    default: // 'user'
      scopeClause = 'user_id = ? AND org_id = ?';
      scopeBinds  = [user_id, org_id];
  }

  const typeClause = type_filter ? `AND m.type = '${normalizeType(type_filter)}'` : '';

  const rows = [];
  db.exec({
    sql: `SELECT m.id, m.user_id, m.agent_id, m.org_id, m.content, m.type,
                 m.importance_score, m.access_count, m.created_at, m.token_count,
                 me.embedding, me.embedding_model,
                 sm.facts, sm.preferences, sm.intent, sm.entities
          FROM memories m
          LEFT JOIN memory_embeddings me ON me.memory_id = m.id
          LEFT JOIN structured_memory sm ON sm.memory_id = m.id
          WHERE ${scopeClause} ${typeClause}
          ORDER BY m.importance_score DESC, m.created_at DESC
          LIMIT ?`,
    bind:     [...scopeBinds, candidates],
    callback: (row) => rows.push(row),
  });

  if (!rows.length) return [];

  // Warn if embedding model mismatch
  const storedModel  = rows[0]?.[11];
  const currentModel = config.embeddingModel || 'text-embedding-3-small';
  if (storedModel && storedModel !== 'unknown' && storedModel !== currentModel) {
    console.warn(`[hippo-core] ⚠ Embedding model mismatch: stored=${storedModel}, current=${currentModel}. Run 'npx @hippo-core/core re-embed' to migrate.`);
  }

  const scored = rows
    .map(r => {
      const emb        = safeJsonParse(r[10], null);
      const similarity = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
      const blended    = 0.7 * similarity + 0.3 * r[6];
      return { row: r, similarity, blended };
    })
    .sort((a, b) => b.blended - a.blended)
    .slice(0, safeLimit);

  if (scored.length > 0) {
    setImmediate(() => updateAccess(db, scored.map(s => s.row[0])));
  }

  return scored.map(({ row, similarity, blended }) => ({
    id:               row[0],
    user_id:          row[1],
    agent_id:         row[2],
    org_id:           row[3],
    content:          row[4],
    type:             row[5],
    importance_score: row[6],
    token_count:      row[9] || estimateTokens(row[4]),
    similarity:       parseFloat(similarity.toFixed(4)),
    blended:          parseFloat(blended.toFixed(4)),
    created_at:       row[8],
    structured: {
      facts:       safeJsonParse(row[12], []),
      preferences: safeJsonParse(row[13], []),
      intent:      row[14] || '',
      entities:    safeJsonParse(row[15], {}),
    },
  }));
}

// ── Feedback ──────────────────────────────────────────────────────────────────
export async function applyFeedback({ memory_id, outcome }, config = {}) {
  const db    = await getDb(config.dbPath);
  const delta = outcome === 'positive' ? 0.1 : outcome === 'negative' ? -0.15 : null;
  if (delta === null) throw new Error('outcome must be "positive" or "negative"');

  db.exec({ sql: `INSERT INTO memory_feedback (id, memory_id, outcome) VALUES (?, ?, ?)`, bind: [uuidv4(), memory_id, outcome] });

  const rows = [];
  db.exec({
    sql: `UPDATE memories SET importance_score = MAX(0.0, MIN(1.0, importance_score + ?)), updated_at = datetime('now') WHERE id = ? RETURNING id, importance_score`,
    bind: [delta, memory_id],
    callback: (row) => rows.push(row),
  });

  saveDb();
  return rows[0] ? { id: rows[0][0], importance_score: rows[0][1] } : null;
}

// ── User profile ──────────────────────────────────────────────────────────────
export async function getUserProfile(user_id, config = {}) {
  const db = await getDb(config.dbPath);
  const { agent_id, org_id } = ns({ user_id, agent_id: config.agentId, org_id: config.orgId });
  const rows = [];

  db.exec({
    sql: `SELECT m.id, m.type, m.content, m.importance_score, m.access_count,
                 m.token_count, m.agent_id, m.org_id, m.created_at,
                 sm.facts, sm.preferences, sm.intent, sm.entities
          FROM memories m
          LEFT JOIN structured_memory sm ON sm.memory_id = m.id
          WHERE m.user_id = ? AND m.org_id = ?
          ORDER BY m.importance_score DESC, m.created_at DESC
          LIMIT 100`,
    bind:     [user_id, org_id],
    callback: (row) => rows.push(row),
  });

  return rows.map(r => ({
    id: r[0], type: r[1], content: r[2], importance_score: r[3],
    access_count: r[4], token_count: r[5], agent_id: r[6], org_id: r[7], created_at: r[8],
    facts: safeJsonParse(r[9], []), preferences: safeJsonParse(r[10], []),
    intent: r[11] || '', entities: safeJsonParse(r[12], {}),
  }));
}

// ── Re-embed (migration tool) ─────────────────────────────────────────────────
// Re-generates all embeddings using the current embedding model.
// Run when switching embedding models.
export async function reEmbedAll(config = {}, onProgress) {
  const db = await getDb(config.dbPath);
  const rows = [];

  db.exec({
    sql:      `SELECT id, content FROM memories ORDER BY created_at ASC`,
    callback: (row) => rows.push({ id: row[0], content: row[1] }),
  });

  const newModel = config.embeddingModel || 'text-embedding-3-small';
  let done = 0;

  for (const { id, content } of rows) {
    try {
      const embedding = await embed(content, config);
      db.exec({
        sql:  `UPDATE memory_embeddings SET embedding = ?, embedding_model = ?, dimensions = ? WHERE memory_id = ?`,
        bind: [JSON.stringify(embedding), newModel, embedding.length, id],
      });
      done++;
      if (onProgress) onProgress(done, rows.length);
    } catch (err) {
      console.error(`[hippo-core] re-embed failed for ${id}: ${err.message}`);
    }
  }

  saveDb();
  return { total: rows.length, done };
}

// ── Metrics ───────────────────────────────────────────────────────────────────
export async function getMetrics(config = {}) {
  const db   = await getDb(config.dbPath);
  const rows = [];

  db.exec({
    sql: `SELECT COUNT(*) as total_memories, COUNT(DISTINCT user_id) as total_users,
                 COUNT(DISTINCT agent_id) as total_agents, COUNT(DISTINCT org_id) as total_orgs,
                 AVG(importance_score) as avg_importance, AVG(token_count) as avg_tokens,
                 SUM(access_count) as total_retrievals
          FROM memories`,
    callback: (row) => rows.push(row),
  });

  const typeRows = [];
  db.exec({
    sql: `SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY count DESC`,
    callback: (row) => typeRows.push({ type: row[0], count: row[1] }),
  });

  const agentRows = [];
  db.exec({
    sql: `SELECT agent_id, COUNT(*) as memory_count FROM memories GROUP BY agent_id ORDER BY memory_count DESC LIMIT 20`,
    callback: (row) => agentRows.push({ agent_id: row[0], memory_count: row[1] }),
  });

  const userRows = [];
  db.exec({
    sql: `SELECT user_id, COUNT(*) as memory_count, SUM(token_count) as total_tokens
          FROM memories GROUP BY user_id ORDER BY memory_count DESC LIMIT 20`,
    callback: (row) => userRows.push({ user_id: row[0], memory_count: row[1], total_tokens: row[2] }),
  });

  const r = rows[0] || [];
  return {
    total_memories:        r[0] || 0,
    total_users:           r[1] || 0,
    total_agents:          r[2] || 0,
    total_orgs:            r[3] || 0,
    avg_importance:        parseFloat((r[4] || 0).toFixed(3)),
    avg_tokens_per_memory: parseFloat((r[5] || 0).toFixed(1)),
    total_retrievals:      r[6] || 0,
    by_type:               typeRows,
    by_agent:              agentRows,
    top_users:             userRows,
  };
}

// ── Delete ────────────────────────────────────────────────────────────────────
export async function deleteMemory(memory_id, config = {}) {
  const db = await getDb(config.dbPath);
  db.exec({ sql: 'DELETE FROM memories WHERE id = ?', bind: [memory_id] });
  saveDb();
  return true;
}

// ── Compression ───────────────────────────────────────────────────────────────
export async function compressMemories(params, config = {}) {
  const { user_id, agent_id, org_id } = ns(typeof params === 'string' ? { user_id: params } : params);
  const db = await getDb(config.dbPath);

  db.exec({
    sql:  `DELETE FROM memories WHERE user_id = ? AND agent_id = ? AND org_id = ? AND importance_score < 0.2 AND access_count < 2 AND created_at < datetime('now', '-7 days')`,
    bind: [user_id, agent_id, org_id],
  });

  const old = [];
  db.exec({
    sql:      `SELECT id, content FROM memories WHERE user_id = ? AND agent_id = ? AND org_id = ? AND type = 'short_term' AND created_at < datetime('now', '-7 days') ORDER BY created_at ASC LIMIT 50`,
    bind:     [user_id, agent_id, org_id],
    callback: (row) => old.push({ id: row[0], content: row[1] }),
  });

  let compressed = 0;
  if (old.length >= 5) {
    const summary = await summarizeMemories(old.map(m => m.content), config);
    await addMemory({ user_id, agent_id, org_id, type: 'long_term', content: summary }, config);
    for (const m of old) db.exec({ sql: 'DELETE FROM memories WHERE id = ?', bind: [m.id] });
    compressed = old.length;
  }

  db.exec({
    sql:  `UPDATE memories SET importance_score = MAX(0.05, importance_score * 0.9), updated_at = datetime('now') WHERE user_id = ? AND agent_id = ? AND org_id = ? AND (last_accessed < datetime('now', '-14 days') OR (last_accessed IS NULL AND created_at < datetime('now', '-7 days')))`,
    bind: [user_id, agent_id, org_id],
  });

  saveDb();
  return { compressed };
}

function updateAccess(db, ids) {
  for (const id of ids) {
    db.exec({
      sql:  `UPDATE memories SET access_count = access_count + 1, last_accessed = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      bind: [id],
    });
  }
  saveDb();
}
