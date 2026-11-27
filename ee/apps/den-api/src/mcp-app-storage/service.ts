import { randomUUID } from "node:crypto"
import {
  MCP_APP_STORAGE_MAX_ROW_BYTES,
  MCP_APP_STORAGE_MAX_TEXT_LENGTH,
  mcpAppStorageReadInputSchema,
  mcpAppStorageWriteInputSchema,
  type McpAppStorage,
  type McpAppStorageCollection,
  type McpAppStorageField,
  type McpAppStorageReadOutput,
  type McpAppStorageRow,
  type McpAppStorageWriteOutput,
} from "@openwork/types/mcp-app"
import {
  MCP_APP_STORAGE_TABLE,
  McpAppStorageBackendError,
  type McpAppStorageBackend,
  type StorageDatabaseRef,
  type McpAppStorageBackendKind,
  type StorageStatement,
  type StorageValue,
} from "./backend.js"

const TABLE = MCP_APP_STORAGE_TABLE
const DEFAULT_READ_ROWS = 50
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/u

export class McpAppStorageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "McpAppStorageError"
  }
}

export type McpAppStorageActor = { memberId: string; name: string }

export type McpAppStorageRegistry = {
  read(ref: StorageDatabaseRef): Promise<{ sizeBytes: number } | null>
  record(ref: StorageDatabaseRef, usage: { backend: McpAppStorageBackendKind; rowCount: number; sizeBytes: number }): Promise<void>
}

export type McpAppStorageAccess = {
  ref: StorageDatabaseRef
  storage: McpAppStorage
  actor: McpAppStorageActor
  backend: McpAppStorageBackend
  limits: { maxRows: number; maxBytes: number }
  registry: McpAppStorageRegistry
}

type FieldValue = string | number | boolean | null
type StoredRow = Record<string, StorageValue>

function collectionOf(access: McpAppStorageAccess, name: string): McpAppStorageCollection {
  const collection = access.storage.collections.find((candidate) => candidate.name === name)
  if (!collection) {
    throw new McpAppStorageError("unknown_collection", `This artifact does not save "${name}". It saves: ${access.storage.collections.map((candidate) => candidate.name).join(", ")}.`)
  }
  return collection
}

function fieldOf(collection: McpAppStorageCollection, name: string): McpAppStorageField {
  const field = collection.fields.find((candidate) => candidate.name === name)
  if (!field) throw new McpAppStorageError("unknown_field", `"${name}" is not a field of ${collection.name}. Its fields are: ${collection.fields.map((candidate) => candidate.name).join(", ")}.`)
  return field
}

function label(field: McpAppStorageField): string {
  const words = field.name.replace(/_/gu, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function checkedValue(field: McpAppStorageField, value: FieldValue): FieldValue {
  if (value === null) return null
  if (field.type === "text") {
    if (typeof value !== "string") throw new McpAppStorageError("invalid_value", `${label(field)} must be text.`)
    const text = value.trim()
    if (text.length > MCP_APP_STORAGE_MAX_TEXT_LENGTH) throw new McpAppStorageError("invalid_value", `${label(field)} must be at most ${MCP_APP_STORAGE_MAX_TEXT_LENGTH} characters.`)
    if (field.options && text !== "" && !field.options.includes(text)) {
      throw new McpAppStorageError("invalid_value", `${label(field)} must be one of: ${field.options.join(", ")}.`)
    }
    return text === "" ? null : text
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new McpAppStorageError("invalid_value", `${label(field)} must be a number.`)
    return value
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new McpAppStorageError("invalid_value", `${label(field)} must be true or false.`)
    return value
  }
  if (typeof value !== "string" || !(ISO_DATE.test(value) || ISO_DATE_TIME.test(value)) || Number.isNaN(Date.parse(value))) {
    throw new McpAppStorageError("invalid_value", `${label(field)} must be a date such as 2026-03-01.`)
  }
  return value
}

function matchesField(field: McpAppStorageField, value: unknown): value is FieldValue {
  if (value === null) return true
  if (field.type === "number") return typeof value === "number"
  if (field.type === "boolean") return typeof value === "boolean"
  return typeof value === "string"
}

function storedData(text: StorageValue | undefined): Record<string, unknown> {
  if (typeof text !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {}
  } catch {
    return {}
  }
}

function publicRow(collection: McpAppStorageCollection, row: StoredRow, actor: McpAppStorageActor): McpAppStorageRow {
  const data = storedData(row.data)
  const values: Record<string, FieldValue> = {}
  for (const field of collection.fields) {
    const value = data[field.name]
    values[field.name] = value !== undefined && matchesField(field, value) ? value : null
  }
  const text = (value: StorageValue | undefined) => typeof value === "string" ? value : ""
  return {
    id: text(row.id),
    values,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    createdBy: text(row.created_by_name),
    updatedBy: text(row.updated_by_name),
    mine: row.created_by === actor.memberId,
  }
}

function visibility(collection: McpAppStorageCollection, actor: McpAppStorageActor): { sql: string; params: StorageValue[] } {
  return collection.scope === "personal"
    ? { sql: "collection = ? AND owner = ?", params: [collection.name, actor.memberId] }
    : { sql: "collection = ? AND owner IS NULL", params: [collection.name] }
}

function jsonPath(field: string): string {
  return `$.${field}`
}

function sqlValue(value: FieldValue): StorageValue {
  return typeof value === "boolean" ? (value ? 1 : 0) : value
}

async function run<Result>(access: McpAppStorageAccess, work: () => Promise<Result>): Promise<Result> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof McpAppStorageBackendError) {
      console.error("mcp_app_storage_failed", { organizationId: access.ref.organizationId, appId: access.ref.appId, backend: access.backend.kind, error: error.message })
      throw new McpAppStorageError("storage_unavailable", "Saved data is unavailable right now. Try again in a moment.")
    }
    throw error
  }
}

