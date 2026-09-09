import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"
import { ensureSchemaRepairs, type Executor } from "../src/schema-repairs.ts"
import {
  MigrationSafetyError, foundationSql, historyPrefix, inspectSchema, journalTable,
  loadMigrationPlan, planAuthLookupIndexRepairs, preflightRepairs, recognizeBaseline, record, recovery,
  schemaDifferences, snapshotShape, stateTable, type MigrationPlan,
} from "./migration-baseline.ts"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function localConnectionConfig(databaseUrl: string) {
  let config: ReturnType<typeof parseMySqlConnectionConfig>
  try {
    if (new URL(databaseUrl).protocol !== "mysql:") throw new Error()
    config = parseMySqlConnectionConfig(databaseUrl)
  } catch {
    throw new MigrationSafetyError("Set DATABASE_URL to a valid local MySQL database URL (value withheld).")
  }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(config.host)) {
    throw new MigrationSafetyError("Local startup migrations require a loopback DATABASE_URL. Remote databases need a separately reviewed migration procedure.")
  }
  if (config.host === "[::1]") config.host = "::1"
  return config
}

export function matrixPreflightQueries(plan: MigrationPlan) {
  const migration = plan.find((entry) => entry.tag === "0095_gateway_access_matrix")
  if (!migration) throw new MigrationSafetyError("Missing 0095 preflight")
  const statements = migration.sql.map((sql) => sql.replace(/^\s*--[^\n]*$/gm, "").trim())
  const rename = statements.findIndex((sql) => /^RENAME TABLE\b/i.test(sql))
  const queries = statements.slice(0, rename).flatMap((sql) => {
    const match = /^INSERT INTO `__gateway_0095_preflight` \(`failure`\)\s+(SELECT '(0095_[a-z0-9_]+)'[\s\S]*)$/.exec(sql)
    return match ? [{ name: match[2], sql: match[1] }] : []
  })
  const seed = statements.find((sql) => /^INSERT INTO `__gateway_0095_preflight` \(`failure`\) VALUES/.test(sql))
  const names = seed ? [...seed.matchAll(/'(0095_[a-z0-9_]+)'/g)].map((match) => match[1]) : []
  if (rename < 0 || names.length < 10 || queries.length !== names.length
    || new Set(queries.map((query) => query.name)).size !== names.length
    || names.some((name) => !queries.some((query) => query.name === name))) {
    throw new MigrationSafetyError("0095 preflight layout changed; review local startup integration before execution.")
  }
  return queries
}

export async function preflightMatrix(executor: Executor, plan: MigrationPlan, completeSchema = true) {
  for (const query of matrixPreflightQueries(plan)) {
    if (!completeSchema && query.name === "0095_requires_complete_0094_schema") continue
    if ((await executor.query(query.sql)).length) throw new MigrationSafetyError(`Preflight rejected ${query.name}; no rows were changed. ${recovery}`)
  }
}

