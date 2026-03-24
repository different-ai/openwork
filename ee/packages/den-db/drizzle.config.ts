import "./src/load-env.ts"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "drizzle-kit"
import { parseMySqlConnectionConfig } from "./src/mysql-config.ts"

const currentDir = path.dirname(fileURLToPath(import.meta.url))

const databaseUrl = process.env.DATABASE_URL?.trim()

function resolveDrizzleDbCredentials() {
  if (databaseUrl) {
    return parseMySqlConnectionConfig(databaseUrl)
  }

  const host = process.env.DATABASE_HOST?.trim()
  const user = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""

  if (!host || !user) {
    throw new Error("Provide DATABASE_URL for mysql or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD for planetscale")
  }

  return {
    host,
    user,
    password,
  }
}

export default defineConfig({
  dialect: "mysql",
  schema: path.join(currentDir, "src", "schema.ts"),
  out: path.join(currentDir, "..", "..", "apps", "den-controller", "drizzle"),
  dbCredentials: resolveDrizzleDbCredentials(),
})
