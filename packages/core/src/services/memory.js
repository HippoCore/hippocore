// packages/core/src/services/memory.js
// Hippo Core memory engine
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
import { embed, extractStructured, extractMemoryItems, summarizeMemories, estimateTokens } from './ai.js';

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

function terms(text) {
  return new Set((text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
}

export function lexicalSimilarity(query, content) {
  const q = terms(query);
  const c = terms(content);
  if (!q.size || !c.size) return 0;
  let overlap = 0;
  for (const token of q) if (c.has(token)) overlap++;
  return overlap / q.size;
}

// Normalise namespace — all three fields always present
function ns(params) {
  return {
    user_id:  params.user_id  || params.userId  || 'anonymous',
    agent_id: params.agent_id || params.agentId || 'default',
    org_id:   params.org_id   || params.orgId   || 'default',
  };
}

function clampConfidence(value, fallback = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function addEvent(db, memoryId, eventType, details = {}, actor = 'system') {
  db.exec({
    sql: `INSERT INTO memory_events (id, memory_id, event_type, actor, details) VALUES (?, ?, ?, ?, ?)`,
    bind: [uuidv4(), memoryId, eventType, actor, JSON.stringify(details)],
  });
}

function addRelation(db, fromId, toId, relationType) {
  db.exec({
    sql: `INSERT OR IGNORE INTO memory_relations (id, from_memory_id, to_memory_id, relation_type)
          VALUES (?, ?, ?, ?)`,
    bind: [uuidv4(), fromId, toId, relationType],
  });
}

// ── Add memory ────────────────────────────────────────────────────────────────
export async function addMemory(params, config = {}) {
  const { user_id, agent_id, org_id } = ns(params);
  const { type, content } = params;
  if (typeof content !== 'string' || !content.trim()) throw new Error('content is required');
  const db         = await getDb(config.dbPath);
  const memoryType = normalizeType(type);
  const normalizedContent = content.trim();

  const structured = params.structured || await extractStructured(normalizedContent, config);

  const shouldRemember = params.should_remember ?? params.shouldRemember ?? structured.should_remember;
  if (shouldRemember === false) {
    return { skipped: true, reason: structured.reason || 'Memory policy rejected low-signal content' };
  }

  const embedding = await embed(normalizedContent, config);

  const memoryKey = params.memory_key || params.memoryKey || structured.memory_key || null;
  const validFrom = params.valid_from || params.validFrom || structured.valid_from || new Date().toISOString();
  const validUntil = params.valid_until || params.validUntil || structured.valid_until || null;
  const sourceKind = params.source_kind || params.sourceKind || 'user';
  const sourceRef = params.source_ref || params.sourceRef || null;
  const evidenceStatus = params.evidence_status || params.evidenceStatus || (sourceKind === 'user' ? 'explicit' : 'inferred');
  const confidence = clampConfidence(params.confidence ?? structured.confidence, evidenceStatus === 'explicit' ? 1 : 0.6);
  const conflictMode = params.conflict_mode || params.conflictMode || 'supersede';
  const actor = params.actor || agent_id;

  const duplicate = [];
  db.exec({
    sql: `SELECT id, importance_score, created_at FROM memories
          WHERE user_id = ? AND agent_id = ? AND org_id = ? AND type = ? AND content = ? LIMIT 1`,
    bind: [user_id, agent_id, org_id, memoryType, normalizedContent],
    callback: row => duplicate.push(row),
  });
  if (duplicate.length) {
    return { id: duplicate[0][0], user_id, agent_id, org_id, type: memoryType,
      importance_score: duplicate[0][1], created_at: duplicate[0][2], duplicate: true };
  }
  const id         = uuidv4();
  const structId   = uuidv4();

  const importance   = computeImportance({ recencyDays: 0, accessCount: 0 });
  const tokenCount   = estimateTokens(normalizedContent);
  const now          = new Date().toISOString();
  const embModel     = config.embeddingModel || 'text-embedding-3-small';
  const dimensions   = embedding.length;

  const prior = [];
  let initialStatus = 'active';
  db.transaction(() => {
    if (memoryKey) {
      db.exec({
        sql: `SELECT id, content, valid_from FROM memories
              WHERE user_id = ? AND org_id = ? AND memory_key = ? AND status = 'active'
              ORDER BY valid_from DESC, created_at DESC LIMIT 1`,
        bind: [user_id, org_id, memoryKey],
        callback: row => prior.push({ id: row[0], content: row[1], valid_from: row[2] }),
      });
    }

    initialStatus = prior.length && conflictMode === 'dispute' ? 'disputed' : 'active';

    db.exec({
    sql: `INSERT INTO memories
            (id, user_id, agent_id, org_id, content, type, importance_score, token_count,
             source_kind, source_ref, confidence, evidence_status, valid_from, valid_until,
             status, memory_key, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [id, user_id, agent_id, org_id, normalizedContent, memoryType, importance, tokenCount,
      sourceKind, sourceRef, confidence, evidenceStatus, validFrom, validUntil, initialStatus,
      memoryKey, JSON.stringify(params.metadata || {}), now, now],
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

  addEvent(db, id, 'created', { source_kind: sourceKind, source_ref: sourceRef, confidence, evidence_status: evidenceStatus }, actor);

  if (prior.length) {
    const previous = prior[0];
    if (conflictMode === 'dispute') {
      db.exec({ sql: `UPDATE memories SET status = 'disputed', updated_at = ? WHERE id = ?`, bind: [now, previous.id] });
      addRelation(db, id, previous.id, 'contradicts');
      addEvent(db, id, 'disputed', { contradicts: previous.id }, actor);
      addEvent(db, previous.id, 'disputed', { contradicted_by: id }, actor);
    } else {
      db.exec({
        sql: `UPDATE memories SET status = 'superseded', valid_until = ?, updated_at = ? WHERE id = ?`,
        bind: [validFrom, now, previous.id],
      });
      addRelation(db, id, previous.id, 'supersedes');
      addEvent(db, id, 'supersedes', { memory_id: previous.id }, actor);
      addEvent(db, previous.id, 'superseded', { by_memory_id: id }, actor);
    }
  }
    });

  saveDb();
  return {
    id, user_id, agent_id, org_id, type: memoryType, importance_score: importance,
    created_at: now, structured, status: initialStatus, memory_key: memoryKey,
    provenance: { source_kind: sourceKind, source_ref: sourceRef, evidence_status: evidenceStatus, confidence },
    valid_from: validFrom, valid_until: validUntil, supersedes: prior.length && conflictMode !== 'dispute' ? prior[0].id : null,
  };
}

export async function addMemories(params, config = {}) {
  const { content } = params;
  if (typeof content !== 'string' || !content.trim()) throw new Error('content is required');
  const extraction = await extractMemoryItems(content.trim(), config);
  const items = Array.isArray(extraction.memories) ? extraction.memories : [];
  if (extraction.should_remember === false || !items.length) {
    return { memories: [], skipped: true, reason: extraction.reason || 'No durable atomic memories found' };
  }

  const memories = [];
  for (const item of items) {
    if (!item || typeof item.content !== 'string' || !item.content.trim()) continue;
    const structured = {
      facts: item.facts || [], preferences: item.preferences || [], intent: item.intent || '',
      entities: item.entities || {}, should_remember: true, memory_key: item.memory_key || null,
      confidence: item.confidence, valid_from: item.valid_from, valid_until: item.valid_until,
    };
    const result = await addMemory({
      ...params,
      content: item.content,
      type: item.type || params.type || 'long_term',
      memory_key: item.memory_key || params.memory_key || null,
      confidence: item.confidence ?? params.confidence,
      valid_from: item.valid_from || params.valid_from,
      valid_until: item.valid_until || params.valid_until,
      source_ref: item.source_ref || params.source_ref,
      metadata: { ...(params.metadata || {}), extraction_reason: extraction.reason || '', source_interaction: content },
      structured,
    }, config);
    if (!result.skipped) memories.push(result);
  }
  return { memories, skipped: memories.length === 0, reason: memories.length ? null : 'No valid atomic memories found' };
}

// ── Query memories ────────────────────────────────────────────────────────────
export async function queryMemories(params, config = {}) {
  const { user_id, agent_id, org_id } = ns(params);
  const {
    query,
    limit          = 5,
    type_filter,
    scope          = 'user',       // 'user' | 'agent' | 'org' | 'user+agent'
    retrievalLimit = 5000,
    include_history = false,
  } = params;

  const db        = await getDb(config.dbPath);
  const safeLimit = Math.min(Math.max(1, limit), 20);
  const candidates = Math.min(Math.max(1, retrievalLimit), config.retrievalLimit || 5000);

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
  const lifecycleClause = include_history ? '' : `AND m.status = 'active' AND (m.valid_until IS NULL OR datetime(m.valid_until) > datetime('now'))`;

  const rows = [];
  db.exec({
    sql: `SELECT m.id, m.user_id, m.agent_id, m.org_id, m.content, m.type,
                 m.importance_score, m.access_count, m.created_at, m.token_count,
                 me.embedding, me.embedding_model,
                 sm.facts, sm.preferences, sm.intent, sm.entities,
                 m.source_kind, m.source_ref, m.confidence, m.evidence_status,
                 m.valid_from, m.valid_until, m.status, m.memory_key, m.metadata
          FROM memories m
          LEFT JOIN memory_embeddings me ON me.memory_id = m.id
          LEFT JOIN structured_memory sm ON sm.memory_id = m.id
          WHERE ${scopeClause} ${typeClause} ${lifecycleClause}
          ORDER BY m.created_at DESC
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
      const lexical    = lexicalSimilarity(query, `${r[4]} ${r[12] || ''} ${r[13] || ''} ${r[14] || ''}`);
      const confidence = clampConfidence(r[18], 1);
      const blended    = 0.55 * similarity + 0.15 * lexical + 0.15 * r[6] + 0.15 * confidence;
      return { row: r, similarity, lexical, blended };
    })
    .sort((a, b) => b.blended - a.blended)
    .slice(0, safeLimit);

  if (scored.length > 0) {
    updateAccess(db, scored.map(s => s.row[0]));
  }

  return scored.map(({ row, similarity, lexical, blended }) => ({
    id:               row[0],
    user_id:          row[1],
    agent_id:         row[2],
    org_id:           row[3],
    content:          row[4],
    type:             row[5],
    importance_score: row[6],
    token_count:      row[9] || estimateTokens(row[4]),
    similarity:       parseFloat(similarity.toFixed(4)),
    lexical:          parseFloat(lexical.toFixed(4)),
    blended:          parseFloat(blended.toFixed(4)),
    created_at:       row[8],
    status:           row[22],
    memory_key:       row[23],
    valid_from:       row[20],
    valid_until:      row[21],
    provenance: {
      source_kind:    row[16],
      source_ref:     row[17],
      confidence:     row[18],
      evidence_status: row[19],
    },
    metadata: safeJsonParse(row[24], {}),
    explanation: {
      summary: `Selected as ${row[22]} memory with blended score ${blended.toFixed(4)}`,
      signals: {
        semantic_similarity: parseFloat(similarity.toFixed(4)),
        lexical_overlap: parseFloat(lexical.toFixed(4)),
        importance: parseFloat(Number(row[6]).toFixed(4)),
        confidence: parseFloat(Number(row[18]).toFixed(4)),
      },
      evidence: { source_kind: row[16], source_ref: row[17], evidence_status: row[19] },
    },
    structured: {
      facts:       safeJsonParse(row[12], []),
      preferences: safeJsonParse(row[13], []),
      intent:      row[14] || '',
      entities:    safeJsonParse(row[15], {}),
    },
  }));
}

// ── Feedback ──────────────────────────────────────────────────────────────────
export async function getMemoryHistory(params, config = {}) {
  const { user_id, org_id } = ns(params);
  const memoryKey = params.memory_key || params.memoryKey;
  if (!memoryKey) throw new Error('memory_key is required');
  const db = await getDb(config.dbPath);
  const rows = [];
  db.exec({
    sql: `SELECT id, content, type, status, confidence, evidence_status, source_kind, source_ref,
                 valid_from, valid_until, created_at, metadata
          FROM memories WHERE user_id = ? AND org_id = ? AND memory_key = ?
          ORDER BY valid_from ASC, created_at ASC`,
    bind: [user_id, org_id, memoryKey],
    callback: row => rows.push({
      id: row[0], content: row[1], type: row[2], status: row[3], confidence: row[4],
      evidence_status: row[5], source_kind: row[6], source_ref: row[7],
      valid_from: row[8], valid_until: row[9], created_at: row[10], metadata: safeJsonParse(row[11], {}),
    }),
  });
  for (const memory of rows) {
    memory.events = [];
    db.exec({
      sql: `SELECT event_type, actor, details, created_at FROM memory_events
            WHERE memory_id = ? ORDER BY created_at ASC`,
      bind: [memory.id],
      callback: row => memory.events.push({ type: row[0], actor: row[1], details: safeJsonParse(row[2], {}), created_at: row[3] }),
    });
    memory.relations = [];
    db.exec({
      sql: `SELECT from_memory_id, to_memory_id, relation_type, created_at FROM memory_relations
            WHERE from_memory_id = ? OR to_memory_id = ? ORDER BY created_at ASC`,
      bind: [memory.id, memory.id],
      callback: row => memory.relations.push({ from: row[0], to: row[1], type: row[2], created_at: row[3] }),
    });
  }
  return rows;
}

export async function resolveConflict({ winner_id, loser_ids = [], actor = 'user' }, config = {}) {
  if (!winner_id) throw new Error('winner_id is required');
  const db = await getDb(config.dbPath);
  const now = new Date().toISOString();
  db.exec({ sql: `UPDATE memories SET status = 'active', valid_until = NULL, updated_at = ? WHERE id = ?`, bind: [now, winner_id] });
  addEvent(db, winner_id, 'conflict_resolved', { outcome: 'winner', loser_ids }, actor);
  for (const loserId of loser_ids) {
    db.exec({ sql: `UPDATE memories SET status = 'superseded', valid_until = ?, updated_at = ? WHERE id = ?`, bind: [now, now, loserId] });
    addRelation(db, winner_id, loserId, 'supersedes');
    addEvent(db, loserId, 'conflict_resolved', { outcome: 'superseded', winner_id }, actor);
  }
  saveDb();
  return { winner_id, superseded: loser_ids, resolved_at: now };
}

export async function retractMemory(memory_id, reason = '', config = {}) {
  const db = await getDb(config.dbPath);
  const now = new Date().toISOString();
  db.exec({ sql: `UPDATE memories SET status = 'retracted', valid_until = ?, updated_at = ? WHERE id = ?`, bind: [now, now, memory_id] });
  addEvent(db, memory_id, 'retracted', { reason }, 'user');
  saveDb();
  return { id: memory_id, status: 'retracted', retracted_at: now };
}

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
                 sm.facts, sm.preferences, sm.intent, sm.entities,
                 m.status, m.memory_key, m.source_kind, m.source_ref, m.confidence,
                 m.evidence_status, m.valid_from, m.valid_until
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
    status: r[13], memory_key: r[14], source_kind: r[15], source_ref: r[16],
    confidence: r[17], evidence_status: r[18], valid_from: r[19], valid_until: r[20],
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

  const statusRows = [];
  db.exec({
    sql: `SELECT status, COUNT(*) as count FROM memories GROUP BY status ORDER BY count DESC`,
    callback: row => statusRows.push({ status: row[0], count: row[1] }),
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
    by_status:             statusRows,
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
