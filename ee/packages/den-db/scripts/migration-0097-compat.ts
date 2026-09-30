import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator"
import type { Executor } from "../src/schema-repairs.ts"
import {
  assertMatrixEnvironment, assertMatrixSchema, assertNoPartialMatrix, loadMatrixSnapshot, matrixRecovery,
  MatrixSafetyError, matrixSnapshotShape, matrixSources, matrixTargets, rejectMatrix,
} from "./migration-0097-schema.ts"

export const matrixHash = "96e872e1fdf004ff4cdf66715a589a442dff80170f2b47e70204b38a2fd09470"
export const matrixMillis = 1788895934602
const matrixTag = "0097_gateway_access_matrix"
const journalTable = "__drizzle_migrations"
type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean }
type Journal = { version: string; dialect: string; entries: JournalEntry[] }

export function matrixStatements(migration: MigrationMeta) {
  if (migration.hash !== matrixHash || migration.folderMillis !== matrixMillis
    || createHash("sha256").update(migration.sql.join("--> statement-breakpoint")).digest("hex") !== matrixHash) rejectMatrix("0097 source hash/timestamp changed")
  const omitted = matrixTargets.slice(0, 8).flatMap((table) => [
    `ALTER TABLE \`${table}\` DROP PRIMARY KEY;`,
    `ALTER TABLE \`${table}\` ADD PRIMARY KEY(\`id\`);`,
  ])
  for (const sql of omitted) if (migration.sql.filter((packet) => packet.trim() === sql).length !== 1) rejectMatrix("0097 PRIMARY(id) operation set changed")
  const sql = migration.sql.filter((packet) => !omitted.includes(packet.trim()))
  if (migration.sql.length !== 98 || sql.length !== 82) rejectMatrix("0097 statement count changed")
  return sql
}

export function loadUpgradePlan(migrationsFolder: string) {
  const journal: Journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"))
  if (journal.dialect !== "mysql" || !Array.isArray(journal.entries)) rejectMatrix("invalid migration journal")
  const migrations = readMigrationFiles({ migrationsFolder })
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.idx !== index + 1 || typeof entry.tag !== "string" || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag)
      || Number(entry.tag.slice(0, 4)) !== entry.idx || !Number.isSafeInteger(entry.when)
      || entry.when !== migrations[index]?.folderMillis || (index > 0 && entry.when <= journal.entries[index - 1].when)) rejectMatrix("invalid migration order")
  }
  if (journal.entries[96]?.tag !== matrixTag || migrations.length !== journal.entries.length) rejectMatrix("missing canonical 0097 entry")
  matrixStatements(migrations[96])
  return { journal, migrations, migrationsFolder }
}

type UpgradePlan = ReturnType<typeof loadUpgradePlan>

export async function upgradeHistoryPrefix(executor: Executor, plan: UpgradePlan) {
  const rows = await executor.query(`SELECT hash, created_at FROM \`${journalTable}\` ORDER BY created_at, id`)
  for (const [index, row] of rows.entries()) {
    const expected = plan.migrations[index]
    const millis = typeof row.created_at === "number" || typeof row.created_at === "string" || typeof row.created_at === "bigint" ? Number(row.created_at) : NaN
    if (!expected || row.hash !== expected.hash || millis !== expected.folderMillis) rejectMatrix(`history is not an exact hash/timestamp prefix at receipt ${index + 1}`)
  }
  if (rows.length === 0) rejectMatrix("existing database has no migration receipts")
  return rows.length
}

