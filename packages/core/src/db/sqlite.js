// packages/core/src/db/sqlite.js
// Hippo Core — storage layer
//
// SQLite + sqlite-vec: zero infrastructure, single file, works on any machine.
// Memory lives at .hippo-core/memory.db in your project root by default.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'path';
import { mkdirSync } from 'fs';

let _db = null;

export function getDb(dbPath) {
  if (_db) return _db;

  const resolvedPath = dbPath || join(process.cwd(), '.hippo-core', 'memory.db');
  mkdirSync(resolvedPath.replace(/\/[^/]+$/, ''), { recursive: true });

  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  sqliteVec.load(_db);
  runMigrations(_db);

  return _db;
}

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      content          TEXT NOT NULL,
      type             TEXT NOT NULL DEFAULT 'conversation',
      importance_score REAL NOT NULL DEFAULT 0.5,
      access_count     INTEGER NOT NULL DEFAULT 0,
      last_accessed    TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
    CREATE INDEX IF NOT EXISTS idx_memories_type    ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

    CREATE TABLE IF NOT EXISTS structured_memory (
      id          TEXT PRIMARY KEY,
      memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      facts       TEXT NOT NULL DEFAULT '[]',
      preferences TEXT NOT NULL DEFAULT '[]',
      intent      TEXT NOT NULL DEFAULT '',
      entities    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_structured_memory_id ON structured_memory(memory_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[1536]
    );

    CREATE TABLE IF NOT EXISTS memory_feedback (
      id         TEXT PRIMARY KEY,
      memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      outcome    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}
