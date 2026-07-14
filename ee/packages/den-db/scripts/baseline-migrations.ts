/**
 * One-time baseline for databases that were previously managed with
 * `db:push` (state-based) and have no `__drizzle_migrations` table.
 *
 * Marks existing migrations as applied WITHOUT executing them, so a
 * subsequent `db:migrate` only runs migrations newer than the baseline.
 *
 * Usage:
 *   pnpm --filter @openwork-ee/den-db db:baseline              # dry run through safe legacy cutoff
 *   pnpm --filter @openwork-ee/den-db db:baseline -- --yes     # apply through safe legacy cutoff
 *   pnpm --filter @openwork-ee/den-db db:baseline -- --yes --through latest
 *   pnpm --filter @openwork-ee/den-db db:baseline -- --yes --through 0020_breezy_siren
 *
 * Connects with DATABASE_URL (mysql2) or DATABASE_HOST/DATABASE_USERNAME/
 * DATABASE_PASSWORD (PlanetScale HTTP driver) -- same as the rest of den-db.
 */
import "../src/load-env.ts"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createExecutor } from "./db-executor.ts"
import { resolveBaselineTarget, type MigrationJournalEntry } from "./migration-policy.ts"
import { assertMinimumMigrationSnapshot } from "./migration-snapshot-verifier.ts"

const MIGRATIONS_TABLE = "__drizzle_migrations"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const drizzleDir = path.join(packageDir, "drizzle")

function parseArgs() {
  const args = process.argv.slice(2)
  const apply = args.includes("--yes")
  const throughIndex = args.indexOf("--through")
  const through = throughIndex >= 0 ? args[throughIndex + 1] : undefined
  if (throughIndex >= 0 && !through) throw new Error("--through requires a migration tag or 'latest'")
  return { apply, through }
}

async function main() {
  const { apply, through } = parseArgs()

  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: MigrationJournalEntry[]
  }
  const entries = [...journal.entries].sort((a, b) => a.when - b.when)

  if (entries.length === 0) {
    console.log("No migrations in journal; nothing to baseline.")
    return
  }

  const throughEntry = resolveBaselineTarget(entries, through)

  const executor = await createExecutor()
  try {
    const tableRows = await executor.query(
      `SELECT 1 AS present FROM information_schema.TABLES
       WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
      [MIGRATIONS_TABLE],
    )
    const ledgerExists = tableRows.length > 0
    const rows = ledgerExists
      ? await executor.query(`select created_at as createdAt from \`${MIGRATIONS_TABLE}\` where created_at > 0`)
      : []
    const recordedTimestamps = new Set(rows.flatMap((row) => {
      const timestamp = Number(row.createdAt)
      return Number.isSafeInteger(timestamp) ? [timestamp] : []
    }))
    const latest = Math.max(0, ...recordedTimestamps)

    // Fill every missing ledger entry through the requested target, not only
    // entries above max(created_at). That makes an interrupted older baseline
    // repairable without allowing a hole below the cursor to skip migrations.
    const targetEntries = entries.filter((entry) => entry.when <= throughEntry.when)
    const pending = targetEntries.filter((entry) => !recordedTimestamps.has(entry.when))

    console.log(`Baseline target: ${throughEntry.tag} (when=${throughEntry.when})`)
    console.log(`Already recorded through: created_at=${latest || "none"}`)
    console.log(`Entries to mark as applied (without executing): ${pending.length}`)
    for (const entry of pending) {
      console.log(`  - ${entry.tag}`)
    }

    if (pending.length === 0) {
      console.log("Nothing to do.")
      return
    }

    console.log(`Verifying live schema contains every object through ${throughEntry.tag}`)
    await assertMinimumMigrationSnapshot({
      executor,
      snapshotIndex: throughEntry.idx,
      snapshotTag: throughEntry.tag,
    })
    console.log(`Schema verified through ${throughEntry.tag}`)

    if (!apply) {
      console.log("\nDry run. Re-run with --yes to record the baseline.")
      return
    }

    if (!ledgerExists) {
      await executor.query(
        `create table \`${MIGRATIONS_TABLE}\` (id serial primary key, hash text not null, created_at bigint)`,
      )
    }

    const records = pending.map((entry) => {
      const sqlContents = readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8")
      const hash = crypto.createHash("sha256").update(sqlContents).digest("hex")
      return { entry, hash }
    })
    const placeholders = records.map(() => "(?, ?)").join(", ")
    await executor.query(
      `insert into \`${MIGRATIONS_TABLE}\` (hash, created_at) values ${placeholders}`,
      records.flatMap(({ entry, hash }) => [hash, entry.when]),
    )
    for (const { entry } of records) {
      console.log(`Recorded ${entry.tag}`)
    }

    const verifiedRows = await executor.query(
      `select created_at as createdAt from \`${MIGRATIONS_TABLE}\` where created_at > 0 and created_at <= ?`,
      [throughEntry.when],
    )
    const verifiedTimestamps = new Set(verifiedRows.flatMap((row) => {
      const timestamp = Number(row.createdAt)
      return Number.isSafeInteger(timestamp) ? [timestamp] : []
    }))
    const missingAfterWrite = targetEntries.filter((entry) => !verifiedTimestamps.has(entry.when))
    if (missingAfterWrite.length > 0) {
      throw new Error(
        `Baseline ledger verification failed; missing ${missingAfterWrite.map((entry) => entry.tag).join(", ")}.`,
      )
    }

    console.log(`\nBaseline complete. 'db:migrate' will now only apply migrations newer than ${throughEntry.tag}.`)
  } finally {
    await executor.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
