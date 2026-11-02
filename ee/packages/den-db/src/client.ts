import { Client } from "@planetscale/database"
import { createRetryingPlanetScaleFetch } from "./transient-retry"
import { drizzle } from "drizzle-orm/mysql2"
import { drizzle as drizzlePlanetScale } from "drizzle-orm/planetscale-serverless"
import { withReplicas, type MySQLWithReplicas } from "drizzle-orm/mysql-core"
import type { FieldPacket, QueryOptions, QueryResult } from "mysql2"
import mysql from "mysql2/promise"
import { parseMySqlConnectionConfig } from "./mysql-config"
import * as schema from "./schema"
import type { Logger } from "drizzle-orm/logger"

export type DenDbMode = "mysql" | "planetscale"
type DenPrimaryDb = ReturnType<typeof drizzlePlanetScale<typeof schema>>
/**
 * Reads (`select`, `selectDistinct`, `$count`, `with`, `query`) go to a read
 * replica when one is configured; writes, `execute` and transactions always go
 * to the primary. Use `db.$primary` for a read that must see a write made
 * moments earlier. Without replica credentials both sides are the primary.
 */
export type DenDb = MySQLWithReplicas<DenPrimaryDb>
export type PlanetScaleCredentials = {
  host: string
  username: string
  password: string
}
/** Read-only credentials for the same database host, routed to its replicas. */
export type ReadReplicaCredentials = {
  username: string
  password: string
}

/**
 * Reads DATABASE_READ_USERNAME / DATABASE_READ_PASSWORD. Both must be set;
 * otherwise reads keep using the primary credentials (self-hosted and
 * single-credential deployments need nothing new).
 */
export function readReplicaCredentialsFromEnv(source: { DATABASE_READ_USERNAME?: string; DATABASE_READ_PASSWORD?: string }): ReadReplicaCredentials | null {
  const username = source.DATABASE_READ_USERNAME?.trim()
  const password = source.DATABASE_READ_PASSWORD?.trim()
  if (username && password) return { username, password }
  if (username || password) {
    console.warn("[db] only one of DATABASE_READ_USERNAME / DATABASE_READ_PASSWORD is set; reads will use the primary")
  }
  return null
}

const TRANSIENT_DB_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
])

const RETRYABLE_QUERY_PREFIXES = ["select", "show", "describe", "explain"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getErrorCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null
  }

  if (typeof error.code === "string") {
    return error.code
  }

  return getErrorCode(error.cause)
}

export function isTransientDbConnectionError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (!code) {
    return false
  }
  return TRANSIENT_DB_ERROR_CODES.has(code)
}

function extractSql(value: unknown): string | null {
  if (typeof value === "string") {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  if (typeof value.sql === "string") {
    return value.sql
  }

  return null
}

function isRetryableReadQuery(sql: string | null): boolean {
  if (!sql) {
    return false
  }

  const normalized = sql.trimStart().toLowerCase()
  return RETRYABLE_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * MariaDB does not parse the SQL-standard `FOR SHARE` that drizzle emits for
 * `.for("share")`; it only knows `LOCK IN SHARE MODE`, which MySQL 8 still
 * accepts as an alias. Rewriting the trailing clause keeps one spelling that
 * both engines run (self-hosted Den images and the Daytona server snapshot ship
 * MariaDB) without touching every locking read.
 */
export function rewriteShareLock(sql: string): string {
  // Trim first so the match itself has no ambiguous trailing quantifiers.
  const statement = sql.trimEnd().replace(/;$/, "").trimEnd()
  const match = /\bfor\s+share$/i.exec(statement)
  return match ? `${statement.slice(0, match.index)}lock in share mode` : sql
}

function rewriteQueryInput(input: string): string
function rewriteQueryInput(input: QueryOptions): QueryOptions
function rewriteQueryInput(input: string | QueryOptions): string | QueryOptions
function rewriteQueryInput(input: string | QueryOptions): string | QueryOptions {
  if (typeof input === "string") return rewriteShareLock(input)
  return { ...input, sql: rewriteShareLock(input.sql) }
}

type QueryRunner = <T extends QueryResult>(sqlOrOptions: string | QueryOptions, values?: unknown) => Promise<[T, FieldPacket[]]>

/** Drizzle runs transaction statements on a checked-out connection, so pooled connections need the same rewrite. */
function rewriteConnectionQueries(connection: mysql.PoolConnection): mysql.PoolConnection {
  if (rewrittenConnections.has(connection)) return connection
  rewrittenConnections.add(connection)
  const query = connection.query.bind(connection) as QueryRunner
  const execute = connection.execute.bind(connection) as QueryRunner
  connection.query = ((sqlOrOptions: string | QueryOptions, values?: unknown) => query(rewriteQueryInput(sqlOrOptions), values)) as typeof connection.query
  connection.execute = ((sqlOrOptions: string | QueryOptions, values?: unknown) => execute(rewriteQueryInput(sqlOrOptions), values)) as typeof connection.execute
  return connection
}

const rewrittenConnections = new WeakSet<mysql.PoolConnection>()

async function retryReadQuery<T>(label: "query" | "execute", sql: string | null, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!isRetryableReadQuery(sql) || !isTransientDbConnectionError(error)) {
      throw error
    }

    const queryType = sql?.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "QUERY"
    console.warn(`[db] transient mysql error on ${label} (${queryType}); retrying once`)
    return run()
  }
}

