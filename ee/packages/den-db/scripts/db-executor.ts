/**
 * Minimal SQL executor used by den-db operational scripts (bootstrap and
 * schema repairs). Depending on the environment it wraps either a direct
 * mysql2 connection (DATABASE_URL) or the PlanetScale HTTP driver
 * (DATABASE_HOST / DATABASE_USERNAME / DATABASE_PASSWORD), and exposes the
 * two operations the scripts need: run a parameterized query and close.
 */

import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"

export type Executor = {
  query: (sql: string, args?: (string | number)[]) => Promise<Record<string, unknown>[]>
  close: () => Promise<void>
}

function toRecordRows(rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return []
  const out: Record<string, unknown>[] = []
  for (const row of rows) {
    if (typeof row === "object" && row !== null) out.push(row as Record<string, unknown>)
  }
  return out
}

async function mysqlExecutor(databaseUrl: string): Promise<Executor> {
  const mysql = await import("mysql2/promise")
  const connection = await mysql.createConnection(parseMySqlConnectionConfig(databaseUrl))
  return {
    async query(statement, args = []) {
      const [rows] = await connection.query(statement, args)
      return toRecordRows(rows)
    },
    close: () => connection.end(),
  }
}

async function planetscaleExecutor(host: string, username: string, password: string): Promise<Executor> {
  const { Client } = await import("@planetscale/database")
  const client = new Client({ host, username, password })
  return {
    async query(statement, args = []) {
      const result = await client.execute(statement, args)
      return toRecordRows(result.rows)
    },
    async close() {},
  }
}

export async function createExecutor(): Promise<Executor> {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (databaseUrl) return mysqlExecutor(databaseUrl)

  const host = process.env.DATABASE_HOST?.trim()
  const username = process.env.DATABASE_USERNAME?.trim()
  const password = process.env.DATABASE_PASSWORD ?? ""
  if (!host || !username) {
    throw new Error("Provide DATABASE_URL, or DATABASE_HOST/DATABASE_USERNAME/DATABASE_PASSWORD.")
  }
  return planetscaleExecutor(host, username, password)
}
