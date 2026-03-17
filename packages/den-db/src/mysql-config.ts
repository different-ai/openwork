type ParsedMySqlConfig = {
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl?: {
    rejectUnauthorized: boolean
  }
}

function readSslSettings(parsed: URL) {
  const sslAccept = parsed.searchParams.get("sslaccept")?.trim().toLowerCase()
  const sslMode =
    parsed.searchParams.get("sslmode")?.trim().toLowerCase() ??
    parsed.searchParams.get("ssl-mode")?.trim().toLowerCase()

  const needsSsl = Boolean(sslAccept || sslMode)
  if (!needsSsl) {
    return undefined
  }

  const rejectUnauthorized =
    sslAccept === "strict" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full" ||
    sslMode === "require"

  return { rejectUnauthorized }
}

export function parseMySqlConnectionConfig(databaseUrl: string): ParsedMySqlConfig {
  const parsed = new URL(databaseUrl)
  const database = parsed.pathname.replace(/^\//, "")

  if (!parsed.hostname || !parsed.username || !database) {
    throw new Error("DATABASE_URL must include host, username, and database for mysql mode")
  }

  return {
    host: parsed.hostname,
    port: Number(parsed.port || "3306"),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    ssl: readSslSettings(parsed),
  }
}
