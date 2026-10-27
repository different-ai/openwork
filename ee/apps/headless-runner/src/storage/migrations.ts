import { z } from "zod"
import type { SqlDriver } from "../sql.js"

/**
 * Numbered schema migrations, shared by every SQLite host.
 *
 * The version lives in a `meta` table, not `PRAGMA user_version`: Durable Object SQL (Cloudflare and celld) only allows
 * a short list of pragmas, and `user_version` is not on it (celld `storage.rs` `allowed_sql_pragma`; workerd's list is
 * the same). Each migration is idempotent (it may run again on a database that already has it, for example one an
 * older runner touched during a rollback) and additive: tables and nullable columns only, never a rename, drop or
 * rewrite, so the previous runner version still opens a migrated database during a switch or a rollback.
 */
export type Migration = {
  /** 1, 2, 3, …: run in order, each once per database (and harmless when repeated). */
  version: number
  /** Short stable name, for logs. */
  name: string
  up(db: SqlDriver): void
}

const META_TABLE = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
const SCHEMA_VERSION = "schema_version"
const valueRow = z.object({ value: z.string() })

export function ensureMeta(db: SqlDriver) {
  db.exec(META_TABLE)
}

export function readMeta(db: SqlDriver, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
  const parsed = valueRow.safeParse(row)
  return parsed.success ? parsed.data.value : null
}

export function writeMeta(db: SqlDriver, key: string, value: string) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value)
}

/** The database's schema version: 0 for one no numbered migration has touched (any database before them). */
export function schemaVersion(db: SqlDriver): number {
  ensureMeta(db)
  const value = Number(readMeta(db, SCHEMA_VERSION) ?? "0")
  return Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * Brings the database to the newest version: every migration above its version, in order, each in its own
 * transaction with the version bump, so a failure leaves the database at the last version that completed. A database
 * from a newer runner (a version above every migration here) is left alone: its extra tables and columns are additive.
 * Returns the versions applied.
 */
export function runMigrations(db: SqlDriver, migrations: readonly Migration[]): number[] {
  const ordered = [...migrations].sort((left, right) => left.version - right.version)
  ordered.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`migration_numbering:${migration.version}`)
  })
  const current = schemaVersion(db)
  const applied: number[] = []
  for (const migration of ordered) {
    if (migration.version <= current) continue
    db.transaction(() => {
      migration.up(db)
      writeMeta(db, SCHEMA_VERSION, String(migration.version))
    })
    applied.push(migration.version)
  }
  return applied
}

/** The columns a table has (PRAGMA table_info is allowed on every host). */
export function columnsOf(db: SqlDriver, table: string): string[] {
  return z
    .array(z.object({ name: z.string() }).loose())
    .parse(db.prepare(`PRAGMA table_info(${table})`).all())
    .map((column) => column.name)
}

/** Adds a column unless it is there: the additive, repeatable form of ALTER TABLE ADD COLUMN. */
export function addColumn(db: SqlDriver, table: string, column: string, definition: string) {
  if (!columnsOf(db, table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
