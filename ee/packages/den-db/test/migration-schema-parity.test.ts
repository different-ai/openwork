import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { drizzle } from "drizzle-orm/mysql2"
import { migrate } from "drizzle-orm/mysql2/migrator"
import mysql from "mysql2/promise"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"
import { ensureSchemaRepairs, type Executor } from "../src/schema-repairs.ts"
import {
  ConfigObjectTable,
  ConfigObjectVersionTable,
} from "../src/schema/sharables/plugin-arch.ts"

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..")
const migrationsFolder = join(packageDir, "drizzle")
const mysqlUrl = process.env.DEN_DB_MYSQL_TEST_URL?.trim()
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function quoteIdentifier(identifier: string) {
  return `\`${identifier.replace(/`/g, "``")}\``
}

function scratchDatabaseName() {
  return `ow_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

function databaseUrlFor(baseUrl: string, databaseName: string) {
  const url = new URL(baseUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

function mysqlConnectionConfigFor(baseUrl: string, databaseName: string) {
  return {
    ...parseMySqlConnectionConfig(databaseUrlFor(baseUrl, databaseName)),
    multipleStatements: true,
  }
}

async function queryRecords(
  connection: mysql.Connection,
  sql: string,
  args: (string | number)[] = [],
) {
  const [rows] = await connection.query(sql, args)
  return Array.isArray(rows) ? rows.filter(isRecord) : []
}

function executorFor(connection: mysql.Connection): Executor {
  return {
    query: (sql, args = []) => queryRecords(connection, sql, args),
  }
}

function stringField(row: Record<string, unknown>, field: string) {
  const value = row[field]
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`)
  }
  return value
}

function shortOutput(output: string) {
  return output.slice(Math.max(0, output.length - 2_000))
}

function sqlFromDrizzleKitExport(stdout: string) {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n")
  const firstSqlLine = lines.findIndex((line) => /^(CREATE|ALTER|DROP)\s/i.test(line.trimStart()))

  if (firstSqlLine === -1) {
    throw new Error("drizzle-kit export did not emit SQL")
  }

  return `${lines.slice(firstSqlLine).join("\n").trim()}\n`
}

const drizzleKitExportArgs = ["exec", "drizzle-kit", "export", "--config", "drizzle.config.ts"]
const drizzleKitExportCommand = [pnpmCommand, ...drizzleKitExportArgs].join(" ")

type ExportResult = {
  status: number | null
  stdout: string
  stderr: string
  error?: Error
}

type ExportRunner = (command: string, args: string[]) => ExportResult

const defaultExportRunner: ExportRunner = (command, args) =>
  spawnSync(command, args, {
    cwd: packageDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_HOST: "",
      DATABASE_NAME: "",
      DATABASE_PASSWORD: "",
      DATABASE_URL: "",
      DATABASE_USERNAME: "",
    },
  })

function exportFailureDiagnostics(result: ExportResult) {
  const reasons: string[] = []
  if (result.status !== 0) reasons.push(`exit status was ${result.status}`)
  if (result.error) reasons.push(result.error.message)

  try {
    sqlFromDrizzleKitExport(result.stdout)
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error))
  }

  if (reasons.length === 0) return
  return `${reasons.join("; ")}\ncommand: ${drizzleKitExportCommand}\nexit status: ${result.status}\nerror: ${result.error?.message ?? "(none)"}\nstderr:\n${shortOutput(result.stderr)}\nstdout:\n${shortOutput(result.stdout)}`
}

async function runDrizzleKitExport(runner: ExportRunner = defaultExportRunner, retryDelayMs = 2_000) {
  const failures: string[] = []

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = runner(pnpmCommand, drizzleKitExportArgs)
    const diagnostics = exportFailureDiagnostics(result)
    if (!diagnostics) return sqlFromDrizzleKitExport(result.stdout)

    failures.push(`Attempt ${attempt}:\n${diagnostics}`)
    if (attempt === 1) {
      console.error(`drizzle-kit export first attempt failed; retrying once\n${diagnostics}`)
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }

  throw new Error(`drizzle-kit export failed after 2 attempts\n\n${failures.join("\n\n")}`)
}

