type ParsedMySqlConfig = {
  host: string
  port: number
  user: string
  password: string
  database: string
  // Unix socket path for the MySQL connection (e.g. Cloud SQL's
  // `/cloudsql/<project>:<region>:<instance>`). When set, `mysql2` ignores
  // `host`/`port` and connects via the socket.
  socketPath?: string
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

function readSocketPath(parsed: URL): string | undefined {
  const value =
    parsed.searchParams.get("socketPath")?.trim() ||
    parsed.searchParams.get("socket")?.trim() ||
    ""
  return value || undefined
}

export function parseMySqlConnectionConfig(databaseUrl: string): ParsedMySqlConfig {
  const parsed = new URL(databaseUrl)
  const database = parsed.pathname.replace(/^\//, "")

  if (!parsed.hostname || !parsed.username || !database) {
    throw new Error("DATABASE_URL must include host, username, and database for mysql mode")
  }

  const socketPath = readSocketPath(parsed)

  return {
    host: parsed.hostname,
    port: Number(parsed.port || "3306"),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    ...(socketPath ? { socketPath } : {}),
    ssl: readSslSettings(parsed),
  }
}
