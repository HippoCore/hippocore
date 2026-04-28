// packages/core/src/db/sqlite.js
// Hippo Core — storage layer

import { join } from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

let _db     = null;
let _capi   = null;
let _wasm   = null;
let _dbPath = null;

export async function getDb(dbPath) {
  if (_db) return _db;

  _dbPath = dbPath || join(process.cwd(), '.hippo-core', 'memory.db');
  mkdirSync(_dbPath.replace(/[\\\/][^\\\/]+$/, ''), { recursive: true });

  // Load sqlite-wasm and initialise
  const mod = await import('@sqlite.org/sqlite-wasm');
  const init = mod.default ?? mod;
  const sqlite3 = await init({ print: () => {}, printErr: () => {} });

  // The module shape changed across versions — handle both
  // Older: sqlite3.oo1.DB   Newer: sqlite3.oo1?.DB or direct sqlite3.DB
  const oo1 = sqlite3.oo1 ?? sqlite3;
  const DB  = oo1.DB ?? sqlite3.DB;

  if (typeof DB !== 'function') {
    throw new Error(
      'sqlite-wasm did not expose a DB constructor. ' +
      'Try: npm install @sqlite.org/sqlite-wasm@3.53.0-build1'
    );
  }

  _capi = sqlite3.capi ?? sqlite3;
  _wasm = sqlite3.wasm ?? sqlite3;

  // Open or restore from file
  _db = new DB();

  if (existsSync(_dbPath)) {
    try {
      const bytes = new Uint8Array(readFileSync(_dbPath));
      const ptr   = _wasm.allocFromTypedArray(bytes);
      _capi.sqlite3_deserialize(
        _db.pointer, 'main', ptr, bytes.byteLength, bytes.byteLength,
        _capi.SQLITE_DESERIALIZE_FREEONCLOSE | _capi.SQLITE_DESERIALIZE_RESIZABLE
      );
    } catch {
      // File corrupt or incompatible — start fresh
    }
  }

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
      token_count      INTEGER NOT NULL DEFAULT 0,
      access_count     INTEGER NOT NULL DEFAULT 0,
      last_accessed    TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);
    CREATE INDEX IF NOT EXISTS idx_memories_type    ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_score   ON memories(user_id, importance_score DESC);

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

    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      embedding TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_feedback (
      id         TEXT PRIMARY KEY,
      memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      outcome    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS request_log (
      id                 TEXT PRIMARY KEY,
      user_id            TEXT NOT NULL,
      query              TEXT,
      memories_retrieved INTEGER DEFAULT 0,
      memory_tokens_used INTEGER DEFAULT 0,
      total_tokens       INTEGER DEFAULT 0,
      retrieval_ms       INTEGER DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_user ON request_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_request_log_time ON request_log(created_at);
  `);
}

export function saveDb() {
  if (!_db || !_dbPath || !_capi) return;
  try {
    const data = _capi.sqlite3_js_db_export(_db.pointer);
    writeFileSync(_dbPath, Buffer.from(data));
  } catch (err) {
    console.error('[hippo-core] saveDb error:', err.message);
  }
}

export function closeDb() {
  if (_db) { saveDb(); _db.close(); _db = null; }
}