export async function readMcpAppStorage(access: McpAppStorageAccess, rawInput: unknown): Promise<McpAppStorageReadOutput> {
  const parsed = mcpAppStorageReadInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new McpAppStorageError("invalid_input", "Reading saved data takes a collection and optional where, orderBy, order, limit, and offset.")
  const input = parsed.data
  const collection = collectionOf(access, input.collection)
  const visible = visibility(collection, access.actor)
  const filters: string[] = [visible.sql]
  const params: StorageValue[] = [...visible.params]
  for (const [name, value] of Object.entries(input.where ?? {})) {
    const field = fieldOf(collection, name)
    const checked = checkedValue(field, value)
    if (checked === null) {
      filters.push("json_extract(data, ?) IS NULL")
      params.push(jsonPath(field.name))
    } else {
      filters.push("json_extract(data, ?) = ?")
      params.push(jsonPath(field.name), sqlValue(checked))
    }
  }
  const direction = (input.order ?? "desc") === "asc" ? "ASC" : "DESC"
  const orderParams: StorageValue[] = []
  let orderSql = `created_at ${direction}`
  if (input.orderBy === "updatedAt") orderSql = `updated_at ${direction}`
  else if (input.orderBy !== undefined && input.orderBy !== "createdAt") {
    orderSql = `json_extract(data, ?) ${direction}`
    orderParams.push(jsonPath(fieldOf(collection, input.orderBy).name))
  }
  const limit = input.limit ?? DEFAULT_READ_ROWS
  const offset = input.offset ?? 0
  const where = filters.join(" AND ")
  const [rows, count] = await run(access, () => Promise.all([
    access.backend.query(access.ref, {
      sql: `SELECT id, created_by, created_by_name, updated_by_name, created_at, updated_at, data FROM ${TABLE} WHERE ${where} ORDER BY ${orderSql}, id ASC LIMIT ? OFFSET ?`,
      params: [...params, ...orderParams, limit, offset],
    }),
    access.backend.query(access.ref, { sql: `SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${where}`, params }),
  ]))
  const total = count.rows[0]?.total
  return {
    collection: collection.name,
    rows: rows.rows.map((row) => publicRow(collection, row, access.actor)),
    total: typeof total === "number" ? total : 0,
    limit,
    offset,
  }
}

function checkedValues(collection: McpAppStorageCollection, values: Record<string, FieldValue>): Record<string, FieldValue> {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, checkedValue(fieldOf(collection, name), value)]))
}

function requireComplete(collection: McpAppStorageCollection, data: Record<string, unknown>): void {
  const missing = collection.fields.filter((field) => field.required && (data[field.name] === undefined || data[field.name] === null))
  if (missing.length > 0) throw new McpAppStorageError("missing_value", `${missing.map(label).join(", ")} ${missing.length === 1 ? "is" : "are"} required.`)
}

function encoded(data: Record<string, unknown>): string {
  const kept = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null && value !== undefined))
  const text = JSON.stringify(kept)
  if (Buffer.byteLength(text) > MCP_APP_STORAGE_MAX_ROW_BYTES) {
    throw new McpAppStorageError("row_too_large", `One entry can hold at most ${MCP_APP_STORAGE_MAX_ROW_BYTES / 1024} KB. Shorten it and try again.`)
  }
  return text
}

async function visibleRow(access: McpAppStorageAccess, collection: McpAppStorageCollection, id: string): Promise<StoredRow> {
  const visible = visibility(collection, access.actor)
  const found = await access.backend.query(access.ref, {
    sql: `SELECT id, created_by, created_by_name, updated_by_name, created_at, updated_at, data FROM ${TABLE} WHERE ${visible.sql} AND id = ? LIMIT 1`,
    params: [...visible.params, id],
  })
  const row = found.rows[0]
  if (!row) throw new McpAppStorageError("row_not_found", "That entry no longer exists. Reload to see the latest.")
  return row
}

