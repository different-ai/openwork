import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseMySqlConnectionConfig } from "../../src/mysql-config"

const MIGRATIONS_TABLE = "__drizzle_migrations"
const LOCK_TABLE = "__openwork_migration_lock"
const PROGRESS_TABLE = "__openwork_migration_progress"
const LOCK_NAME = "openwork-den-schema"
const BOOTSTRAP_PROGRESS_TAG = "bootstrap"
const LEGACY_BASELINE_PROGRESS_TAG = "legacy-baseline"
const STATEMENT_BREAKPOINT = "--> statement-breakpoint"

export enum ExitCode {
  Success = 0,
  ConfigurationInvalid = 2,
  DatabaseUnreachable = 3,
  TlsVerificationFailed = 4,
  DatabaseIncompatible = 5,
  MigrationLockUnavailable = 6,
  MigrationStatementFailed = 7,
  VerificationFailed = 8,
  ReleaseArtifactInvalid = 10,
  ProcessInterrupted = 130,
  ProcessTerminated = 143,
}

export type FailureCategory =
  | "configuration_invalid"
  | "database_unreachable"
  | "tls_verification_failed"
  | "database_incompatible"
  | "migration_lock_unavailable"
  | "migration_statement_failed"
  | "verification_failed"
  | "release_artifact_invalid"
  | "process_interrupted"
  | "process_terminated"

type LogValue = string | number | boolean | null
type LogFields = Record<string, LogValue>
type QueryValue = string | number

type ManifestIndex = {
  name: string
  table: string
}

type RequiredIndex = ManifestIndex & {
  columns: string[]
  kind: string
}

type ManifestMigration = {
  idx: number
  createdAt: number
  tag: string
  file: string
  sha256: string
}

type MigrationManifest = {
  formatVersion: number
  dialect: string
  schemaVersion: string
  journalVersion: string
  bootstrap: {
    file: string
    sha256: string
    tables: string[]
    indexes: ManifestIndex[]
  }
  requiredIndexes: RequiredIndex[]
  migrations: ManifestMigration[]
}

type LoadedArtifact = {
  root: string
  manifest: MigrationManifest
  bootstrapSql: string
  migrationSql: Map<string, string>
}

type RunnerConfig = {
  mode: "apply" | "check"
  databaseMode: "mysql" | "planetscale"
  databaseUrl: string | null
  databaseHost: string | null
  databaseUsername: string | null
  databasePassword: string
  connectTimeoutMs: number
  lockTimeoutSeconds: number
  lockLeaseSeconds: number
}

type Executor = {
  query: (sql: string, args?: QueryValue[]) => Promise<Record<string, unknown>[]>
  close: () => Promise<void>
}

type MigrationPlan = {
  state: "empty" | "legacy" | "managed"
  pending: ManifestMigration[]
}

type RunSummary = {
  mode: "apply" | "check"
  schemaVersion: string
  databaseVersion: string
  databaseState: MigrationPlan["state"]
  pending: number
  applied: number
  baselined: number
  indexesCreated: number
  durationMs: number
}

export class MigrationFailure extends Error {
  readonly category: FailureCategory
  readonly exitCode: ExitCode
  readonly stage: string
  readonly fields: LogFields

  constructor(input: {
    category: FailureCategory
    exitCode: ExitCode
    stage: string
    message: string
    fields?: LogFields
    cause?: unknown
  }) {
    super(input.message, { cause: input.cause })
    this.name = "MigrationFailure"
    this.category = input.category
    this.exitCode = input.exitCode
    this.stage = input.stage
    this.fields = input.fields ?? {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return []
  }
  const rows: Record<string, unknown>[] = []
  for (const entry of value) {
    if (isRecord(entry)) {
      rows.push(entry)
    }
  }
  return rows
}

function log(level: "info" | "error", event: string, fields: LogFields = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    component: "den-db-migration",
    ...fields,
  }))
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw artifactFailure(`Manifest field '${field}' must be a non-empty string.`)
  }
  return value
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw artifactFailure(`Manifest field '${field}' must be a finite number.`)
  }
  return value
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw artifactFailure(`Manifest field '${field}' must be an array.`)
  }
  return value.map((entry, index) => stringField(entry, `${field}[${index}]`))
}

function parseManifestIndex(value: unknown, field: string): ManifestIndex {
  if (!isRecord(value)) {
    throw artifactFailure(`Manifest field '${field}' must be an object.`)
  }
  return {
    name: stringField(value.name, `${field}.name`),
    table: stringField(value.table, `${field}.table`),
  }
}

function parseRequiredIndex(value: unknown, field: string): RequiredIndex {
  if (!isRecord(value)) {
    throw artifactFailure(`Manifest field '${field}' must be an object.`)
  }
  return {
    ...parseManifestIndex(value, field),
    columns: stringArray(value.columns, `${field}.columns`),
    kind: stringField(value.kind, `${field}.kind`),
  }
}

function parseMigration(value: unknown, field: string): ManifestMigration {
  if (!isRecord(value)) {
    throw artifactFailure(`Manifest field '${field}' must be an object.`)
  }
  return {
    idx: numberField(value.idx, `${field}.idx`),
    createdAt: numberField(value.createdAt, `${field}.createdAt`),
    tag: stringField(value.tag, `${field}.tag`),
    file: stringField(value.file, `${field}.file`),
    sha256: stringField(value.sha256, `${field}.sha256`),
  }
}

