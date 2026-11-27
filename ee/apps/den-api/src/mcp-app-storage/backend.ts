/**
 * Where an artifact's saved data lives: one SQLite database per artifact.
 *
 * A backend only stores and runs SQL. It never sees who is asking: Den decides
 * who may read or change a row before it calls a backend, and writes every
 * statement itself, so a backend needs no permission model of its own.
 *
 * Every backend applies `McpAppStorageSchema.statements` before the first
 * statement it runs on a database, and again whenever `version` is higher than
 * the one it last applied. The statements are idempotent.
 */

export type StorageValue = string | number | null

export type StorageStatement = { sql: string; params?: StorageValue[] }

/** One artifact's database. Both ids are Den type ids (`org_…`, `cob_…`), safe in a path or URL segment. */
export type StorageDatabaseRef = { organizationId: string; appId: string }

export type StorageQueryResult = { rows: Array<Record<string, StorageValue>> }

/** `changes[i]` is the number of rows statement `i` changed. `sizeBytes` is the database size after the batch. */
export type StorageWriteResult = { changes: number[]; sizeBytes: number }

export type McpAppStorageSchema = { version: number; statements: string[] }

export type McpAppStorageBackendKind = "local" | "celld"

export interface McpAppStorageBackend {
  readonly kind: McpAppStorageBackendKind
  /** Runs one read-only statement. A database that does not exist yet reads as empty. */
  query(ref: StorageDatabaseRef, statement: StorageStatement): Promise<StorageQueryResult>
  /** Runs the statements in order as one transaction: all of them apply, or none. */
  write(ref: StorageDatabaseRef, statements: StorageStatement[]): Promise<StorageWriteResult>
  /** The whole database as one SQLite file, or null when the artifact has no database. */
  export(ref: StorageDatabaseRef): Promise<Uint8Array | null>
  /** Removes the database and everything in it. Removing one that does not exist succeeds. */
  delete(ref: StorageDatabaseRef): Promise<void>
}

/** A backend failed or is not reachable. Den reports the artifact's saved data as unavailable. */
export class McpAppStorageBackendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "McpAppStorageBackendError"
  }
}

export const MCP_APP_STORAGE_TABLE = "artifact_rows"

/**
 * One table holds every collection's rows. `data` is the row's values as JSON,
 * so changing an artifact's fields never needs a migration: Den checks values
 * against the artifact's current fields when it writes and reads.
 * `owner` is the member a personal row belongs to, and NULL for a shared row.
 */
export const MCP_APP_STORAGE_SCHEMA: McpAppStorageSchema = {
  version: 1,
  statements: [
    `CREATE TABLE IF NOT EXISTS ${MCP_APP_STORAGE_TABLE} (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      owner TEXT,
      created_by TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_by_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    )`,
    `CREATE INDEX IF NOT EXISTS ${MCP_APP_STORAGE_TABLE}_recent ON ${MCP_APP_STORAGE_TABLE} (collection, owner, created_at)`,
  ],
}
