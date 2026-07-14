import { createHash, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import * as mysql from "mysql2/promise"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"
import type { Executor } from "./db-executor.ts"
import { repairMigration0038 } from "./migration-0038-repair.ts"
import {
  FRESH_BOOTSTRAP_SENTINEL_CREATED_AT,
  FRESH_BOOTSTRAP_SENTINEL_HASH,
  LEGACY_BASELINE_THROUGH_TAG,
  LATEST_BASELINE_ALIAS,
  resolveBaselineTarget,
  resolveBootstrapMigrationPlan,
  type MigrationJournalEntry,
} from "./migration-policy.ts"
import {
  assertMinimumMigrationSnapshot,
  minimumMigrationSnapshotProblems,
  type LiveColumn,
  type LiveIndexColumn,
  type MigrationSnapshot,
} from "./migration-snapshot-verifier.ts"

const MIGRATION_0038_TAG = "0038_organic_nicolaos"
const MIGRATION_0039_TAG = "0039_marketplace_plugin_provenance"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function journalEntries(): MigrationJournalEntry[] {
  const value: unknown = JSON.parse(
    readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  )
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Migration journal is missing entries")
  }
  return value.entries.flatMap((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.idx !== "number"
      || typeof entry.when !== "number"
      || typeof entry.tag !== "string"
    ) {
      return []
    }
    return [{ idx: entry.idx, when: entry.when, tag: entry.tag }]
  })
}

const entries = journalEntries()
const migration0037 = resolveBaselineTarget(entries, LEGACY_BASELINE_THROUGH_TAG)

function requiredMigration(tag: string): MigrationJournalEntry {
  const entry = entries.find((candidate) => candidate.tag === tag)
  if (!entry) throw new Error(`${tag} is missing from the migration journal`)
  return entry
}

const migration0038 = requiredMigration(MIGRATION_0038_TAG)
const migration0039 = requiredMigration(MIGRATION_0039_TAG)

describe("Den database migration lifecycle policy", () => {
  test("defaults a legacy no-ledger baseline to 0037 and leaves 0038 plus 0039 pending", () => {
    const target = resolveBaselineTarget(entries)
    const pending = entries.filter((entry) => entry.when > target.when)

    expect(target.tag).toBe(LEGACY_BASELINE_THROUGH_TAG)
    expect(pending.map((entry) => entry.tag)).toEqual([MIGRATION_0038_TAG, MIGRATION_0039_TAG])
  })

  test("requires an explicit latest baseline for a freshly pushed empty database", () => {
    const plan = resolveBootstrapMigrationPlan({
      applicationTableCount: 0,
      recordedMigrationCount: 0,
      freshBootstrapSentinelPresent: false,
    })

    expect(plan).toEqual({
      applyCurrentSchema: true,
      baselineThrough: LATEST_BASELINE_ALIAS,
      createFreshBootstrapSentinel: true,
      verifyLegacySnapshot: false,
    })
    expect(resolveBaselineTarget(entries, plan.baselineThrough ?? undefined)).toEqual(entries.at(-1))
  })

  test("uses the safe cutoff only for a non-empty schema without recorded history", () => {
    expect(resolveBootstrapMigrationPlan({
      applicationTableCount: 12,
      recordedMigrationCount: 0,
      freshBootstrapSentinelPresent: false,
    })).toEqual({
      applyCurrentSchema: false,
      baselineThrough: LEGACY_BASELINE_THROUGH_TAG,
      createFreshBootstrapSentinel: false,
      verifyLegacySnapshot: true,
    })

    expect(resolveBootstrapMigrationPlan({
      applicationTableCount: 12,
      recordedMigrationCount: 37,
      freshBootstrapSentinelPresent: false,
    })).toEqual({
      applyCurrentSchema: false,
      baselineThrough: null,
      createFreshBootstrapSentinel: false,
      verifyLegacySnapshot: false,
    })
  })

  test("a durable sentinel resumes a fresh push even after a partial baseline", () => {
    expect(resolveBootstrapMigrationPlan({
      applicationTableCount: 12,
      recordedMigrationCount: 9,
      freshBootstrapSentinelPresent: true,
    })).toEqual({
      applyCurrentSchema: true,
      baselineThrough: LATEST_BASELINE_ALIAS,
      createFreshBootstrapSentinel: false,
      verifyLegacySnapshot: false,
    })
    expect(FRESH_BOOTSTRAP_SENTINEL_HASH).toContain("fresh-bootstrap")
    expect(FRESH_BOOTSTRAP_SENTINEL_CREATED_AT).toBe(0)
  })

  test("refuses to overwrite an empty application schema with recorded history", () => {
    expect(() => resolveBootstrapMigrationPlan({
      applicationTableCount: 0,
      recordedMigrationCount: 1,
      freshBootstrapSentinelPresent: false,
    })).toThrow("Migration history exists")
  })
})

