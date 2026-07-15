import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const drizzleDir = path.join(packageDir, "drizzle")
const runtimeDir = path.join(packageDir, "dist", "migration-runtime")
const sqlDir = path.join(runtimeDir, "sql")
const journalPath = path.join(drizzleDir, "meta", "_journal.json")

function fail(message) {
  console.error(`[den-db] migration runtime build failed: ${message}`)
  process.exit(1)
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex")
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageDir,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  })

  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr || result.stdout || "")
    }
    fail(`${command} ${args.join(" ")} exited with ${result.status ?? "no status"}`)
  }

  return result.stdout || ""
}

function splitExportedSql(sql) {
  const statements = []
  let start = 0
  let quote = null
  let escaped = false

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]

    if (escaped) {
      escaped = false
      continue
    }

    if (quote) {
      if (character === "\\" && quote !== "`") {
        escaped = true
      } else if (character === quote) {
        if (sql[index + 1] === quote && quote !== "`") {
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character
      continue
    }

    if (character === ";") {
      const statement = sql.slice(start, index + 1).trim()
      if (statement) {
        statements.push(statement)
      }
      start = index + 1
    }
  }

  const remainder = sql.slice(start).trim()
  if (remainder) {
    statements.push(remainder)
  }

  return statements
}

function extractBootstrapSql(exportOutput) {
  const firstStatement = exportOutput.indexOf("CREATE TABLE")
  if (firstStatement < 0) {
    fail("drizzle-kit export did not emit a CREATE TABLE statement")
  }

  const statements = splitExportedSql(exportOutput.slice(firstStatement))
  if (statements.length === 0) {
    fail("drizzle-kit export emitted an empty schema")
  }

  return `${statements.join("\n--> statement-breakpoint\n")}\n`
}

function collectMatches(pattern, input, map) {
  const values = []
  for (const match of input.matchAll(pattern)) {
    values.push(map(match))
  }
  return values
}

const journalValue = JSON.parse(readFileSync(journalPath, "utf8"))
if (!journalValue || !Array.isArray(journalValue.entries) || journalValue.entries.length === 0) {
  fail("drizzle/meta/_journal.json has no migration entries")
}

rmSync(runtimeDir, { recursive: true, force: true })

run("pnpm", [
  "exec",
  "tsup",
  "scripts/migration-runtime/runner.ts",
  "--format",
  "esm",
  "--platform",
  "node",
  "--target",
  "node22",
  "--out-dir",
  "dist/migration-runtime",
  "--no-config",
])

const exportOutput = run(
  process.execPath,
  ["--import", "tsx", "./node_modules/drizzle-kit/bin.cjs", "export", "--config", "drizzle.config.ts"],
  {
    capture: true,
    env: {
      DB_MODE: "mysql",
      DATABASE_URL: "mysql://migration-artifact:unused@127.0.0.1:3306/openwork_artifact",
    },
  },
)
const bootstrapSql = extractBootstrapSql(exportOutput)

mkdirSync(sqlDir, { recursive: true })
writeFileSync(path.join(sqlDir, "bootstrap.sql"), bootstrapSql)

const tables = collectMatches(/^CREATE TABLE `([^`]+)`/gm, bootstrapSql, (match) => match[1])
const indexes = collectMatches(
  /^CREATE (?:UNIQUE )?INDEX `([^`]+)` ON `([^`]+)`/gm,
  bootstrapSql,
  (match) => ({ name: match[1], table: match[2] }),
)

const migrations = journalValue.entries.map((entry) => {
  if (
    !entry ||
    typeof entry.idx !== "number" ||
    typeof entry.when !== "number" ||
    typeof entry.tag !== "string"
  ) {
    fail("drizzle/meta/_journal.json contains an invalid entry")
  }

  const file = `${entry.tag}.sql`
  const sql = readFileSync(path.join(drizzleDir, file), "utf8")
  writeFileSync(path.join(sqlDir, file), sql)

  return {
    idx: entry.idx,
    createdAt: entry.when,
    tag: entry.tag,
    file: `sql/${file}`,
    sha256: sha256(sql),
  }
})

const schemaVersion = migrations[migrations.length - 1].tag
const manifest = {
  formatVersion: 1,
  dialect: "mysql",
  schemaVersion,
  journalVersion: String(journalValue.version ?? "unknown"),
  bootstrap: {
    file: "sql/bootstrap.sql",
    sha256: sha256(bootstrapSql),
    tables: [...tables].sort(),
    indexes: [...indexes].sort((left, right) => `${left.table}.${left.name}`.localeCompare(`${right.table}.${right.name}`)),
  },
  requiredIndexes: [
    {
      name: "memory_content_fulltext",
      table: "memory",
      columns: ["content"],
      kind: "FULLTEXT",
    },
  ],
  migrations,
}

writeFileSync(path.join(runtimeDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[den-db] built immutable migration runtime for ${schemaVersion} (${migrations.length} migrations)`)
