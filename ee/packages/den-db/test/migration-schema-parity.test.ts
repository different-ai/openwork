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
import { ensureFulltextIndexes } from "../src/fulltext.ts"
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
  return output.slice(Math.max(0, output.length - 4_000))
}

function sqlFromDrizzleKitExport(stdout: string) {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n")
  const firstSqlLine = lines.findIndex((line) => /^(CREATE|ALTER|DROP)\s/i.test(line.trimStart()))

  if (firstSqlLine === -1) {
    throw new Error("drizzle-kit export did not emit SQL")
  }

  return `${lines.slice(firstSqlLine).join("\n").trim()}\n`
}

function exportCurrentSchemaSql() {
  const result = spawnSync(pnpmCommand, ["exec", "drizzle-kit", "export", "--config", "drizzle.config.ts"], {
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

  assert.equal(
    result.status,
    0,
    `drizzle-kit export failed\nstdout:\n${shortOutput(result.stdout)}\nstderr:\n${shortOutput(result.stderr)}`,
  )
  return sqlFromDrizzleKitExport(result.stdout)
}

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

function statementForSeed(statement: string) {
  if (createTableName(statement) !== "worker") {
    return statement
  }

  return statement
    .replace(/\n\s*`last_heartbeat_at` timestamp\(3\),/i, "")
    .replace(/\n\s*`last_active_at` timestamp\(3\),/i, "")
}

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

    const exportSql = exportCurrentSchemaSql()
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
    await ensureFulltextIndexes(executorFor(migratedConnection))
    await ensureSchemaRepairs(executorFor(migratedConnection))

    await applyStatements(exportedConnection, exportStatements)
    await ensureFulltextIndexes(executorFor(exportedConnection))
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
