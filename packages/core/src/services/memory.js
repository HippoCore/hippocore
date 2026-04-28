// packages/core/src/services/memory.js
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/sqlite.js';
import { embed, extractStructured, summarizeMemories } from './ai.js';

/**
 * importance = (recency × 0.3) + (frequency × 0.4) + (explicit × 0.3)
 */
function computeImportance({ recencyDays = 0, accessCount = 0, explicit = 0.5 }) {
  const DECAY = 30;
  const recency   = Math.max(0, 1 - recencyDays / DECAY);
  const frequency = Math.min(1, accessCount / 20);
  const exp       = Math.max(0, Math.min(1, explicit));
  return recency * 0.3 + frequency * 0.4 + exp * 0.3;
}

const VALID_TYPES = new Set([
  'conversation', 'event', 'preference',
  'short_term', 'long_term', 'behavioral',
]);

function normalizeType(type) {
  if (VALID_TYPES.has(type)) return type;
  const aliases = { chat: 'conversation', action: 'behavioral', fact: 'long_term' };
  return aliases[type] || 'conversation';
}

/**
 * Store a new memory. Runs embedding + extraction in parallel.
 * Returns the stored memory object.
 */
export async function addMemory({ user_id, type, content, metadata = {} }, config = {}) {
  const db = getDb(config.dbPath);
  const memoryType = normalizeType(type);
  const id = uuidv4();
  const structuredId = uuidv4();

  // Parallel AI processing — extraction + embedding at the same time
  const [embedding, structured] = await Promise.all([
    embed(content, config),
    extractStructured(content, config),
  ]);

  const importance = computeImportance({ recencyDays: 0, accessCount: 0 });
  const now = new Date().toISOString();

  // Store memory row
  db.prepare(`
    INSERT INTO memories (id, user_id, content, type, importance_score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, user_id, content, memoryType, importance, now, now);

  // Store embedding in vec0 table
  db.prepare(`
    INSERT INTO memory_embeddings (memory_id, embedding)
    VALUES (?, ?)
  `).run(id, new Float32Array(embedding));

  // Store structured extraction
  db.prepare(`
    INSERT INTO structured_memory (id, memory_id, facts, preferences, intent, entities, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    structuredId, id,
    JSON.stringify(structured.facts || []),
    JSON.stringify(structured.preferences || []),
    structured.intent || '',
    JSON.stringify(structured.entities || {}),
    now,
  );

  return {
    id,
    user_id,
    type: memoryType,
    importance_score: importance,
    created_at: now,
    structured,
  };
}

/**
 * Query memories by semantic similarity + importance blending.
 * Returns top-N most relevant memories with structured data.
 */
export async function queryMemories({ user_id, query, limit = 5, type_filter }, config = {}) {
  const db = getDb(config.dbPath);
  const safeLimit = Math.min(Math.max(1, limit), 20);

  const queryEmbedding = await embed(query, config);

  // sqlite-vec KNN query with user filter
  // We over-fetch then re-rank by blending similarity + importance
  const overFetch = Math.min(safeLimit * 4, 50);

  let vecResults;
  try {
    vecResults = db.prepare(`
      SELECT
        me.memory_id,
        me.distance
      FROM memory_embeddings me
      WHERE me.embedding MATCH ?
        AND k = ?
      ORDER BY me.distance
    `).all(new Float32Array(queryEmbedding), overFetch);
  } catch {
    // sqlite-vec not available — fall back to recency-only
    vecResults = db.prepare(`
      SELECT id as memory_id, 0.5 as distance
      FROM memories
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(user_id, overFetch);
  }

  if (!vecResults.length) return [];

  const ids = vecResults.map(r => r.memory_id);
  const distanceMap = Object.fromEntries(vecResults.map(r => [r.memory_id, r.distance]));

  // Fetch full memory data for these IDs, filtered to user
  const placeholders = ids.map(() => '?').join(',');
  const typeClause = type_filter ? `AND m.type = '${normalizeType(type_filter)}'` : '';

  const rows = db.prepare(`
    SELECT
      m.id, m.user_id, m.content, m.type,
      m.importance_score, m.access_count, m.created_at,
      sm.facts, sm.preferences, sm.intent, sm.entities
    FROM memories m
    LEFT JOIN structured_memory sm ON sm.memory_id = m.id
    WHERE m.id IN (${placeholders})
      AND m.user_id = ?
      ${typeClause}
  `).all(...ids, user_id);

  // Re-rank: blend similarity (70%) + importance (30%)
  const ranked = rows
    .map(r => {
      const distance = distanceMap[r.id] ?? 1;
      const similarity = 1 - Math.min(1, distance); // cosine: lower distance = higher similarity
      const blended = 0.7 * similarity + 0.3 * r.importance_score;
      return { ...r, similarity, blended };
    })
    .sort((a, b) => b.blended - a.blended)
    .slice(0, safeLimit);

  if (ranked.length > 0) {
    // Update access metadata (non-blocking)
    setImmediate(() => updateAccess(db, ranked.map(r => r.id)));
  }

  return ranked.map(r => ({
    id: r.id,
    user_id: r.user_id,
    content: r.content,
    type: r.type,
    importance_score: r.importance_score,
    similarity: parseFloat(r.similarity.toFixed(4)),
    created_at: r.created_at,
    structured: {
      facts:       safeJsonParse(r.facts, []),
      preferences: safeJsonParse(r.preferences, []),
      intent:      r.intent || '',
      entities:    safeJsonParse(r.entities, {}),
    },
  }));
}

/**
 * Apply positive/negative feedback — adjusts importance score.
 */
export function applyFeedback({ memory_id, outcome }, config = {}) {
  const db = getDb(config.dbPath);
  const delta = outcome === 'positive' ? 0.1 : outcome === 'negative' ? -0.15 : null;
  if (delta === null) throw new Error('outcome must be "positive" or "negative"');

  db.prepare(`
    INSERT INTO memory_feedback (id, memory_id, outcome) VALUES (?, ?, ?)
  `).run(uuidv4(), memory_id, outcome);

  const updated = db.prepare(`
    UPDATE memories
    SET importance_score = MAX(0.0, MIN(1.0, importance_score + ?)),
        updated_at = datetime('now')
    WHERE id = ?
    RETURNING id, importance_score
  `).get(delta, memory_id);

  return updated || null;
}

/**
 * Get full memory profile for a user.
 */
export function getUserProfile(user_id, config = {}) {
  const db = getDb(config.dbPath);
  return db.prepare(`
    SELECT m.id, m.type, m.content, m.importance_score, m.access_count,
           m.created_at, sm.facts, sm.preferences, sm.intent, sm.entities
    FROM memories m
    LEFT JOIN structured_memory sm ON sm.memory_id = m.id
    WHERE m.user_id = ?
    ORDER BY m.importance_score DESC, m.created_at DESC
    LIMIT 100
  `).all(user_id).map(r => ({
    ...r,
    facts:       safeJsonParse(r.facts, []),
    preferences: safeJsonParse(r.preferences, []),
    entities:    safeJsonParse(r.entities, {}),
  }));
}

/**
 * Hard delete a memory (GDPR).
 */
export function deleteMemory(memory_id, config = {}) {
  const db = getDb(config.dbPath);
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(memory_id);
  return result.changes > 0;
}

/**
 * Compress: merge short_term → long_term, prune noise.
 * Call this on a schedule (daily, or after N memories).
 */
export async function compressMemories(user_id, config = {}) {
  const db = getDb(config.dbPath);

  // Prune: old, low-importance, rarely accessed
  const pruned = db.prepare(`
    DELETE FROM memories
    WHERE user_id = ?
      AND importance_score < 0.2
      AND access_count < 2
      AND created_at < datetime('now', '-7 days')
  `).run(user_id);

  // Compress: merge 5+ old short_term into one long_term summary
  const oldShortTerm = db.prepare(`
    SELECT id, content FROM memories
    WHERE user_id = ?
      AND type = 'short_term'
      AND created_at < datetime('now', '-7 days')
    ORDER BY created_at ASC
    LIMIT 50
  `).all(user_id);

  let compressed = 0;

  if (oldShortTerm.length >= 5) {
    const summary = await summarizeMemories(oldShortTerm.map(m => m.content), config);
    await addMemory({ user_id, type: 'long_term', content: summary }, config);

    const ids = oldShortTerm.map(m => m.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
    compressed = ids.length;
  }

  // Decay: reduce importance of stale, unaccessed memories
  db.prepare(`
    UPDATE memories
    SET importance_score = MAX(0.05, importance_score * 0.9),
        updated_at = datetime('now')
    WHERE user_id = ?
      AND (last_accessed < datetime('now', '-14 days')
           OR (last_accessed IS NULL AND created_at < datetime('now', '-7 days')))
  `).run(user_id);

  return { pruned: pruned.changes, compressed };
}

// --- Internals ---

function updateAccess(db, ids) {
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE memories
    SET access_count = access_count + 1,
        last_accessed = datetime('now'),
        updated_at = datetime('now')
    WHERE id IN (${placeholders})
  `).run(...ids);
}

function safeJsonParse(val, fallback) {
  try { return val ? JSON.parse(val) : fallback; }
  catch { return fallback; }
}
