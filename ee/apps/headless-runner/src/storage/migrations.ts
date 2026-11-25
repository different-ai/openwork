import { z } from "zod"
import type { SqlDriver } from "../sql.js"

export type Migration = {
  version: number
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

export function schemaVersion(db: SqlDriver): number {
  ensureMeta(db)
  const value = Number(readMeta(db, SCHEMA_VERSION) ?? "0")
  return Number.isInteger(value) && value >= 0 ? value : 0
}

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

export function columnsOf(db: SqlDriver, table: string): string[] {
  return z
    .array(z.object({ name: z.string() }).loose())
    .parse(db.prepare(`PRAGMA table_info(${table})`).all())
    .map((column) => column.name)
}

export function addColumn(db: SqlDriver, table: string, column: string, definition: string) {
  if (!columnsOf(db, table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
