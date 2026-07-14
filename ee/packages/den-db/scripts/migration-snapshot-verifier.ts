import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Executor } from "./db-executor.ts"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

type SnapshotDefault = string | number | boolean | null

export type SnapshotColumn = {
  name: string
  type: string
  notNull: boolean
  defaultValue?: SnapshotDefault
}

export type SnapshotIndex = {
  name: string
  columns: string[]
  isUnique: boolean
}

export type SnapshotTable = {
  name: string
  columns: Record<string, SnapshotColumn>
  indexes: Record<string, SnapshotIndex>
  compositePrimaryKeys: Record<string, { columns: string[] }>
  uniqueConstraints: Record<string, SnapshotIndex>
}

export type MigrationSnapshot = {
  tables: Record<string, SnapshotTable>
}

export type LiveColumn = {
  tableName: string
  columnName: string
  columnType: string
  isNullable: string
  columnDefault: unknown
  extra: string
}

export type LiveIndexColumn = {
  tableName: string
  indexName: string
  nonUnique: number | string
  columnName: string
  sequence: number | string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Migration snapshot has invalid ${label}.`)
  }
  return value.flatMap((entry) => typeof entry === "string" ? [entry] : [])
}

function snapshotDefault(value: unknown, label: string): SnapshotDefault {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  throw new Error(`Migration snapshot has invalid ${label}.default.`)
}

function snapshotIndex(value: unknown, label: string, defaultUnique?: boolean): SnapshotIndex {
  if (!isRecord(value) || typeof value.name !== "string") {
    throw new Error(`Migration snapshot has invalid ${label}.`)
  }
  if (defaultUnique === undefined && typeof value.isUnique !== "boolean") {
    throw new Error(`Migration snapshot has invalid ${label}.isUnique.`)
  }
  return {
    name: value.name,
    columns: stringArray(value.columns, `${label}.columns`),
    isUnique: defaultUnique ?? value.isUnique === true,
  }
}

function readSnapshot(snapshotPath: string): MigrationSnapshot {
  const value: unknown = JSON.parse(readFileSync(snapshotPath, "utf8"))
  if (!isRecord(value) || !isRecord(value.tables)) {
    throw new Error(`Migration snapshot ${snapshotPath} is missing its table catalog.`)
  }

  const tables: Record<string, SnapshotTable> = {}
  for (const [tableKey, tableValue] of Object.entries(value.tables)) {
    if (
      !isRecord(tableValue)
      || typeof tableValue.name !== "string"
      || !isRecord(tableValue.columns)
      || !isRecord(tableValue.indexes)
      || !isRecord(tableValue.compositePrimaryKeys)
    ) {
      throw new Error(`Migration snapshot ${snapshotPath} has invalid table ${tableKey}.`)
    }

    const columns: Record<string, SnapshotColumn> = {}
    for (const [columnKey, columnValue] of Object.entries(tableValue.columns)) {
      if (
        !isRecord(columnValue)
        || typeof columnValue.name !== "string"
        || typeof columnValue.type !== "string"
        || typeof columnValue.notNull !== "boolean"
      ) {
        throw new Error(`Migration snapshot ${snapshotPath} has invalid column ${tableValue.name}.${columnKey}.`)
      }
      columns[columnKey] = {
        name: columnValue.name,
        type: columnValue.type,
        notNull: columnValue.notNull,
        ...(Object.hasOwn(columnValue, "default")
          ? { defaultValue: snapshotDefault(columnValue.default, `${tableValue.name}.${columnKey}`) }
          : {}),
      }
    }

    const indexes: Record<string, SnapshotIndex> = {}
    for (const [indexKey, indexValue] of Object.entries(tableValue.indexes)) {
      indexes[indexKey] = snapshotIndex(indexValue, `${tableValue.name}.${indexKey}`)
    }

    const compositePrimaryKeys: Record<string, { columns: string[] }> = {}
    for (const [primaryKey, primaryValue] of Object.entries(tableValue.compositePrimaryKeys)) {
      if (!isRecord(primaryValue)) {
        throw new Error(`Migration snapshot ${snapshotPath} has invalid primary key ${tableValue.name}.${primaryKey}.`)
      }
      compositePrimaryKeys[primaryKey] = {
        columns: stringArray(primaryValue.columns, `${tableValue.name}.${primaryKey}.columns`),
      }
    }

    const uniqueConstraints: Record<string, SnapshotIndex> = {}
    if (tableValue.uniqueConstraints !== undefined) {
      if (!isRecord(tableValue.uniqueConstraints)) {
        throw new Error(`Migration snapshot ${snapshotPath} has invalid unique constraints for ${tableValue.name}.`)
      }
      for (const [constraintKey, constraintValue] of Object.entries(tableValue.uniqueConstraints)) {
        uniqueConstraints[constraintKey] = snapshotIndex(
          constraintValue,
          `${tableValue.name}.${constraintKey}`,
          true,
        )
      }
    }

    tables[tableKey] = {
      name: tableValue.name,
      columns,
      indexes,
      compositePrimaryKeys,
      uniqueConstraints,
    }
  }
  return { tables }
}

function normalizedType(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll(/\s+/g, " ")
  return normalized === "boolean" ? "tinyint(1)" : normalized
}

function stripOuterParentheses(value: string): string {
  let current = value.trim()
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0
    let enclosesWholeValue = true
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === "(") depth += 1
      if (current[index] === ")") depth -= 1
      if (depth === 0 && index < current.length - 1) {
        enclosesWholeValue = false
        break
      }
    }
    if (!enclosesWholeValue || depth !== 0) break
    current = current.slice(1, -1).trim()
  }
  return current
}

function normalizedSqlDefault(value: unknown, extra = ""): string | null {
  if (value === null || value === undefined) return null
  if (value === true) return "1"
  if (value === false) return "0"

  let normalized = stripOuterParentheses(String(value))
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, " ")
  if (
    normalized.length >= 2
    && normalized.startsWith("'")
    && normalized.endsWith("'")
  ) {
    normalized = normalized.slice(1, -1)
  }
  normalized = normalized
    .replaceAll(/\b(?:now|current_timestamp)\(\d*\)/g, "current_timestamp")
    .replaceAll(/\bcurrent_timestamp\b/g, "current_timestamp")

  const onUpdate = extra.toLowerCase().match(/\bon update\s+(.+)$/)?.[1]
  if (onUpdate && !normalized.includes(" on update ")) {
    const normalizedOnUpdate = normalizedSqlDefault(onUpdate)
    if (normalizedOnUpdate) normalized += ` on update ${normalizedOnUpdate}`
  }
  return normalized
}

function allowedColumnType(tableName: string, columnName: string, expectedType: string, actualType: string): boolean {
  if (normalizedType(expectedType) === normalizedType(actualType)) return true
  // Migration 0038 widens this column. A no-ledger database managed by
  // db:push may already contain that safe forward shape when bootstrap first
  // adopts it, so accept either side of this one reviewed migration delta.
  return tableName === "external_mcp_connection"
    && columnName === "scope"
    && normalizedType(expectedType) === "varchar(1024)"
    && normalizedType(actualType) === "text"
}

function orderedIndexKey(tableName: string, indexName: string): string {
  return `${tableName}\0${indexName}`
}

/**
 * Return every reason a live schema cannot safely be adopted at a snapshot.
 * Extra forward-compatible tables, columns, and indexes are allowed; every
 * object claimed by the baseline must exist with its reviewed shape/order.
 */
export function minimumMigrationSnapshotProblems(input: {
  snapshot: MigrationSnapshot
  columns: LiveColumn[]
  indexes: LiveIndexColumn[]
}): string[] {
  const problems: string[] = []
  const liveColumns = new Map(input.columns.map((column) => [
    `${column.tableName}\0${column.columnName}`,
    column,
  ]))
  const liveIndexes = new Map<string, LiveIndexColumn[]>()
  for (const index of input.indexes) {
    const key = orderedIndexKey(index.tableName, index.indexName)
    const entries = liveIndexes.get(key) ?? []
    entries.push(index)
    liveIndexes.set(key, entries)
  }
  for (const entries of liveIndexes.values()) {
    entries.sort((left, right) => Number(left.sequence) - Number(right.sequence))
  }

  for (const table of Object.values(input.snapshot.tables)) {
    for (const column of Object.values(table.columns)) {
      const live = liveColumns.get(`${table.name}\0${column.name}`)
      if (!live) {
        problems.push(`missing column ${table.name}.${column.name}`)
        continue
      }
      if (!allowedColumnType(table.name, column.name, column.type, live.columnType)) {
        problems.push(`incompatible type ${table.name}.${column.name}: expected ${column.type}, found ${live.columnType}`)
      }
      const nullable = live.isNullable.trim().toLowerCase() === "yes"
      if (nullable === column.notNull) {
        problems.push(`incompatible nullability ${table.name}.${column.name}`)
      }
      const expectedDefault = normalizedSqlDefault(column.defaultValue)
      const actualDefault = normalizedSqlDefault(live.columnDefault, live.extra)
      if (actualDefault !== expectedDefault) {
        problems.push(
          `incompatible default ${table.name}.${column.name}: expected ${expectedDefault ?? "none"}, `
          + `found ${actualDefault ?? "none"}`,
        )
      }
    }

    const expectedIndexes: SnapshotIndex[] = [
      ...Object.values(table.indexes),
      ...Object.values(table.uniqueConstraints),
      ...Object.values(table.compositePrimaryKeys).map((primary) => ({
        name: "PRIMARY",
        columns: primary.columns,
        isUnique: true,
      })),
    ]
    for (const expected of expectedIndexes) {
      const live = liveIndexes.get(orderedIndexKey(table.name, expected.name))
      if (!live) {
        problems.push(`missing index ${table.name}.${expected.name}`)
        continue
      }
      const actualColumns = live.map((entry) => entry.columnName)
      if (actualColumns.join("\0") !== expected.columns.join("\0")) {
        problems.push(
          `incompatible index ${table.name}.${expected.name}: expected (${expected.columns.join(", ")}), `
          + `found (${actualColumns.join(", ")})`,
        )
      }
      const actualUnique = Number(live[0]?.nonUnique) === 0
      if (actualUnique !== expected.isUnique) {
        problems.push(`incompatible uniqueness ${table.name}.${expected.name}`)
      }
    }
  }
  return problems
}

function liveColumn(row: Record<string, unknown>): LiveColumn {
  if (
    typeof row.tableName !== "string"
    || typeof row.columnName !== "string"
    || typeof row.columnType !== "string"
    || typeof row.isNullable !== "string"
    || typeof row.extra !== "string"
  ) {
    throw new Error("Could not read live column metadata while verifying a migration snapshot.")
  }
  return {
    tableName: row.tableName,
    columnName: row.columnName,
    columnType: row.columnType,
    isNullable: row.isNullable,
    columnDefault: row.columnDefault,
    extra: row.extra,
  }
}

function liveIndex(row: Record<string, unknown>): LiveIndexColumn {
  if (
    typeof row.tableName !== "string"
    || typeof row.indexName !== "string"
    || (typeof row.nonUnique !== "number" && typeof row.nonUnique !== "string")
    || typeof row.columnName !== "string"
    || (typeof row.sequence !== "number" && typeof row.sequence !== "string")
  ) {
    throw new Error("Could not read live index metadata while verifying a migration snapshot.")
  }
  return {
    tableName: row.tableName,
    indexName: row.indexName,
    nonUnique: row.nonUnique,
    columnName: row.columnName,
    sequence: row.sequence,
  }
}

export async function assertMinimumMigrationSnapshot(input: {
  executor: Executor
  snapshotIndex: number
  snapshotTag: string
  snapshotPath?: string
}): Promise<void> {
  if (!Number.isSafeInteger(input.snapshotIndex) || input.snapshotIndex < 0) {
    throw new Error(`Invalid migration snapshot index ${input.snapshotIndex}.`)
  }
  const snapshotPath = input.snapshotPath
    ?? path.join(packageDir, "drizzle", "meta", `${String(input.snapshotIndex).padStart(4, "0")}_snapshot.json`)
  const snapshot = readSnapshot(snapshotPath)
  const columns = (await input.executor.query(
    `SELECT table_name AS tableName, column_name AS columnName,
            column_type AS columnType, is_nullable AS isNullable,
            column_default AS columnDefault, extra AS extra
     FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE()`,
  )).map(liveColumn)
  const indexes = (await input.executor.query(
    `SELECT table_name AS tableName, index_name AS indexName, non_unique AS nonUnique,
            column_name AS columnName, seq_in_index AS sequence
     FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE()`,
  )).map(liveIndex)
  const problems = minimumMigrationSnapshotProblems({ snapshot, columns, indexes })
  if (problems.length === 0) return
  const preview = problems.slice(0, 12).join("; ")
  const suffix = problems.length > 12 ? `; and ${problems.length - 12} more` : ""
  throw new Error(
    `Refusing to baseline an unverified no-ledger schema through ${input.snapshotTag}: ${preview}${suffix}. `
    + "Restore/finish the earlier schema first, then rerun db:bootstrap.",
  )
}