export function parseManifest(value: unknown): MigrationManifest {
  if (!isRecord(value) || !isRecord(value.bootstrap)) {
    throw artifactFailure("Migration manifest must be an object with bootstrap metadata.")
  }
  if (!Array.isArray(value.bootstrap.indexes) || !Array.isArray(value.requiredIndexes) || !Array.isArray(value.migrations)) {
    throw artifactFailure("Migration manifest index and migration fields must be arrays.")
  }

  const manifest: MigrationManifest = {
    formatVersion: numberField(value.formatVersion, "formatVersion"),
    dialect: stringField(value.dialect, "dialect"),
    schemaVersion: stringField(value.schemaVersion, "schemaVersion"),
    journalVersion: stringField(value.journalVersion, "journalVersion"),
    bootstrap: {
      file: stringField(value.bootstrap.file, "bootstrap.file"),
      sha256: stringField(value.bootstrap.sha256, "bootstrap.sha256"),
      tables: stringArray(value.bootstrap.tables, "bootstrap.tables"),
      indexes: value.bootstrap.indexes.map((entry, index) => parseManifestIndex(entry, `bootstrap.indexes[${index}]`)),
    },
    requiredIndexes: value.requiredIndexes.map((entry, index) => parseRequiredIndex(entry, `requiredIndexes[${index}]`)),
    migrations: value.migrations.map((entry, index) => parseMigration(entry, `migrations[${index}]`)),
  }

  if (manifest.formatVersion !== 1 || manifest.dialect !== "mysql") {
    throw artifactFailure(`Unsupported migration artifact format ${manifest.formatVersion}/${manifest.dialect}.`)
  }
  if (manifest.migrations.length === 0 || manifest.migrations[manifest.migrations.length - 1]?.tag !== manifest.schemaVersion) {
    throw artifactFailure("Migration manifest schemaVersion does not match the final migration.")
  }

  for (let index = 1; index < manifest.migrations.length; index += 1) {
    const previous = manifest.migrations[index - 1]
    const current = manifest.migrations[index]
    if (!previous || !current || current.createdAt <= previous.createdAt || current.idx <= previous.idx) {
      throw artifactFailure("Migration manifest entries must be strictly ordered.")
    }
  }

  return manifest
}

function artifactFailure(message: string, fields: LogFields = {}, cause?: unknown) {
  return new MigrationFailure({
    category: "release_artifact_invalid",
    exitCode: ExitCode.ReleaseArtifactInvalid,
    stage: "load_artifact",
    message,
    fields,
    cause,
  })
}

function sha256(contents: string) {
  return createHash("sha256").update(contents).digest("hex")
}

async function readVerifiedSql(root: string, file: string, expectedHash: string) {
  const resolved = path.resolve(root, file)
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw artifactFailure(`Migration artifact path escapes its immutable root: ${file}`)
  }

  let contents: string
  try {
    contents = await readFile(resolved, "utf8")
  } catch (error) {
    throw artifactFailure(`Migration artifact file is missing: ${file}`, { file }, error)
  }

  const actualHash = sha256(contents)
  if (actualHash !== expectedHash) {
    throw artifactFailure(`Migration artifact hash mismatch: ${file}`, { file, expectedHash, actualHash })
  }
  return contents
}

async function loadArtifact(): Promise<LoadedArtifact> {
  const root = path.dirname(fileURLToPath(import.meta.url))
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"))
  } catch (error) {
    throw artifactFailure("Unable to read migration manifest.", {}, error)
  }

  const manifest = parseManifest(parsed)
  const bootstrapSql = await readVerifiedSql(root, manifest.bootstrap.file, manifest.bootstrap.sha256)
  const migrationSql = new Map<string, string>()
  for (const migration of manifest.migrations) {
    migrationSql.set(migration.tag, await readVerifiedSql(root, migration.file, migration.sha256))
  }
  return { root, manifest, bootstrapSql, migrationSql }
}

function parseIntegerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MigrationFailure({
      category: "configuration_invalid",
      exitCode: ExitCode.ConfigurationInvalid,
      stage: "validate_configuration",
      message: `${name} must be an integer between ${minimum} and ${maximum}.`,
      fields: { name },
    })
  }
  return value
}

