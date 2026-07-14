import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Executor } from "./db-executor.ts"
import { LEGACY_BASELINE_THROUGH_TAG } from "./migration-policy.ts"

const MIGRATIONS_TABLE = "__drizzle_migrations"
const BASE_TABLE = "external_mcp_connection"
const TRANSACTION_TABLE = "external_mcp_oauth_transaction"
const MIGRATION_TAG = "0040_square_jackpot"
const LEGACY_MARKETPLACE_MIGRATION_CURSORS = new Set([1783990757465, 1784037192791])
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

type ColumnExpectation = {
  dataType: string
  nullable: boolean
  length?: number
  precision?: number
  defaultValues?: string[]
}

type VisibilityRetry = {
  attempts: number
  delayMs: number
}

type MigrationMetadata = {
  hash: string
  previousWhen: number
  when: number
}

export type Migration0040RepairResult = {
  operations: string[]
  status: "already_recorded" | "not_applicable" | "recorded" | "repaired_recorded"
}

const DEFAULT_VISIBILITY_RETRY: VisibilityRetry = {
  attempts: 20,
  delayMs: 250,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" ? value.trim().toLowerCase() : null
}

function normalizedNumber(value: unknown): number | null {
  if (typeof value === "number") return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
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

function normalizedDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return stripOuterParentheses(String(value))
    .toLowerCase()
    .replaceAll(/\s+/g, " ")
}

function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function migrationMetadata(drizzleDir = path.join(packageDir, "drizzle")): MigrationMetadata {
  const journalValue: unknown = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"))
  if (!isRecord(journalValue) || !Array.isArray(journalValue.entries)) {
    throw new Error("drizzle/meta/_journal.json is missing migration entries")
  }
  const entry = journalValue.entries.find((candidate) => (
    isRecord(candidate)
    && candidate.tag === MIGRATION_TAG
    && typeof candidate.when === "number"
  ))
  if (!isRecord(entry) || typeof entry.when !== "number") {
    throw new Error(`Migration ${MIGRATION_TAG} is missing from drizzle/meta/_journal.json`)
  }
  const previousEntry = journalValue.entries.find((candidate) => (
    isRecord(candidate)
    && candidate.tag === LEGACY_BASELINE_THROUGH_TAG
    && typeof candidate.when === "number"
  ))
  if (!isRecord(previousEntry) || typeof previousEntry.when !== "number") {
    throw new Error(`Migration ${LEGACY_BASELINE_THROUGH_TAG} is missing from drizzle/meta/_journal.json`)
  }
  const sqlContents = readFileSync(path.join(drizzleDir, `${MIGRATION_TAG}.sql`), "utf8")
  return {
    hash: crypto.createHash("sha256").update(sqlContents).digest("hex"),
    previousWhen: previousEntry.when,
    when: entry.when,
  }
}

async function tableExists(executor: Executor, tableName: string): Promise<boolean> {
  const rows = await executor.query(
    `SELECT 1 AS present FROM information_schema.TABLES
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [tableName],
  )
  return rows.length > 0
}

async function columnInfo(executor: Executor, tableName: string, columnName: string) {
  const rows = await executor.query(
    `SELECT data_type AS dataType, is_nullable AS isNullable,
            column_default AS columnDefault,
            character_maximum_length AS characterMaximumLength,
            datetime_precision AS datetimePrecision
     FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [tableName, columnName],
  )
  return rows[0] ?? null
}

