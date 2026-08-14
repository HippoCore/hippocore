// packages/core/src/db/sqlite.js
// sql.js — pure WebAssembly SQLite, works on Windows/Mac/Linux, Node 12+

import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { getDefaultDbPath } from '../config.js';

const _require = createRequire(import.meta.url);
let _db = null, _dbPath = null;

async function openDb(filePath) {
  const initSqlJs = _require('sql.js');
  const SQL = await initSqlJs();
  return existsSync(filePath)
    ? new SQL.Database(readFileSync(filePath))
    : new SQL.Database();
}

function wrap(sqlDb, filePath) {
  return {
    exec({ sql, bind = [], callback } = {}) {
      if (callback) {
        try {
          const stmt = sqlDb.prepare(sql.trim());
          if (bind.length) stmt.bind(bind);
          while (stmt.step()) callback(stmt.get());
          stmt.free();
        } catch {}
      } else if (bind.length > 0) {
        sqlDb.run(sql.trim(), bind);
        try { writeFileSync(filePath, Buffer.from(sqlDb.export())); } catch {}
      } else {
        for (const s of sql.split(';').map(s => s.trim()).filter(Boolean)) {
          try { sqlDb.run(s); } catch {}
        }
        try { writeFileSync(filePath, Buffer.from(sqlDb.export())); } catch {}
      }
    },
    close() {
      try { writeFileSync(filePath, Buffer.from(sqlDb.export())); } catch {}
      sqlDb.close();
    },
    _sqlDb: sqlDb,
  };
}

function migrate(sqlDb) {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'default', org_id TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'conversation',
      importance_score REAL NOT NULL DEFAULT 0.5, token_count INTEGER NOT NULL DEFAULT 0,
      access_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_mem_ns ON memories(user_id, agent_id, org_id)`,
    `CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type)`,
    `CREATE INDEX IF NOT EXISTS idx_mem_time ON memories(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_mem_lifecycle ON memories(user_id, org_id, memory_key, status)`,
    `CREATE TABLE IF NOT EXISTS structured_memory (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      facts TEXT NOT NULL DEFAULT '[]', preferences TEXT NOT NULL DEFAULT '[]',
      intent TEXT NOT NULL DEFAULT '', entities TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding TEXT NOT NULL, embedding_model TEXT NOT NULL DEFAULT 'unknown',
      dimensions INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS memory_feedback (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS memory_relations (
      id TEXT PRIMARY KEY,
      from_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(from_memory_id, to_memory_id, relation_type))`,
    `CREATE INDEX IF NOT EXISTS idx_rel_from ON memory_relations(from_memory_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rel_to ON memory_relations(to_memory_id)`,
    `CREATE TABLE IF NOT EXISTS memory_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_event_memory ON memory_events(memory_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS request_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'default', org_id TEXT NOT NULL DEFAULT 'default',
      framework TEXT NOT NULL DEFAULT 'unknown',
      query TEXT, memories_retrieved INTEGER DEFAULT 0,
      tokens_injected INTEGER DEFAULT 0,
      retrieval_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_req_time ON request_log(created_at)`,
    `CREATE TABLE IF NOT EXISTS hippo_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ];
  for (const s of stmts) { try { sqlDb.run(s); } catch {} }
  for (const s of [
    "ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'",
    "ALTER TABLE memories ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'",
    "ALTER TABLE memory_embeddings ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE memory_embeddings ADD COLUMN dimensions INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE request_log ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default'",
    "ALTER TABLE request_log ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'",
    "ALTER TABLE request_log ADD COLUMN framework TEXT NOT NULL DEFAULT 'unknown'",
    "ALTER TABLE request_log ADD COLUMN tokens_injected INTEGER DEFAULT 0",
    "ALTER TABLE memories ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'user'",
    "ALTER TABLE memories ADD COLUMN source_ref TEXT",
    "ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0",
    "ALTER TABLE memories ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'explicit'",
    "ALTER TABLE memories ADD COLUMN valid_from TEXT",
    "ALTER TABLE memories ADD COLUMN valid_until TEXT",
    "ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE memories ADD COLUMN memory_key TEXT",
    "ALTER TABLE memories ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
  ]) { try { sqlDb.run(s); } catch {} }

  // Existing memories predate lifecycle tracking. Treat their creation time as
  // the beginning of validity without changing their historical evidence.
  try { sqlDb.run("UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL"); } catch {}
  try { sqlDb.run("CREATE INDEX IF NOT EXISTS idx_mem_lifecycle ON memories(user_id, org_id, memory_key, status)"); } catch {}
}

// Cached connection — used by MCP server (single long-running process)
export async function getDb(dbPath) {
  const p = dbPath || getDefaultDbPath();
  if (_db && _dbPath === p) return _db;
  _dbPath = p;
  mkdirSync(p.replace(/[\\\/][^\\\/]+$/, ''), { recursive: true });
  const sqlDb = await openDb(p);
  _db = wrap(sqlDb, p);
  migrate(sqlDb);
  try { writeFileSync(p, Buffer.from(sqlDb.export())); } catch {}
  return _db;
}

// Fresh connection — always reads latest from disk (used by dashboard)
export async function getFreshDb(dbPath) {
  const p = dbPath || getDefaultDbPath();
  mkdirSync(p.replace(/[\\\/][^\\\/]+$/, ''), { recursive: true });
  const sqlDb = await openDb(p);
  return wrap(sqlDb, p);
}

// Reset cached connection
export function resetDb() { _db = null; }

export function saveDb() {
  if (_db?._sqlDb && _dbPath) {
    try { writeFileSync(_dbPath, Buffer.from(_db._sqlDb.export())); } catch {}
  }
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