export function parseConfig(argv = process.argv.slice(2)): RunnerConfig {
  const knownArgs = new Set(["--", "--check", "--dry-run"])
  const unknown = argv.filter((argument) => !knownArgs.has(argument))
  if (unknown.length > 0) {
    throw new MigrationFailure({
      category: "configuration_invalid",
      exitCode: ExitCode.ConfigurationInvalid,
      stage: "validate_configuration",
      message: `Unknown migration runner argument: ${unknown.join(", ")}`,
    })
  }

  const databaseUrl = process.env.DATABASE_URL?.trim() || null
  const databaseHost = process.env.DATABASE_HOST?.trim() || null
  const databaseUsername = process.env.DATABASE_USERNAME?.trim() || null
  const databasePassword = process.env.DATABASE_PASSWORD ?? ""
  const requestedMode = process.env.DB_MODE?.trim()
  const databaseMode = requestedMode || (databaseUrl ? "mysql" : "planetscale")

  if (databaseMode !== "mysql" && databaseMode !== "planetscale") {
    throw new MigrationFailure({
      category: "configuration_invalid",
      exitCode: ExitCode.ConfigurationInvalid,
      stage: "validate_configuration",
      message: "DB_MODE must be 'mysql' or 'planetscale'.",
    })
  }
  if (databaseMode === "mysql" && !databaseUrl) {
    throw new MigrationFailure({
      category: "configuration_invalid",
      exitCode: ExitCode.ConfigurationInvalid,
      stage: "validate_configuration",
      message: "DATABASE_URL is required when DB_MODE=mysql.",
    })
  }
  if (databaseMode === "planetscale" && (!databaseHost || !databaseUsername)) {
    throw new MigrationFailure({
      category: "configuration_invalid",
      exitCode: ExitCode.ConfigurationInvalid,
      stage: "validate_configuration",
      message: "DATABASE_HOST and DATABASE_USERNAME are required when DB_MODE=planetscale.",
    })
  }

  if (databaseUrl) {
    try {
      parseMySqlConnectionConfig(databaseUrl)
    } catch (error) {
      throw new MigrationFailure({
        category: "configuration_invalid",
        exitCode: ExitCode.ConfigurationInvalid,
        stage: "validate_configuration",
        message: error instanceof Error ? error.message : "DATABASE_URL is invalid.",
        cause: error,
      })
    }
  }

  return {
    mode: argv.includes("--check") || argv.includes("--dry-run") ? "check" : "apply",
    databaseMode,
    databaseUrl,
    databaseHost,
    databaseUsername,
    databasePassword,
    connectTimeoutMs: parseIntegerEnv("MIGRATION_CONNECT_TIMEOUT_MS", 10_000, 1_000, 120_000),
    lockTimeoutSeconds: parseIntegerEnv("MIGRATION_LOCK_TIMEOUT_SECONDS", 30, 0, 600),
    lockLeaseSeconds: parseIntegerEnv("MIGRATION_LOCK_LEASE_SECONDS", 300, 60, 3_600),
  }
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null
  }
  if (typeof error.code === "string") {
    return error.code
  }
  return errorCode(error.cause)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HANDSHAKE_SSL_ERROR",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
])

function connectionFailure(error: unknown) {
  const code = errorCode(error)
  const message = errorMessage(error)
  const tlsFailure = Boolean(code && TLS_ERROR_CODES.has(code)) || /certificate|tls|ssl/i.test(message)
  return new MigrationFailure({
    category: tlsFailure ? "tls_verification_failed" : "database_unreachable",
    exitCode: tlsFailure ? ExitCode.TlsVerificationFailed : ExitCode.DatabaseUnreachable,
    stage: "connect_database",
    message: tlsFailure ? "Database TLS verification failed." : "Database connection failed.",
    fields: code ? { code } : {},
    cause: error,
  })
}

async function createExecutor(config: RunnerConfig): Promise<Executor> {
  try {
    if (config.databaseMode === "mysql" && config.databaseUrl) {
      const mysql = await import("mysql2/promise")
      const connection = await mysql.createConnection({
        ...parseMySqlConnectionConfig(config.databaseUrl),
        connectTimeout: config.connectTimeoutMs,
      })
      return {
        query: async (sql, args = []) => {
          const [rows] = await connection.query(sql, args)
          return normalizeRows(rows)
        },
        close: () => connection.end(),
      }
    }

    if (!config.databaseHost || !config.databaseUsername) {
      throw new Error("PlanetScale credentials are incomplete.")
    }
    const { Client } = await import("@planetscale/database")
    const client = new Client({
      host: config.databaseHost,
      username: config.databaseUsername,
      password: config.databasePassword,
    })
    await client.execute("SELECT 1")
    return {
      query: async (sql, args = []) => {
        const result = await client.execute(sql, args)
        return normalizeRows(result.rows)
      },
      close: async () => {},
    }
  } catch (error) {
    throw connectionFailure(error)
  }
}

async function validateDatabaseCompatibility(executor: Executor, mode: RunnerConfig["databaseMode"]) {
  let rows: Record<string, unknown>[]
  try {
    rows = await executor.query("SELECT VERSION() AS version")
  } catch (error) {
    throw connectionFailure(error)
  }
  const value = rows[0]?.version
  const version = typeof value === "string" ? value : String(value ?? "unknown")
  const match = version.match(/^(\d+)\.(\d+)/)
  const major = match ? Number(match[1]) : NaN

  if (!Number.isFinite(major) || major < 8 || /mariadb/i.test(version)) {
    throw new MigrationFailure({
      category: "database_incompatible",
      exitCode: ExitCode.DatabaseIncompatible,
      stage: "check_database_compatibility",
      message: "OpenWork migrations require MySQL 8 or a compatible PlanetScale/Vitess database.",
      fields: { databaseVersion: version, databaseMode: mode },
    })
  }

  log("info", "database_compatible", { databaseVersion: version, databaseMode: mode })
  return version
}

async function listTables(executor: Executor) {
  const rows = await executor.query("SHOW TABLES")
  return rows
    .map((row) => Object.values(row).find((value) => typeof value === "string"))
    .filter((value): value is string => typeof value === "string")
}