export async function migrateLocalDatabase(executor: Executor, plan: MigrationPlan, checkOnly = false) {
  const server = (await executor.query("SELECT VERSION() AS version, @@SESSION.sql_mode AS mode, DATABASE() AS db"))[0]
  const version = String(server?.version).match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!version || /mariadb|tidb/i.test(String(server?.version)) || Number(version[1]) < 8
    || (Number(version[1]) === 8 && Number(version[2]) === 0 && Number(version[3]) < 16)
    || !/STRICT_(?:TRANS|ALL)_TABLES/.test(String(server?.mode))) {
    throw new MigrationSafetyError("Local migrations require MySQL 8.0.16+ with strict SQL mode and enforced CHECK constraints.")
  }
  if (typeof server?.db !== "string" || !server.db) throw new MigrationSafetyError("No database selected")
  // MySQL named locks are server-scoped and survive DDL commits. Worktree,
  // credentials and localhost spelling must not change this lock's identity.
  const lock = `ow-dev:${createHash("sha256").update(server.db.toLowerCase()).digest("hex").slice(0, 56)}`
  if (Number((await executor.query("SELECT GET_LOCK(?, 0) AS acquired", [lock]))[0]?.acquired) !== 1) {
    throw new MigrationSafetyError("Another local migration runner holds this database's lock. Wait for it to finish; do not start a second schema tool.")
  }
  try {
    const otherSessions = await executor.query("SELECT 1 FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID() LIMIT 1")
    if (otherSessions.length) {
      if (!checkOnly) throw new MigrationSafetyError("Other connections are using this local database. Stop the old services, OAuth callbacks and workers before the migration cutover; no database changes made.")
      console.log("[den-db] Active connections detected: inspecting only. Stop services before applying migrations; startup will recheck compatibility.")
    }
    const { shape, tables } = await inspectSchema(executor)
    if (tables.includes(stateTable) && (await executor.query(`SELECT 1 FROM \`${stateTable}\` LIMIT 1`)).length) {
      throw new MigrationSafetyError(`A prior local migration/repair was interrupted. MySQL DDL cannot be rolled back or blindly retried. ${recovery}`)
    }
    const receipts = tables.includes(journalTable)
      ? await executor.query(`SELECT hash, created_at FROM \`${journalTable}\` ORDER BY id`) : []
    let applied = historyPrefix(plan, receipts)
    const empty = shape.size === 0
    const baseline = !empty && applied === 0
    const lookupRepairs = baseline ? planAuthLookupIndexRepairs(plan, shape) : []
    if (baseline) {
      const plannedShape = new Map(shape)
      for (const repair of lookupRepairs) plannedShape.set(repair.key, repair.definition)
      applied = recognizeBaseline(plan, plannedShape)
    }
    if (!empty && !baseline) {
      const snapshot = plan[applied - 1]?.snapshot
      if (!snapshot) throw new MigrationSafetyError(`No known snapshot for the recorded history prefix. ${recovery}`)
      const differences = schemaDifferences(snapshotShape(snapshot), shape)
      if (differences.length) throw new MigrationSafetyError(`Schema differs from its recorded migration (${differences.slice(0, 8).join(", ")}). ${recovery}`)
    }
    if (empty && applied) throw new MigrationSafetyError(`Migration receipts exist but the application schema is empty. ${recovery}`)
    await preflightRepairs(executor, shape)
    const pending = plan.slice(applied)
    matrixPreflightQueries(plan)
    if (pending.some((entry) => entry.tag === "0095_gateway_access_matrix") && shape.has("table:inference_providers")) {
      await preflightMatrix(executor, plan, plan[applied - 1].tag.startsWith("0094_"))
      console.log("[den-db] 0095 read-only data/schema guards passed")
    }
    const seed = empty ? await foundationSql(plan) : []
    for (const repair of lookupRepairs) console.log(`[den-db] Planned additive auth lookup index: ${repair.key.slice("index:".length)}`)
    if (lookupRepairs.length) console.log("[den-db] Schema will match 0094 only after the planned indexes; apply must reverify before recording any baseline receipts")
    console.log(`[den-db] ${empty ? "Empty database: replay from foundation" : baseline ? `Recognized schema: baseline through ${plan[applied - 1].tag} only` : `Verified ${applied} migration receipts`}; ${pending.length} migrations pending`)
    if (checkOnly) { console.log("[den-db] Read-only preflight complete; no schema, data or journal changes"); return }

    await executor.query(`CREATE TABLE IF NOT EXISTS \`${stateTable}\` (id int PRIMARY KEY, step varchar(255) NOT NULL) ENGINE=InnoDB`)
    await executor.query(`INSERT INTO \`${stateTable}\` (id, step) VALUES (1, 'initialize')`)
    if (lookupRepairs.length) {
      await executor.query(`UPDATE \`${stateTable}\` SET step='auth-lookup-indexes' WHERE id=1`)
      for (const repair of lookupRepairs) await executor.query(repair.sql)
      const snapshot = plan[applied - 1].snapshot
      if (!snapshot) throw new MigrationSafetyError("Missing pre-baseline snapshot")
      const differences = schemaDifferences(snapshotShape(snapshot), (await inspectSchema(executor)).shape)
      if (differences.length) throw new MigrationSafetyError(`Auth lookup index reconciliation did not reach exact 0094 (${differences.slice(0, 8).join(", ")}); no baseline receipts recorded. ${recovery}`)
      console.log("[den-db] Auth lookup indexes reconciled; exact 0094 schema verified before baselining")
    }
    await executor.query(`CREATE TABLE IF NOT EXISTS \`${journalTable}\` (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint) ENGINE=InnoDB`)
    if (baseline) {
      // Baseline receipts are atomic; the durable marker also covers DDL and
      // the gap between journal creation, seeding, migration and repairs.
      await executor.query("START TRANSACTION")
      try {
        for (const entry of plan.slice(0, applied)) await executor.query(`INSERT INTO \`${journalTable}\` (hash, created_at) VALUES (?, ?)`, [entry.hash, entry.folderMillis])
        await executor.query("COMMIT")
      } catch (error) { await executor.query("ROLLBACK"); throw error }
    }
    for (const statement of seed) await executor.query(statement)
    for (const entry of pending) {
      await executor.query(`UPDATE \`${stateTable}\` SET step=? WHERE id=1`, [entry.tag])
      if (entry.tag === "0095_gateway_access_matrix") await preflightMatrix(executor, plan)
      console.log(`[den-db] Applying ${entry.tag}`)
      for (const statement of entry.sql) if (statement.trim()) await executor.query(statement)
      await executor.query(`INSERT INTO \`${journalTable}\` (hash, created_at) VALUES (?, ?)`, [entry.hash, entry.folderMillis])
    }
    await executor.query(`UPDATE \`${stateTable}\` SET step='schema-repairs' WHERE id=1`)
    await ensureSchemaRepairs(executor)
    const finalSnapshot = plan[plan.length - 1]?.snapshot
    if (!finalSnapshot) throw new MigrationSafetyError("Missing final migration snapshot")
    const finalShape = (await inspectSchema(executor)).shape
    const differences = schemaDifferences(snapshotShape(finalSnapshot), finalShape)
    if (differences.length) throw new MigrationSafetyError(`Replay schema differs from the final snapshot (${differences.slice(0, 8).join(", ")}). ${recovery}`)
    const recorded = historyPrefix(plan, await executor.query(`SELECT hash, created_at FROM \`${journalTable}\` ORDER BY id`))
    if (recorded !== plan.length) throw new MigrationSafetyError(`Final migration receipts are incomplete. ${recovery}`)
    await executor.query(`DELETE FROM \`${stateTable}\` WHERE id=1`)
    console.log("[den-db] Migrations and schema repairs complete; services may start")
  } finally {
    await executor.query("SELECT RELEASE_LOCK(?)", [lock])
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => !["--check", "--check-artifacts"].includes(arg))) throw new MigrationSafetyError("Supported options: --check (read-only database preflight), --check-artifacts (offline only)")
  const plan = loadMigrationPlan(path.join(packageDir, "drizzle"))
  // Source schema is deliberately not imported: only canonical migration assets
  // own this operation, never a build export or drizzle-kit push.
  if (args.includes("--check-artifacts")) {
    matrixPreflightQueries(plan)
    const seed = await foundationSql(plan)
    console.log(`[den-db] Validated ${plan.length} ordered migration files and ${seed.length} foundation statements (offline)`)
    return
  }
  const config = localConnectionConfig(process.env.DATABASE_URL ?? "")
  const connection = await mysql.createConnection({ ...config, multipleStatements: true })
  try {
    await migrateLocalDatabase({ query: async (sql, args = []) => {
      const [rows] = await connection.query(sql, args)
      const result: unknown = rows
      return Array.isArray(result) ? result.filter(record) : []
    } }, plan, args.includes("--check"))
  } finally { await connection.end() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // Driver errors can contain SQL, row values, URLs and credentials. Never log
    // them here; the persistent marker and a code are sufficient for triage.
    const code = record(error) && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : ""
    console.error(`[den-db] ${error instanceof MigrationSafetyError ? error.message : `Migration failed${code}; database error details withheld. ${recovery}`}`)
    process.exitCode = 1
  })
}
