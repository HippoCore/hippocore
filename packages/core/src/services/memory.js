// packages/core/src/services/memory.js
// Hippo Core — memory service
// Handles: store, retrieve (with scalable vector search), feedback, compression

import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from '../db/sqlite.js';
import { embed, extractStructured, summarizeMemories, estimateTokens } from './ai.js';

// ── Importance scoring ────────────────────────────────────────────────────────
function computeImportance({ recencyDays = 0, accessCount = 0, explicit = 0.5 }) {
  const DECAY   = 30;
  const recency   = Math.max(0, 1 - recencyDays / DECAY);
  const frequency = Math.min(1, accessCount / 20);
  const exp       = Math.max(0, Math.min(1, explicit));
  return recency * 0.3 + frequency * 0.4 + exp * 0.3;
}

const VALID_TYPES = new Set(['conversation','event','preference','short_term','long_term','behavioral']);

function normalizeType(type) {
  if (VALID_TYPES.has(type)) return type;
  const aliases = { chat: 'conversation', action: 'behavioral', fact: 'long_term' };
  return aliases[type] || 'conversation';
}

function safeJsonParse(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; } catch { return fallback; }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Add memory ────────────────────────────────────────────────────────────────
export async function addMemory({ user_id, type, content, metadata = {} }, config = {}) {
  const db         = await getDb(config.dbPath);
  const memoryType = normalizeType(type);
  const id         = uuidv4();
  const structId   = uuidv4();

  const [embedding, structured] = await Promise.all([
    embed(content, config),
    extractStructured(content, config),
  ]);

  const importance = computeImportance({ recencyDays: 0, accessCount: 0 });
  const now        = new Date().toISOString();
  const tokenCount = estimateTokens(content);

  db.exec({
    sql: `INSERT INTO memories
            (id, user_id, content, type, importance_score, token_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [id, user_id, content, memoryType, importance, tokenCount, now, now],
  });

  db.exec({
    sql:  `INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)`,
    bind: [id, JSON.stringify(embedding)],
  });

  db.exec({
    sql: `INSERT INTO structured_memory
            (id, memory_id, facts, preferences, intent, entities, created_at)
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
  return { id, user_id, type: memoryType, importance_score: importance, created_at: now, structured };
}

// ── Query memories ────────────────────────────────────────────────────────────
// Uses cosine similarity computed in JS over the candidate set.
// For datasets < 5,000 memories this is fast enough.
// For larger datasets, switch the DB layer to sqlite-vec vec0 HNSW index.
export async function queryMemories({
  user_id,
  query,
  limit        = 5,
  type_filter,
  retrievalLimit = 100,  // how many candidates to pull before re-ranking
}, config = {}) {
  const db        = await getDb(config.dbPath);
  const safeLimit = Math.min(Math.max(1, limit), 20);
  const candidates = Math.min(retrievalLimit, config.retrievalLimit || 100);

  const queryEmbedding = await embed(query, config);
  const typeClause     = type_filter ? `AND m.type = '${normalizeType(type_filter)}'` : '';

  // Pull candidate memories with their embeddings
  const rows = [];
  db.exec({
    sql: `SELECT m.id, m.user_id, m.content, m.type,
                 m.importance_score, m.access_count, m.created_at,
                 m.token_count,
                 me.embedding,
                 sm.facts, sm.preferences, sm.intent, sm.entities
          FROM memories m
          LEFT JOIN memory_embeddings me ON me.memory_id = m.id
          LEFT JOIN structured_memory sm ON sm.memory_id = m.id
          WHERE m.user_id = ? ${typeClause}
          ORDER BY m.importance_score DESC, m.created_at DESC
          LIMIT ?`,
    bind:     [user_id, candidates],
    callback: (row) => rows.push(row),
  });

  if (!rows.length) return [];

  // Score: blend semantic similarity (70%) + importance (30%)
  const scored = rows
    .map(r => {
      const emb        = safeJsonParse(r[8], null);
      const similarity = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
      const blended    = 0.7 * similarity + 0.3 * r[4];
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
    content:          row[2],
    type:             row[3],
    importance_score: row[4],
    token_count:      row[7] || estimateTokens(row[2]),
    similarity:       parseFloat(similarity.toFixed(4)),
    blended:          parseFloat(blended.toFixed(4)),
    created_at:       row[6],
    structured: {
      facts:       safeJsonParse(row[9],  []),
      preferences: safeJsonParse(row[10], []),
      intent:      row[11] || '',
      entities:    safeJsonParse(row[12], {}),
    },
  }));
}