async function listIndexes(executor: Executor) {
  const rows = await executor.query(
    "SELECT table_name AS tableName, index_name AS indexName FROM information_schema.STATISTICS WHERE table_schema = DATABASE()",
  )
  const indexes = new Set<string>()
  for (const row of rows) {
    if (typeof row.tableName === "string" && typeof row.indexName === "string") {
      indexes.add(`${row.tableName}.${row.indexName}`)
    }
  }
  return indexes
}

function missingSchemaObjects(manifest: MigrationManifest, tables: string[], indexes: Set<string>) {
  const tableSet = new Set(tables)
  return {
    tables: manifest.bootstrap.tables.filter((table) => !tableSet.has(table)),
    indexes: manifest.bootstrap.indexes
      .map((index) => `${index.table}.${index.name}`)
      .filter((index) => !indexes.has(index)),
  }
}

function ledgerRow(row: Record<string, unknown>) {
  const hash = typeof row.hash === "string" ? row.hash : null
  const createdAt = Number(row.createdAt ?? row.created_at)
  if (!hash || !Number.isFinite(createdAt)) {
    throw new MigrationFailure({
      category: "database_incompatible",
      exitCode: ExitCode.DatabaseIncompatible,
      stage: "inspect_schema_version",
      message: "The Drizzle migration ledger contains an invalid row.",
    })
  }
  return { hash, createdAt }
}

