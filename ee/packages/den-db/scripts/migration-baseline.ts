import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { generateMySQLDrizzleJson, generateMySQLMigration } from "drizzle-kit/api"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { ORGANIZATION_REPAIRS, type Executor } from "../src/schema-repairs.ts"

export const journalTable = "__drizzle_migrations"
export const stateTable = "__openwork_dev_migration_state"
export class MigrationSafetyError extends Error {}
export const recovery = "Stop writers and inspect a backup/restored copy with the migration owner. Reconcile the exact schema and migration receipts explicitly; do not use db:push, db:baseline, or delete the interruption marker to bypass this check."

type Snapshot = {
  version: "5"
  dialect: "mysql"
  id: string
  prevId: string
  tables: Record<string, {
    name: string
    columns: Record<string, { name: string; type: string; notNull: boolean; primaryKey: boolean; autoincrement?: boolean; default?: unknown; generated?: unknown; onUpdate?: unknown }>
    indexes: Record<string, { name: string; columns: string[]; isUnique: boolean; using?: "btree" | "hash" }>
    compositePrimaryKeys: Record<string, { name: string; columns: string[] }>
    uniqueConstraints: Record<string, { name: string; columns: string[] }>
    foreignKeys: Record<string, unknown>
    checkConstraint: Record<string, { name: string; value: string }>
  }>
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function loadMigrationPlan(folder: string) {
  const journal: unknown = JSON.parse(readFileSync(path.join(folder, "meta/_journal.json"), "utf8"))
  if (!record(journal) || !Array.isArray(journal.entries)) throw new MigrationSafetyError("Invalid migration journal")
  const migrations = readMigrationFiles({ migrationsFolder: folder })
  const plan = journal.entries.map((entry: unknown, index: number) => {
    if (!record(entry) || typeof entry.tag !== "string" || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag)
      || !Number.isSafeInteger(entry.when) || typeof entry.when !== "number" || !Number.isInteger(entry.idx)
      || entry.idx !== index + 1 || entry.idx !== Number(entry.tag.slice(0, 4))) throw new MigrationSafetyError("Invalid migration entry")
    const migration = migrations[index]
    if (!migration || migration.folderMillis !== entry.when) throw new MigrationSafetyError("Migration journal/SQL mismatch")
    const snapshotPath = path.join(folder, "meta", `${entry.tag.slice(0, 4)}_snapshot.json`)
    // Canonical, repository-owned Drizzle v5 snapshots, not input from the database.
    const snapshot: Snapshot | undefined = existsSync(snapshotPath)
      ? JSON.parse(readFileSync(snapshotPath, "utf8")) : undefined
    if (snapshot && (snapshot.version !== "5" || snapshot.dialect !== "mysql"
      || typeof snapshot.id !== "string" || typeof snapshot.prevId !== "string")) throw new MigrationSafetyError("Unsupported migration snapshot")
    if (snapshot) snapshotShape(snapshot)
    return { ...migration, tag: entry.tag, snapshot }
  })
  for (let index = 1; index < plan.length; index++) {
    if (plan[index].folderMillis <= plan[index - 1].folderMillis) throw new MigrationSafetyError("Migration timestamps are not strictly ordered")
    if (Number(plan[index].tag.slice(0, 4)) >= 95 && plan[index].snapshot?.prevId !== plan[index - 1].snapshot?.id) {
      throw new MigrationSafetyError("Migration snapshot chain is incomplete or mismatched")
    }
  }
  if (!plan.some((entry) => entry.tag === "0097_gateway_access_matrix" && entry.snapshot)) {
    throw new MigrationSafetyError("0097_gateway_access_matrix SQL, journal entry and generated snapshot must be finalized together before local startup. No database changes made.")
  }
  if (!plan.at(-1)?.snapshot) throw new MigrationSafetyError("Missing final migration snapshot; refusing to start a partial migration plan")
  return plan
}

export type MigrationPlan = ReturnType<typeof loadMigrationPlan>

export function historyPrefix(plan: MigrationPlan, rows: Record<string, unknown>[]) {
  for (const [index, row] of rows.entries()) {
    const entry = plan[index]
    if (!entry || row.hash !== entry.hash || Number(row.created_at) !== entry.folderMillis) {
      throw new MigrationSafetyError(`Migration history is not an exact hash/timestamp prefix at receipt ${index + 1}. ${recovery}`)
    }
  }
  return rows.length
}