const verifierSnapshot: MigrationSnapshot = {
  tables: {
    external_mcp_connection: {
      name: "external_mcp_connection",
      columns: {
        id: { name: "id", type: "varchar(64)", notNull: true },
        scope: { name: "scope", type: "varchar(1024)", notNull: false },
        created_at: {
          name: "created_at",
          type: "timestamp(3)",
          notNull: true,
          defaultValue: "(now())",
        },
      },
      indexes: {
        external_mcp_connection_organization_id: {
          name: "external_mcp_connection_organization_id",
          columns: ["id"],
          isUnique: false,
        },
      },
      compositePrimaryKeys: {
        external_mcp_connection_id: { columns: ["id"] },
      },
      uniqueConstraints: {},
    },
  },
}

const verifierColumns: LiveColumn[] = [
  {
    tableName: "external_mcp_connection",
    columnName: "id",
    columnType: "varchar(64)",
    isNullable: "NO",
    columnDefault: null,
    extra: "",
  },
  {
    tableName: "external_mcp_connection",
    columnName: "scope",
    columnType: "text",
    isNullable: "YES",
    columnDefault: null,
    extra: "",
  },
  {
    tableName: "external_mcp_connection",
    columnName: "created_at",
    columnType: "timestamp(3)",
    isNullable: "NO",
    columnDefault: "CURRENT_TIMESTAMP(3)",
    extra: "DEFAULT_GENERATED",
  },
]

const verifierIndexes: LiveIndexColumn[] = [
  {
    tableName: "external_mcp_connection",
    indexName: "PRIMARY",
    nonUnique: 0,
    columnName: "id",
    sequence: 1,
  },
  {
    tableName: "external_mcp_connection",
    indexName: "external_mcp_connection_organization_id",
    nonUnique: 1,
    columnName: "id",
    sequence: 1,
  },
]

describe("minimum migration snapshot verifier", () => {
  test("accepts the reviewed 0038 scope widening and equivalent timestamp defaults", () => {
    expect(minimumMigrationSnapshotProblems({
      snapshot: verifierSnapshot,
      columns: verifierColumns,
      indexes: verifierIndexes,
    })).toEqual([])
  })

  test("fails closed for missing objects, changed defaults, and changed uniqueness", () => {
    const problems = minimumMigrationSnapshotProblems({
      snapshot: verifierSnapshot,
      columns: verifierColumns
        .filter((column) => column.columnName !== "scope")
        .map((column) => column.columnName === "created_at"
          ? { ...column, columnDefault: null }
          : column),
      indexes: verifierIndexes.map((index) => index.indexName === "external_mcp_connection_organization_id"
        ? { ...index, nonUnique: 0 }
        : index),
    })

    expect(problems).toContain("missing column external_mcp_connection.scope")
    expect(problems.some((problem) => problem.startsWith("incompatible default external_mcp_connection.created_at"))).toBe(true)
    expect(problems).toContain("incompatible uniqueness external_mcp_connection.external_mcp_connection_organization_id")
  })
})

const testDatabaseUrl = process.env.DEN_DB_MIGRATION_TEST_URL?.trim()
if (process.env.CI && !testDatabaseUrl) {
  throw new Error("DEN_DB_MIGRATION_TEST_URL is required in CI; migration database simulations must not be skipped.")
}
const describeMySql = testDatabaseUrl ? describe : describe.skip

async function withTemporaryDatabase(
  run: (executor: Executor) => Promise<void>,
): Promise<void> {
  if (!testDatabaseUrl) throw new Error("DEN_DB_MIGRATION_TEST_URL is required")
  const parsed = parseMySqlConnectionConfig(testDatabaseUrl)
  const { database: _configuredDatabase, ...serverConfig } = parsed
  const database = `openwork_migration_test_${randomUUID().replaceAll("-", "")}`
  const admin = await mysql.createConnection(serverConfig)
  let connection: mysql.Connection | undefined
  try {
    await admin.query(`CREATE DATABASE \`${database}\``)
    connection = await mysql.createConnection({ ...parsed, database })
    const executor: Executor = {
      query: async (sql, args = []) => {
        const [rows] = await connection!.query(sql, args)
        const result: unknown = rows
        return Array.isArray(result) ? result.filter(isRecord) : []
      },
      close: () => connection!.end(),
    }
    await run(executor)
  } finally {
    if (connection) await connection.end()
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``)
    await admin.end()
  }
}