async function exportCurrentSchemaSql() {
  return runDrizzleKitExport()
}

test("drizzle-kit export retries empty SQL and returns the successful retry", async () => {
  let attempts = 0
  const sql = "CREATE TABLE `example` (`id` int);\n"
  const runner: ExportRunner = (command, args) => {
    assert.equal(command, pnpmCommand)
    assert.deepEqual(args, drizzleKitExportArgs)
    attempts += 1
    return attempts === 1
      ? { status: 0, stdout: "No SQL here", stderr: "temporary runner issue" }
      : { status: 0, stdout: sql, stderr: "" }
  }

  assert.equal(await runDrizzleKitExport(runner, 0), sql)
  assert.equal(attempts, 2)
})

test("drizzle-kit export reports diagnostics from both failed attempts", async () => {
  let attempts = 0
  const runner: ExportRunner = () => {
    attempts += 1
    return {
      status: attempts === 1 ? 1 : 2,
      stdout: `failed stdout ${attempts}`,
      stderr: `failed stderr ${attempts}`,
    }
  }

  await assert.rejects(runDrizzleKitExport(runner, 0), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /exit status: 1/)
    assert.match(error.message, /exit status: 2/)
    assert.match(error.message, /failed stderr 1/)
    assert.match(error.message, /failed stderr 2/)
    assert.ok(error.message.includes(`command: ${drizzleKitExportCommand}`))
    return true
  })
})

test("drizzle-kit export returns successful SQL unchanged", async () => {
  const sql = "CREATE TABLE `example` (`id` int);\nALTER TABLE `example` ADD `name` text;\n"
  const runner: ExportRunner = () => ({ status: 0, stdout: sql, stderr: "" })

  assert.equal(await runDrizzleKitExport(runner, 0), sql)
})