function columnType(value: string) {
  if (/^(enum|set)\(/i.test(value)) return value.replace(/,\s+(?=')/g, ",")
  return value.replace(/^boolean$/i, "tinyint(1)").replace(/^(int|bigint|smallint|mediumint)\(\d+\)/i, "$1")
    .replace(/,\s+(?=')/g, ",").toLowerCase()
}

function defaultValue(value: unknown) {
  if (value === undefined || value === null) return null
  if (value === true || value === "true") return "1"
  if (value === false || value === "false") return "0"
  const text = String(value).replace(/\s+ON UPDATE .+$/i, "")
  if (/^\(?(?:now|current_timestamp)\s*(?:\(\d*\))?\)?$/i.test(text)) return "CURRENT_TIMESTAMP"
  if (/^\(?json_object\(\)\)?$/i.test(text)) return "json_object()"
  if (/^\(?json_array\(\)\)?$/i.test(text)) return "json_array()"
  return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1).replace(/''/g, "'") : text
}

function columnShape(type: string, nullable: boolean, value: unknown, extra: string) {
  return JSON.stringify([columnType(type), nullable, defaultValue(value), /auto_increment/i.test(extra), /on update/i.test(extra)])
}

function checkExpression(value: string) {
  // Normalize MySQL's serialization of the one matrix CHECK, keeping the OR
  // grouping intact (stripping all parentheses would accept a weaker check).
  // INFORMATION_SCHEMA on MySQL 8.4 escapes the known string delimiters.
  let text = value.replace(/_utf8mb4\\'(member:|team:|organization)\\'/g, "'$1'")
    .replace(/`gateway_provider_access`\./g, "").replace(/`|\s/g, "")
    .split(/('[^']*')/).map((part, index) => index % 2 ? part : part.toLowerCase()).join("")
    .replace(/_utf8mb4(?=')/g, "")
    .replace(/\(((?:org_membership_id|team_id)is(?:not)?null)\)/g, "$1")
    .replace(/\((case[\s\S]*?end)\)/g, "$1")
    .replace(/\((audience_key=case[\s\S]*?end)\)/g, "$1")
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0
    let enclosed = true
    for (let index = 0; index < text.length - 1; index++) {
      if (text[index] === "(") depth++
      if (text[index] === ")") depth--
      if (depth === 0) { enclosed = false; break }
    }
    if (!enclosed) break
    text = text.slice(1, -1)
  }
  return text
}

function indexShape(columns: string[], unique: boolean, type = "BTREE") {
  return JSON.stringify([columns.map((column) => column.replace(/`/g, "")), unique, type])
}

export function snapshotShape(snapshot: Snapshot) {
  const shape = new Map<string, string>()
  for (const table of Object.values(snapshot.tables)) {
    shape.set(`table:${table.name}`, "BASE TABLE:InnoDB")
    for (const column of Object.values(table.columns)) {
      if (column.generated) throw new MigrationSafetyError("Generated columns need explicit local migration recognition")
      shape.set(`column:${table.name}.${column.name}`, columnShape(column.type, !column.notNull, column.default,
        `${column.autoincrement ? "auto_increment" : ""} ${column.onUpdate ? "on update" : ""} ${typeof column.default === "string" ? column.default : ""}`))
      if (column.primaryKey) shape.set(`index:${table.name}.PRIMARY`, indexShape([column.name], true))
    }
    for (const index of Object.values(table.indexes)) shape.set(`index:${table.name}.${index.name}`, indexShape(index.columns, index.isUnique, index.using?.toUpperCase()))
    for (const index of Object.values(table.uniqueConstraints)) shape.set(`index:${table.name}.${index.name}`, indexShape(index.columns, true))
    for (const index of Object.values(table.compositePrimaryKeys)) shape.set(`index:${table.name}.PRIMARY`, indexShape(index.columns, true))
    for (const check of Object.values(table.checkConstraint)) shape.set(`check:${table.name}.${check.name}`, checkExpression(check.value))
    if (Object.keys(table.foreignKeys).length) throw new MigrationSafetyError("Foreign keys need explicit local migration recognition")
  }
  return shape
}

export async function inspectSchema(executor: Executor) {
  const shape = new Map<string, string>()
  const tables = await executor.query("SELECT table_name AS `name`, table_type AS `kind`, engine AS `engine` FROM information_schema.TABLES WHERE table_schema = DATABASE()")
  const excluded = new Set([journalTable, stateTable])
  for (const table of tables) if (!excluded.has(String(table.name))) shape.set(`table:${table.name}`, `${table.kind}:${table.engine}`)
  const columns = await executor.query("SELECT table_name AS `tbl`, column_name AS `name`, column_type AS `type`, is_nullable AS `nullable`, column_default AS `def`, extra AS `extra`, generation_expression AS `generated` FROM information_schema.COLUMNS WHERE table_schema = DATABASE()")
  for (const column of columns) {
    if (excluded.has(String(column.tbl))) continue
    if (column.generated) throw new MigrationSafetyError(`Generated column in local schema. ${recovery}`)
    shape.set(`column:${column.tbl}.${column.name}`, columnShape(String(column.type), column.nullable === "YES", column.def, String(column.extra)))
  }
  const indexes = await executor.query("SELECT table_name AS `tbl`, index_name AS `name`, column_name AS `col`, sub_part AS `prefix`, non_unique AS `non_unique`, index_type AS `type`, collation AS `direction`, is_visible AS `visible` FROM information_schema.STATISTICS WHERE table_schema = DATABASE() ORDER BY table_name, index_name, seq_in_index")
  const grouped = new Map<string, { columns: string[]; unique: boolean; type: string }>()
  for (const index of indexes) {
    if (excluded.has(String(index.tbl))) continue
    if (index.direction === "D" || index.visible !== "YES" || index.col === null) throw new MigrationSafetyError(`Unsupported index in local schema. ${recovery}`)
    const key = `index:${index.tbl}.${index.name}`
    let group = grouped.get(key)
    if (!group) {
      group = { columns: [], unique: Number(index.non_unique) === 0, type: String(index.type) }
      grouped.set(key, group)
    }
    group.columns.push(`${index.col}${index.prefix === null ? "" : `(${index.prefix})`}`)
  }
  for (const [key, group] of grouped) shape.set(key, indexShape(group.columns, group.unique, group.type))
  const constraints = await executor.query("SELECT t.table_name AS `tbl`, t.constraint_name AS `name`, t.constraint_type AS `kind`, c.check_clause AS `clause`, t.enforced AS `enforced` FROM information_schema.TABLE_CONSTRAINTS t LEFT JOIN information_schema.CHECK_CONSTRAINTS c ON c.constraint_schema=t.constraint_schema AND c.constraint_name=t.constraint_name WHERE t.table_schema=DATABASE() AND t.constraint_type IN ('CHECK','FOREIGN KEY')")
  for (const constraint of constraints) {
    if (excluded.has(String(constraint.tbl))) continue
    if (constraint.kind !== "CHECK" || constraint.enforced !== "YES") throw new MigrationSafetyError(`Unexpected foreign key or unenforced check. ${recovery}`)
    shape.set(`check:${constraint.tbl}.${constraint.name}`, checkExpression(String(constraint.clause)))
  }
  if ((await executor.query("SELECT 1 FROM information_schema.TRIGGERS WHERE trigger_schema=DATABASE() LIMIT 1")).length) throw new MigrationSafetyError(`Unexpected database triggers. ${recovery}`)
  return { shape, tables: tables.map((table) => String(table.name)) }
}

function withoutKnownRepairs(input: Map<string, string>) {
  const shape = new Map(input)
  for (const { table } of ORGANIZATION_REPAIRS) {
    const column = `column:${table}.organization_id`
    if ([columnShape("varchar(64)", false, null, ""), columnShape("varchar(64)", true, null, "")].includes(shape.get(column) ?? "")) shape.delete(column)
    const index = `index:${table}.${table}_organization_id`
    if (shape.get(index) === indexShape(["organization_id"], false)) shape.delete(index)
  }
  const limit = "column:inference_org_limit_policies.limit_amount"
  if ([columnShape("bigint", false, null, ""), columnShape("bigint", true, null, "")].includes(shape.get(limit) ?? "")) shape.delete(limit)
  if (shape.get("index:memory.memory_content_fulltext") === indexShape(["content"], false, "FULLTEXT")) {
    shape.delete("index:memory.memory_content_fulltext")
    if (shape.get("column:memory.FTS_DOC_ID") === columnShape("bigint unsigned", false, null, "")) shape.delete("column:memory.FTS_DOC_ID")
    if (shape.get("index:memory.FTS_DOC_ID_INDEX") === indexShape(["FTS_DOC_ID"], true)) shape.delete("index:memory.FTS_DOC_ID_INDEX")
  }
  return shape
}

export function schemaDifferences(expected: Map<string, string>, actual: Map<string, string>) {
  const left = withoutKnownRepairs(expected)
  const right = withoutKnownRepairs(actual)
  return [...new Set([...left.keys(), ...right.keys()])].filter((key) => left.get(key) !== right.get(key)).sort()
}

export function planAuthLookupIndexRepairs(plan: MigrationPlan, actual: Map<string, string>) {
  const snapshot = plan.find((entry) => entry.tag === "0096_inference_accounting_observations")?.snapshot
  if (!snapshot) throw new MigrationSafetyError("Missing canonical 0096 snapshot")
  const expected = snapshotShape(snapshot)
  const differences = schemaDifferences(expected, actual)
  if (differences.length === 0) return []
  // This is a repair plan, not a matcher exception. Only these non-unique
  // prefix indexes may be added, and the resulting schema must match 0096.
  const allowed = [
    { tag: "0073_young_scrambler", table: "account", name: "account_account_id_provider_id", columns: ["account_id", "provider_id"] },
    { tag: "0046_messy_reaper", table: "oauthAccessToken", name: "oauth_access_token_token", columns: ["token"] },
    { tag: "0073_young_scrambler", table: "oauthRefreshToken", name: "oauth_refresh_token_token", columns: ["token"] },
  ]
  if (differences.some((key) => actual.has(key) || !allowed.some((index) => key === `index:${index.table}.${index.name}`))) return []
  return allowed.filter((index) => differences.includes(`index:${index.table}.${index.name}`)).map((index) => {
    const key = `index:${index.table}.${index.name}`
    const definition = indexShape(index.columns.map((column) => `${column}(191)`), false)
    const canonicalSql = `CREATE INDEX \`${index.name}\` ON \`${index.table}\` (${index.columns.map((column) => `\`${column}\`(191)`).join(",")});`
    const sql = plan.find((entry) => entry.tag === index.tag)?.sql
      .map((statement) => statement.replace(/^\s*--[^\n]*$/gm, "").trim())
      .find((statement) => statement.replace(/\s/g, "") === canonicalSql.replace(/\s/g, ""))
    if (expected.get(key) !== definition || !sql) throw new MigrationSafetyError("Canonical auth lookup index definition changed; review the local repair allowlist")
    return { key, definition, sql }
  })
}

export function recognizeBaseline(plan: MigrationPlan, actual: Map<string, string>) {
  if ([...actual.keys()].some((key) => key.startsWith("table:gateway_"))) {
    throw new MigrationSafetyError(`Gateway tables exist without migration receipts (already pushed or partial 0097). Historical groups/sets cannot be reconstructed safely from this state. ${recovery}`)
  }
  // Never baseline the matrix migration, even if a future snapshot matches.
  for (let index = plan.length - 1; index >= 0; index--) {
    const entry = plan[index]
    if (Number(entry.tag.slice(0, 4)) > 96 || !entry.snapshot) continue
    if (schemaDifferences(snapshotShape(entry.snapshot), actual).length === 0) return index + 1
  }
  throw new MigrationSafetyError(`Unjournaled schema does not match a known pre-matrix snapshot (0096 or earlier); unknown, mixed and partial schemas cannot be auto-baselined. ${recovery}`)
}

export async function preflightRepairs(executor: Executor, shape: Map<string, string>) {
  for (const repair of ORGANIZATION_REPAIRS) {
    if (!shape.has(`table:${repair.table}`)) continue
    const column = shape.get(`column:${repair.table}.organization_id`)
    if (column === columnShape("varchar(64)", false, null, "")) continue
    const needsOrg = column ? "child.organization_id IS NULL AND" : ""
    const rows = await executor.query(`SELECT 1 AS invalid FROM \`${repair.table}\` child LEFT JOIN \`${repair.parentTable}\` parent ON child.\`${repair.foreignKey}\`=parent.id WHERE ${needsOrg} parent.organization_id IS NULL LIMIT 1`)
    if (rows.length) throw new MigrationSafetyError(`Orphan rows prevent ${repair.table}.organization_id repair. ${recovery}`)
  }
}