function parsePlanetScaleConfigFromDatabaseUrl(databaseUrl: string): PlanetScaleCredentials {
  const parsed = new URL(databaseUrl)
  if (!parsed.hostname || !parsed.username) {
    throw new Error("DATABASE_URL must include host and username when DB_MODE=planetscale")
  }

  return {
    host: parsed.hostname,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  }
}

function resolveDbMode(input: { mode?: DenDbMode; databaseUrl?: string | null }): DenDbMode {
  if (input.mode) {
    return input.mode
  }

  return input.databaseUrl ? "mysql" : "planetscale"
}

function createMySqlPool(config: mysql.PoolOptions) {
  const client = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60_000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  })

  const query = client.query.bind(client)

  async function retryingQuery<T extends QueryResult>(sql: string): Promise<[T, FieldPacket[]]>
  async function retryingQuery<T extends QueryResult>(sql: string, values: unknown): Promise<[T, FieldPacket[]]>
  async function retryingQuery<T extends QueryResult>(options: QueryOptions): Promise<[T, FieldPacket[]]>
  async function retryingQuery<T extends QueryResult>(options: QueryOptions, values: unknown): Promise<[T, FieldPacket[]]>
  async function retryingQuery<T extends QueryResult>(
    sqlOrOptions: string | QueryOptions,
    values?: unknown,
  ): Promise<[T, FieldPacket[]]> {
    const rewritten = rewriteQueryInput(sqlOrOptions)
    const sql = extractSql(rewritten)
    return retryReadQuery("query", sql, () => query<T>(rewritten as never, values as never))
  }

  client.query = retryingQuery

  const execute = client.execute.bind(client)

  async function retryingExecute<T extends QueryResult>(sql: string): Promise<[T, FieldPacket[]]>
  async function retryingExecute<T extends QueryResult>(sql: string, values: unknown): Promise<[T, FieldPacket[]]>
  async function retryingExecute<T extends QueryResult>(options: QueryOptions): Promise<[T, FieldPacket[]]>
  async function retryingExecute<T extends QueryResult>(options: QueryOptions, values: unknown): Promise<[T, FieldPacket[]]>
  async function retryingExecute<T extends QueryResult>(
    sqlOrOptions: string | QueryOptions,
    values?: unknown,
  ): Promise<[T, FieldPacket[]]> {
    const rewritten = rewriteQueryInput(sqlOrOptions)
    const sql = extractSql(rewritten)
    return retryReadQuery("execute", sql, () => execute<T>(rewritten as never, values as never))
  }

  client.execute = retryingExecute

  const getConnection = client.getConnection.bind(client)
  client.getConnection = async () => rewriteConnectionQueries(await getConnection())

  return client
}

export function createDenDb(input: {
  databaseUrl?: string | null
  mode?: DenDbMode
  planetscale?: PlanetScaleCredentials | null
  /** Optional replica credentials for the same host; reads use the primary when absent. */
  readReplica?: ReadReplicaCredentials | null
  logger?: Logger
}) {
  const mode = resolveDbMode(input)
  const readReplica = input.readReplica ?? null

  if (mode === "planetscale") {
    const credentials = input.planetscale ?? (input.databaseUrl ? parsePlanetScaleConfigFromDatabaseUrl(input.databaseUrl) : null)
    if (!credentials) {
      throw new Error("PlanetScale mode requires DATABASE_HOST, DATABASE_USERNAME, and DATABASE_PASSWORD")
    }

    const client = new Client({ ...credentials, fetch: createRetryingPlanetScaleFetch() })
    const primary: DenPrimaryDb = drizzlePlanetScale(client, { schema, logger: input.logger })
    const readClient = readReplica
      ? new Client({ host: credentials.host, ...readReplica, fetch: createRetryingPlanetScaleFetch() })
      : null
    const replica: DenPrimaryDb = readClient ? drizzlePlanetScale(readClient, { schema, logger: input.logger }) : primary
    return { client, readClient, db: withReplicas(primary, [replica]) }
  }

  if (!input.databaseUrl) {
    throw new Error("MySQL mode requires DATABASE_URL")
  }

  const connection = parseMySqlConnectionConfig(input.databaseUrl)
  const client = createMySqlPool(connection)
  const readClient = readReplica
    ? createMySqlPool({ ...connection, user: readReplica.username, password: readReplica.password })
    : null
  // Both drivers expose the same MySqlDatabase query surface; Den types `db` as the PlanetScale flavour.
  const primary = drizzle(client, { schema, mode: "default", logger: input.logger }) as unknown as DenPrimaryDb
  const replica = readClient
    ? (drizzle(readClient, { schema, mode: "default", logger: input.logger }) as unknown as DenPrimaryDb)
    : primary
  return { client, readClient, db: withReplicas(primary, [replica]) }
}