async function inspectMigrationPlan(executor: Executor, manifest: MigrationManifest): Promise<MigrationPlan> {
  const tables = await listTables(executor)
  const infrastructureTables = new Set([MIGRATIONS_TABLE, LOCK_TABLE, PROGRESS_TABLE])
  const applicationTables = tables.filter((table) => !infrastructureTables.has(table))

  if (tables.includes(PROGRESS_TABLE)) {
    const releaseMarkers = await executor.query(
      `SELECT migration_tag AS migrationTag, statement_hash AS statementHash
       FROM \`${PROGRESS_TABLE}\` WHERE statement_index = -1`,
    )
    if (releaseMarkers.length > 1) {
      throw new MigrationFailure({
        category: "database_incompatible",
        exitCode: ExitCode.DatabaseIncompatible,
        stage: "inspect_schema_version",
        message: "Database contains conflicting immutable migration recovery markers.",
      })
    }

    const releaseMarker = releaseMarkers[0]
    if (releaseMarker) {
      if (releaseMarker.statementHash !== manifest.bootstrap.sha256) {
        throw new MigrationFailure({
          category: "database_incompatible",
          exitCode: ExitCode.DatabaseIncompatible,
          stage: "resume_release_operation",
          message: "Interrupted database setup belongs to a different immutable release artifact.",
        })
      }

      const expectedTables = new Set(manifest.bootstrap.tables)
      const unexpectedTables = applicationTables.filter((table) => !expectedTables.has(table))
      if (unexpectedTables.length > 0) {
        throw new MigrationFailure({
          category: "database_incompatible",
          exitCode: ExitCode.DatabaseIncompatible,
          stage: "inspect_schema_version",
          message: "Interrupted bootstrap contains tables outside the immutable release schema.",
          fields: { unexpectedTables: unexpectedTables.length },
        })
      }

      if (releaseMarker.migrationTag === BOOTSTRAP_PROGRESS_TAG) {
        return { state: "empty", pending: manifest.migrations }
      }
      if (releaseMarker.migrationTag === LEGACY_BASELINE_PROGRESS_TAG) {
        const missing = missingSchemaObjects(manifest, tables, await listIndexes(executor))
        if (missing.tables.length > 0 || missing.indexes.length > 0) {
          throw new MigrationFailure({
            category: "database_incompatible",
            exitCode: ExitCode.DatabaseIncompatible,
            stage: "resume_legacy_baseline",
            message: "Interrupted legacy baseline no longer matches the immutable release schema.",
            fields: { missingTables: missing.tables.length, missingIndexes: missing.indexes.length },
          })
        }
        return { state: "legacy", pending: [] }
      }

      throw new MigrationFailure({
        category: "database_incompatible",
        exitCode: ExitCode.DatabaseIncompatible,
        stage: "inspect_schema_version",
        message: "Database contains an unknown immutable migration recovery marker.",
      })
    }
  }

  if (applicationTables.length === 0) {
    return { state: "empty", pending: manifest.migrations }
  }

  if (!tables.includes(MIGRATIONS_TABLE)) {
    const missing = missingSchemaObjects(manifest, tables, await listIndexes(executor))
    if (missing.tables.length > 0 || missing.indexes.length > 0) {
      throw new MigrationFailure({
        category: "database_incompatible",
        exitCode: ExitCode.DatabaseIncompatible,
        stage: "inspect_schema_version",
        message: "Existing database has no migration ledger and does not match the immutable release schema.",
        fields: { missingTables: missing.tables.length, missingIndexes: missing.indexes.length },
      })
    }
    return { state: "legacy", pending: [] }
  }

  const rows = await executor.query(
    `SELECT hash, created_at AS createdAt FROM \`${MIGRATIONS_TABLE}\` ORDER BY created_at ASC`,
  )
  const applied = rows.map(ledgerRow)
  if (applied.length > manifest.migrations.length) {
    throw new MigrationFailure({
      category: "database_incompatible",
      exitCode: ExitCode.DatabaseIncompatible,
      stage: "inspect_schema_version",
      message: "Database migration history is newer than this release.",
    })
  }

  for (let index = 0; index < applied.length; index += 1) {
    const actual = applied[index]
    const expected = manifest.migrations[index]
    if (!actual || !expected || actual.createdAt !== expected.createdAt || actual.hash !== expected.sha256) {
      throw new MigrationFailure({
        category: "database_incompatible",
        exitCode: ExitCode.DatabaseIncompatible,
        stage: "inspect_schema_version",
        message: "Database migration history does not match this release's immutable history.",
        fields: { ledgerPosition: index },
      })
    }
  }

  return { state: "managed", pending: manifest.migrations.slice(applied.length) }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function acquireMigrationLock(executor: Executor, config: RunnerConfig) {
  await executor.query(
    `CREATE TABLE IF NOT EXISTS \`${LOCK_TABLE}\` (
      name varchar(191) NOT NULL,
      owner varchar(64) NOT NULL,
      acquired_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      expires_at timestamp(3) NOT NULL,
      PRIMARY KEY (name),
      INDEX \`openwork_migration_lock_expires_at\` (expires_at)
    )`,
  )

  const owner = randomUUID()
  const startedAt = Date.now()
  const deadline = startedAt + config.lockTimeoutSeconds * 1_000
  const leaseExpression = `DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ${config.lockLeaseSeconds} SECOND)`

  do {
    await executor.query(
      `INSERT INTO \`${LOCK_TABLE}\` (name, owner, acquired_at, expires_at)
       VALUES (?, ?, CURRENT_TIMESTAMP(3), ${leaseExpression})
       ON DUPLICATE KEY UPDATE
         owner = IF(expires_at < CURRENT_TIMESTAMP(3), VALUES(owner), owner),
         acquired_at = IF(expires_at < CURRENT_TIMESTAMP(3), VALUES(acquired_at), acquired_at),
         expires_at = IF(expires_at < CURRENT_TIMESTAMP(3), VALUES(expires_at), expires_at)`,
      [LOCK_NAME, owner],
    )
    const rows = await executor.query(`SELECT owner FROM \`${LOCK_TABLE}\` WHERE name = ?`, [LOCK_NAME])
    if (rows[0]?.owner === owner) {
      log("info", "migration_lock_acquired", { waitMs: Date.now() - startedAt, leaseSeconds: config.lockLeaseSeconds })
      let renewing = false
      const timer = setInterval(() => {
        if (renewing) {
          return
        }
        renewing = true
        void executor.query(
          `UPDATE \`${LOCK_TABLE}\` SET expires_at = ${leaseExpression} WHERE name = ? AND owner = ?`,
          [LOCK_NAME, owner],
        ).catch((error) => {
          log("error", "migration_lock_renewal_failed", { message: errorMessage(error) })
        }).finally(() => {
          renewing = false
        })
      }, Math.max(10_000, Math.floor(config.lockLeaseSeconds * 1_000 / 3)))
      timer.unref()

      return async () => {
        clearInterval(timer)
        await executor.query(`DELETE FROM \`${LOCK_TABLE}\` WHERE name = ? AND owner = ?`, [LOCK_NAME, owner])
        log("info", "migration_lock_released")
      }
    }

    if (Date.now() >= deadline) {
      break
    }
    await sleep(1_000)
  } while (Date.now() <= deadline)

  throw new MigrationFailure({
    category: "migration_lock_unavailable",
    exitCode: ExitCode.MigrationLockUnavailable,
    stage: "acquire_migration_lock",
    message: "Migration lock is held by another runner.",
    fields: { timeoutSeconds: config.lockTimeoutSeconds },
  })
}

export function splitStatements(sql: string) {
  const source = sql.replaceAll(STATEMENT_BREAKPOINT, "")
  const statements: string[] = []
  let start = 0
  let quote: "'" | '"' | "`" | null = null
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]

    if (lineComment) {
      if (character === "\n") {
        lineComment = false
      }
      continue
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (quote) {
      if (character === "\\" && quote !== "`") {
        escaped = true
      } else if (character === quote) {
        if (next === quote && quote !== "`") {
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }

    if ((character === "-" && next === "-") || character === "#") {
      lineComment = true
      if (character === "-") {
        index += 1
      }
      continue
    }
    if (character === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character
      continue
    }
    if (character === ";") {
      const statement = source.slice(start, index + 1).trim()
      if (statement) {
        statements.push(statement)
      }
      start = index + 1
    }
  }

  const remainder = source.slice(start).trim()
  if (remainder) {
    statements.push(remainder)
  }
  return statements
}

async function ensureProgressTable(executor: Executor) {
  await executor.query(
    `CREATE TABLE IF NOT EXISTS \`${PROGRESS_TABLE}\` (
      migration_tag varchar(191) NOT NULL,
      statement_index int NOT NULL,
      statement_hash char(64) NOT NULL,
      completed_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (migration_tag, statement_index)
    )`,
  )
}

async function markReleaseOperationStarted(executor: Executor, tag: string, bootstrapHash: string) {
  await ensureProgressTable(executor)
  await executor.query(
    `INSERT INTO \`${PROGRESS_TABLE}\` (migration_tag, statement_index, statement_hash)
     VALUES (?, -1, ?)
     ON DUPLICATE KEY UPDATE statement_hash = statement_hash`,
    [tag, bootstrapHash],
  )
}

function executableStatement(statement: string) {
  let executable = statement.trimStart()
  while (true) {
    const withoutLineComment = executable.replace(/^(?:--|#)[^\n]*(?:\n|$)\s*/, "")
    const withoutBlockComment = withoutLineComment.replace(/^\/\*[\s\S]*?\*\/\s*/, "")
    if (withoutBlockComment === executable) {
      return executable
    }
    executable = withoutBlockComment
  }
}

function isConnectionLocalStatement(statement: string) {
  return /^(?:SET\s+@|PREPARE\s+|EXECUTE\s+|DEALLOCATE\s+PREPARE\s+)/i.test(executableStatement(statement))
}

async function columnExists(executor: Executor, table: string, column: string) {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  )
  return rows.length > 0
}

async function statementPostconditionHolds(executor: Executor, statement: string) {
  const executable = executableStatement(statement)
  const createTable = executable.match(/^CREATE TABLE(?: IF NOT EXISTS)? `([^`]+)`/i)
  if (createTable?.[1]) {
    return (await listTables(executor)).includes(createTable[1])
  }

  const createIndex = executable.match(/^CREATE (?:UNIQUE |FULLTEXT )?INDEX `([^`]+)` ON `([^`]+)`/i)
  if (createIndex?.[1] && createIndex[2]) {
    return indexExists(executor, { name: createIndex[1], table: createIndex[2] })
  }

  const addColumn = executable.match(/^ALTER TABLE `([^`]+)`[\s\S]*?ADD (?:COLUMN )?`([^`]+)`/i)
  if (addColumn?.[1] && addColumn[2]) {
    return columnExists(executor, addColumn[1], addColumn[2])
  }

  const addUniqueConstraint = executable.match(
    /^ALTER TABLE `([^`]+)`[\s\S]*?ADD CONSTRAINT `([^`]+)` UNIQUE/i,
  )
  if (addUniqueConstraint?.[1] && addUniqueConstraint[2]) {
    return indexExists(executor, { table: addUniqueConstraint[1], name: addUniqueConstraint[2] })
  }

  const dropColumn = executable.match(/^ALTER TABLE `([^`]+)`[\s\S]*?DROP COLUMN `([^`]+)`/i)
  if (dropColumn?.[1] && dropColumn[2]) {
    return !(await columnExists(executor, dropColumn[1], dropColumn[2]))
  }

  const dropIndex =
    executable.match(/^DROP INDEX `([^`]+)` ON `([^`]+)`/i) ??
    executable.match(/^ALTER TABLE `([^`]+)`[\s\n]+DROP INDEX `([^`]+)`/i)
  if (dropIndex?.[1] && dropIndex[2]) {
    const alterTableForm = /^ALTER TABLE/i.test(executable)
    const table = alterTableForm ? dropIndex[1] : dropIndex[2]
    const name = alterTableForm ? dropIndex[2] : dropIndex[1]
    return !(await indexExists(executor, { name, table }))
  }

  return false
}

async function executeStatements(
  executor: Executor,
  sql: string,
  tag: string,
) {
  const statements = splitStatements(sql)
  await ensureProgressTable(executor)
  const progressRows = await executor.query(
    `SELECT statement_index AS statementIndex, statement_hash AS statementHash
     FROM \`${PROGRESS_TABLE}\` WHERE migration_tag = ? AND statement_index >= 0`,
    [tag],
  )
  const completed = new Map<number, string>()
  for (const row of progressRows) {
    const statementIndex = Number(row.statementIndex)
    if (Number.isInteger(statementIndex) && typeof row.statementHash === "string") {
      completed.set(statementIndex, row.statementHash)
    }
  }

  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]
    if (!statement) {
      continue
    }
    const statementHash = sha256(statement)
    const checkpointed = !isConnectionLocalStatement(statement)
    const completedHash = checkpointed ? completed.get(index) : undefined
    if (completedHash) {
      if (completedHash !== statementHash) {
        throw new MigrationFailure({
          category: "database_incompatible",
          exitCode: ExitCode.DatabaseIncompatible,
          stage: "resume_migration",
          message: `Recorded statement progress does not match migration '${tag}'.`,
          fields: { migration: tag, statement: index + 1 },
        })
      }
      continue
    }

    try {
      await executor.query(statement)
    } catch (error) {
      if (!(await statementPostconditionHolds(executor, statement))) {
        throw new MigrationFailure({
          category: "migration_statement_failed",
          exitCode: ExitCode.MigrationStatementFailed,
          stage: "apply_migrations",
          message: `Migration '${tag}' failed at statement ${index + 1}.`,
          fields: { migration: tag, statement: index + 1, code: errorCode(error) ?? "unknown" },
          cause: error,
        })
      }
      log("info", "migration_statement_recovered", { migration: tag, statement: index + 1 })
    }

    if (checkpointed) {
      await executor.query(
        `INSERT INTO \`${PROGRESS_TABLE}\` (migration_tag, statement_index, statement_hash)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE statement_hash = VALUES(statement_hash), completed_at = CURRENT_TIMESTAMP(3)`,
        [tag, index, statementHash],
      )
    }
  }
  return statements.length
}