function assertColumnShape(
  tableName: string,
  columnName: string,
  row: Record<string, unknown> | null,
  expected: ColumnExpectation,
): void {
  if (!row) throw new Error(`Migration ${MIGRATION_TAG} requires ${tableName}.${columnName}`)
  const failures: string[] = []
  if (normalizedString(row.dataType) !== expected.dataType) failures.push(`type ${expected.dataType}`)
  if ((normalizedString(row.isNullable) === "yes") !== expected.nullable) {
    failures.push(expected.nullable ? "nullable" : "NOT NULL")
  }
  if (expected.length !== undefined && normalizedNumber(row.characterMaximumLength) !== expected.length) {
    failures.push(`length ${expected.length}`)
  }
  if (expected.precision !== undefined && normalizedNumber(row.datetimePrecision) !== expected.precision) {
    failures.push(`precision ${expected.precision}`)
  }
  if (expected.defaultValues !== undefined) {
    const actualDefault = normalizedDefault(row.columnDefault)
    const acceptedDefaults = expected.defaultValues.map(normalizedDefault)
    if (!acceptedDefaults.includes(actualDefault)) {
      failures.push(`default ${expected.defaultValues.join(" or ")}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Migration ${MIGRATION_TAG} found incompatible ${tableName}.${columnName}; expected ${failures.join(", ")}.`,
    )
  }
}

async function waitForColumnShape(input: {
  executor: Executor
  tableName: string
  columnName: string
  expected: ColumnExpectation
  retry: VisibilityRetry
}): Promise<void> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= input.retry.attempts; attempt += 1) {
    const row = await columnInfo(input.executor, input.tableName, input.columnName)
    try {
      assertColumnShape(input.tableName, input.columnName, row, input.expected)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < input.retry.attempts) await sleep(input.retry.delayMs)
  }
  throw lastError ?? new Error(`Migration ${MIGRATION_TAG} could not observe ${input.tableName}.${input.columnName}.`)
}

async function waitForTable(executor: Executor, tableName: string, retry: VisibilityRetry): Promise<boolean> {
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    if (await tableExists(executor, tableName)) return true
    if (attempt < retry.attempts) await sleep(retry.delayMs)
  }
  return false
}

async function ensureColumn(input: {
  executor: Executor
  tableName: string
  columnName: string
  addSql: string
  expected: ColumnExpectation
  operations: string[]
  retry: VisibilityRetry
}): Promise<void> {
  const row = await columnInfo(input.executor, input.tableName, input.columnName)
  if (!row) {
    try {
      await input.executor.query(input.addSql)
      input.operations.push(`add ${input.tableName}.${input.columnName}`)
    } catch (error) {
      // Concurrent DDL and ambiguous network responses are safe when the exact
      // reviewed object becomes visible. Re-read before surfacing the error.
      try {
        await waitForColumnShape(input)
        return
      } catch {
        throw error
      }
    }
    await waitForColumnShape(input)
    return
  }
  assertColumnShape(input.tableName, input.columnName, row, input.expected)
}

type IndexShape = {
  columns: string[]
  unique: boolean
}

async function indexShape(executor: Executor, tableName: string, indexName: string): Promise<IndexShape | null> {
  const rows = await executor.query(
    `SELECT column_name AS columnName, non_unique AS nonUnique FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
     ORDER BY seq_in_index`,
    [tableName, indexName],
  )
  if (rows.length === 0) return null
  const columns = rows.flatMap((row) => typeof row.columnName === "string" ? [row.columnName] : [])
  const nonUnique = normalizedNumber(rows[0]?.nonUnique)
  if (columns.length !== rows.length || nonUnique === null) {
    throw new Error(`Migration ${MIGRATION_TAG} could not read index ${tableName}.${indexName}.`)
  }
  return { columns, unique: nonUnique === 0 }
}

function assertIndexShape(
  tableName: string,
  indexName: string,
  expected: IndexShape,
  actual: IndexShape | null,
): void {
  if (!actual) {
    throw new Error(`Migration ${MIGRATION_TAG} requires index ${tableName}.${indexName}.`)
  }
  const failures: string[] = []
  if (actual.columns.join("\0") !== expected.columns.join("\0")) {
    failures.push(`columns (${expected.columns.join(", ")})`)
  }
  if (actual.unique !== expected.unique) {
    failures.push(expected.unique ? "UNIQUE" : "non-unique")
  }
  if (failures.length > 0) {
    throw new Error(
      `Migration ${MIGRATION_TAG} found incompatible index ${tableName}.${indexName}; `
      + `expected ${failures.join(" and ")}.`,
    )
  }
}