function splitSqlStatements(sql: string) {
  return sql
    .replace(/\r\n/g, "\n")
    .split(/;\s*(?:\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
}

function createTableName(statement: string) {
  return /^CREATE\s+TABLE\s+`([^`]+)`/i.exec(statement)?.[1]
}

function indexTableName(statement: string) {
  return /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+`[^`]+`\s+ON\s+`([^`]+)`/i.exec(statement)?.[1]
}

function indexName(statement: string) {
  return /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+`([^`]+)`/i.exec(statement)?.[1]
}

async function migrationOwnedTables() {
  const entries = await readdir(migrationsFolder)
  const tables = new Set<string>()
  const createTableRegex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`([^`]+)`/gi
  const renameTableRegex = /RENAME\s+TABLE\s+`[^`]+`\s+TO\s+`([^`]+)`/gi

  for (const entry of entries) {
    if (!entry.endsWith(".sql")) {
      continue
    }

    const sql = await readFile(join(migrationsFolder, entry), "utf8")
    let match = createTableRegex.exec(sql)
    while (match) {
      tables.add(match[1])
      match = createTableRegex.exec(sql)
    }
    match = renameTableRegex.exec(sql)
    while (match) {
      tables.add(match[1])
      match = renameTableRegex.exec(sql)
    }
  }

  return tables
}

async function migrationOwnedIndexes() {
  const entries = await readdir(migrationsFolder)
  const indexes = new Set<string>()
  const createIndexRegex = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+`([^`]+)`/gi

  for (const entry of entries) {
    if (!entry.endsWith(".sql")) {
      continue
    }

    const sql = await readFile(join(migrationsFolder, entry), "utf8")
    let match = createIndexRegex.exec(sql)
    while (match) {
      indexes.add(match[1])
      match = createIndexRegex.exec(sql)
    }
  }

  return indexes
}

function exportTableNames(statements: string[]) {
  return statements
    .map(createTableName)
    .filter((tableName): tableName is string => typeof tableName === "string")
    .sort()
}

// Columns that migrations ADD to tables the migration chain does not create
// (those tables are seeded from the current export before replay, so the
// seeded CREATE TABLE must not already contain the columns the replay adds).
// worker: added by 0002 and 0084. oauth*: added by 0056.
const SEED_COLUMN_STRIPS: Record<string, string[]> = {
  worker: [
    "last_heartbeat_at",
    "last_active_at",
    "cloud_failure_code",
    "cloud_failure_stage",
    "cloud_failure_reference",
    "cloud_failure_at",
  ],
  oauthClient: [
    "backchannel_logout_uri",
    "backchannel_logout_session_required",
    "jwks",
    "jwks_uri",
    "dpop_bound_access_tokens",
  ],
  oauthAccessToken: [
    "authorization_code_id",
    "resources",
    "requested_user_info_claims",
    "revoked",
    "confirmation",
  ],
  oauthRefreshToken: [
    "authorization_code_id",
    "resources",
    "requested_user_info_claims",
    "rotated_at",
    "rotation_replay_response",
    "rotation_replay_expires_at",
    "confirmation",
  ],
  oauthConsent: ["resources", "requested_user_info_claims"],
}

function statementForSeed(statement: string) {
  const tableName = createTableName(statement)
  const strips = tableName ? SEED_COLUMN_STRIPS[tableName] : undefined
  if (!strips) {
    return statement
  }

  let seeded = statement
  for (const column of strips) {
    seeded = seeded.replace(new RegExp(`\\n\\s*\`${column}\` [^,\\n]+,`, "i"), "")
  }
  return seeded
}

test("worker seed strips every column added by committed migrations", async () => {
  const migrationEntries = (await readdir(migrationsFolder))
    .filter((entry) => entry.endsWith(".sql"))
  const addedWorkerColumns: string[] = []

  for (const entry of migrationEntries) {
    const sql = await readFile(join(migrationsFolder, entry), "utf8")
    for (const match of sql.matchAll(/ALTER\s+TABLE\s+`worker`\s+ADD\s+`([^`]+)`/gi)) {
      addedWorkerColumns.push(match[1])
    }
  }

  assert.deepEqual(
    addedWorkerColumns.filter((column) => !SEED_COLUMN_STRIPS.worker.includes(column)),
    [],
  )
})

function seedShouldSkipIndex(statement: string) {
  return /^CREATE\s+INDEX\s+`worker_last_(?:heartbeat|active)_at`\s+ON\s+`worker`/i.test(statement)
}

async function seedNonMigrationOwnedTables(
  connection: mysql.Connection,
  exportStatements: string[],
  nonMigrationOwnedTables: Set<string>,
  migrationCreatedIndexes: Set<string>,
) {
  // The committed migrations start after the original auth/system schema. They do not
  // create the export tables in nonMigrationOwnedTables, so those tables are seeded
  // before replay. The worker table is seeded from export with the two columns that
  // 0002 adds removed, letting the full migration chain replay deterministically.
  for (const statement of exportStatements) {
    const tableName = createTableName(statement)
    if (tableName && nonMigrationOwnedTables.has(tableName)) {
      await connection.query(statementForSeed(statement))
    }
  }

  for (const statement of exportStatements) {
    const tableName = indexTableName(statement)
    const createdIndexName = indexName(statement)
    if (
      tableName &&
      createdIndexName &&
      nonMigrationOwnedTables.has(tableName) &&
      !migrationCreatedIndexes.has(createdIndexName) &&
      !seedShouldSkipIndex(statement)
    ) {
      await connection.query(statement)
    }
  }
}

async function applyStatements(connection: mysql.Connection, statements: string[]) {
  for (const statement of statements) {
    await connection.query(statement)
  }
}

async function schemaColumnLines(connection: mysql.Connection) {
  const rows = await queryRecords(
    connection,
    `SELECT table_name AS table_name, column_name AS column_name, column_type AS column_type, is_nullable AS is_nullable
     FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name <> '__drizzle_migrations'
     ORDER BY table_name, ordinal_position`,
  )

  return rows.map((row) => {
    const tableName = stringField(row, "table_name")
    const columnName = stringField(row, "column_name")
    const columnType = stringField(row, "column_type")
    const isNullable = stringField(row, "is_nullable")
    return `${tableName}.${columnName}: ${columnType} ${isNullable}`
  })
}

async function schemaIndexLines(connection: mysql.Connection) {
  const rows = await queryRecords(
    connection,
    `SELECT table_name AS table_name, index_name AS index_name, column_name AS column_name
     FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name <> '__drizzle_migrations'
     ORDER BY table_name, index_name, seq_in_index`,
  )
  const keys: string[] = []
  const columnsByKey = new Map<string, string[]>()

  for (const row of rows) {
    const tableName = stringField(row, "table_name")
    const indexName = stringField(row, "index_name")
    const key = `${tableName}.${indexName}`
    let columns = columnsByKey.get(key)
    if (!columns) {
      columns = []
      columnsByKey.set(key, columns)
      keys.push(key)
    }
    columns.push(stringField(row, "column_name"))
  }

  return keys.sort().map((key) => {
    const columns = columnsByKey.get(key)
    assert.ok(columns, `Missing columns for ${key}`)
    return `${key}: ${columns.join(",")}`
  })
}

function diffLines(expected: string[], actual: string[]) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  const missing = expected.filter((line) => !actualSet.has(line))
  const extra = actual.filter((line) => !expectedSet.has(line))
  const lines: string[] = []

  if (missing.length > 0) {
    lines.push("Missing:", ...missing.map((line) => `  - ${line}`))
  }
  if (extra.length > 0) {
    lines.push("Extra:", ...extra.map((line) => `  + ${line}`))
  }

  return lines.join("\n")
}

async function assertSchemasMatch(expected: mysql.Connection, actual: mysql.Connection) {
  const expectedColumns = await schemaColumnLines(expected)
  const actualColumns = await schemaColumnLines(actual)
  const columnDiff = diffLines(expectedColumns, actualColumns)
  assert.equal(columnDiff, "", `Column parity mismatch\n${columnDiff}`)

  const expectedIndexes = await schemaIndexLines(expected)
  const actualIndexes = await schemaIndexLines(actual)
  const indexDiff = diffLines(expectedIndexes, actualIndexes)
  assert.equal(indexDiff, "", `Index parity mismatch\n${indexDiff}`)
}

async function runRegressionInsert(connection: mysql.Connection) {
  const previousEncryptionKey = process.env.DEN_DB_ENCRYPTION_KEY
  process.env.DEN_DB_ENCRYPTION_KEY = "12345678901234567890123456789012"
  try {
    const db = drizzle(connection)
    const organizationId = createDenTypeId("organization")
    const memberId = createDenTypeId("member")
    const configObjectId = createDenTypeId("configObject")

    await db.insert(ConfigObjectTable).values({
      id: configObjectId,
      organizationId,
      objectType: "skill",
      sourceMode: "cloud",
      title: "Parity insert object",
      createdByOrgMembershipId: memberId,
    })

    await db.insert(ConfigObjectVersionTable).values({
      id: createDenTypeId("configObjectVersion"),
      organizationId,
      configObjectId,
      normalizedPayloadJson: { ok: true },
      rawSourceText: "insert proof",
      createdVia: "cloud",
    })
  } finally {
    if (previousEncryptionKey === undefined) {
      delete process.env.DEN_DB_ENCRYPTION_KEY
    } else {
      process.env.DEN_DB_ENCRYPTION_KEY = previousEncryptionKey
    }
  }
}

test("migrations replay to exported schema and config object version inserts", { skip: !mysqlUrl, timeout: 300_000 }, async () => {
  if (!mysqlUrl) return

  const root = await mysql.createConnection(mysqlUrl)
  const migratedDatabase = scratchDatabaseName()
  const exportedDatabase = scratchDatabaseName()
  let migratedConnection: mysql.Connection | undefined
  let exportedConnection: mysql.Connection | undefined

  try {
    await root.query(`CREATE DATABASE ${quoteIdentifier(migratedDatabase)}`)
    await root.query(`CREATE DATABASE ${quoteIdentifier(exportedDatabase)}`)

    const exportSql = await exportCurrentSchemaSql()
    const exportStatements = splitSqlStatements(exportSql)
    const ownedTables = await migrationOwnedTables()
    const ownedIndexes = await migrationOwnedIndexes()
    const nonMigrationOwnedTableNames = exportTableNames(exportStatements).filter((tableName) => !ownedTables.has(tableName))
    const nonMigrationOwnedTables = new Set(nonMigrationOwnedTableNames)

    migratedConnection = await mysql.createConnection(mysqlConnectionConfigFor(mysqlUrl, migratedDatabase))
    exportedConnection = await mysql.createConnection(mysqlConnectionConfigFor(mysqlUrl, exportedDatabase))

    await seedNonMigrationOwnedTables(migratedConnection, exportStatements, nonMigrationOwnedTables, ownedIndexes)

    const migratedDb = drizzle(migratedConnection)
    await migrate(migratedDb, { migrationsFolder })
    await ensureSchemaRepairs(executorFor(migratedConnection))

    await applyStatements(exportedConnection, exportStatements)
    await ensureSchemaRepairs(executorFor(exportedConnection))

    await assertSchemasMatch(exportedConnection, migratedConnection)
    await runRegressionInsert(migratedConnection)
  } finally {
    await migratedConnection?.end().catch(() => {})
    await exportedConnection?.end().catch(() => {})
    await root.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(migratedDatabase)}`).catch(() => {})
    await root.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(exportedDatabase)}`).catch(() => {})
    await root.end()
  }
})

test("0076 migrates workflow table, enums, and legacy data without changing IDs", { skip: !mysqlUrl, timeout: 120_000 }, async () => {
  if (!mysqlUrl) return

  const root = await mysql.createConnection(mysqlUrl)
  const database = scratchDatabaseName()
  let connection: mysql.Connection | undefined

  try {
    await root.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    connection = await mysql.createConnection(databaseUrlFor(mysqlUrl, database))
    await connection.query("CREATE TABLE `codemode_run` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, `automation_run_id` varchar(64), `config_object_id` varchar(64), `finished_at` timestamp(3) NOT NULL, `created_at` timestamp(3) NOT NULL, `payload` text, PRIMARY KEY (`id`), KEY `codemode_run_org_created` (`organization_id`,`created_at`), KEY `codemode_run_automation` (`automation_run_id`), KEY `codemode_run_artifact_history` (`config_object_id`,`finished_at`))")
    await connection.query("CREATE TABLE `config_object` (`id` varchar(64) NOT NULL, `object_type` enum('skill','agent','command','tool','mcp','hook','context','custom','script','app') NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("CREATE TABLE `connector_mapping` (`id` varchar(64) NOT NULL, `object_type` enum('skill','agent','command','tool','mcp','hook','context','custom','script','app') NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("INSERT INTO `codemode_run` (`id`, `organization_id`, `finished_at`, `created_at`, `payload`) VALUES ('cmr_01k28e8q8pf8r9sff9mhyqxved', 'org_legacy', NOW(3), NOW(3), 'retained')")
    await connection.query("INSERT INTO `config_object` (`id`, `object_type`) VALUES ('cob_legacy', 'script')")
    await connection.query("INSERT INTO `connector_mapping` (`id`, `object_type`) VALUES ('cmp_legacy', 'script')")

    const migrationSql = await readFile(join(migrationsFolder, "0076_abnormal_mongu.sql"), "utf8")
    await applyStatements(connection, splitSqlStatements(migrationSql.replace(/--> statement-breakpoint/g, "")))
    await connection.query("INSERT INTO `workflow_run` (`id`, `organization_id`, `finished_at`, `created_at`, `payload`) VALUES ('wfr_01k28e8q8pf8r9sff9mhyqxvee', 'org_new', NOW(3), NOW(3), 'new')")

    const tables = await queryRecords(connection, "SELECT table_name AS table_name FROM information_schema.TABLES WHERE table_schema = DATABASE() AND table_name IN ('codemode_run', 'workflow_run') ORDER BY table_name")
    assert.deepEqual(tables.map((row) => row.table_name), ["workflow_run"])
    const runs = await queryRecords(connection, "SELECT `id`, `payload` FROM `workflow_run` ORDER BY `id`")
    assert.deepEqual(runs, [
      { id: "cmr_01k28e8q8pf8r9sff9mhyqxved", payload: "retained" },
      { id: "wfr_01k28e8q8pf8r9sff9mhyqxvee", payload: "new" },
    ])
    const objects = await queryRecords(connection, "SELECT `object_type` FROM `config_object` WHERE `id` = 'cob_legacy'")
    const mappings = await queryRecords(connection, "SELECT `object_type` FROM `connector_mapping` WHERE `id` = 'cmp_legacy'")
    assert.equal(objects[0]?.object_type, "workflow")
    assert.equal(mappings[0]?.object_type, "workflow")
    const enumColumns = await queryRecords(connection, "SELECT `table_name` AS `table_name`, `column_type` AS `column_type` FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name IN ('config_object', 'connector_mapping') AND column_name = 'object_type' ORDER BY table_name")
    for (const row of enumColumns) {
      assert.match(stringField(row, "column_type"), /'workflow'/)
      assert.match(stringField(row, "column_type"), /'script'/)
    }
  } finally {
    await connection?.end().catch(() => {})
    await root.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`).catch(() => {})
    await root.end()
  }
})

