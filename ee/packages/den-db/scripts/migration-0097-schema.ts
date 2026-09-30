import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { Executor } from "../src/schema-repairs.ts"

export const matrixSources = [
  "inference_request_logs", "inference_rollup_lock", "inference_usage_rollups",
  "inference_provider_access", "inference_provider_credentials", "inference_provider_models",
  "inference_provider_oauth_states", "inference_providers",
]
export const matrixTargets = [
  ...matrixSources.map((name) => name.replace("inference_", "gateway_")),
  "gateway_credential_sets", "gateway_keys", "gateway_model_group_models", "gateway_model_groups",
]
export const matrixRecovery = "Stop application writers and concurrent migration jobs. Inspect a backup with the migration owner and use separately reviewed recovery for partial or unrecognized schemas/history; do not baseline, auto-repair, or retry DDL manually."
export class MatrixSafetyError extends Error {}
export function rejectMatrix(reason: string): never {
  throw new MatrixSafetyError(`[den-db] 0097 compatibility refused: ${reason}. ${matrixRecovery}`)
}

type Column = {
  name: string; type: string; notNull: boolean; primaryKey: boolean; autoincrement?: boolean
  default?: string | number | boolean | null; generated?: unknown; onUpdate?: unknown
}
type Key = { name: string; columns: string[] }
type Table = {
  name: string
  columns: Record<string, Column>
  indexes: Record<string, Key & { isUnique: boolean; using?: string }>
  compositePrimaryKeys: Record<string, Key>
  uniqueConstraints: Record<string, Key>
  foreignKeys: Record<string, unknown>
  checkConstraint: Record<string, { name: string; value: string }>
}
type Snapshot = { version: string; dialect: string; id: string; prevId: string; tables: Record<string, Table> }

export function loadMatrixSnapshot(folder: string, stage: "0096" | "0097"): Snapshot {
  const bytes = readFileSync(path.join(folder, "meta", `${stage}_snapshot.json`), "utf8")
  const pins = {
    "0096": "62c1d2787cd6064a258238dfc1c066bfa3bde1dbf4a33b4ebc8f1af906a74282",
    "0097": "64a86086082e0906028aa0064514658ebee7a8fe2b0ecb2e6f589e61b9fca5b5",
  }
  if (createHash("sha256").update(bytes).digest("hex") !== pins[stage]) rejectMatrix(`canonical ${stage} snapshot changed`)
  const snapshot: Snapshot = JSON.parse(bytes)
  if (snapshot.version !== "5" || snapshot.dialect !== "mysql") rejectMatrix("unsupported canonical snapshot")
  return snapshot
}