async function waitForIndex(input: {
  executor: Executor
  tableName: string
  indexName: string
  columns: string[]
  unique: boolean
  retry: VisibilityRetry
}): Promise<void> {
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= input.retry.attempts; attempt += 1) {
    const shape = await indexShape(input.executor, input.tableName, input.indexName)
    try {
      assertIndexShape(input.tableName, input.indexName, input, shape)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < input.retry.attempts) await sleep(input.retry.delayMs)
  }
  throw lastError ?? new Error(`Migration ${MIGRATION_TAG} could not observe index ${input.tableName}.${input.indexName}.`)
}

async function ensureIndex(input: {
  executor: Executor
  tableName: string
  indexName: string
  columns: string[]
  unique: boolean
  createSql?: string
  operations: string[]
  retry: VisibilityRetry
}): Promise<void> {
  const shape = await indexShape(input.executor, input.tableName, input.indexName)
  if (!shape) {
    if (!input.createSql) {
      throw new Error(
        `Migration ${MIGRATION_TAG} requires index ${input.tableName}.${input.indexName} `
        + `on (${input.columns.join(", ")}).`,
      )
    }
    try {
      await input.executor.query(input.createSql)
      input.operations.push(`create ${input.tableName}.${input.indexName}`)
    } catch (error) {
      try {
        await waitForIndex(input)
        return
      } catch {
        throw error
      }
    }
    await waitForIndex(input)
    return
  }
  assertIndexShape(input.tableName, input.indexName, input, shape)
}

async function latestRecordedMigration(executor: Executor): Promise<number> {
  const rows = await executor.query(`SELECT max(created_at) AS latest FROM \`${MIGRATIONS_TABLE}\``)
  return normalizedNumber(rows[0]?.latest) ?? 0
}

async function ensureTransactionTable(
  executor: Executor,
  operations: string[],
  retry: VisibilityRetry,
): Promise<void> {
  const existed = await tableExists(executor, TRANSACTION_TABLE)
  if (!existed) {
    try {
      await executor.query(`CREATE TABLE \`${TRANSACTION_TABLE}\` (
      \`state_key\` varchar(64) NOT NULL,
      \`organization_id\` varchar(64) NOT NULL,
      \`external_mcp_connection_id\` varchar(64) NOT NULL,
      \`org_membership_id\` varchar(64) NOT NULL,
      \`connection_authorization_epoch\` int NOT NULL DEFAULT 0,
      \`client_registration_revision\` varchar(64),
      \`code_verifier\` text NOT NULL,
      \`expires_at\` timestamp(3) NOT NULL,
      \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
      CONSTRAINT \`external_mcp_oauth_transaction_state_key\` PRIMARY KEY(\`state_key\`)
    )`)
      operations.push(`create ${TRANSACTION_TABLE}`)
    } catch (error) {
      if (!(await waitForTable(executor, TRANSACTION_TABLE, retry))) throw error
    }
    if (!(await waitForTable(executor, TRANSACTION_TABLE, retry))) {
      throw new Error(`Migration ${MIGRATION_TAG} could not observe table ${TRANSACTION_TABLE} after creating it.`)
    }
  }

  const expectedColumns: Array<[string, ColumnExpectation]> = [
    ["state_key", { dataType: "varchar", nullable: false, length: 64 }],
    ["organization_id", { dataType: "varchar", nullable: false, length: 64 }],
    ["external_mcp_connection_id", { dataType: "varchar", nullable: false, length: 64 }],
    ["org_membership_id", { dataType: "varchar", nullable: false, length: 64 }],
    ["connection_authorization_epoch", { dataType: "int", nullable: false, defaultValues: ["0"] }],
    ["code_verifier", { dataType: "text", nullable: false }],
    ["expires_at", { dataType: "timestamp", nullable: false, precision: 3 }],
    ["created_at", {
      dataType: "timestamp",
      nullable: false,
      precision: 3,
      defaultValues: ["now()", "now(3)", "current_timestamp", "current_timestamp(3)"],
    }],
  ]
  for (const [columnName, expected] of expectedColumns) {
    if (existed) {
      assertColumnShape(TRANSACTION_TABLE, columnName, await columnInfo(executor, TRANSACTION_TABLE, columnName), expected)
    } else {
      await waitForColumnShape({ executor, tableName: TRANSACTION_TABLE, columnName, expected, retry })
    }
  }
  await ensureColumn({
    executor,
    tableName: TRANSACTION_TABLE,
    columnName: "client_registration_revision",
    addSql: `ALTER TABLE \`${TRANSACTION_TABLE}\` ADD \`client_registration_revision\` varchar(64)`,
    expected: { dataType: "varchar", nullable: true, length: 64 },
    operations,
    retry,
  })
  await ensureIndex({
    executor,
    tableName: TRANSACTION_TABLE,
    indexName: "PRIMARY",
    columns: ["state_key"],
    unique: true,
    operations,
    retry,
  })
}

