import assert from "node:assert/strict"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { initializeDenDb } from "../scripts/bootstrap.ts"
import { loadUpgradePlan, matrixHash, matrixMillis, matrixStatements, migrateWith0097Compatibility } from "../scripts/migration-0097-compat.ts"
import { loadMatrixSnapshot, matrixCheckShape, matrixColumnShape, matrixSources, matrixTargets } from "../scripts/migration-0097-schema.ts"

const folder = fileURLToPath(new URL("../drizzle", import.meta.url))
const plan = loadUpgradePlan(folder)
const packets = matrixStatements(plan.migrations[96])

type Metadata = { tables: Record<string, unknown>[]; columns: Record<string, unknown>[]; indexes: Record<string, unknown>[]; checks: Record<string, unknown>[] }
function metadata(stage: "0096" | "0097"): Metadata {
  const snapshot = loadMatrixSnapshot(folder, stage)
  const names = stage === "0096" ? matrixSources : matrixTargets
  const output: Metadata = { tables: [], columns: [], indexes: [], checks: [] }
  for (const name of names) {
    const table = snapshot.tables[name]
    output.tables.push({ tbl: name, kind: "BASE TABLE", engine: "InnoDB", collation: "utf8mb4_0900_ai_ci" })
    for (const column of Object.values(table.columns)) {
      let def: string | number | null = column.default === undefined ? null : String(column.default)
      let extra = column.autoincrement ? "auto_increment" : ""
      if (typeof def === "string" && def.startsWith("'")) def = def.slice(1, -1)
      if (column.type.startsWith("timestamp") && def !== null) {
        extra = `DEFAULT_GENERATED${String(def).includes("ON UPDATE") ? " on update CURRENT_TIMESTAMP(3)" : ""}`
        def = def === "(now())" ? "now()" : String(def).split(" ON UPDATE ")[0]
      }
      if (column.type === "json" && def !== null) { def = "json_array()"; extra = "DEFAULT_GENERATED" }
      output.columns.push({ tbl: name, name: column.name, type: column.type, nullable: column.notNull ? "NO" : "YES", def, extra, generated: "", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" })
    }
    const keys = [
      ...Object.values(table.indexes),
      ...Object.values(table.uniqueConstraints).map((key) => ({ ...key, isUnique: true })),
      ...Object.values(table.compositePrimaryKeys).map((key) => ({ ...key, name: "PRIMARY", isUnique: true })),
    ]
    for (const key of keys) key.columns.forEach((col, index) => output.indexes.push({
      tbl: name, name: key.name, col, prefix: null, non_unique: key.isUnique ? 0 : 1, type: "BTREE", direction: "A", visible: "YES", seq: index + 1,
    }))
    for (const check of Object.values(table.checkConstraint)) output.checks.push({ tbl: name, name: check.name, kind: "CHECK", clause: check.value, enforced: "YES" })
  }
  return output
}

function fixture(options: {
  engine?: unknown; grants?: string[]; grantFailure?: boolean; database?: string; writersStoppedFor0097?: boolean; competingSessions?: boolean
  prefix?: number; failAt?: number; finalDrift?: boolean; populated?: string; locked?: boolean; failReceipt?: boolean; failCommit?: boolean; commitApplied?: boolean; changeHistory?: boolean; mutateFinal?: (schema: Metadata) => void
} = {}) {
  const prefix = options.prefix ?? 96
  let schema = metadata(prefix < 97 ? "0096" : "0097")
  if (prefix < 95) schema = { tables: [], columns: [], indexes: [], checks: [] }
  if (prefix === 95) schema.tables = schema.tables.filter((row) => row.tbl !== "inference_rollup_lock")
  const receipts: Record<string, unknown>[] = plan.migrations.slice(0, prefix).map((entry) => ({ hash: entry.hash, created_at: entry.folderMillis }))
  const calls: { sql: string; args: (string | number)[] }[] = []
  const logs: string[] = []
  const ordinary: number[] = []
  const temporary: string[] = []
  let executed = 0
  let stagedReceipt: Record<string, unknown> | undefined
  const executor = { async query(sql: string, args: (string | number)[] = []): Promise<Record<string, unknown>[]> {
    calls.push({ sql, args })
    if (sql.startsWith("SELECT hash, created_at")) return structuredClone(receipts)
    if (sql.includes("@@SESSION.default_storage_engine")) return [{ engine: options.engine === undefined ? "InnoDB" : options.engine, db: options.database ?? "synthetic_db" }]
    if (sql === "SHOW GRANTS") {
      if (options.grantFailure) throw new Error("synthetic permission failure")
      return (options.grants ?? ["GRANT SELECT, SHOW VIEW, TRIGGER, REFERENCES ON `synthetic_db`.* TO 'migration'@'localhost'"]).map((grant) => ({ grant }))
    }
    if (sql.includes("GET_LOCK")) return [{ acquired: options.locked ? 0 : 1 }]
    if (sql.includes("RELEASE_LOCK")) return [{ released: 1 }]
    if (sql.startsWith("SELECT table_name AS name")) return schema.tables.map((row) => ({ name: row.tbl }))
    if (sql.includes("information_schema.PROCESSLIST")) return options.competingSessions ? [{ present: 1 }] : []
    if (sql.includes("information_schema.SCHEMATA")) return [{ charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" }]
    if (sql.includes("information_schema.TABLES")) return schema.tables
    if (sql.includes("information_schema.COLUMNS")) return schema.columns.filter((row) => args.includes(String(row.tbl)))
    if (sql.includes("information_schema.STATISTICS")) return schema.indexes.filter((row) => args.includes(String(row.tbl)))
    if (sql.includes("information_schema.TABLE_CONSTRAINTS")) return schema.checks.filter((row) => args.includes(String(row.tbl)))
    if (sql.includes("information_schema.KEY_COLUMN_USAGE") || sql.includes("information_schema.TRIGGERS")) return []
    if (/^SELECT 1 FROM `/.test(sql)) return sql.includes(`\`${options.populated}\``) ? [{ present: 1 }] : []
    if (sql === "START TRANSACTION") return []
    if (sql.startsWith("INSERT INTO `__drizzle_migrations`")) {
      if (options.failReceipt) throw new Error("synthetic receipt failure")
      stagedReceipt = { hash: args[0], created_at: args[1] }
      return []
    }
    if (sql === "COMMIT") {
      if (options.failCommit && !options.commitApplied) throw new Error("synthetic commit uncertainty")
      assert.ok(stagedReceipt)
      receipts.push(stagedReceipt)
      stagedReceipt = undefined
      if (options.failCommit) throw new Error("synthetic commit acknowledgement loss")
      return []
    }
    if (sql === "ROLLBACK") { stagedReceipt = undefined; return [] }
    assert.equal(sql, packets[executed], `unexpected or reordered DDL at ${executed}`)
    if (executed === options.failAt) throw new Error("synthetic DDL failure")
    executed++
    if (executed === packets.length) {
      schema = metadata("0097")
      if (options.finalDrift) schema.columns[0].type = "varchar(1)"
      options.mutateFinal?.(schema)
      if (options.changeHistory) receipts[95].hash = "changed"
    } else if (executed === 1) schema.tables.push({ tbl: "gateway_credential_sets", kind: "BASE TABLE", engine: "InnoDB" })
    return []
  } }
  const regular = async (migrationsFolder: string) => {
    const migrations = readMigrationFiles({ migrationsFolder })
    if (migrationsFolder !== folder) {
      temporary.push(migrationsFolder)
      assert.equal(migrations.length, 96)
      assert.deepEqual(migrations, plan.migrations.slice(0, 96))
    }
    for (const [index, migration] of migrations.entries()) {
      if (index < receipts.length) continue
      assert.notEqual(index, 96, "ordinary migrator must never execute pending 0097")
      ordinary.push(index + 1)
      receipts.push({ hash: migration.hash, created_at: migration.folderMillis })
    }
    if (receipts.length === 96) schema = metadata("0096")
  }
  return {
    executor, calls, receipts, logs, ordinary, temporary,
    get schema() { return schema },
    get executed() { return executed },
    run: (migrationsFolder = folder) => migrateWith0097Compatibility(executor, migrationsFolder, regular, (message) => logs.push(message), { writersStoppedFor0097: options.writersStoppedFor0097 ?? true }),
  }
}

function assertReadOnly(state: ReturnType<typeof fixture>) {
  assert.equal(state.executed, 0)
  assert.equal(state.ordinary.length, 0)
  assert.ok(state.calls.every(({ sql }) => sql.startsWith("SELECT") || sql === "SHOW GRANTS"))
}

test("exact SQL hash and timestamp pin excludes exactly sixteen redundant PK operations", () => {
  assert.equal(plan.migrations[96].hash, matrixHash)
  assert.equal(plan.migrations[96].folderMillis, matrixMillis)
  assert.equal(packets.length, 82)
  assert.equal(plan.migrations[96].sql.length - packets.length, 16)
  assert.ok(packets.every((packet) => plan.migrations[96].sql.includes(packet)))
  assert.equal(packets.filter((packet) => /CREATE TABLE/.test(packet)).length, 4)
  assert.doesNotMatch(packets.join("\n"), /(?:DROP|ADD) PRIMARY KEY|sql_require_primary_key|SET\s+(?:SESSION|GLOBAL)/i)
  for (const mutation of [
    { hash: "unknown" }, { folderMillis: matrixMillis + 1 },
    { sql: plan.migrations[96].sql.slice(1) },
    { sql: plan.migrations[96].sql.map((sql) => sql.replace("NOT NULL", "NULL")) },
    { sql: [...plan.migrations[96].sql, "SELECT 1;"] },
  ]) assert.throws(() => matrixStatements({ ...plan.migrations[96], ...mutation }), /source hash\/timestamp changed/)
})

test("altered packaged SQL, journal or canonical snapshots fail before database writes", async () => {
  const copy = mkdtempSync(path.join(tmpdir(), "den-db-0097-pin-test-"))
  try {
    cpSync(folder, copy, { recursive: true })
    for (const asset of ["0097_gateway_access_matrix.sql", "meta/_journal.json", "meta/0096_snapshot.json", "meta/0097_snapshot.json"]) {
      const file = path.join(copy, asset)
      const original = readFileSync(file, "utf8")
      writeFileSync(file, asset.endsWith("_journal.json") ? original.replace(String(matrixMillis), String(matrixMillis + 1)) : `${original}\n`)
      const state = fixture()
      await assert.rejects(state.run(copy), /source hash\/timestamp changed|snapshot changed/)
      assertReadOnly(state)
      writeFileSync(file, original)
    }
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test("096 compatibility validates before DDL and before the original completion receipt", async () => {
  const state = fixture()
  await state.run()
  assert.equal(state.executed, 82)
  assert.deepEqual(state.receipts[96], { hash: matrixHash, created_at: matrixMillis })
  assert.deepEqual(state.ordinary, plan.migrations.slice(97).map((_, index) => index + 98))
  const sql = state.calls.map((call) => call.sql)
  const first = sql.indexOf(packets[0])
  const last = sql.indexOf(packets.at(-1) ?? "")
  const receipt = sql.findIndex((query) => query.startsWith("INSERT INTO"))
  assert.ok(first > 0 && receipt > last)
  for (const name of matrixSources) assert.ok(sql.indexOf(`SELECT 1 FROM \`${name}\` LIMIT 1`) < first)
  for (const name of matrixTargets) assert.ok(sql.indexOf(`SELECT 1 FROM \`${name}\` LIMIT 1`) > last && sql.indexOf(`SELECT 1 FROM \`${name}\` LIMIT 1`) < receipt)
  assert.ok(sql.slice(last + 1, receipt).some((query) => query.includes("CHECK_CONSTRAINTS")))
  assert.doesNotMatch(sql.join("\n"), /sql_require_primary_key|SET\s+(?:SESSION|GLOBAL)|VERSION\(/i)
  assert.match(state.logs[0], new RegExp(matrixHash))
  assert.equal(state.logs.length, 2)
})

test("older clean installs replay the canonical 077..096 prefix then compatibility then the rest", async () => {
  for (const prefix of [76, 94, 95]) {
    const state = fixture({ prefix })
    await state.run()
    assert.deepEqual(state.ordinary, plan.migrations.map((_, index) => index + 1).filter((number) => number > prefix && number !== 97))
    assert.equal(state.executed, 82)
    assert.equal(state.temporary.length, 1)
    assert.equal(existsSync(state.temporary[0]), false)
    assert.equal(state.receipts.length, plan.migrations.length)
  }
})

test("completed 0097+ and current snapshot baselines never replay, restamp or require native metadata", async () => {
  for (const prefix of [97, 98, plan.migrations.length]) {
    const state = fixture({ prefix })
    const previous = structuredClone(state.receipts)
    await state.run()
    assert.deepEqual(state.receipts.slice(0, prefix), previous)
    assert.equal(state.executed, 0)
    assert.equal(state.logs.length, 0)
    assert.equal(state.calls.length, 1)
    assert.match(state.calls[0].sql, /^SELECT hash, created_at/)
  }
})

test("wrong, missing, duplicate, superseded and unknown history fail closed before writes", async () => {
  for (const prefix of [76, 96, 97, 98, plan.migrations.length]) {
    for (const corrupt of [
      (rows: Record<string, unknown>[]) => { rows[0].hash = "unknown" },
      (rows: Record<string, unknown>[]) => { rows.pop(); rows.push({ hash: "superseded", created_at: matrixMillis }) },
      (rows: Record<string, unknown>[]) => { rows[0].created_at = 0 },
      (rows: Record<string, unknown>[]) => { rows.splice(2, 1) },
      (rows: Record<string, unknown>[]) => { rows.push(rows[0]) },
      (rows: Record<string, unknown>[]) => { rows.length = 0 },
    ]) {
      const state = fixture({ prefix })
      corrupt(state.receipts)
      const before = structuredClone(state.receipts)
      await assert.rejects(state.run(), /history is not an exact|no migration receipts/)
      assertReadOnly(state)
      assert.deepEqual(state.receipts, before)
    }
  }
})

test("superseded 0097 hashes cannot hide behind later receipts", async () => {
  for (const prefix of [97, 98, 99, plan.migrations.length]) {
    for (const hash of [
      "dec021c8b3bb9fb139b3e0737ac5618ab1ed74d64d82fe36e1fcfe71306f378d",
      "2882d271052bd27a6281e5a1b161056546c817d27e218ba69fecd5f00cb4db9a",
    ]) {
      const state = fixture({ prefix })
      state.receipts[96].hash = hash
      await assert.rejects(state.run(), /exact hash\/timestamp prefix at receipt 97/)
      assertReadOnly(state)
    }
  }
})

test("actual shipped first-failure prefix is refused before repeating any CREATE or writing receipts", async () => {
  const state = fixture()
  const original = plan.migrations[96].sql.map((packet) => packet.trim())
  const failure = original.findIndex((sql) => sql === "ALTER TABLE `gateway_request_logs` DROP PRIMARY KEY;")
  assert.equal(failure, 39)
  for (const sql of original.slice(0, failure)) {
    const create = /^CREATE TABLE `([^`]+)`/.exec(sql)
    if (create) state.schema.tables.push({ tbl: create[1], kind: "BASE TABLE", engine: "InnoDB" })
    const rename = /^RENAME TABLE `([^`]+)` TO `([^`]+)`/.exec(sql)
    if (rename) for (const rows of Object.values(state.schema)) for (const row of rows) if (row.tbl === rename[1]) row.tbl = rename[2]
    const column = /^ALTER TABLE `([^`]+)` RENAME COLUMN `([^`]+)` TO `([^`]+)`/.exec(sql)
    if (column) {
      for (const row of state.schema.columns) if (row.tbl === column[1] && row.name === column[2]) row.name = column[3]
      for (const row of state.schema.indexes) if (row.tbl === column[1] && row.col === column[2]) row.col = column[3]
    }
    const drop = /^ALTER TABLE `([^`]+)` DROP INDEX `([^`]+)`/.exec(sql)
    const dropIndex = /^DROP INDEX `([^`]+)` ON `([^`]+)`/.exec(sql)
    if (drop || dropIndex) state.schema.indexes = state.schema.indexes.filter((row) => !(row.tbl === (drop?.[1] ?? dropIndex?.[2]) && row.name === (drop?.[2] ?? dropIndex?.[1])))
  }
  assert.equal(state.schema.tables.length, 12)
  assert.ok(state.schema.tables.every((row) => String(row.tbl).startsWith("gateway_")))
  const before = structuredClone(state.receipts)
  await assert.rejects(state.run(), /partial 0097/)
  assertReadOnly(state)
  assert.deepEqual(state.receipts, before)
})

test("even the first CREATE, mixed names, unknown gateway tables and older partial installs are refused", async () => {
  for (const prefix of [76, 95, 96]) {
    for (const name of ["gateway_credential_sets", "gateway_request_logs", "gateway_unrecognized"]) {
      const state = fixture({ prefix })
      state.schema.tables.push({ tbl: name, kind: "BASE TABLE", engine: "InnoDB" })
      await assert.rejects(state.run(), /partial 0097/)
      assertReadOnly(state)
    }
  }
})

test("each nonempty source refuses all DDL and receipts", async () => {
  for (const populated of matrixSources) {
    const state = fixture({ populated })
    await assert.rejects(state.run(), /nonempty intermediate/)
    assertReadOnly(state)
  }
  const older = fixture({ prefix: 95, populated: "inference_providers" })
  await assert.rejects(older.run(), /nonempty intermediate/)
  assertReadOnly(older)
})

test("each field definition and PK/index/check discrepancy refuses before DDL", async () => {
  const mutations: ((schema: Metadata) => void)[] = [
    (schema) => { schema.tables.pop() },
    (schema) => { schema.tables[0].engine = "MyISAM" },
    (schema) => { schema.tables[0].collation = "utf8mb4_bin" },
    (schema) => { schema.columns[0].collation = "utf8mb4_bin" },
    (schema) => { schema.columns[0].charset = "latin1" },
    (schema) => { schema.columns[0].type = "varchar(32)" },
    (schema) => { schema.columns[0].nullable = "YES" },
    (schema) => { schema.columns[0].generated = "1" },
    (schema) => { schema.columns[0].extra = "INVISIBLE" },
    (schema) => { schema.columns[0].def = "unexpected" },
    (schema) => { schema.columns.push({ ...schema.columns[0], name: "unexpected" }) },
    (schema) => { schema.indexes = schema.indexes.filter((row) => row.name !== "PRIMARY") },
    (schema) => { const row = schema.indexes.find((row) => row.name === "PRIMARY"); assert.ok(row); row.col = "organization_id" },
    (schema) => { schema.indexes[0].non_unique = 1 - Number(schema.indexes[0].non_unique) },
    (schema) => { schema.indexes[0].prefix = 16 },
    (schema) => { schema.indexes[0].direction = "D" },
    (schema) => { schema.indexes[0].visible = "NO" },
    (schema) => { schema.indexes[0].seq = 2 },
    (schema) => { schema.indexes[0].col = null },
    (schema) => { schema.indexes[0].type = "HASH" },
    (schema) => { schema.checks.push({ tbl: matrixSources[0], name: "extra", kind: "CHECK", clause: "id is null", enforced: "YES" }) },
    (schema) => { schema.checks.push({ tbl: matrixSources[0], name: "fk", kind: "FOREIGN KEY" }) },
  ]
  for (const mutate of mutations) {
    const state = fixture()
    mutate(state.schema)
    await assert.rejects(state.run(), /0097 compatibility refused/)
    assertReadOnly(state)
  }
})

test("unrelated repaired objects are outside the exact affected-table guard", async () => {
  const state = fixture()
  state.schema.tables.push({ tbl: "memory", kind: "BASE TABLE", engine: "InnoDB" })
  state.schema.columns.push({ tbl: "config_object_version", name: "organization_id", type: "varchar(64)", nullable: "NO", def: null, extra: "", generated: "" })
  state.schema.indexes.push({ tbl: "memory", name: "memory_content_fulltext", type: "FULLTEXT", direction: null })
  await state.run()
  assert.equal(state.executed, 82)
})

test("metadata literals never inherit snapshot quote, boolean or ON UPDATE decoding", () => {
  const column = { name: "status", type: "varchar(255)", notNull: true, primaryKey: false }
  for (const literal of ["active", "true", "false", "CURRENT_TIMESTAMP", "active ON UPDATE CURRENT_TIMESTAMP(3)", "member: "]) {
    const expected = matrixColumnShape({ ...column, default: `'${literal}'` }, "snapshot")
    assert.equal(matrixColumnShape({ ...column, default: literal }, "metadata"), expected)
    assert.notEqual(matrixColumnShape({ ...column, default: `'${literal}'` }, "metadata"), expected)
  }
  assert.notEqual(matrixColumnShape({ ...column, default: "true" }, "metadata"), matrixColumnShape({ ...column, default: "1" }, "metadata"))
  assert.notEqual(matrixColumnShape({ ...column, type: "ENUM('Org','member')" }, "metadata"), matrixColumnShape({ ...column, type: "enum('org','member')" }, "snapshot"))
  const timestamp = { ...column, type: "timestamp(3)", default: "CURRENT_TIMESTAMP(3)" }
  assert.notEqual(matrixColumnShape(timestamp, "snapshot"), matrixColumnShape({ ...timestamp, default: "CURRENT_TIMESTAMP" }, "metadata"))
  assert.notEqual(matrixColumnShape(timestamp, "metadata", "on update CURRENT_TIMESTAMP(3)"), matrixColumnShape(timestamp, "metadata", "on update CURRENT_TIMESTAMP"))
})

test("observed MySQL 8.4.11 clean0096 timestamp metadata preserves expression precision", () => {
  const columns = loadMatrixSnapshot(folder, "0096").tables.inference_providers.columns
  const created = { name: "created_at", type: "timestamp(3)", notNull: true, primaryKey: false, default: "now()" }
  const updated = { name: "updated_at", type: "timestamp(3)", notNull: true, primaryKey: false, default: "CURRENT_TIMESTAMP(3)" }
  assert.equal(columns.created_at.default, "(now())")
  assert.equal(columns.updated_at.default, "CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)")
  assert.equal(matrixColumnShape(columns.created_at, "snapshot"), matrixColumnShape(created, "metadata", "DEFAULT_GENERATED"))
  assert.equal(matrixColumnShape(columns.updated_at, "snapshot"), matrixColumnShape(updated, "metadata", "DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)"))
  for (const def of ["now(3)", "now(6)", "CURRENT_TIMESTAMP(3)", "'now()'"]) {
    assert.notEqual(matrixColumnShape(columns.created_at, "snapshot"), matrixColumnShape({ ...created, default: def }, "metadata", "DEFAULT_GENERATED"))
  }
  assert.equal(matrixColumnShape(created, "metadata", "DEFAULT_GENERATED"), matrixColumnShape({ ...created, default: "now(0)" }, "metadata", "DEFAULT_GENERATED"))
  assert.notEqual(matrixColumnShape(columns.updated_at, "snapshot"), matrixColumnShape(updated, "metadata", "DEFAULT_GENERATED on update CURRENT_TIMESTAMP(6)"))
})

test("CHECK normalization accepts MySQL serialization but preserves literal whitespace and OR grouping", () => {
  const source = loadMatrixSnapshot(folder, "0097").tables.gateway_provider_access.checkConstraint.gateway_provider_access_audience.value
  const serialized = "(((`org_membership_id` is null) or (`team_id` is null)) and (`audience_key` = (case when (`org_membership_id` is not null) then concat(_utf8mb4'member:',`org_membership_id`) when (`team_id` is not null) then concat(_utf8mb4'team:',`team_id`) else _utf8mb4'organization' end)))"
  assert.equal(matrixCheckShape(source), matrixCheckShape(serialized))
  assert.equal(matrixCheckShape(source), matrixCheckShape(serialized.replace(/_utf8mb4'([^']+)'/g, "_utf8mb4\\'$1\\'")))
  for (const changed of [
    serialized.replace("member:", "member: "), serialized.replace("member:", "Member:"),
    serialized.replace("or (`team_id` is null)) and", "or ((`team_id` is null) and"),
    serialized.replace("organization", "organization "),
  ]) assert.notEqual(matrixCheckShape(changed), matrixCheckShape(source))
})

test("DDL interruption and failed final verification never receipt 0097 or continue ordinary migrations", async () => {
  for (const options of [{ failAt: 0 }, { failAt: 1 }, { failAt: 40 }, { failAt: 81 }, { finalDrift: true }, { failReceipt: true }, { failCommit: true }, { changeHistory: true }, { populated: "gateway_providers" }]) {
    const state = fixture(options)
    await assert.rejects(state.run(), /0097 compatibility/)
    assert.equal(state.receipts.length, 96)
    assert.equal(state.ordinary.length, 0)
    if (!options.failReceipt && !options.failCommit) assert.equal(state.calls.some(({ sql }) => sql.startsWith("INSERT INTO")), false)
    assert.equal(state.logs.some((line) => line.includes("recorded original")), false)
    if (options.failAt === 1 || options.failAt === 40 || options.failAt === 81 || options.finalDrift || options.failReceipt || options.failCommit) {
      const count = state.calls.length
      await assert.rejects(state.run(), /partial 0097/)
      assert.ok(state.calls.slice(count).every(({ sql }) => sql.startsWith("SELECT") || sql === "SHOW GRANTS"))
    }
  }
})

test("final PK, CHECK enforcement/grouping/literals and field definitions gate the receipt", async () => {
  for (const mutateFinal of [
    (schema: Metadata) => { schema.indexes = schema.indexes.filter((row) => row.name !== "PRIMARY") },
    (schema: Metadata) => { schema.checks[0].enforced = "NO" },
    (schema: Metadata) => { schema.checks[0].clause = String(schema.checks[0].clause).replace("member:", "member: ") },
    (schema: Metadata) => { schema.checks[0].clause = String(schema.checks[0].clause).replace(" OR ", " AND ") },
    (schema: Metadata) => { schema.columns[0].collation = "utf8mb4_bin" },
    (schema: Metadata) => { schema.columns[0].def = "'literal'" },
  ]) {
    const state = fixture({ mutateFinal })
    await assert.rejects(state.run(), /0097 compatibility refused/)
    assert.equal(state.executed, 82)
    assert.equal(state.receipts.length, 96)
    assert.equal(state.calls.some(({ sql }) => sql.startsWith("INSERT INTO")), false)
  }
})

test("metadata failures, triggers, incoming references and interruption markers fail closed", async () => {
  for (const selected of ["information_schema.COLUMNS", "information_schema.KEY_COLUMN_USAGE", "information_schema.TRIGGERS", "__openwork_dev_migration_state"]) {
    const state = fixture()
    if (selected.startsWith("__")) state.schema.tables.push({ tbl: selected })
    const original = state.executor.query
    state.executor.query = async (sql, args) => {
      if (sql.includes(selected)) {
        state.calls.push({ sql, args: args ?? [] })
        if (selected === "information_schema.COLUMNS") throw new Error("synthetic metadata permission failure")
        return [{ present: 1 }]
      }
      return original(sql, args)
    }
    await assert.rejects(state.run(), /0097 compatibility/)
    assertReadOnly(state)
  }
})

test("lost commit acknowledgement is not automatically retried and committed 0097 is not restamped", async () => {
  const state = fixture({ failCommit: true, commitApplied: true })
  await assert.rejects(state.run(), /0097 compatibility upgrade stopped/)
  assert.equal(state.receipts.length, 97)
  const calls = state.calls.length
  await state.run()
  assert.equal(state.calls.length, calls + 1)
  assert.deepEqual(state.receipts[96], { hash: matrixHash, created_at: matrixMillis })
  assert.equal(state.calls.filter(({ sql }) => sql.startsWith("INSERT INTO")).length, 1)
})

test("unjournaled existing and receipt-only databases never initialize or baseline", async () => {
  for (const tables of [["gateway_providers"], ["inference_providers"], ["organization"], ["__drizzle_migrations"]]) {
    const calls: string[] = []
    await assert.rejects(initializeDenDb({
      async query(sql) {
        calls.push(sql)
        if (sql === "show tables") return tables.map((name) => ({ name }))
        if (sql === "SELECT 1 FROM `__drizzle_migrations` LIMIT 1") return [{ present: 1 }]
        throw new Error("unexpected write")
      },
      async close() {},
    }), /no migration ledger|application tables are missing/)
    assert.ok(calls.every((sql) => sql === "show tables" || sql.startsWith("SELECT")))
  }
})

test("predecessor failure removes temporary assets and never enters 0097", async () => {
  const state = fixture({ prefix: 76 })
  let temporary = ""
  await assert.rejects(migrateWith0097Compatibility(state.executor, folder, async (prefixFolder) => {
    temporary = prefixFolder
    assert.equal(readMigrationFiles({ migrationsFolder: prefixFolder }).length, 96)
    throw new Error("synthetic ordinary migration failure")
  }, undefined, { writersStoppedFor0097: true }), /0097 compatibility upgrade stopped/)
  assert.ok(temporary)
  assert.equal(existsSync(temporary), false)
  assertReadOnly(state)
})

test("pending 0097 requires a fresh explicit boolean acknowledgement before locks or DDL", async () => {
  for (const prefix of [76, 96]) {
    const unacknowledged = fixture({ prefix })
    await assert.rejects(migrateWith0097Compatibility(unacknowledged.executor, folder, async () => assert.fail("ordinary migrations must not run")), /DEN_DB_0097_WRITERS_STOPPED=1/)
    assert.equal(unacknowledged.calls.length, 1)
    for (const value of [false, null, 0, 1, "", "1", "true", "false"]) {
      const options: { writersStoppedFor0097?: boolean } = JSON.parse(JSON.stringify({ writersStoppedFor0097: value }))
      const state = fixture({ prefix })
      await assert.rejects(migrateWith0097Compatibility(state.executor, folder, async () => assert.fail("ordinary migrations must not run"), undefined, options), /this process does not freeze writers/)
      assertReadOnly(state)
      assert.equal(state.calls.length, 1)
    }
  }
})

test("completed canonical 0097 and current snapshot receipts need no acknowledgement", async () => {
  for (const prefix of [97, plan.migrations.length]) {
    const state = fixture({ prefix })
    let ordinary = 0
    await migrateWith0097Compatibility(state.executor, folder, async () => { ordinary++ })
    assert.equal(ordinary, prefix < plan.migrations.length ? 1 : 0)
    assert.equal(state.calls.length, 1)
    assert.equal(state.executed, 0)
  }
})

test("acknowledgement never overrides a visible active database session", async () => {
  for (const prefix of [76, 96]) {
    const state = fixture({ prefix, writersStoppedFor0097: true, competingSessions: true })
    await assert.rejects(state.run(), /another visible database session is active/)
    assertReadOnly(state)
    const query = state.calls.find(({ sql }) => sql.includes("information_schema.PROCESSLIST"))
    assert.ok(query)
    assert.match(query.sql, /ID <> CONNECTION_ID\(\) AND COMMAND <> 'Sleep'/)
  }
})

test("non-InnoDB session defaults refuse before any predecessor or compatibility DDL", async () => {
  for (const prefix of [76, 96]) for (const engine of ["MyISAM", "MEMORY", "", null, 1]) {
    const state = fixture({ prefix, engine })
    await assert.rejects(state.run(), /SESSION default_storage_engine must be InnoDB/)
    assertReadOnly(state)
    assert.equal(state.calls.some(({ sql }) => /information_schema|GET_LOCK/.test(sql)), false)
  }
})

test("missing direct visibility privileges, role-only grants and partial revocations fail before metadata absence or writes", async () => {
  const required = ["SELECT", "SHOW VIEW", "TRIGGER", "REFERENCES"]
  const insufficient = [
    [],
    ...required.map((missing) => [`GRANT ${required.filter((privilege) => privilege !== missing).join(", ")} ON \`synthetic_db\`.* TO 'migration'@'localhost'`]),
    ["GRANT 'migration_role'@'%' TO 'migration'@'localhost'"],
    ["GRANT ALL PRIVILEGES ON `other_db`.* TO 'migration'@'localhost'"],
    ["GRANT SELECT, SHOW VIEW, TRIGGER, REFERENCES ON `synthetic_db`.`inference_providers` TO 'migration'@'localhost'"],
    ["GRANT ALL PRIVILEGES ON *.* TO 'migration'@'localhost'", "REVOKE TRIGGER ON `synthetic_db`.* FROM 'migration'@'localhost'"],
  ]
  for (const prefix of [76, 96]) for (const grants of insufficient) {
    const state = fixture({ prefix, grants })
    await assert.rejects(state.run(), /metadata absence is not trustworthy|partial privilege revocations/)
    assertReadOnly(state)
    assert.equal(state.calls.some(({ sql }) => /information_schema|GET_LOCK/.test(sql)), false)
  }
  const unreadable = fixture({ grantFailure: true })
  await assert.rejects(unreadable.run(), /cannot inspect direct grants/)
  assertReadOnly(unreadable)
})

test("direct global and database-wide privilege unions satisfy visibility without relying on roles", async () => {
  for (const grants of [
    ["GRANT ALL PRIVILEGES ON *.* TO 'migration'@'localhost' WITH GRANT OPTION"],
    ["GRANT ALL PRIVILEGES ON `synthetic_db`.* TO 'migration'@'localhost'"],
    ["GRANT SELECT, SHOW VIEW ON *.* TO 'migration'@'localhost'", "GRANT TRIGGER, REFERENCES ON `synthetic_db`.* TO 'migration'@'localhost'"],
  ]) {
    const state = fixture({ grants })
    await state.run()
    assert.equal(state.executed, 82)
    const queries = state.calls.map(({ sql }) => sql)
    assert.ok(queries.indexOf("SHOW GRANTS") < queries.findIndex((sql) => sql.includes("information_schema.TABLES")))
    assert.doesNotMatch(queries.join("\n"), /SET\s+(SESSION|GLOBAL)|SET\s+default_storage_engine/i)
  }
})

test("session defaults and visibility are rechecked after predecessors and before final validation", async () => {
  for (const failedInspection of [2, 3]) for (const guard of ["engine", "grants"]) {
    const state = fixture({ prefix: 76 })
    const original = state.executor.query
    let inspections = 0
    state.executor.query = async (sql, args) => {
      if (sql.includes("@@SESSION.default_storage_engine")) inspections++
      if (inspections === failedInspection && ((guard === "engine" && sql.includes("@@SESSION.default_storage_engine")) || (guard === "grants" && sql === "SHOW GRANTS"))) {
        state.calls.push({ sql, args: args ?? [] })
        return guard === "engine" ? [{ engine: "MyISAM", db: "synthetic_db" }] : []
      }
      return original(sql, args)
    }
    await assert.rejects(state.run(), /SESSION default_storage_engine|metadata absence is not trustworthy/)
    assert.equal(state.executed, failedInspection === 2 ? 0 : 82)
    assert.equal(state.receipts.length, 96)
    assert.equal(state.calls.some(({ sql }) => sql.startsWith("INSERT INTO")), false)
  }
})

test("completed canonical receipts do not inspect engine or grants even for restricted accounts", async () => {
  for (const prefix of [97, plan.migrations.length]) {
    const state = fixture({ prefix, engine: "MyISAM", grants: [], grantFailure: true })
    await state.run()
    assert.equal(state.calls.length, 1)
    assert.match(state.calls[0].sql, /^SELECT hash, created_at/)
  }
})

test("competing compatibility runner fails before writes", async () => {
  const state = fixture({ locked: true })
  await assert.rejects(state.run(), /owns this database/)
  assertReadOnly(state)
})