export async function foundationSql(plan: MigrationPlan) {
  const source = plan.find((entry) => entry.tag.startsWith("0096_"))?.snapshot
  if (!source) throw new MigrationSafetyError("Missing 0096 foundation snapshot")
  const foundation = structuredClone(source)
  const sql = plan.map((entry) => entry.sql.join("\n")).join("\n")
  const owned = new Set([...sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`([^`]+)`|RENAME\s+TABLE\s+`[^`]+`\s+TO\s+`([^`]+)`/gi)].map((match) => match[1] || match[2]))
  for (const [name, table] of Object.entries(foundation.tables)) {
    if (owned.has(name)) { delete foundation.tables[name]; continue }
    // The migration chain starts after auth/system existed. Seed only those
    // tables, excluding columns/indexes that the real replay adds later.
    for (const match of sql.matchAll(/ALTER\s+TABLE\s+`([^`]+)`\s+ADD(?:\s+COLUMN)?\s+`([^`]+)`/gi)) {
      if (match[1] === name) delete table.columns[match[2]]
    }
    for (const match of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+`([^`]+)`\s+ON\s+`([^`]+)`/gi)) {
      if (match[2] === name) delete table.indexes[match[1]]
    }
  }
  return generateMySQLMigration(await generateMySQLDrizzleJson({}), foundation)
}