async function recreateScenarioTables(connection: mysql.Connection) {
  await connection.query("DROP TABLE IF EXISTS `inference_org_limit_policies`")
  await connection.query("DROP TABLE IF EXISTS `config_object_version`")
  await connection.query("DROP TABLE IF EXISTS `config_object_access_grant`")
  await connection.query("DROP TABLE IF EXISTS `plugin_config_object`")
  await connection.query("DROP TABLE IF EXISTS `plugin_access_grant`")
  await connection.query("DROP TABLE IF EXISTS `connector_instance_access_grant`")
  await connection.query("DROP TABLE IF EXISTS `connector_target`")
  await connection.query("DROP TABLE IF EXISTS `connector_mapping`")
  await connection.query("DROP TABLE IF EXISTS `connector_sync_event`")
  await connection.query("DROP TABLE IF EXISTS `connector_source_binding`")
  await connection.query("DROP TABLE IF EXISTS `connector_source_tombstone`")
  await connection.query("DROP TABLE IF EXISTS `config_object`")
  await connection.query("DROP TABLE IF EXISTS `plugin`")
  await connection.query("DROP TABLE IF EXISTS `connector_instance`")
}

async function columnNullable(connection: mysql.Connection, table: string, column = "organization_id") {
  const rows = await queryRecords(
    connection,
    `SELECT is_nullable AS is_nullable FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  const row = rows[0]
  assert.ok(row, `Missing ${column} column on ${table}`)
  return stringField(row, "is_nullable")
}

async function indexExists(connection: mysql.Connection, table: string) {
  const rows = await queryRecords(
    connection,
    `SELECT 1 AS present FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, `${table}_organization_id`],
  )
  return rows.length > 0
}

