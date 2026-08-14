// Concurrency-safe embedded SQLite. WAL lets independent MCP server processes
// share one user-owned vault without maintaining divergent in-memory copies.

import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { createRequire } from 'module';
import { getDefaultDbPath } from '../config.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
let cached = null;
let cachedPath = null;

function openDb(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function wrap(db) {
  return {
    exec({ sql, bind = [], callback } = {}) {
      const statement = sql.trim();
      if (callback) {
        const rows = db.prepare(statement).raw(true).all(...bind);
        for (const row of rows) callback(row);
      } else if (bind.length) {
        db.prepare(statement).run(...bind);
      } else {
        db.exec(statement);
      }
    },
    transaction(fn) {
      return db.transaction(fn).immediate();
    },
    close() {
      if (db.open) db.close();
    },
    _db: db,
  };
}

function migrate(db) {
  const statements = [
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
      framework TEXT NOT NULL DEFAULT 'unknown', query TEXT,
      memories_retrieved INTEGER DEFAULT 0, tokens_injected INTEGER DEFAULT 0,
      retrieval_ms INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_req_time ON request_log(created_at)`,
    `CREATE TABLE IF NOT EXISTS hippo_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  ];
  for (const sql of statements) db.exec(sql);

  const additions = [
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
  ];
  for (const sql of additions) {
    try { db.exec(sql); } catch (error) {
      if (!String(error.message).includes('duplicate column name')) throw error;
    }
  }
  db.exec("UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_mem_lifecycle ON memories(user_id, org_id, memory_key, status)");
}

export async function getDb(dbPath) {
  const path = dbPath || getDefaultDbPath();
  if (cached && cachedPath === path && cached._db.open) return cached;
  if (cached) cached.close();
  cachedPath = path;
  cached = wrap(openDb(path));
  return cached;
}

export async function getFreshDb(dbPath) {
  const path = dbPath || getDefaultDbPath();
  return {
    exec(args) {
      const connection = wrap(openDb(path));
      try { return connection.exec(args); } finally { connection.close(); }
    },
    close() {},
  };
}

export function resetDb() {
  if (cached) cached.close();
  cached = null;
  cachedPath = null;
}

// Native SQLite commits each statement/transaction directly to the WAL.
export function saveDb() {}

export function closeDb() {
  resetDb();
}
