import { sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { db } from "../db.js"

export type Row = Record<string, unknown>
export type Rows = (query: SQL) => Promise<Row[]>

export function normalizeRows(result: unknown): Row[] {
  if (Array.isArray(result)) {
    const first: unknown = result[0]
    if (Array.isArray(first)) {
      return first as Row[]
    }
    return result as Row[]
  }
  if (typeof result === "object" && result !== null && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Row[] }).rows
  }
  return []
}

export const dbRows: Rows = async (query) => normalizeRows(await (db.$replicas[0] ?? db).execute(query))

const STATEMENT_TIME_LIMIT_MS = 120_000
export const SELECT = sql.raw(`SELECT /*+ MAX_EXECUTION_TIME(${STATEMENT_TIME_LIMIT_MS}) */ /*vt+ QUERY_TIMEOUT_MS=${STATEMENT_TIME_LIMIT_MS} */`)

export const TASK_EVENT = sql.raw(`t.event_type IN ('task.started', 'task.completed', 'task.failed') AND t.session_id IS NOT NULL AND t.source = 'app'`)
export const HUMAN_MEMBER = sql.raw(`m.user_id IS NOT NULL AND m.is_setup_agent = 0 AND m.removed_at IS NULL`)

export function inList(values: readonly string[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `)
}