test("ensureSchemaRepairs handles healthy, empty, backfill, and orphan tables", { skip: !mysqlUrl, timeout: 120_000 }, async () => {
  if (!mysqlUrl) return

  const root = await mysql.createConnection(mysqlUrl)
  const database = scratchDatabaseName()
  let connection: mysql.Connection | undefined

  try {
    await root.query(`CREATE DATABASE ${quoteIdentifier(database)}`)
    connection = await mysql.createConnection(databaseUrlFor(mysqlUrl, database))

    await recreateScenarioTables(connection)
    await connection.query("CREATE TABLE `config_object` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("CREATE TABLE `config_object_version` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, `config_object_id` varchar(64) NOT NULL, PRIMARY KEY (`id`), KEY `config_object_version_organization_id` (`organization_id`))")
    await ensureSchemaRepairs(executorFor(connection))
    assert.equal(await columnNullable(connection, "config_object_version"), "NO")
    assert.equal(await indexExists(connection, "config_object_version"), true)

    await recreateScenarioTables(connection)
    await connection.query("CREATE TABLE `plugin` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("CREATE TABLE `plugin_config_object` (`id` varchar(64) NOT NULL, `plugin_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await ensureSchemaRepairs(executorFor(connection))
    assert.equal(await columnNullable(connection, "plugin_config_object"), "NO")
    assert.equal(await indexExists(connection, "plugin_config_object"), true)

    await recreateScenarioTables(connection)
    await connection.query("CREATE TABLE `plugin` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("CREATE TABLE `plugin_access_grant` (`id` varchar(64) NOT NULL, `plugin_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("INSERT INTO `plugin` (`id`, `organization_id`) VALUES ('plugin_parent', 'org_parent')")
    await connection.query("INSERT INTO `plugin_access_grant` (`id`, `plugin_id`) VALUES ('grant_child', 'plugin_parent')")
    await ensureSchemaRepairs(executorFor(connection))
    assert.equal(await columnNullable(connection, "plugin_access_grant"), "NO")
    assert.equal(await indexExists(connection, "plugin_access_grant"), true)
    const backfilled = await queryRecords(connection, "SELECT `organization_id` FROM `plugin_access_grant` WHERE `id` = 'grant_child'")
    assert.equal(backfilled[0]?.organization_id, "org_parent")

    await recreateScenarioTables(connection)
    await connection.query("CREATE TABLE `config_object` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("CREATE TABLE `config_object_access_grant` (`id` varchar(64) NOT NULL, `organization_id` varchar(64), `config_object_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("INSERT INTO `config_object` (`id`, `organization_id`) VALUES ('config_parent', 'org_resume')")
    await connection.query("INSERT INTO `config_object_access_grant` (`id`, `organization_id`, `config_object_id`) VALUES ('resume_child', NULL, 'config_parent')")
    await ensureSchemaRepairs(executorFor(connection))
    assert.equal(await columnNullable(connection, "config_object_access_grant"), "NO")
    assert.equal(await indexExists(connection, "config_object_access_grant"), true)
    const resumed = await queryRecords(connection, "SELECT `organization_id` FROM `config_object_access_grant` WHERE `id` = 'resume_child'")
    assert.equal(resumed[0]?.organization_id, "org_resume")

    await recreateScenarioTables(connection)
    await connection.query("CREATE TABLE `inference_org_limit_policies` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, `window_type` enum('five_hour','weekly','monthly') NOT NULL, `limit_amount` bigint NOT NULL, `reset_strategy` enum('anchored','activity_based') NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("INSERT INTO `inference_org_limit_policies` (`id`, `organization_id`, `window_type`, `limit_amount`, `reset_strategy`) VALUES ('policy_old', 'org_limit', 'five_hour', 10, 'anchored')")
    await ensureSchemaRepairs(executorFor(connection))
    await ensureSchemaRepairs(executorFor(connection))
    assert.equal(await columnNullable(connection, "inference_org_limit_policies", "limit_amount"), "YES")
    await connection.query("INSERT INTO `inference_org_limit_policies` (`id`, `organization_id`, `window_type`, `reset_strategy`) VALUES ('policy_new', 'org_limit', 'weekly', 'anchored')")

    await recreateScenarioTables(connection)
    await connection.query("CREATE TABLE `connector_instance` (`id` varchar(64) NOT NULL, `organization_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("CREATE TABLE `connector_target` (`id` varchar(64) NOT NULL, `connector_instance_id` varchar(64) NOT NULL, PRIMARY KEY (`id`))")
    await connection.query("INSERT INTO `connector_target` (`id`, `connector_instance_id`) VALUES ('orphan_target', 'missing_instance')")
    await assert.rejects(
      () => ensureSchemaRepairs(executorFor(connection)),
      /connector_target.*orphan_target/,
    )
  } finally {
    await connection?.end().catch(() => {})
    await root.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`).catch(() => {})
    await root.end()
  }
})
