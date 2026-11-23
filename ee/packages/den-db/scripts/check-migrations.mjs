import { execFileSync, spawnSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { readMigrationFiles } from "drizzle-orm/migrator"

// Generation compares against snapshots. A snapshot alone must not satisfy the check.
const migrations = readMigrationFiles({ migrationsFolder: "drizzle" })
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"))
const journalPrefixes = new Set(journal.entries.map(({ tag }) => tag.split("_")[0]))
for (const name of readdirSync("drizzle/meta")) {
  if (name.endsWith("_snapshot.json") && !journalPrefixes.has(name.split("_")[0])) {
    throw new Error(`No migration journal entry for ${name}`)
  }
}

// A noninteractive rename prompt or an early Drizzle error can exit without writing files.
const result = spawnSync(process.execPath, [process.env.npm_execpath, "run", "db:generate"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
})
if (result.error) throw result.error
process.stdout.write(result.stdout)
if (result.status !== 0 || !/^No schema changes, nothing to migrate\b/m.test(result.stdout)) {
  process.stderr.write("Run pnpm --dir ee/packages/den-db db:generate and commit the generated SQL and metadata.\n")
  process.exit(1)
}
const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "drizzle"], { encoding: "utf8" })
if (changes) {
  process.stderr.write(`Commit the migration files before checking:\n${changes}`)
  process.exit(1)
}
process.stdout.write(`Schema is in sync with ${migrations.length} journaled migrations.\n`)