async function createMigrationLedger(executor: Executor, timestamps: number[]) {
  await executor.query(
    "CREATE TABLE `__drizzle_migrations` (id serial primary key, hash text NOT NULL, created_at bigint)",
  )
  for (const timestamp of timestamps) {
    await executor.query(
      "INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)",
      [`test-${timestamp}`, timestamp],
    )
  }
}

async function createPre0038ConnectionTable(executor: Executor, scopeType = "varchar(1024)") {
  await executor.query(`CREATE TABLE \`external_mcp_connection\` (
    \`id\` varchar(64) NOT NULL PRIMARY KEY,
    \`scope\` ${scopeType}
  )`)
}

async function createOAuthTransactionTable(executor: Executor, createdAtDefault = " DEFAULT (now())") {
  await executor.query(`CREATE TABLE \`external_mcp_oauth_transaction\` (
    \`state_key\` varchar(64) NOT NULL,
    \`organization_id\` varchar(64) NOT NULL,
    \`external_mcp_connection_id\` varchar(64) NOT NULL,
    \`org_membership_id\` varchar(64) NOT NULL,
    \`connection_authorization_epoch\` int NOT NULL DEFAULT 0,
    \`code_verifier\` text NOT NULL,
    \`expires_at\` timestamp(3) NOT NULL,
    \`created_at\` timestamp(3) NOT NULL${createdAtDefault},
    CONSTRAINT \`external_mcp_oauth_transaction_state_key\` PRIMARY KEY(\`state_key\`)
  )`)
}

async function expectMigration0038Schema(executor: Executor) {
  const columns = await executor.query(
    `SELECT table_name AS tableName, column_name AS columnName, data_type AS dataType
     FROM information_schema.COLUMNS
     WHERE table_schema = DATABASE()
       AND ((table_name = 'external_mcp_connection' AND column_name IN (
         'scope',
         'requested_oauth_scopes',
         'oauth_registration_lease_token',
         'oauth_registration_lease_started_at',
         'oauth_authorization_epoch'
       )) OR table_name = 'external_mcp_oauth_transaction')`,
  )
  const connectionColumns = columns
    .filter((row) => row.tableName === "external_mcp_connection")
    .map((row) => row.columnName)
    .sort()
  const transactionColumns = columns
    .filter((row) => row.tableName === "external_mcp_oauth_transaction")
    .map((row) => row.columnName)
    .sort()

  expect(connectionColumns).toEqual([
    "oauth_authorization_epoch",
    "oauth_registration_lease_started_at",
    "oauth_registration_lease_token",
    "requested_oauth_scopes",
    "scope",
  ])
  expect(transactionColumns).toEqual([
    "client_registration_revision",
    "code_verifier",
    "connection_authorization_epoch",
    "created_at",
    "expires_at",
    "external_mcp_connection_id",
    "org_membership_id",
    "organization_id",
    "state_key",
  ])
  expect(columns.find((row) => row.columnName === "scope")?.dataType).toBe("text")

  const indexes = await executor.query(
    `SELECT DISTINCT index_name AS indexName
     FROM information_schema.STATISTICS
     WHERE table_schema = DATABASE() AND table_name = 'external_mcp_oauth_transaction'`,
  )
  expect(indexes.map((row) => row.indexName).sort()).toEqual([
    "PRIMARY",
    "external_mcp_oauth_transaction_connection",
    "external_mcp_oauth_transaction_expires_at",
  ])

  const ledger = await executor.query("SELECT max(created_at) AS latest FROM `__drizzle_migrations`")
  expect(Number(ledger[0]?.latest)).toBe(migration0038.when)
}