async function ensureLedger(executor: Executor) {
  await executor.query(
    `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (id serial primary key, hash text not null, created_at bigint)`,
  )
}

async function recordMigration(executor: Executor, migration: ManifestMigration) {
  await executor.query(
    `INSERT INTO \`${MIGRATIONS_TABLE}\` (hash, created_at) VALUES (?, ?)`,
    [migration.sha256, migration.createdAt],
  )
}

async function baselineMigrations(executor: Executor, migrations: ManifestMigration[]) {
  await ensureLedger(executor)
  const rows = await executor.query(
    `SELECT hash, created_at AS createdAt FROM \`${MIGRATIONS_TABLE}\` ORDER BY created_at ASC`,
  )
  const existing = rows.map(ledgerRow)
  for (let index = 0; index < existing.length; index += 1) {
    const actual = existing[index]
    const expected = migrations[index]
    if (!actual || !expected || actual.createdAt !== expected.createdAt || actual.hash !== expected.sha256) {
      throw new MigrationFailure({
        category: "database_incompatible",
        exitCode: ExitCode.DatabaseIncompatible,
        stage: "resume_bootstrap",
        message: "Partially recorded bootstrap ledger does not match this release.",
        fields: { ledgerPosition: index },
      })
    }
  }
  for (const migration of migrations.slice(existing.length)) {
    await recordMigration(executor, migration)
  }
}

