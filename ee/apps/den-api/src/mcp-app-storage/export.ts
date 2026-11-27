import type { McpAppStorage } from "@openwork/types/mcp-app"
import { MCP_APP_STORAGE_TABLE, McpAppStorageBackendError, type StorageDatabaseRef } from "./backend.js"
import { buildMcpAppStorageCsv, csvRowSchema, type CsvRow } from "./csv.js"
import { getMcpAppStorageBackend } from "./index.js"
import { readMcpAppStorageRecord } from "./registry.js"

const PAGE_SIZE = 500
const MAX_CSV_ROWS = 100_000

export { buildMcpAppStorageCsv } from "./csv.js"

export class McpAppStorageCsvLimitError extends Error {}

function storageBackend() {
  const backend = getMcpAppStorageBackend()
  if (!backend) throw new McpAppStorageBackendError("The artifact storage backend is not configured.")
  return backend
}

export async function exportMcpAppStorageSqlite(ref: StorageDatabaseRef): Promise<Uint8Array | null> {
  const record = await readMcpAppStorageRecord(ref)
  if (!record || ("deletedAt" in record && record.deletedAt)) return null
  const backend = storageBackend()
  if (record.backend !== backend.kind) throw new McpAppStorageBackendError("The artifact storage backend has changed.")
  return backend.export(ref)
}

export async function exportMcpAppStorageCsv(ref: StorageDatabaseRef, input: { collection: string; fields: readonly string[] }): Promise<string> {
  const backend = storageBackend()
  const rows: CsvRow[] = []
  let last: CsvRow | undefined
  while (true) {
    const page = await backend.query(ref, {
      sql: `SELECT id, owner, created_by, created_at, updated_by, updated_at, data FROM ${MCP_APP_STORAGE_TABLE}
        WHERE collection = ? ${last ? "AND (created_at, id) > (?, ?)" : ""}
        ORDER BY created_at, id LIMIT ?`,
      params: [input.collection, ...(last ? [last.created_at, last.id] : []), PAGE_SIZE],
    })
    if (rows.length + page.rows.length > MAX_CSV_ROWS) throw new McpAppStorageCsvLimitError()
    for (const row of page.rows) {
      last = csvRowSchema.parse({ ...row, data: JSON.parse(String(row.data)) })
      rows.push(last)
    }
    if (page.rows.length < PAGE_SIZE) break
  }
  return buildMcpAppStorageCsv(input.fields, rows)
}

export async function readMcpAppStorageSummary(ref: StorageDatabaseRef, declaration: McpAppStorage | undefined) {
  const record = await readMcpAppStorageRecord(ref)
  if (!record || ("deletedAt" in record && record.deletedAt)) return null
  const backend = storageBackend()
  if (record.backend !== backend.kind) throw new McpAppStorageBackendError("The artifact storage backend has changed.")
  const result = await backend.query(ref, {
    sql: `SELECT collection, COUNT(*) AS rows FROM ${MCP_APP_STORAGE_TABLE} GROUP BY collection ORDER BY collection`,
  })
  const counts = new Map<string, number>(declaration?.collections.map(({ name }) => [name, 0]))
  for (const row of result.rows) {
    if (typeof row.collection === "string" && typeof row.rows === "number") counts.set(row.collection, row.rows)
  }
  return {
    collections: [...counts].map(([name, rows]) => ({ name, rows })),
    rowCount: record.rowCount,
    sizeBytes: record.sizeBytes,
    updatedAt: record.updatedAt.toISOString(),
  }
}
