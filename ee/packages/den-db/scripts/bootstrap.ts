/**
 * Production-oriented install/upgrade entrypoint for Den databases.
 *
 * Empty databases cannot currently be built by replaying the historical
 * migration chain, because the migration history starts after early schema
 * state. For a new empty database we apply the current schema once, record the
 * committed migrations as the baseline, then run normal migrations.
 *
 * A durable zero-timestamp ledger marker lets a retry distinguish and resume
 * an interrupted fresh schema push. Existing no-ledger databases skip schema
 * push and are baselined only after the matching migration snapshot verifies
 * every object claimed by that baseline.
 */
import "../src/load-env.ts"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureFulltextIndexes } from "../src/fulltext.ts"
import { createExecutor, type Executor } from "./db-executor.ts"
import {
  FRESH_BOOTSTRAP_SENTINEL_CREATED_AT,
  FRESH_BOOTSTRAP_SENTINEL_HASH,
  resolveBootstrapMigrationPlan,
} from "./migration-policy.ts"

const MIGRATIONS_TABLE = "__drizzle_migrations"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: packageDir,
    env: process.env,
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

async function listTables(executor: Executor) {
  const rows = await executor.query("show tables")
  return rows
    .map((row) => Object.values(row).find((value) => typeof value === "string"))
    .filter((value): value is string => Boolean(value))
}

async function hasMigrationLedger(executor: Executor) {
  const tables = await listTables(executor)
  return tables.some((table) => table === MIGRATIONS_TABLE)
}

async function migrationLedgerState(executor: Executor) {
  if (!(await hasMigrationLedger(executor))) {
    return { freshBootstrapSentinelPresent: false, recordedMigrationCount: 0 }
  }
  const rows = await executor.query(`SELECT hash, created_at AS createdAt FROM \`${MIGRATIONS_TABLE}\``)
  let freshBootstrapSentinelPresent = false
  let recordedMigrationCount = 0
  for (const row of rows) {
    const createdAt = Number(row.createdAt)
    if (typeof row.hash !== "string" || !Number.isSafeInteger(createdAt)) {
      throw new Error(`Could not read ${MIGRATIONS_TABLE} entries.`)
    }
    if (
      row.hash === FRESH_BOOTSTRAP_SENTINEL_HASH
      && createdAt === FRESH_BOOTSTRAP_SENTINEL_CREATED_AT
    ) {
      freshBootstrapSentinelPresent = true
    } else {
      recordedMigrationCount += 1
    }
  }
  return { freshBootstrapSentinelPresent, recordedMigrationCount }
}

async function freshBootstrapSentinelExists(executor: Executor) {
  if (!(await hasMigrationLedger(executor))) return false
  const rows = await executor.query(
    `SELECT 1 AS present FROM \`${MIGRATIONS_TABLE}\`
     WHERE hash = ? AND created_at = ? LIMIT 1`,
    [FRESH_BOOTSTRAP_SENTINEL_HASH, FRESH_BOOTSTRAP_SENTINEL_CREATED_AT],
  )
  return rows.length > 0
}

async function ensureFreshBootstrapSentinel(executor: Executor) {
  await executor.query(
    `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\`
     (id serial primary key, hash text NOT NULL, created_at bigint)`,
  )
  if (await freshBootstrapSentinelExists(executor)) return
  try {
    await executor.query(
      `INSERT INTO \`${MIGRATIONS_TABLE}\` (hash, created_at) VALUES (?, ?)`,
      [FRESH_BOOTSTRAP_SENTINEL_HASH, FRESH_BOOTSTRAP_SENTINEL_CREATED_AT],
    )
  } catch (error) {
    // A concurrent bootstrap or an ambiguous network response may have written
    // the marker. Re-read before surfacing the error.
    if (await freshBootstrapSentinelExists(executor)) return
    throw error
  }
}

async function clearFreshBootstrapSentinel(executor: Executor) {
  if (!(await hasMigrationLedger(executor))) return
  await executor.query(
    `DELETE FROM \`${MIGRATIONS_TABLE}\` WHERE hash = ? AND created_at = ?`,
    [FRESH_BOOTSTRAP_SENTINEL_HASH, FRESH_BOOTSTRAP_SENTINEL_CREATED_AT],
  )
}

async function main() {
  const executor = await createExecutor()
  try {
    const tables = await listTables(executor)
    const applicationTables = tables.filter((table) => table !== MIGRATIONS_TABLE)
    const ledgerState = await migrationLedgerState(executor)
    const plan = resolveBootstrapMigrationPlan({
      applicationTableCount: applicationTables.length,
      ...ledgerState,
    })

    if (plan.applyCurrentSchema) {
      if (plan.createFreshBootstrapSentinel) {
        console.log("[den-db] empty database detected; recording durable fresh-bootstrap marker")
        await ensureFreshBootstrapSentinel(executor)
      } else {
        console.log("[den-db] interrupted fresh bootstrap detected; resuming current-schema push")
      }
      console.log("[den-db] applying current schema")
      run("sh", ["-lc", "yes | node --import tsx ./node_modules/drizzle-kit/bin.cjs push --config drizzle.config.ts"])
    }
    if (plan.baselineThrough) {
      if (plan.verifyLegacySnapshot) {
        console.log("[den-db] untracked existing schema detected; requiring a complete 0039 snapshot fingerprint")
      }
      console.log(`[den-db] recording migration baseline through ${plan.baselineThrough}`)
      run("node", [
        "--import",
        "tsx",
        "scripts/baseline-migrations.ts",
        "--yes",
        "--through",
        plan.baselineThrough,
      ])
    }
    if (ledgerState.freshBootstrapSentinelPresent || plan.createFreshBootstrapSentinel) {
      await clearFreshBootstrapSentinel(executor)
      console.log("[den-db] fresh-bootstrap marker cleared after verified complete baseline")
    }
  } finally {
    await executor.close()
  }

  console.log("[den-db] repairing/verifying resumable migration 0040")
  run("node", ["--import", "tsx", "scripts/repair-migration-0040.ts"])

  console.log("[den-db] running migrations")
  run("node", ["--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "migrate", "--config", "drizzle.config.ts"])

  // FULLTEXT indexes cannot be expressed via Drizzle's DSL and are baselined-away on the
  // fresh-install (push + baseline) path, so create them idempotently here — the same seam
  // the post-`db:migrate` hook runs, so the two apply paths cannot drift (§3, B2).
  console.log("[den-db] ensuring FULLTEXT indexes")
  const indexExecutor = await createExecutor()
  try {
    await ensureFulltextIndexes(indexExecutor)
  } finally {
    await indexExecutor.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