async function applyMigrations(executor: Executor, artifact: LoadedArtifact, pending: ManifestMigration[]) {
  await ensureLedger(executor)
  let applied = 0
  for (const migration of pending) {
    log("info", "migration_started", { migration: migration.tag })
    const sql = artifact.migrationSql.get(migration.tag)
    if (!sql) {
      throw artifactFailure(`Migration SQL was not loaded: ${migration.tag}`)
    }
    const statementCount = await executeStatements(executor, sql, migration.tag)
    await recordMigration(executor, migration)
    await executor.query(`DELETE FROM \`${PROGRESS_TABLE}\` WHERE migration_tag = ?`, [migration.tag])
    applied += 1
    log("info", "migration_applied", { migration: migration.tag, statementCount })
  }
  return applied
}

async function indexExists(executor: Executor, index: ManifestIndex) {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [index.table, index.name],
  )
  return rows.length > 0
}

async function ensureRequiredIndexes(executor: Executor, indexes: RequiredIndex[]) {
  let created = 0
  for (const index of indexes) {
    if (await indexExists(executor, index)) {
      continue
    }
    const columns = index.columns.map((column) => `\`${column.replaceAll("`", "``")}\``).join(", ")
    const kind = index.kind.toUpperCase()
    if (kind !== "FULLTEXT") {
      throw artifactFailure(`Unsupported required index kind: ${index.kind}`)
    }
    try {
      await executor.query(
        `CREATE ${kind} INDEX \`${index.name.replaceAll("`", "``")}\` ON \`${index.table.replaceAll("`", "``")}\` (${columns})`,
      )
      created += 1
      log("info", "required_index_created", { table: index.table, index: index.name, kind })
    } catch (error) {
      if (!(await indexExists(executor, index))) {
        throw new MigrationFailure({
          category: "verification_failed",
          exitCode: ExitCode.VerificationFailed,
          stage: "ensure_required_indexes",
          message: `Required index '${index.table}.${index.name}' could not be created.`,
          fields: { table: index.table, index: index.name, code: errorCode(error) ?? "unknown" },
          cause: error,
        })
      }
    }
  }
  return created
}

async function verifyReleaseSchema(executor: Executor, manifest: MigrationManifest) {
  const tables = await listTables(executor)
  const indexes = await listIndexes(executor)
  const missing = missingSchemaObjects(manifest, tables, indexes)
  const missingRequired = []
  for (const index of manifest.requiredIndexes) {
    if (!(await indexExists(executor, index))) {
      missingRequired.push(`${index.table}.${index.name}`)
    }
  }

  const rows = await executor.query(
    `SELECT hash, created_at AS createdAt FROM \`${MIGRATIONS_TABLE}\` ORDER BY created_at ASC`,
  )
  const ledger = rows.map(ledgerRow)
  const ledgerComplete = ledger.length === manifest.migrations.length && ledger.every((entry, index) => {
    const expected = manifest.migrations[index]
    return Boolean(expected && entry.createdAt === expected.createdAt && entry.hash === expected.sha256)
  })

  if (missing.tables.length > 0 || missing.indexes.length > 0 || missingRequired.length > 0 || !ledgerComplete) {
    throw new MigrationFailure({
      category: "verification_failed",
      exitCode: ExitCode.VerificationFailed,
      stage: "verify_release_schema",
      message: "Database verification did not match the immutable release schema.",
      fields: {
        missingTables: missing.tables.length,
        missingIndexes: missing.indexes.length + missingRequired.length,
        ledgerEntries: ledger.length,
        expectedLedgerEntries: manifest.migrations.length,
      },
    })
  }

  log("info", "schema_verified", {
    schemaVersion: manifest.schemaVersion,
    tables: manifest.bootstrap.tables.length,
    indexes: manifest.bootstrap.indexes.length + manifest.requiredIndexes.length,
  })
}

let activeCleanup: (() => Promise<void>) | null = null
let terminating = false

function installSignalHandlers() {
  const handle = (signal: "SIGINT" | "SIGTERM") => {
    if (terminating) {
      return
    }
    terminating = true
    const exitCode = signal === "SIGTERM" ? ExitCode.ProcessTerminated : ExitCode.ProcessInterrupted
    const category = signal === "SIGTERM" ? "process_terminated" : "process_interrupted"
    log("error", "migration_result", { status: "failed", category, exitCode, signal })

    const forceExit = setTimeout(() => process.exit(exitCode), 5_000)
    forceExit.unref()
    void Promise.resolve(activeCleanup?.()).finally(() => process.exit(exitCode))
  }

  process.once("SIGINT", () => handle("SIGINT"))
  process.once("SIGTERM", () => handle("SIGTERM"))
}

async function runMigration(): Promise<RunSummary> {
  const startedAt = Date.now()
  const artifact = await loadArtifact()
  const config = parseConfig()
  log("info", "migration_runner_started", {
    mode: config.mode,
    schemaVersion: artifact.manifest.schemaVersion,
    migrationCount: artifact.manifest.migrations.length,
  })

  const executor = await createExecutor(config)
  let releaseLock: (() => Promise<void>) | null = null
  activeCleanup = async () => {
    try {
      await releaseLock?.()
    } finally {
      await executor.close()
    }
  }

  try {
    const databaseVersion = await validateDatabaseCompatibility(executor, config.databaseMode)

    if (config.mode === "check") {
      const plan = await inspectMigrationPlan(executor, artifact.manifest)
      log("info", "migration_plan", {
        mode: config.mode,
        databaseState: plan.state,
        pending: plan.pending.length,
        schemaVersion: artifact.manifest.schemaVersion,
      })
      return {
        mode: config.mode,
        schemaVersion: artifact.manifest.schemaVersion,
        databaseVersion,
        databaseState: plan.state,
        pending: plan.pending.length,
        applied: 0,
        baselined: 0,
        indexesCreated: 0,
        durationMs: Date.now() - startedAt,
      }
    }

    releaseLock = await acquireMigrationLock(executor, config)
    const plan = await inspectMigrationPlan(executor, artifact.manifest)
    log("info", "migration_plan", {
      mode: config.mode,
      databaseState: plan.state,
      pending: plan.pending.length,
      schemaVersion: artifact.manifest.schemaVersion,
    })

    let applied = 0
    let baselined = 0
    if (plan.state === "empty") {
      log("info", "bootstrap_started", { schemaVersion: artifact.manifest.schemaVersion })
      await markReleaseOperationStarted(executor, BOOTSTRAP_PROGRESS_TAG, artifact.manifest.bootstrap.sha256)
      const statementCount = await executeStatements(executor, artifact.bootstrapSql, BOOTSTRAP_PROGRESS_TAG)
      await baselineMigrations(executor, artifact.manifest.migrations)
      baselined = artifact.manifest.migrations.length
      await executor.query(`DELETE FROM \`${PROGRESS_TABLE}\` WHERE migration_tag = ?`, [BOOTSTRAP_PROGRESS_TAG])
      log("info", "bootstrap_applied", { statementCount, baselined })
    } else if (plan.state === "legacy") {
      await markReleaseOperationStarted(executor, LEGACY_BASELINE_PROGRESS_TAG, artifact.manifest.bootstrap.sha256)
      await baselineMigrations(executor, artifact.manifest.migrations)
      baselined = artifact.manifest.migrations.length
      await executor.query(`DELETE FROM \`${PROGRESS_TABLE}\` WHERE migration_tag = ?`, [LEGACY_BASELINE_PROGRESS_TAG])
      log("info", "legacy_schema_baselined", { baselined })
    } else {
      applied = await applyMigrations(executor, artifact, plan.pending)
    }

    const indexesCreated = await ensureRequiredIndexes(executor, artifact.manifest.requiredIndexes)
    await verifyReleaseSchema(executor, artifact.manifest)
    if ((await listTables(executor)).includes(PROGRESS_TABLE)) {
      await executor.query(`DELETE FROM \`${PROGRESS_TABLE}\``)
    }

    return {
      mode: config.mode,
      schemaVersion: artifact.manifest.schemaVersion,
      databaseVersion,
      databaseState: plan.state,
      pending: plan.pending.length,
      applied,
      baselined,
      indexesCreated,
      durationMs: Date.now() - startedAt,
    }
  } finally {
    try {
      await releaseLock?.()
    } finally {
      releaseLock = null
      await executor.close()
      activeCleanup = null
    }
  }
}

export function main() {
  installSignalHandlers()
  void runMigration()
    .then((summary) => {
      log("info", "migration_result", { status: "success", exitCode: ExitCode.Success, ...summary })
    })
    .catch((error) => {
      const failure =
        error instanceof MigrationFailure
          ? error
          : new MigrationFailure({
              category: "migration_statement_failed",
              exitCode: ExitCode.MigrationStatementFailed,
              stage: "run_migration",
              message: errorMessage(error),
              cause: error,
            })
      log("error", "migration_result", {
        status: "failed",
        category: failure.category,
        exitCode: failure.exitCode,
        stage: failure.stage,
        message: failure.message,
        ...failure.fields,
      })
      process.exitCode = failure.exitCode
    })
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (entryPath === fileURLToPath(import.meta.url)) {
  main()
}
