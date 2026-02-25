import { drizzle } from "drizzle-orm/mysql2"
import type { FieldPacket, QueryOptions, QueryResult } from "mysql2"
import mysql from "mysql2/promise"
import { env } from "../env.js"
import * as schema from "./schema.js"

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

function isTransientDbConnectionError(error: unknown): boolean {
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

const client = mysql.createPool({
  uri: env.databaseUrl,
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
async function retryingQuery<T extends QueryResult>(
  options: QueryOptions,
  values: unknown,
): Promise<[T, FieldPacket[]]>
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
async function retryingExecute<T extends QueryResult>(
  options: QueryOptions,
  values: unknown,
): Promise<[T, FieldPacket[]]>
async function retryingExecute<T extends QueryResult>(
  sqlOrOptions: string | QueryOptions,
  values?: unknown,
): Promise<[T, FieldPacket[]]> {
  const sql = extractSql(sqlOrOptions)
  return retryReadQuery("execute", sql, () => execute<T>(sqlOrOptions as never, values as never))
}

client.execute = retryingExecute

export const db = drizzle(client, { schema, mode: "default" })
