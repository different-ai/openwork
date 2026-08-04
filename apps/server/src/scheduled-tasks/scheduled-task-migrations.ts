import type { RuntimeSqliteDatabase } from "../runtime-db.js";

export const SCHEDULED_TASK_SCHEMA_VERSION = 3;

type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
};

function statement(database: RuntimeSqliteDatabase, sql: string): SqliteStatement {
  return database.sqlite.prepare(sql) as unknown as SqliteStatement;
}

/**
 * Scheduled Tasks owns a feature-local migration ledger so it can coexist with
 * the other runtime.sqlite stores without taking over SQLite's user_version.
 */
export function migrateScheduledTaskDatabase(database: RuntimeSqliteDatabase): void {
  database.sqlite.exec("PRAGMA foreign_keys = ON");
  database.sqlite.exec("PRAGMA busy_timeout = 5000");
  database.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS openwork_scheduled_task_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  database.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const current = Number(
      (statement(
        database,
        "SELECT COALESCE(MAX(version), 0) AS version FROM openwork_scheduled_task_migrations",
      ).get() as { version?: number } | undefined)?.version ?? 0,
    );
    if (current < 1) {
      database.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS openwork_scheduled_tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          state TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          draft_revision_id TEXT NOT NULL,
          active_revision_id TEXT,
          active_grant_id TEXT,
          next_run_at INTEGER,
          needs_attention_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS openwork_scheduled_tasks_workspace_idx
          ON openwork_scheduled_tasks(workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS openwork_scheduled_tasks_due_idx
          ON openwork_scheduled_tasks(enabled, next_run_at);

        CREATE TABLE IF NOT EXISTS openwork_scheduled_task_revisions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES openwork_scheduled_tasks(id) ON DELETE RESTRICT,
          revision INTEGER NOT NULL,
          definition_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          reviewed_at INTEGER,
          reviewed_by TEXT,
          UNIQUE(task_id, revision)
        );
        CREATE INDEX IF NOT EXISTS openwork_scheduled_task_revisions_task_idx
          ON openwork_scheduled_task_revisions(task_id, revision DESC);

        CREATE TABLE IF NOT EXISTS openwork_scheduled_task_grants (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES openwork_scheduled_tasks(id) ON DELETE RESTRICT,
          revision INTEGER NOT NULL,
          task_revision_id TEXT NOT NULL REFERENCES openwork_scheduled_task_revisions(id) ON DELETE RESTRICT,
          workspace_id TEXT NOT NULL,
          grant_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(task_id, revision)
        );
        CREATE INDEX IF NOT EXISTS openwork_scheduled_task_grants_task_idx
          ON openwork_scheduled_task_grants(task_id, revision DESC);

        CREATE TABLE IF NOT EXISTS openwork_scheduled_task_grant_revocations (
          grant_id TEXT PRIMARY KEY REFERENCES openwork_scheduled_task_grants(id) ON DELETE RESTRICT,
          revoked_at INTEGER NOT NULL,
          reason TEXT NOT NULL,
          revoked_by TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS openwork_scheduled_task_occurrences (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES openwork_scheduled_tasks(id) ON DELETE RESTRICT,
          task_revision_id TEXT NOT NULL REFERENCES openwork_scheduled_task_revisions(id) ON DELETE RESTRICT,
          scheduled_for INTEGER,
          trigger TEXT NOT NULL,
          status TEXT NOT NULL,
          claimed_at INTEGER NOT NULL,
          run_id TEXT,
          UNIQUE(task_id, task_revision_id, scheduled_for, trigger)
        );
        CREATE INDEX IF NOT EXISTS openwork_scheduled_task_occurrences_task_idx
          ON openwork_scheduled_task_occurrences(task_id, scheduled_for DESC);

        CREATE TABLE IF NOT EXISTS openwork_scheduled_task_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES openwork_scheduled_tasks(id) ON DELETE RESTRICT,
          task_revision_id TEXT NOT NULL REFERENCES openwork_scheduled_task_revisions(id) ON DELETE RESTRICT,
          grant_revision_id TEXT NOT NULL REFERENCES openwork_scheduled_task_grants(id) ON DELETE RESTRICT,
          occurrence_id TEXT NOT NULL REFERENCES openwork_scheduled_task_occurrences(id) ON DELETE RESTRICT,
          trigger TEXT NOT NULL,
          status TEXT NOT NULL,
          scheduled_for INTEGER,
          claimed_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          duration_ms INTEGER,
          idempotency_key TEXT NOT NULL UNIQUE,
          session_id TEXT,
          attempt_count INTEGER NOT NULL,
          bounded_usage_json TEXT NOT NULL,
          error_json TEXT,
          needs_attention_json TEXT,
          artifacts_json TEXT NOT NULL,
          cancel_requested_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(occurrence_id)
        );
        CREATE INDEX IF NOT EXISTS openwork_scheduled_task_runs_task_idx
          ON openwork_scheduled_task_runs(task_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS openwork_scheduled_task_runs_active_idx
          ON openwork_scheduled_task_runs(task_id, status, updated_at);

        CREATE TABLE IF NOT EXISTS openwork_scheduled_task_attempts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES openwork_scheduled_task_runs(id) ON DELETE RESTRICT,
          attempt INTEGER NOT NULL,
          status TEXT NOT NULL,
          session_id TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          error_json TEXT,
          UNIQUE(run_id, attempt)
        );
        CREATE INDEX IF NOT EXISTS openwork_scheduled_task_attempts_run_idx
          ON openwork_scheduled_task_attempts(run_id, attempt);
      `);
      statement(
        database,
        "INSERT INTO openwork_scheduled_task_migrations(version, applied_at) VALUES (?, ?)",
      ).run(1, Date.now());
    }
    if (current < 2) {
      database.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS openwork_scheduled_task_grant_revocations (
          grant_id TEXT PRIMARY KEY REFERENCES openwork_scheduled_task_grants(id) ON DELETE RESTRICT,
          revoked_at INTEGER NOT NULL,
          reason TEXT NOT NULL,
          revoked_by TEXT NOT NULL
        )
      `);
      statement(
        database,
        "INSERT INTO openwork_scheduled_task_migrations(version, applied_at) VALUES (?, ?)",
      ).run(2, Date.now());
    }
    if (current < 3) {
      database.sqlite.exec(`
        ALTER TABLE openwork_scheduled_task_runs ADD COLUMN placement_json TEXT
      `);
      statement(
        database,
        "INSERT INTO openwork_scheduled_task_migrations(version, applied_at) VALUES (?, ?)",
      ).run(3, Date.now());
    }
    database.sqlite.exec("COMMIT");
  } catch (error) {
    database.sqlite.exec("ROLLBACK");
    throw error;
  }
}