// ── Feedback ──────────────────────────────────────────────────────────────────
export async function applyFeedback({ memory_id, outcome }, config = {}) {
  const db    = await getDb(config.dbPath);
  const delta = outcome === 'positive' ? 0.1 : outcome === 'negative' ? -0.15 : null;
  if (delta === null) throw new Error('outcome must be "positive" or "negative"');

  db.exec({
    sql:  `INSERT INTO memory_feedback (id, memory_id, outcome) VALUES (?, ?, ?)`,
    bind: [uuidv4(), memory_id, outcome],
  });

  const rows = [];
  db.exec({
    sql: `UPDATE memories
          SET importance_score = MAX(0.0, MIN(1.0, importance_score + ?)),
              updated_at = datetime('now')
          WHERE id = ?
          RETURNING id, importance_score`,
    bind:     [delta, memory_id],
    callback: (row) => rows.push(row),
  });

  saveDb();
  return rows[0] ? { id: rows[0][0], importance_score: rows[0][1] } : null;
}

// ── User profile ──────────────────────────────────────────────────────────────
export async function getUserProfile(user_id, config = {}) {
  const db   = await getDb(config.dbPath);
  const rows = [];
  db.exec({
    sql: `SELECT m.id, m.type, m.content, m.importance_score, m.access_count,
                 m.token_count, m.created_at,
                 sm.facts, sm.preferences, sm.intent, sm.entities
          FROM memories m
          LEFT JOIN structured_memory sm ON sm.memory_id = m.id
          WHERE m.user_id = ?
          ORDER BY m.importance_score DESC, m.created_at DESC
          LIMIT 100`,
    bind:     [user_id],
    callback: (row) => rows.push(row),
  });

  return rows.map(r => ({
    id:               r[0],
    type:             r[1],
    content:          r[2],
    importance_score: r[3],
    access_count:     r[4],
    token_count:      r[5] || estimateTokens(r[2]),
    created_at:       r[6],
    facts:            safeJsonParse(r[7],  []),
    preferences:      safeJsonParse(r[8],  []),
    intent:           r[9]  || '',
    entities:         safeJsonParse(r[10], {}),
  }));
}

// ── Metrics (for dashboard) ───────────────────────────────────────────────────
export async function getMetrics(config = {}) {
  const db   = await getDb(config.dbPath);
  const rows = [];

  db.exec({
    sql: `SELECT
            COUNT(*)                          as total_memories,
            COUNT(DISTINCT user_id)           as total_users,
            AVG(importance_score)             as avg_importance,
            AVG(token_count)                  as avg_tokens_per_memory,
            SUM(access_count)                 as total_retrievals,
            AVG(access_count)                 as avg_access_per_memory
          FROM memories`,
    callback: (row) => rows.push(row),
  });

  const typeRows = [];
  db.exec({
    sql: `SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY count DESC`,
    callback: (row) => typeRows.push({ type: row[0], count: row[1] }),
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
    avg_importance:        parseFloat((r[2] || 0).toFixed(3)),
    avg_tokens_per_memory: parseFloat((r[3] || 0).toFixed(1)),
    total_retrievals:      r[4] || 0,
    avg_access_per_memory: parseFloat((r[5] || 0).toFixed(2)),
    by_type:               typeRows,
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
export async function compressMemories(user_id, config = {}) {
  const db = await getDb(config.dbPath);

  // Prune: old, low-importance, rarely accessed
  const pruned = { changes: 0 };
  db.exec({
    sql: `DELETE FROM memories
          WHERE user_id = ? AND importance_score < 0.2
          AND access_count < 2 AND created_at < datetime('now', '-7 days')`,
    bind: [user_id],
  });

  // Compress: old short_term → long_term summary
  const old = [];
  db.exec({
    sql: `SELECT id, content FROM memories
          WHERE user_id = ? AND type = 'short_term'
          AND created_at < datetime('now', '-7 days')
          ORDER BY created_at ASC LIMIT 50`,
    bind:     [user_id],
    callback: (row) => old.push({ id: row[0], content: row[1] }),
  });

  let compressed = 0;
  if (old.length >= 5) {
    const summary = await summarizeMemories(old.map(m => m.content), config);
    await addMemory({ user_id, type: 'long_term', content: summary }, config);
    for (const m of old) {
      db.exec({ sql: 'DELETE FROM memories WHERE id = ?', bind: [m.id] });
    }
    compressed = old.length;
  }

  // Decay: reduce importance of stale memories
  db.exec({
    sql: `UPDATE memories
          SET importance_score = MAX(0.05, importance_score * 0.9), updated_at = datetime('now')
          WHERE user_id = ?
          AND (last_accessed < datetime('now', '-14 days')
               OR (last_accessed IS NULL AND created_at < datetime('now', '-7 days')))`,
    bind: [user_id],
  });

  saveDb();
  return { compressed };
}

// ── Internals ─────────────────────────────────────────────────────────────────
function updateAccess(db, ids) {
  for (const id of ids) {
    db.exec({
      sql: `UPDATE memories
            SET access_count = access_count + 1, last_accessed = datetime('now'), updated_at = datetime('now')
            WHERE id = ?`,
      bind: [id],
    });
  }
  saveDb();
}
