
export type StorageValue = string | number | null

export type StorageStatement = { sql: string; params?: StorageValue[] }

export type StorageDatabaseRef = { organizationId: string; appId: string }

export type StorageQueryResult = { rows: Array<Record<string, StorageValue>> }

export type StorageWriteResult = { changes: number[]; sizeBytes: number }

export type McpAppStorageSchema = { version: number; statements: string[] }

export type McpAppStorageBackendKind = "local" | "celld"

export interface McpAppStorageBackend {
  readonly kind: McpAppStorageBackendKind
  query(ref: StorageDatabaseRef, statement: StorageStatement): Promise<StorageQueryResult>
  write(ref: StorageDatabaseRef, statements: StorageStatement[]): Promise<StorageWriteResult>
  export(ref: StorageDatabaseRef): Promise<Uint8Array | null>
  delete(ref: StorageDatabaseRef): Promise<void>
}

export class McpAppStorageBackendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "McpAppStorageBackendError"
  }
}

export const MCP_APP_STORAGE_TABLE = "artifact_rows"

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
