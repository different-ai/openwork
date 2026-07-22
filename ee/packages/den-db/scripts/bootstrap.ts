/**
 * Production install/upgrade entrypoint for Den databases.
 *
 * Empty databases are initialized from the build-time current-schema snapshot,
 * then committed migrations are recorded as the baseline. Existing databases
 * without a migration ledger are baselined before the normal migration pass.
 */
import "../src/load-env.ts"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/mysql2"
import { migrate } from "drizzle-orm/mysql2/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import mysql from "mysql2/promise"
import { ensureFulltextIndexes } from "../src/fulltext.ts"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"
import { ensureSchemaRepairs } from "../src/schema-repairs.ts"
import { createExecutor, type Executor } from "./db-executor.ts"

const MIGRATIONS_TABLE = "__drizzle_migrations"

const scriptPath = fileURLToPath(import.meta.url)
const distDir = path.resolve(path.dirname(scriptPath), "..")
const migrationsFolder = path.join(distDir, "drizzle")
const currentSchemaPath = path.join(distDir, "current-schema.sql")

function mysqlConnectionConfigFromEnv(): ReturnType<typeof parseMySqlConnectionConfig> {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl) {
    return parseMySqlConnectionConfig(databaseUrl)
  }

  const host = process.env.DATABASE_HOST?.trim()
  const user = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""
  const database = process.env.DATABASE_NAME?.trim()
  const portValue = process.env.DATABASE_PORT?.trim()
  const port = portValue ? Number(portValue) : 3306

  if (!host || !user || !database) {
    throw new Error("Provide DATABASE_URL, or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD/DATABASE_NAME.")
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("DATABASE_PORT must be a positive integer")
  }

  return {
    host,
    port,
    user,
    password,
    database,
    ssl: { rejectUnauthorized: true },
  }
}

function splitSqlStatements(sql: string) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
}

async function applyCurrentSchema(executor: Executor) {
  const statements = splitSqlStatements(readFileSync(currentSchemaPath, "utf8"))
  if (statements.length === 0) {
    throw new Error(`No SQL statements found in ${currentSchemaPath}`)
  }

  for (const statement of statements) {
    await executor.query(statement)
  }
}

async function listTables(executor: Executor) {
  const rows = await executor.query("show tables")
  return rows
    .map((row) => Object.values(row).find((value) => typeof value === "string"))
    .filter((value): value is string => Boolean(value))
}

function latestMigrationMillis(rows: Record<string, unknown>[]) {
  const latest = rows[0]?.latest
  if (typeof latest === "number") {
    return latest
  }
  if (typeof latest === "bigint") {
    return Number(latest)
  }
  if (typeof latest === "string") {
    const parsed = Number(latest)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

async function baselineCommittedMigrations(executor: Executor) {
  const migrations = readMigrationFiles({ migrationsFolder }).sort((left, right) => left.folderMillis - right.folderMillis)

  await executor.query(
    `create table if not exists \`${MIGRATIONS_TABLE}\` (id serial primary key, hash text not null, created_at bigint)`,
  )

  const rows = await executor.query(`select max(created_at) as latest from \`${MIGRATIONS_TABLE}\``)
  const latest = latestMigrationMillis(rows)
  const pending = migrations.filter((migration) => migration.folderMillis > latest)

  if (pending.length === 0) {
    console.log("[den-db] migration baseline already current")
    return
  }

  console.log(`[den-db] recording ${pending.length} committed migrations as baseline`)
  for (const migration of pending) {
    await executor.query(`insert into \`${MIGRATIONS_TABLE}\` (hash, created_at) values (?, ?)`, [
      migration.hash,
      migration.folderMillis,
    ])
  }
}

async function runCommittedMigrations() {
  const connection = await mysql.createConnection(mysqlConnectionConfigFromEnv())
  try {
    const db = drizzle(connection)
    await migrate(db, { migrationsFolder })
  } finally {
    await connection.end()
  }
}

export async function bootstrapDenDb() {
  const executor = await createExecutor()
  try {
    const tables = await listTables(executor)
    const applicationTables = tables.filter((table) => table !== MIGRATIONS_TABLE)

    if (applicationTables.length === 0) {
      console.log("[den-db] empty database detected; applying current schema snapshot")
      await applyCurrentSchema(executor)
      await baselineCommittedMigrations(executor)
    } else if (!tables.includes(MIGRATIONS_TABLE)) {
      console.log("[den-db] existing schema without migration ledger detected; recording baseline")
      await baselineCommittedMigrations(executor)
    }
  } finally {
    await executor.close()
  }

  console.log("[den-db] running committed migrations")
  await runCommittedMigrations()

  console.log("[den-db] ensuring FULLTEXT indexes")
  const indexExecutor = await createExecutor()
  try {
    await ensureFulltextIndexes(indexExecutor)
    console.log("[den-db] ensuring schema repairs")
    await ensureSchemaRepairs(indexExecutor)
  } finally {
    await indexExecutor.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  bootstrapDenDb().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