function editRule(collection: McpAppStorageCollection, actor: McpAppStorageActor, row: StoredRow): { sql: string; params: StorageValue[] } {
  if (collection.scope === "personal" || collection.edit !== "creator") return { sql: "", params: [] }
  if (row.created_by !== actor.memberId) {
    throw new McpAppStorageError("not_allowed", "Only the person who added this entry can change or remove it.")
  }
  return { sql: " AND created_by = ?", params: [actor.memberId] }
}

async function writeAndRecord(access: McpAppStorageAccess, statement: StorageStatement): Promise<number> {
  const registry = access.registry
  const result = await access.backend.write(access.ref, [statement])
  const counted = await access.backend.query(access.ref, { sql: `SELECT COUNT(*) AS total FROM ${TABLE}` }).catch(() => null)
  const total = counted?.rows[0]?.total
  await registry.record(access.ref, { backend: access.backend.kind, rowCount: typeof total === "number" ? total : 0, sizeBytes: result.sizeBytes }).catch((error: unknown) => {
    console.error("mcp_app_storage_usage_not_recorded", { organizationId: access.ref.organizationId, appId: access.ref.appId, error: error instanceof Error ? error.message : String(error) })
  })
  return result.changes[0] ?? 0
}

export async function writeMcpAppStorage(access: McpAppStorageAccess, rawInput: unknown): Promise<McpAppStorageWriteOutput> {
  const parsed = mcpAppStorageWriteInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new McpAppStorageError("invalid_input", "Changing saved data takes a collection, an action (insert, update, or delete), an id for update and delete, and values for insert and update.")
  const input = parsed.data
  const collection = collectionOf(access, input.collection)
  const registry = access.registry
  const actor = access.actor
  const now = new Date().toISOString()
  return run(access, async () => {
    if (input.action === "delete") {
      if (!input.id) throw new McpAppStorageError("invalid_input", "Removing an entry needs its id.")
      const row = await visibleRow(access, collection, input.id)
      const visible = visibility(collection, actor)
      const rule = editRule(collection, actor, row)
      const changed = await writeAndRecord(access, {
        sql: `DELETE FROM ${TABLE} WHERE ${visible.sql} AND id = ?${rule.sql}`,
        params: [...visible.params, input.id, ...rule.params],
      })
      if (changed === 0) throw new McpAppStorageError("row_not_found", "That entry no longer exists. Reload to see the latest.")
      return { collection: collection.name, action: "delete", id: input.id }
    }

    const known = await registry.read(access.ref)
    if (known && known.sizeBytes >= access.limits.maxBytes) {
      throw new McpAppStorageError("storage_full", "This artifact's saved data is full. Remove entries you no longer need, or ask an OpenWork admin to export and clear it.")
    }
    const values = checkedValues(collection, input.values ?? {})

    if (input.action === "insert") {
      if (input.id) throw new McpAppStorageError("invalid_input", "OpenWork sets the id of a new entry. Leave id out.")
      requireComplete(collection, values)
      const data = encoded(values)
      if (!known) await registry.record(access.ref, { backend: access.backend.kind, rowCount: 0, sizeBytes: 0 })
      const id = randomUUID()
      const owner = collection.scope === "personal" ? actor.memberId : null
      const changed = await writeAndRecord(access, {
        sql: `INSERT INTO ${TABLE} (collection, id, owner, created_by, created_by_name, updated_by, updated_by_name, created_at, updated_at, data)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM ${TABLE}) < ?`,
        params: [collection.name, id, owner, actor.memberId, actor.name, actor.memberId, actor.name, now, now, data, access.limits.maxRows],
      })
      if (changed === 0) {
        throw new McpAppStorageError("storage_full", `This artifact can hold ${access.limits.maxRows.toLocaleString("en-US")} entries and is full. Remove entries you no longer need, or ask an OpenWork admin to export and clear it.`)
      }
      return { collection: collection.name, action: "insert", id, row: publicRow(collection, await visibleRow(access, collection, id), actor) }
    }

    if (!input.id) throw new McpAppStorageError("invalid_input", "Changing an entry needs its id.")
    if (Object.keys(values).length === 0) throw new McpAppStorageError("invalid_input", "Changing an entry needs at least one value.")
    const row = await visibleRow(access, collection, input.id)
    const rule = editRule(collection, actor, row)
    const merged = { ...storedData(row.data), ...values }
    requireComplete(collection, merged)
    const visible = visibility(collection, actor)
    const changed = await writeAndRecord(access, {
      sql: `UPDATE ${TABLE} SET data = ?, updated_by = ?, updated_by_name = ?, updated_at = ? WHERE ${visible.sql} AND id = ?${rule.sql}`,
      params: [encoded(merged), actor.memberId, actor.name, now, ...visible.params, input.id, ...rule.params],
    })
    if (changed === 0) throw new McpAppStorageError("row_not_found", "That entry no longer exists. Reload to see the latest.")
    return { collection: collection.name, action: "update", id: input.id, row: publicRow(collection, await visibleRow(access, collection, input.id), actor) }
  })
}
