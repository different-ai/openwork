import { Client } from "@planetscale/database"
import { drizzle } from "drizzle-orm/mysql2"
import { drizzle as drizzlePlanetScale } from "drizzle-orm/planetscale-serverless"
import type { FieldPacket, QueryOptions, QueryResult } from "mysql2"
import mysql from "mysql2/promise"
import { parseMySqlConnectionConfig } from "./mysql-config"
import * as schema from "./schema"
import { createRetryingPlanetScaleFetch, retryReadQuery } from "./transient-retry"

export { isTransientDbConnectionError } from "./transient-retry"

export type DenDbMode = "mysql" | "planetscale"
type DenDb = ReturnType<typeof drizzlePlanetScale>
export type PlanetScaleCredentials = {
  host: string
  username: string
  password: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
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

export function createDenDb(input: {
  databaseUrl?: string | null
  mode?: DenDbMode
  planetscale?: PlanetScaleCredentials | null
}) {
  const mode = resolveDbMode(input)

  if (mode === "planetscale") {
    const credentials = input.planetscale ?? (input.databaseUrl ? parsePlanetScaleConfigFromDatabaseUrl(input.databaseUrl) : null)
    if (!credentials) {
      throw new Error("PlanetScale mode requires DATABASE_HOST, DATABASE_USERNAME, and DATABASE_PASSWORD")
    }

    const client = new Client({ ...credentials, fetch: createRetryingPlanetScaleFetch() })
    return {
      client,
      db: drizzlePlanetScale(client, { schema }) as unknown as DenDb,
    }
  }

  if (!input.databaseUrl) {
    throw new Error("MySQL mode requires DATABASE_URL")
  }

  const client = mysql.createPool({
    ...parseMySqlConnectionConfig(input.databaseUrl),
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
    const sql = extractSql(sqlOrOptions)
    return retryReadQuery("query", sql, () => query<T>(sqlOrOptions as never, values as never))
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
    const sql = extractSql(sqlOrOptions)
    return retryReadQuery("execute", sql, () => execute<T>(sqlOrOptions as never, values as never))
  }

  client.execute = retryingExecute

  return {
    client,
    db: drizzle(client, { schema, mode: "default" }) as unknown as DenDb,
  }
}