describeMySql("migration 0038 MySQL repair simulations", () => {
  test("empty schema is left for bootstrap's push-and-explicit-latest path", async () => {
    await withTemporaryDatabase(async (executor) => {
      expect(await repairMigration0038(executor)).toEqual({
        operations: [],
        status: "not_applicable",
      })
    })
  })

  test("pre-0038 schema is applied, verified, recorded, and safely rerun", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0037.when])

      const first = await repairMigration0038(executor)
      expect(first.status).toBe("recorded")
      expect(first.operations.length).toBeGreaterThan(0)
      await expectMigration0038Schema(executor)

      expect(await repairMigration0038(executor)).toEqual({
        operations: [],
        status: "already_recorded",
      })
    })
  })

  test("refuses a 0037 ledger with a missing base table before creating any 0038 object", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createMigrationLedger(executor, [migration0037.when])

      await expect(repairMigration0038(executor)).rejects.toThrow(
        "required table external_mcp_connection is missing",
      )
      const table = await executor.query(
        `SELECT 1 AS present FROM information_schema.TABLES
         WHERE table_schema = DATABASE() AND table_name = 'external_mcp_oauth_transaction'`,
      )
      expect(table).toEqual([])
    })
  })

  test("fully applied but unrecorded schema is verified before recording", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0037.when])
      await repairMigration0038(executor)
      await executor.query(
        "DELETE FROM `__drizzle_migrations` WHERE created_at = ?",
        [migration0038.when],
      )

      expect(await repairMigration0038(executor)).toEqual({
        operations: [],
        status: "recorded",
      })
      await expectMigration0038Schema(executor)
    })
  })

  test("partial implicit-DDL application resumes only missing statements", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0037.when])
      await createOAuthTransactionTable(executor)
      await executor.query("ALTER TABLE `external_mcp_connection` MODIFY COLUMN `scope` text")
      await executor.query("ALTER TABLE `external_mcp_connection` ADD `requested_oauth_scopes` json")

      const result = await repairMigration0038(executor)
      expect(result.status).toBe("recorded")
      expect(result.operations).not.toContain("create external_mcp_oauth_transaction")
      expect(result.operations).not.toContain("modify external_mcp_connection.scope")
      expect(result.operations).not.toContain("add external_mcp_connection.requested_oauth_scopes")
      expect(result.operations).toContain("add external_mcp_oauth_transaction.client_registration_revision")
      expect(result.operations).toContain("add external_mcp_connection.oauth_authorization_epoch")
      await expectMigration0038Schema(executor)
    })
  })

  test("re-reads exact schema after an ambiguous create-table response", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0037.when])
      let injectedFailure = false
      const ambiguousExecutor: Executor = {
        close: executor.close,
        query: async (sql, args = []) => {
          if (!injectedFailure && sql.startsWith("CREATE TABLE `external_mcp_oauth_transaction`")) {
            injectedFailure = true
            await executor.query(sql, args)
            throw new Error("simulated response loss after committed DDL")
          }
          return executor.query(sql, args)
        },
      }

      const result = await repairMigration0038(ambiguousExecutor, {
        visibilityAttempts: 2,
        visibilityDelayMs: 0,
      })
      expect(injectedFailure).toBe(true)
      expect(result.status).toBe("recorded")
      await expectMigration0038Schema(executor)
    })
  })

  test("repairs a schema that an older baseline already marked as 0038", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0037.when, migration0038.when])

      const result = await repairMigration0038(executor)
      expect(result.status).toBe("repaired_recorded")
      expect(result.operations.length).toBeGreaterThan(0)
      await expectMigration0038Schema(executor)
    })
  })

  test("backfills the OAuth client revision fence for an already-recorded 0038 database", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0037.when])
      await repairMigration0038(executor)
      await executor.query(
        "ALTER TABLE `external_mcp_oauth_transaction` DROP COLUMN `client_registration_revision`",
      )

      const result = await repairMigration0038(executor)
      expect(result.status).toBe("repaired_recorded")
      expect(result.operations).toContain("add external_mcp_oauth_transaction.client_registration_revision")
      await expectMigration0038Schema(executor)
    })
  })

  test("does not enforce the 0038 shape after a later migration cursor", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createMigrationLedger(executor, [migration0037.when, migration0038.when + 1])

      expect(await repairMigration0038(executor)).toEqual({
        operations: [],
        status: "not_applicable",
      })
    })
  })

  test("does not skip migrations when the ledger is older than 0037", async () => {
    const migration0036 = entries.find((entry) => entry.tag === "0036_petite_fallen_one")
    if (!migration0036) throw new Error("0036 migration is missing")
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0036.when])

      expect(await repairMigration0038(executor)).toEqual({
        operations: [],
        status: "not_applicable",
      })
      const table = await executor.query(
        `SELECT 1 AS present FROM information_schema.TABLES
         WHERE table_schema = DATABASE() AND table_name = 'external_mcp_oauth_transaction'`,
      )
      expect(table).toEqual([])
    })
  })

  test("fails closed instead of coercing an unexpected legacy scope type", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor, "int")
      await createMigrationLedger(executor, [migration0037.when])

      await expect(repairMigration0038(executor)).rejects.toThrow(
        "incompatible external_mcp_connection.scope type int",
      )
      const ledger = await executor.query("SELECT max(created_at) AS latest FROM `__drizzle_migrations`")
      expect(Number(ledger[0]?.latest)).toBe(migration0037.when)
    })
  })

  test("rejects a wrongly unique OAuth transaction lookup index", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0037.when])
      await createOAuthTransactionTable(executor)
      await executor.query(
        `CREATE UNIQUE INDEX \`external_mcp_oauth_transaction_connection\`
         ON \`external_mcp_oauth_transaction\` (\`external_mcp_connection_id\`)`,
      )

      await expect(repairMigration0038(executor)).rejects.toThrow(
        "expected non-unique",
      )
      const ledger = await executor.query("SELECT max(created_at) AS latest FROM `__drizzle_migrations`")
      expect(Number(ledger[0]?.latest)).toBe(migration0037.when)
    })
  })

  test("rejects a transaction table without the runtime-required created_at default", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await createMigrationLedger(executor, [migration0037.when])
      await createOAuthTransactionTable(executor, "")

      await expect(repairMigration0038(executor)).rejects.toThrow(
        "external_mcp_oauth_transaction.created_at",
      )
      const ledger = await executor.query("SELECT max(created_at) AS latest FROM `__drizzle_migrations`")
      expect(Number(ledger[0]?.latest)).toBe(migration0037.when)
    })
  })

  test("rejects a partial no-ledger schema instead of adopting it through 0037", async () => {
    await withTemporaryDatabase(async (executor) => {
      await createPre0038ConnectionTable(executor)
      await expect(assertMinimumMigrationSnapshot({
        executor,
        snapshotIndex: migration0037.idx,
        snapshotTag: migration0037.tag,
      })).rejects.toThrow("Refusing to baseline an unverified no-ledger schema")
    })
  })
})

