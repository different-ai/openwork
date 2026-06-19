/**
 * One-time baseline for databases that were previously managed with
 * `db:push` (state-based) and have no `__drizzle_migrations` table.
 *
 * Marks existing migrations as applied WITHOUT executing them, so a
 * subsequent `db:migrate` only runs migrations newer than the baseline.
 *
 * Usage:
 *   pnpm --filter @openwork-ee/den-db db:baseline              # dry run
 *   pnpm --filter @openwork-ee/den-db db:baseline -- --yes     # apply
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

const MIGRATIONS_TABLE = "__drizzle_migrations"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const drizzleDir = path.join(packageDir, "drizzle")

type JournalEntry = {
  idx: number
  when: number
  tag: string
}

type Executor = {
  query: (sql: string, args?: (string | number)[]) => Promise<Record<string, unknown>[]>
  close: () => Promise<void>
}

function parseArgs() {
  const args = process.argv.slice(2)
  const apply = args.includes("--yes")
  const throughIndex = args.indexOf("--through")
  const through = throughIndex >= 0 ? args[throughIndex + 1] : undefined
  return { apply, through }
}

async function createExecutor(): Promise<Executor> {
  const databaseUrl = process.env.DATABASE_URL?.trim()

  if (databaseUrl) {
    const mysql = await import("mysql2/promise")
    const connection = await mysql.createConnection(databaseUrl)
    return {
      query: async (sql, args = []) => {
        const [rows] = await connection.query(sql, args)
        return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
      },
      close: () => connection.end(),
    }
  }

  const host = process.env.DATABASE_HOST?.trim()
  const username = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""

  if (!host || !username) {
    throw new Error("Provide DATABASE_URL, or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD (see .env.example)")
  }

  const { Client } = await import("@planetscale/database")
  const client = new Client({ host, username, password })
  return {
    query: async (sql, args = []) => {
      const result = await client.execute(sql, args)
      return result.rows as Record<string, unknown>[]
    },
    close: async () => {},
  }
}

async function main() {
  const { apply, through } = parseArgs()

  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[]
  }
  const entries = [...journal.entries].sort((a, b) => a.when - b.when)

  if (entries.length === 0) {
    console.log("No migrations in journal; nothing to baseline.")
    return
  }

  const throughEntry = through ? entries.find((e) => e.tag === through) : entries[entries.length - 1]
  if (!throughEntry) {
    throw new Error(`--through tag "${through}" not found in drizzle/meta/_journal.json`)
  }

  const executor = await createExecutor()
  try {
    await executor.query(
      `create table if not exists \`${MIGRATIONS_TABLE}\` (id serial primary key, hash text not null, created_at bigint)`,
    )

    const rows = await executor.query(`select max(created_at) as latest from \`${MIGRATIONS_TABLE}\``)
    const latestRaw = rows[0]?.latest
    const latest = latestRaw == null ? 0 : Number(latestRaw)

    const pending = entries.filter((e) => e.when > latest && e.when <= throughEntry.when)

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

    if (!apply) {
      console.log("\nDry run. Re-run with --yes to record the baseline.")
      return
    }

    for (const entry of pending) {
      const sqlContents = readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8")
      const hash = crypto.createHash("sha256").update(sqlContents).digest("hex")
      await executor.query(`insert into \`${MIGRATIONS_TABLE}\` (hash, created_at) values (?, ?)`, [hash, entry.when])
      console.log(`Recorded ${entry.tag}`)
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
