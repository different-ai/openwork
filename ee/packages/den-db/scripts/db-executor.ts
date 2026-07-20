/**
 * Shared query executor for den-db operational scripts (bootstrap, migrate hooks,
 * index backfills). Supports both a direct mysql2 connection (DATABASE_URL) and the
 * PlanetScale HTTP driver (DATABASE_HOST/USERNAME/PASSWORD), normalizing both to a
 * common `{ query, close }` shape.
 */

import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"

export type Executor = {
  query: (sql: string, args?: (string | number)[]) => Promise<Record<string, unknown>[]>
  close: () => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function recordsFromRows(rows: unknown): Record<string, unknown>[] {
  return Array.isArray(rows) ? rows.filter(isRecord) : []
}

export async function createExecutor(): Promise<Executor> {
  const databaseUrl = process.env.DATABASE_URL?.trim()

  if (databaseUrl) {
    const mysql = await import("mysql2/promise")
    const connection = await mysql.createConnection(parseMySqlConnectionConfig(databaseUrl))
    return {
      query: async (sql, args = []) => {
        const [rows] = await connection.query(sql, args)
        return recordsFromRows(rows)
      },
      close: () => connection.end(),
    }
  }

  const host = process.env.DATABASE_HOST?.trim()
  const username = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""

  if (!host || !username) {
    throw new Error("Provide DATABASE_URL, or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD.")
  }

  const { Client } = await import("@planetscale/database")
  const client = new Client({ host, username, password })
  return {
    query: async (sql, args = []) => {
      const result = await client.execute(sql, args)
      return recordsFromRows(result.rows)
    },
    close: async () => {},
  }
}
