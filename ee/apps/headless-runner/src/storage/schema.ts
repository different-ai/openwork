import type { SqlDriver } from "../sql.js"
import { addColumn } from "./migrations.js"

export function storageSchema(db: SqlDriver) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      seq_from INTEGER NOT NULL,
      seq_to INTEGER NOT NULL,
      time_from INTEGER NOT NULL,
      time_to INTEGER NOT NULL,
      turns INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      format_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, n)
    );
    CREATE TABLE IF NOT EXISTS large_bodies (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      part TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY (session_id, seq, part)
    );
    CREATE INDEX IF NOT EXISTS large_bodies_by_key ON large_bodies (storage_key);
    CREATE TABLE IF NOT EXISTS index_outbox (
      session_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      fields TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      capability TEXT
    );
    CREATE INDEX IF NOT EXISTS index_outbox_by_due ON index_outbox (next_attempt_at);
    CREATE TABLE IF NOT EXISTS seal_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      error TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_deletions (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0
    );
  `)
  addColumn(db, "sessions", "hot_bytes", "INTEGER")
  addColumn(db, "sessions", "index_capability", "TEXT")
  addColumn(db, "sessions", "index_version", "INTEGER")
}