async function ensureUpstreamConflictMigrations(
  executor: Executor,
  operations: string[],
  retry: VisibilityRetry,
): Promise<void> {
  await ensureIndex({
    executor,
    tableName: "user",
    indexName: "user_created_at_id",
    columns: ["created_at", "id"],
    unique: false,
    createSql: "CREATE INDEX `user_created_at_id` ON `user` (`created_at`,`id`)",
    operations,
    retry,
  })
  await ensureIndex({
    executor,
    tableName: "invitation",
    indexName: "invitation_inviter_id",
    columns: ["inviter_id"],
    unique: false,
    createSql: "CREATE INDEX `invitation_inviter_id` ON `invitation` (`inviter_id`)",
    operations,
    retry,
  })
  await ensureIndex({
    executor,
    tableName: "organization",
    indexName: "organization_created_at_id",
    columns: ["created_at", "id"],
    unique: false,
    createSql: "CREATE INDEX `organization_created_at_id` ON `organization` (`created_at`,`id`)",
    operations,
    retry,
  })
  await ensureIndex({
    executor,
    tableName: "telemetry_event",
    indexName: "telemetry_event_member_ts",
    columns: ["member_id", "event_timestamp"],
    unique: false,
    createSql: "CREATE INDEX `telemetry_event_member_ts` ON `telemetry_event` (`member_id`,`event_timestamp`)",
    operations,
    retry,
  })

  const tableName = "desktop_connect_grant"
  if (!(await tableExists(executor, tableName))) {
    await executor.query(`CREATE TABLE \`${tableName}\` (
      \`code_hash\` varchar(64) NOT NULL,
      \`install_link_id\` varchar(64) NOT NULL,
      \`claims\` json NOT NULL,
      \`expires_at\` timestamp(3) NOT NULL,
      \`consumed_at\` timestamp(3),
      \`consumed_nonce\` varchar(64),
      \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
      CONSTRAINT \`desktop_connect_grant_code_hash\` PRIMARY KEY(\`code_hash\`)
    )`)
    operations.push(`create ${tableName}`)
  }
  const expectedColumns: Array<[string, ColumnExpectation]> = [
    ["code_hash", { dataType: "varchar", nullable: false, length: 64 }],
    ["install_link_id", { dataType: "varchar", nullable: false, length: 64 }],
    ["claims", { dataType: "json", nullable: false }],
    ["expires_at", { dataType: "timestamp", nullable: false, precision: 3 }],
    ["consumed_at", { dataType: "timestamp", nullable: true, precision: 3 }],
    ["consumed_nonce", { dataType: "varchar", nullable: true, length: 64 }],
    ["created_at", {
      dataType: "timestamp",
      nullable: false,
      precision: 3,
      defaultValues: ["now()", "now(3)", "current_timestamp", "current_timestamp(3)"],
    }],
  ]
  for (const [columnName, expected] of expectedColumns) {
    await waitForColumnShape({ executor, tableName, columnName, expected, retry })
  }
  await ensureIndex({
    executor,
    tableName,
    indexName: "PRIMARY",
    columns: ["code_hash"],
    unique: true,
    operations,
    retry,
  })
  await ensureIndex({
    executor,
    tableName,
    indexName: "desktop_connect_grant_install_link_id",
    columns: ["install_link_id"],
    unique: false,
    createSql: "CREATE INDEX `desktop_connect_grant_install_link_id` ON `desktop_connect_grant` (`install_link_id`)",
    operations,
    retry,
  })
  await ensureIndex({
    executor,
    tableName,
    indexName: "desktop_connect_grant_expires_at",
    columns: ["expires_at"],
    unique: false,
    createSql: "CREATE INDEX `desktop_connect_grant_expires_at` ON `desktop_connect_grant` (`expires_at`)",
    operations,
    retry,
  })
}