function normalizedType(type: string) {
  if (/^(enum|set)\(/i.test(type)) return type.replace(/^[^(]+/, (keyword) => keyword.toLowerCase())
  return type.toLowerCase().replace(/^boolean$/, "tinyint(1)").replace(/^(int|bigint)\(\d+\)/, "$1")
}

function timestampExpression(value: string) {
  const expression = /^\(now\(\)\)$/i.test(value) ? "now()" : value
  const now = /^now\(([0-6]?)\)$/i.exec(expression)
  if (now) return `now(${now[1] || "0"})`
  const current = /^current_timestamp(?:\(([0-6]?)\))?$/i.exec(expression)
  return current ? `current_timestamp(${current[1] || "0"})` : expression
}

export function matrixColumnShape(column: Column, origin: "snapshot" | "metadata", extra = "") {
  const type = normalizedType(column.type)
  let value = column.default ?? null
  let update: string | null = null
  if (origin === "snapshot" && typeof value === "string" && type.startsWith("timestamp")) {
    const parts = value.split(/ ON UPDATE /i)
    if (parts.length > 2) rejectMatrix("unsupported timestamp default")
    value = parts[0]
    update = parts[1] ?? null
  }
  if (origin === "metadata") {
    const match = /(?:^|\s)on update (current_timestamp(?:\(\d+\))?)$/i.exec(extra)
    update = match?.[1] ?? null
    const remaining = extra.replace(/DEFAULT_GENERATED/gi, "").replace(/auto_increment/gi, "").replace(/on update current_timestamp(?:\(\d+\))?/gi, "").trim()
    if (remaining) rejectMatrix("unsupported column attributes")
  }
  if (typeof value === "string" && type.startsWith("timestamp")) value = timestampExpression(value)
  if (update) update = timestampExpression(update)
  if (type === "json" && typeof value === "string") {
    if (/^\(?json_array\(\)\)?$/i.test(value)) value = "json_array()"
    else rejectMatrix("unsupported JSON default")
  }
  if (/^(enum\(|varchar\(|.*text$)/.test(type)) {
    if (origin === "snapshot" && typeof value === "string") {
      if (!/^'(?:[^'\\]|'')*'$/.test(value)) rejectMatrix("unsupported snapshot literal")
      value = value.slice(1, -1).replace(/''/g, "'")
    }
  } else if (/^(?:tinyint|int|bigint|double)/.test(type) && value !== null) {
    if (typeof value === "boolean") value = value ? "1" : "0"
    else value = String(value)
  }
  if (column.generated || column.onUpdate) rejectMatrix("unsupported generated column or update attribute")
  return JSON.stringify([type, column.notNull, value, Boolean(column.autoincrement), update])
}

export function matrixCheckShape(expression: string) {
  const literals: string[] = []
  const input = expression.replace(/_utf8mb4\\'(member:|team:|organization)\\'/g, "_utf8mb4'$1'")
  const token = /\s+|(?:_utf8mb4)?'(?:[^'\\]|'')*'|`[a-z_]+`|[a-z_]+|[(),.=]/giy
  const tokens: string[] = []
  let position = 0
  while (position < input.length) {
    token.lastIndex = position
    const match = token.exec(input)
    if (!match) rejectMatrix("unsupported CHECK syntax")
    position = token.lastIndex
    const text = match[0]
    if (/^\s+$/.test(text)) continue
    if (text.startsWith("'") || /^_utf8mb4'/i.test(text)) {
      literals.push(text.replace(/^_utf8mb4/i, "").slice(1, -1).replace(/''/g, "'"))
      tokens.push(`literal${literals.length}`)
    } else tokens.push(text.replace(/`/g, "").toLowerCase())
  }
  let text = tokens.join(" ").replace(/\bgateway_provider_access \. /g, "")
    .replace(/\( (org_membership_id|team_id) is (not )?null \)/g, "$1 is $2null")
    .replace(/\( (case .*? end) \)/g, "$1")
    .replace(/\( (audience_key = case .*? end) \)/g, "$1")
  while (text.startsWith("( ") && text.endsWith(" )")) {
    let depth = 0
    let enclosed = true
    const parts = text.split(" ")
    for (const part of parts.slice(0, -1)) {
      if (part === "(") depth++
      if (part === ")") depth--
      if (depth === 0) { enclosed = false; break }
    }
    if (!enclosed) break
    text = text.slice(2, -2)
  }
  return JSON.stringify([text, literals])
}

function indexShape(columns: string[], unique: boolean, type = "BTREE") {
  return JSON.stringify([columns, unique, type])
}

export function matrixSnapshotShape(snapshot: Snapshot, names: string[]) {
  const shape = new Map<string, string>()
  for (const name of names) {
    const table = snapshot.tables[name]
    if (!table || table.name !== name) rejectMatrix("missing canonical affected table")
    shape.set(`table:${name}`, "BASE TABLE:InnoDB")
    for (const column of Object.values(table.columns)) {
      shape.set(`column:${name}.${column.name}`, matrixColumnShape(column, "snapshot"))
      if (column.primaryKey) shape.set(`index:${name}.PRIMARY`, indexShape([column.name], true))
    }
    for (const key of Object.values(table.indexes)) shape.set(`index:${name}.${key.name}`, indexShape(key.columns, key.isUnique, key.using?.toUpperCase()))
    for (const key of Object.values(table.uniqueConstraints)) shape.set(`index:${name}.${key.name}`, indexShape(key.columns, true))
    for (const key of Object.values(table.compositePrimaryKeys)) shape.set(`index:${name}.PRIMARY`, indexShape(key.columns, true))
    for (const check of Object.values(table.checkConstraint)) shape.set(`check:${name}.${check.name}`, matrixCheckShape(check.value))
    if (Object.keys(table.foreignKeys).length) rejectMatrix("unexpected canonical foreign keys")
    if (shape.get(`index:${name}.PRIMARY`) !== indexShape(["id"], true)) rejectMatrix("canonical PRIMARY(id) changed")
  }
  return shape
}

export async function assertMatrixEnvironment(executor: Executor) {
  const [session] = await executor.query("SELECT @@SESSION.default_storage_engine AS engine, DATABASE() AS db")
  if (typeof session?.engine !== "string" || session.engine.toLowerCase() !== "innodb") rejectMatrix("SESSION default_storage_engine must be InnoDB before migration DDL; no setting was changed")
  if (typeof session.db !== "string" || !session.db) rejectMatrix("cannot verify database-wide metadata visibility")
  let rows: Record<string, unknown>[]
  try {
    rows = await executor.query("SHOW GRANTS")
  } catch {
    rejectMatrix("cannot inspect direct grants for metadata visibility; require direct database/global SELECT, SHOW VIEW, TRIGGER and REFERENCES (role-only grants are not accepted)")
  }
  const privileges = new Set<string>()
  for (const row of rows) {
    const values = Object.values(row)
    if (values.length !== 1 || typeof values[0] !== "string") rejectMatrix("unreadable direct grants; metadata visibility is unverified")
    const statement = values[0]
    if (/^REVOKE\b/i.test(statement)) rejectMatrix("partial privilege revocations require separate review before trusting metadata visibility")
    const grant = /^GRANT (.+?) ON (\*\.\*|`(?:[^`]|``)+`\.\*) TO /i.exec(statement)
    if (!grant) continue
    const scope = grant[2]
    if (scope !== "*.*" && scope.slice(1, -3).replace(/``/g, "`") !== session.db) continue
    for (const privilege of grant[1].split(",")) privileges.add(privilege.trim().replace(/\s+/g, " ").toUpperCase())
  }
  const required = ["SELECT", "SHOW VIEW", "TRIGGER", "REFERENCES"]
  if (!privileges.has("ALL PRIVILEGES") && required.some((privilege) => !privileges.has(privilege))) rejectMatrix("insufficient direct database/global SELECT, SHOW VIEW, TRIGGER or REFERENCES privileges; metadata absence is not trustworthy (role-only and table-level grants are not accepted)")
}

export async function matrixTableNames(executor: Executor) {
  const rows = await executor.query("SELECT table_name AS name FROM information_schema.TABLES WHERE table_schema = DATABASE()")
  return rows.map((row) => {
    if (typeof row.name !== "string") rejectMatrix("unreadable table metadata")
    return row.name
  })
}

export async function assertMatrixEmpty(executor: Executor, names: string[]) {
  for (const name of names) {
    if (!matrixSources.includes(name) && !matrixTargets.includes(name)) rejectMatrix("unexpected table probe")
    if ((await executor.query(`SELECT 1 FROM \`${name}\` LIMIT 1`)).length) rejectMatrix(`nonempty intermediate table ${name}`)
  }
}

export async function assertNoPartialMatrix(executor: Executor) {
  const names = await matrixTableNames(executor)
  if (names.some((name) => name.toLowerCase().startsWith("gateway_"))) rejectMatrix("gateway tables already exist without the canonical receipt (partial 0097)")
  if (names.some((name) => name !== name.toLowerCase() && matrixSources.includes(name.toLowerCase()))) rejectMatrix("affected table name has unexpected casing")
  if (names.includes("__openwork_dev_migration_state")) {
    if ((await executor.query("SELECT 1 FROM `__openwork_dev_migration_state` LIMIT 1")).length) rejectMatrix("local migration interruption marker exists")
  }
  await assertMatrixEmpty(executor, matrixSources.filter((name) => names.includes(name)))
}

export async function assertMatrixSchema(executor: Executor, expected: Map<string, string>, names: string[]) {
  await assertMatrixEnvironment(executor)
  const actual = new Map<string, string>()
  const relevant = (name: unknown): name is string => typeof name === "string" && (matrixSources.includes(name.toLowerCase()) || name.toLowerCase().startsWith("gateway_"))
  const [defaults] = await executor.query("SELECT default_character_set_name AS charset, default_collation_name AS collation FROM information_schema.SCHEMATA WHERE schema_name = DATABASE()")
  if (typeof defaults?.charset !== "string" || typeof defaults.collation !== "string") rejectMatrix("unreadable database character defaults")
  const tables = await executor.query("SELECT table_name AS tbl, table_type AS kind, engine AS engine, table_collation AS collation FROM information_schema.TABLES WHERE table_schema = DATABASE()")
  for (const row of tables) if (relevant(row.tbl)) {
    if (row.collation !== defaults.collation) rejectMatrix("affected table collation differs from canonical database default")
    actual.set(`table:${row.tbl}`, `${row.kind}:${row.engine}`)
  }
  const parameters = [...matrixSources, ...matrixTargets]
  const scope = parameters.map(() => "?").join(",")
  const columns = await executor.query(`SELECT table_name AS tbl, column_name AS name, column_type AS type, is_nullable AS nullable, column_default AS def, extra AS extra, generation_expression AS \`generated\`, character_set_name AS charset, collation_name AS collation FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name IN (${scope})`, parameters)
  for (const row of columns) {
    if (!relevant(row.tbl) || typeof row.name !== "string" || typeof row.type !== "string" || typeof row.extra !== "string"
      || !["YES", "NO"].includes(String(row.nullable)) || (row.def !== null && typeof row.def !== "string" && typeof row.def !== "number")) rejectMatrix("unreadable column metadata")
    if (/^(enum\(|varchar\(|.*text$)/.test(row.type) && (row.charset !== defaults.charset || row.collation !== defaults.collation)) rejectMatrix("affected column character definition differs from canonical database default")
    actual.set(`column:${row.tbl}.${row.name}`, matrixColumnShape({
      name: row.name, type: row.type, notNull: row.nullable === "NO", primaryKey: false,
      default: row.def, autoincrement: /auto_increment/i.test(row.extra), generated: row.generated,
    }, "metadata", row.extra))
  }
  const indexes = await executor.query(`SELECT table_name AS tbl, index_name AS name, column_name AS col, sub_part AS prefix, non_unique AS non_unique, index_type AS type, collation AS direction, is_visible AS visible, seq_in_index AS seq FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name IN (${scope}) ORDER BY table_name, index_name, seq_in_index`, parameters)
  const groups = new Map<string, { columns: string[]; unique: boolean; type: string }>()
  for (const row of indexes) {
    if (!relevant(row.tbl) || typeof row.name !== "string" || typeof row.col !== "string" || row.prefix !== null
      || row.direction !== "A" || row.visible !== "YES" || row.type !== "BTREE" || ![0, 1].includes(Number(row.non_unique))) rejectMatrix("unsupported affected index definition")
    const key = `index:${row.tbl}.${row.name}`
    const group = groups.get(key) ?? { columns: [], unique: Number(row.non_unique) === 0, type: row.type }
    if (Number(row.seq) !== group.columns.length + 1 || group.unique !== (Number(row.non_unique) === 0)) rejectMatrix("inconsistent affected index metadata")
    group.columns.push(row.col)
    groups.set(key, group)
  }
  for (const [key, group] of groups) actual.set(key, indexShape(group.columns, group.unique, group.type))
  const constraints = await executor.query(`SELECT t.table_name AS tbl, t.constraint_name AS name, t.constraint_type AS kind, c.check_clause AS clause, t.enforced AS enforced FROM information_schema.TABLE_CONSTRAINTS t LEFT JOIN information_schema.CHECK_CONSTRAINTS c ON c.constraint_schema = t.constraint_schema AND c.constraint_name = t.constraint_name WHERE t.table_schema = DATABASE() AND t.table_name IN (${scope}) AND t.constraint_type IN ('CHECK','FOREIGN KEY')`, parameters)
  for (const row of constraints) {
    if (!relevant(row.tbl) || row.kind !== "CHECK" || row.enforced !== "YES" || typeof row.name !== "string" || typeof row.clause !== "string") rejectMatrix("unexpected affected foreign key or unenforced CHECK")
    actual.set(`check:${row.tbl}.${row.name}`, matrixCheckShape(row.clause))
  }
  const references = await executor.query(`SELECT 1 FROM information_schema.KEY_COLUMN_USAGE WHERE referenced_table_schema = DATABASE() AND referenced_table_name IN (${scope}) LIMIT 1`, parameters)
  if (references.length) rejectMatrix("foreign key references an affected table")
  const triggers = await executor.query(`SELECT 1 FROM information_schema.TRIGGERS WHERE trigger_schema = DATABASE() AND event_object_table IN (${scope}) LIMIT 1`, parameters)
  if (triggers.length) rejectMatrix("trigger on an affected table")
  const differences = [...new Set([...expected.keys(), ...actual.keys()])].filter((key) => expected.get(key) !== actual.get(key))
  if (differences.length) rejectMatrix(`affected schema differs at ${differences.filter((key) => expected.has(key)).slice(0, 5).join(", ") || "unexpected objects"}`)
  await assertMatrixEmpty(executor, names)
}
