import "./src/load-env.ts"
import { defineConfig } from "drizzle-kit"
import { parseMySqlConnectionConfig } from "./src/mysql-config.ts"

const databaseUrl = process.env.DATABASE_URL?.trim()

function isGenerateCommand() {
  return process.argv.some((arg) => arg === "generate")
}

function resolveDrizzleDbCredentials() {
  if (databaseUrl) {
    return parseMySqlConnectionConfig(databaseUrl)
  }

  const host = process.env.DATABASE_HOST?.trim()
  const user = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""
  const database = process.env.DATABASE_NAME?.trim()

  if (!host || !user || !database) {
    if (isGenerateCommand()) {
      return {
        host: "127.0.0.1",
        user: "root",
        password: "",
      }
    }

    throw new Error("Provide DATABASE_URL for mysql or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD/DATABASE_NAME for planetscale")
  }

  return {
    host,
    user,
    password,
    database,
    // PlanetScale requires TLS for MySQL-protocol connections.
    ssl: { rejectUnauthorized: true },
  }
}

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: resolveDrizzleDbCredentials(),
})
