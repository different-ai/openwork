import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const drizzleDir = path.resolve(__dirname, "..", "drizzle")

function splitStatements(sql) {
  return sql
    .split(/--> statement-breakpoint/g)
    .map((part) => part.trim())
    .filter(Boolean)
}

async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS __den_migrations (
      id varchar(255) NOT NULL PRIMARY KEY,
      applied_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

async function appliedMigrations(connection) {
  const [rows] = await connection.query("SELECT id FROM __den_migrations")
  return new Set(rows.map((row) => row.id))
}

function connectionConfigFromEnv() {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl) {
    return databaseUrl
  }

  const host = process.env.DATABASE_HOST?.trim()
  const user = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""

  if (!host || !user) {
    throw new Error("DATABASE_URL or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD is required")
  }

  return {
    host,
    user,
    password,
    ssl: {
      rejectUnauthorized: true,
    },
  }
}

async function run() {
  const connection = await mysql.createConnection(connectionConfigFromEnv())

  try {
    await ensureMigrationsTable(connection)
    const completed = await appliedMigrations(connection)
    const files = (await readdir(drizzleDir))
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right))

    for (const file of files) {
      if (completed.has(file)) {
        continue
      }

      const sql = await readFile(path.join(drizzleDir, file), "utf8")
      const statements = splitStatements(sql)

      for (const statement of statements) {
        await connection.query(statement)
      }

      await connection.query("INSERT INTO __den_migrations (id) VALUES (?)", [file])
      process.stdout.write(`[den] Applied migration ${file}\n`)
    }
  } finally {
    await connection.end()
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