/**
 * MySQL commits DDL statement-by-statement. This repair is deliberately not a
 * transaction: every step inspects the live schema, applies only what is
 * missing, verifies existing objects, and records 0040 only after all objects
 * match. A retry after any interrupted statement therefore resumes safely.
 */
export async function repairMigration0040(
  executor: Executor,
  options: {
    drizzleDir?: string
    visibilityAttempts?: number
    visibilityDelayMs?: number
  } = {},
): Promise<Migration0040RepairResult> {
  const metadata = migrationMetadata(options.drizzleDir)
  const retry = {
    attempts: options.visibilityAttempts ?? DEFAULT_VISIBILITY_RETRY.attempts,
    delayMs: options.visibilityDelayMs ?? DEFAULT_VISIBILITY_RETRY.delayMs,
  }
  if (!Number.isSafeInteger(retry.attempts) || retry.attempts <= 0) {
    throw new Error("Migration 0040 visibility attempts must be a positive integer.")
  }
  if (!Number.isFinite(retry.delayMs) || retry.delayMs < 0) {
    throw new Error("Migration 0040 visibility delay must be a non-negative number.")
  }
  const ledgerExists = await tableExists(executor, MIGRATIONS_TABLE)
  const baseTableExists = await tableExists(executor, BASE_TABLE)

  if (!ledgerExists) {
    if (baseTableExists) {
      throw new Error(
        `Existing schema has no ${MIGRATIONS_TABLE} ledger. Run db:bootstrap so it is baselined safely through 0039 first.`,
      )
    }
    return { operations: [], status: "not_applicable" }
  }
  const latest = await latestRecordedMigration(executor)
  const operations: string[] = []
  if (latest === 0) {
    throw new Error(
      `Existing schema has an empty ${MIGRATIONS_TABLE} ledger. Run db:bootstrap so it is baselined safely through 0039 first.`,
    )
  }
  if (latest < metadata.previousWhen && !LEGACY_MARKETPLACE_MIGRATION_CURSORS.has(latest)) {
    // Let Drizzle apply every still-pending migration in order. Recording 0040
    // here would make its max timestamp skip intervening migrations.
    return { operations: [], status: "not_applicable" }
  }
  if (latest > metadata.previousWhen && latest < metadata.when) {
    throw new Error(
      `Migration ledger timestamp ${latest} is between ${LEGACY_BASELINE_THROUGH_TAG} and ${MIGRATION_TAG}; refusing to skip unknown history.`,
    )
  }
  // A later reviewed migration may intentionally supersede or remove an 0040
  // object. This transition repair must never make the 0040 shape immortal.
  if (latest > metadata.when) {
    return { operations: [], status: "not_applicable" }
  }
  if (!baseTableExists) {
    throw new Error(
      `Migration ledger is at or beyond ${LEGACY_BASELINE_THROUGH_TAG}, but required table ${BASE_TABLE} is missing.`,
    )
  }

  if (LEGACY_MARKETPLACE_MIGRATION_CURSORS.has(latest)) {
    await ensureUpstreamConflictMigrations(executor, operations, retry)
  }
  await ensureTransactionTable(executor, operations, retry)

  const scope = await columnInfo(executor, BASE_TABLE, "scope")
  if (!scope) throw new Error(`Migration ${MIGRATION_TAG} requires ${BASE_TABLE}.scope`)
  const scopeType = normalizedString(scope.dataType)
  if (scopeType === "varchar") {
    assertColumnShape(BASE_TABLE, "scope", scope, {
      dataType: "varchar",
      nullable: true,
      length: 1024,
    })
    try {
      await executor.query(`ALTER TABLE \`${BASE_TABLE}\` MODIFY COLUMN \`scope\` text`)
      operations.push(`modify ${BASE_TABLE}.scope`)
    } catch (error) {
      try {
        await waitForColumnShape({
          executor,
          tableName: BASE_TABLE,
          columnName: "scope",
          expected: { dataType: "text", nullable: true },
          retry,
        })
      } catch {
        throw error
      }
    }
    await waitForColumnShape({
      executor,
      tableName: BASE_TABLE,
      columnName: "scope",
      expected: { dataType: "text", nullable: true },
      retry,
    })
  } else if (scopeType !== "text") {
    throw new Error(
      `Migration ${MIGRATION_TAG} found incompatible ${BASE_TABLE}.scope type ${scopeType ?? "unknown"}; `
      + "expected legacy varchar(1024) or text.",
    )
  }
  assertColumnShape(BASE_TABLE, "scope", await columnInfo(executor, BASE_TABLE, "scope"), {
    dataType: "text",
    nullable: true,
  })

  await ensureColumn({
    executor,
    tableName: BASE_TABLE,
    columnName: "requested_oauth_scopes",
    addSql: `ALTER TABLE \`${BASE_TABLE}\` ADD \`requested_oauth_scopes\` json`,
    expected: { dataType: "json", nullable: true },
    operations,
    retry,
  })
  await ensureColumn({
    executor,
    tableName: BASE_TABLE,
    columnName: "oauth_registration_lease_token",
    addSql: `ALTER TABLE \`${BASE_TABLE}\` ADD \`oauth_registration_lease_token\` varchar(64)`,
    expected: { dataType: "varchar", nullable: true, length: 64 },
    operations,
    retry,
  })
  await ensureColumn({
    executor,
    tableName: BASE_TABLE,
    columnName: "oauth_registration_lease_started_at",
    addSql: `ALTER TABLE \`${BASE_TABLE}\` ADD \`oauth_registration_lease_started_at\` timestamp(3)`,
    expected: { dataType: "timestamp", nullable: true, precision: 3 },
    operations,
    retry,
  })
  await ensureColumn({
    executor,
    tableName: BASE_TABLE,
    columnName: "oauth_authorization_epoch",
    addSql: `ALTER TABLE \`${BASE_TABLE}\` ADD \`oauth_authorization_epoch\` int DEFAULT 0 NOT NULL`,
    expected: { dataType: "int", nullable: false, defaultValues: ["0"] },
    operations,
    retry,
  })

  await ensureIndex({
    executor,
    tableName: TRANSACTION_TABLE,
    indexName: "external_mcp_oauth_transaction_connection",
    columns: ["external_mcp_connection_id"],
    unique: false,
    createSql: `CREATE INDEX \`external_mcp_oauth_transaction_connection\` ON \`${TRANSACTION_TABLE}\` (\`external_mcp_connection_id\`)`,
    operations,
    retry,
  })
  await ensureIndex({
    executor,
    tableName: TRANSACTION_TABLE,
    indexName: "external_mcp_oauth_transaction_expires_at",
    columns: ["expires_at"],
    unique: false,
    createSql: `CREATE INDEX \`external_mcp_oauth_transaction_expires_at\` ON \`${TRANSACTION_TABLE}\` (\`expires_at\`)`,
    operations,
    retry,
  })

  if (latest >= metadata.when) {
    return {
      operations,
      status: operations.length > 0 ? "repaired_recorded" : "already_recorded",
    }
  }
  try {
    await executor.query(
      `INSERT INTO \`${MIGRATIONS_TABLE}\` (hash, created_at) VALUES (?, ?)`,
      [metadata.hash, metadata.when],
    )
  } catch (error) {
    // A concurrent repair or an ambiguous write response may already have
    // recorded the transition. The ledger cursor is authoritative.
    if (await latestRecordedMigration(executor) < metadata.when) throw error
  }
  return { operations, status: "recorded" }
}