async function migratePredecessors(plan: UpgradePlan, regularMigrate: (folder: string) => Promise<void>) {
  const folder = mkdtempSync(path.join(tmpdir(), "den-db-before-0097-"))
  try {
    mkdirSync(path.join(folder, "meta"))
    const entries = plan.journal.entries.slice(0, 96)
    for (const entry of entries) copyFileSync(path.join(plan.migrationsFolder, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`))
    writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...plan.journal, entries }))
    const copied = readMigrationFiles({ migrationsFolder: folder })
    if (copied.length !== 96 || copied.some((entry, index) => entry.hash !== plan.migrations[index].hash || entry.folderMillis !== plan.migrations[index].folderMillis)) rejectMatrix("predecessor copy differs from canonical migrations")
    await regularMigrate(folder)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

async function assertNoVisibleActiveSessions(executor: Executor) {
  const rows = await executor.query("SELECT 1 FROM information_schema.PROCESSLIST WHERE DB = DATABASE() AND ID <> CONNECTION_ID() AND COMMAND <> 'Sleep' LIMIT 1")
  if (rows.length) rejectMatrix("another visible database session is active; external quiescence is required even after acknowledgement")
}

export async function migrateWith0097Compatibility(
  executor: Executor,
  migrationsFolder: string,
  regularMigrate: (folder: string) => Promise<void>,
  log: (message: string) => void = console.log,
  options: { writersStoppedFor0097?: boolean } = {},
) {
  const plan = loadUpgradePlan(migrationsFolder)
  const prefix = await upgradeHistoryPrefix(executor, plan)
  if (prefix >= 97) {
    if (prefix < plan.migrations.length) await regularMigrate(migrationsFolder)
    return
  }
  if (options.writersStoppedFor0097 !== true) rejectMatrix("pending 0097 requires explicit external quiescence acknowledgement: stop and drain application/gateway writers, callbacks, cron jobs and competing deploy jobs, then set DEN_DB_0097_WRITERS_STOPPED=1 for this migration process only; this process does not freeze writers")
  const before = loadMatrixSnapshot(migrationsFolder, "0096")
  const after = loadMatrixSnapshot(migrationsFolder, "0097")
  if (after.prevId !== before.id) rejectMatrix("canonical snapshot chain changed")
  const sourceShape = matrixSnapshotShape(before, matrixSources)
  const targetShape = matrixSnapshotShape(after, matrixTargets)
  for (const source of matrixSources) {
    const target = source.replace("inference_", "gateway_")
    if (sourceShape.get(`column:${source}.id`) !== targetShape.get(`column:${target}.id`)) rejectMatrix("canonical id column changed across the rename")
  }
  const statements = matrixStatements(plan.migrations[96])
  let locked = false
  try {
    await assertMatrixEnvironment(executor)
    const lock = await executor.query("SELECT GET_LOCK(CONCAT('den-db-0097:', LEFT(SHA2(DATABASE(), 256), 40)), 0) AS acquired")
    if (Number(lock[0]?.acquired) !== 1) rejectMatrix("another compatibility migration owns this database or locking is unsupported")
    locked = true
    if (await upgradeHistoryPrefix(executor, plan) !== prefix) rejectMatrix("history changed during preflight")
    await assertNoVisibleActiveSessions(executor)
    await assertNoPartialMatrix(executor)
    if (prefix < 96) await migratePredecessors(plan, regularMigrate)
    if (await upgradeHistoryPrefix(executor, plan) !== 96) rejectMatrix("predecessors did not reach exact 0096")
    await assertNoPartialMatrix(executor)
    await assertMatrixSchema(executor, sourceShape, matrixSources)
    await assertNoVisibleActiveSessions(executor)
    log(`[den-db] applying ${matrixTag} compatibility: hash=${matrixHash} timestamp=${matrixMillis}; preserving eight PRIMARY(id) keys; executing 82 original statements`)
    for (const statement of statements) await executor.query(statement)
    await assertMatrixSchema(executor, targetShape, matrixTargets)
    await executor.query("START TRANSACTION")
    try {
      if (await upgradeHistoryPrefix(executor, plan) !== 96) rejectMatrix("history changed before completion receipt")
      await executor.query(`INSERT INTO \`${journalTable}\` (hash, created_at) VALUES (?, ?)`, [matrixHash, matrixMillis])
      await executor.query("COMMIT")
    } catch (error) {
      await executor.query("ROLLBACK")
      throw error
    }
    log(`[den-db] verified ${matrixTag}; recorded original hash/timestamp`)
  } catch (error) {
    if (error instanceof MatrixSafetyError) throw error
    throw new Error(`[den-db] 0097 compatibility upgrade stopped; no automatic recovery or retry. ${matrixRecovery}`, { cause: error })
  } finally {
    if (locked) {
      try {
        await executor.query("SELECT RELEASE_LOCK(CONCAT('den-db-0097:', LEFT(SHA2(DATABASE(), 256), 40)))")
      } catch (error) {
        throw new Error(`[den-db] 0097 compatibility lock release failed; inspect migration receipts before restarting. ${matrixRecovery}`, { cause: error })
      }
    }
  }
  await regularMigrate(migrationsFolder)
}