const migration0039Statements = readFileSync(
  new URL(`../drizzle/${migration0039.tag}.sql`, import.meta.url),
  "utf8",
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean)

describeMySql("migration 0039 MySQL resumability", () => {
  test("resumes after the first committed table and keeps provenance claims unique", async () => {
    await withTemporaryDatabase(async (executor) => {
      await executor.query(`CREATE TABLE \`plugin\` (
        \`id\` varchar(64) NOT NULL PRIMARY KEY,
        \`organization_id\` varchar(64) NOT NULL,
        \`description\` text,
        \`created_by_org_membership_id\` varchar(64) NOT NULL,
        \`created_at\` timestamp(3) NOT NULL DEFAULT (now()),
        \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      )`)
      const sourceUrl = "https://github.com/acme/toolkit"
      await executor.query(
        `INSERT INTO \`plugin\`
         (id, organization_id, description, created_by_org_membership_id)
         VALUES (?, ?, ?, ?)`,
        ["plugin_1", "organization_1", `Plugin components imported from ${sourceUrl}.`, "member_1"],
      )

      expect(migration0039Statements).toHaveLength(3)
      await executor.query(migration0039Statements[0]!)
      for (const statement of migration0039Statements) await executor.query(statement)
      for (const statement of migration0039Statements) await executor.query(statement)

      const imports = await executor.query(
        `SELECT plugin_id AS pluginId, organization_id AS organizationId,
                provider, canonical_source_key AS canonicalSourceKey,
                canonical_source_url AS canonicalSourceUrl
         FROM \`plugin_import_source\``,
      )
      expect(imports).toEqual([{
        pluginId: "plugin_1",
        organizationId: "organization_1",
        provider: "github",
        canonicalSourceKey: createHash("sha256").update(sourceUrl).digest("hex"),
        canonicalSourceUrl: sourceUrl,
      }])

      await expect(executor.query(
        `INSERT INTO \`plugin_import_source\`
         (plugin_id, organization_id, provider, canonical_source_key,
          canonical_source_url, created_by_org_membership_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "plugin_2",
          "organization_1",
          "github",
          createHash("sha256").update(sourceUrl).digest("hex"),
          sourceUrl,
          "member_1",
        ],
      )).rejects.toThrow()

      const managedTable = await executor.query(
        `SELECT 1 AS present FROM information_schema.TABLES
         WHERE table_schema = DATABASE()
           AND table_name = 'plugin_managed_external_mcp_connection'`,
      )
      expect(managedTable).toEqual([{ present: 1 }])
    })
  })
})
