import { z } from "zod"
import type { SqlDriver } from "../sql.js"

/**
 * What Den's content-free session index learns about one session: totals and state, never content, and no id beyond
 * the session id (Den takes org, member and kind from the capability). Sent by the Den-index flusher (den-index.ts).
 */
export const indexFieldsSchema = z
  .object({
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    /** Bytes of the session's transcript and prompts in the hot database. */
    hotBytes: z.number(),
    segmentCount: z.number(),
    /** Hot bytes plus sealed segments, large bodies and kept files, as stored. */
    totalBytes: z.number(),
    /** When the session's oldest running turn started; null while none runs (Den spots stuck turns with it). */
    activeTurnSince: z.number().nullable(),
    deleted: z.boolean(),
  })
  .strict()
export type IndexFields = z.infer<typeof indexFieldsSchema>

export type PendingIndexUpdate = { sessionId: string; version: number; capability: string | null; fields: IndexFields }

/** A size step: an index update every time a session's hot bytes cross a multiple of this. */
export const INDEX_SIZE_STEP_BYTES = 1024 * 1024

const sessionRow = z.object({
  title: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  hot_bytes: z.number().nullable(),
  index_capability: z.string().nullable(),
  index_version: z.number().nullable(),
})
const numberRow = z.object({ n: z.number().nullable() })
const sumOf = (db: SqlDriver, sql: string, ...params: string[]) => numberRow.parse(db.prepare(sql).get(...params)).n ?? 0

/** The session's index fields now, or null when it doesn't exist. */
export function indexFieldsOf(db: SqlDriver, sessionId: string): { fields: IndexFields; capability: string | null; version: number } | null {
  const row = db.prepare("SELECT title, created_at, updated_at, hot_bytes, index_capability, index_version FROM sessions WHERE id = ?").get(sessionId)
  if (!row) return null
  const session = sessionRow.parse(row)
  const hotBytes = session.hot_bytes ?? 0
  const segmentCount = sumOf(db, "SELECT COUNT(*) AS n FROM segments WHERE session_id = ?", sessionId)
  const segmentBytes = sumOf(db, "SELECT SUM(bytes) AS n FROM segments WHERE session_id = ?", sessionId)
  const bodyBytes = sumOf(db, "SELECT SUM(bytes) AS n FROM (SELECT DISTINCT storage_key, bytes FROM large_bodies WHERE session_id = ?)", sessionId)
  const savedBytes = sumOf(db, "SELECT SUM(size) AS n FROM saved_files WHERE session_id = ?", sessionId)
  const active = numberRow.parse(db.prepare("SELECT MIN(updated_at) AS n FROM turns WHERE session_id = ? AND status = 'running'").get(sessionId)).n
  return {
    fields: {
      title: session.title,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      hotBytes,
      segmentCount,
      totalBytes: hotBytes + segmentBytes + bodyBytes + savedBytes,
      activeTurnSince: active,
      deleted: false,
    },
    capability: session.index_capability,
    version: session.index_version ?? 0,
  }
}

const outboxVersion = (db: SqlDriver, sessionId: string) => numberRow.parse(db.prepare("SELECT MAX(version) AS n FROM index_outbox WHERE session_id = ?").get(sessionId)).n ?? 0

/**
 * Replaces the session's pending index update with a fresh snapshot (one row per session, the latest; its version
 * only grows). Call inside the transaction that made the change. With `deleted`, call before the session's rows go:
 * the row keeps the session's capability, which goes with them.
 */
export function enqueueIndexUpdate(db: SqlDriver, sessionId: string, now: number, options: { deleted?: boolean } = {}) {
  const current = indexFieldsOf(db, sessionId)
  if (!current) return
  const version = Math.max(current.version, outboxVersion(db, sessionId)) + 1
  db.prepare("UPDATE sessions SET index_version = ? WHERE id = ?").run(version, sessionId)
  // A deleted session's last word keeps no title: nothing of what it held stays in the index.
  const fields: IndexFields = options.deleted
    ? { ...current.fields, title: "", hotBytes: 0, segmentCount: 0, totalBytes: 0, activeTurnSince: null, deleted: true, updatedAt: now }
    : current.fields
  // A row already waiting keeps its attempt count and retry time (a Den outage is not hammered by every change) and
  // the time it was first queued (rows waiting longer than a week are dropped).
  db.prepare(
    `INSERT INTO index_outbox (session_id, version, fields, attempt, next_attempt_at, created_at, capability) VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET version = excluded.version, fields = excluded.fields, capability = COALESCE(excluded.capability, index_outbox.capability)`,
  ).run(sessionId, version, JSON.stringify(indexFieldsSchema.parse(fields)), now, now, options.deleted ? current.capability : null)
}

export function setIndexCapability(db: SqlDriver, sessionId: string, capability: string) {
  db.prepare("UPDATE sessions SET index_capability = ? WHERE id = ?").run(capability, sessionId)
}

const CAPABILITY = "COALESCE(sessions.index_capability, index_outbox.capability)"
const pendingRow = z.object({ session_id: z.string(), version: z.number(), fields: z.string(), capability: z.string().nullable() })

/** Due updates, those with a capability first (only they can be sent). */
export function pendingIndexUpdates(db: SqlDriver, now: number, limit: number): PendingIndexUpdate[] {
  const rows = db
    .prepare(
      `SELECT index_outbox.session_id, index_outbox.version, index_outbox.fields, ${CAPABILITY} AS capability
       FROM index_outbox LEFT JOIN sessions ON sessions.id = index_outbox.session_id
       WHERE index_outbox.next_attempt_at <= ? ORDER BY (${CAPABILITY} IS NULL), index_outbox.next_attempt_at LIMIT ?`,
    )
    .all(now, limit)
  return rows.flatMap((row) => {
    const value = pendingRow.safeParse(row)
    if (!value.success) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(value.data.fields)
    } catch {
      return []
    }
    const fields = indexFieldsSchema.safeParse(parsed)
    return fields.success ? [{ sessionId: value.data.session_id, version: value.data.version, capability: value.data.capability, fields: fields.data }] : []
  })
}

export function ackIndexUpdate(db: SqlDriver, sessionId: string, version: number) {
  db.prepare("DELETE FROM index_outbox WHERE session_id = ? AND version = ?").run(sessionId, version)
}

export function deferIndexUpdate(db: SqlDriver, sessionId: string, version: number, retryAt: number) {
  db.prepare("UPDATE index_outbox SET attempt = attempt + 1, next_attempt_at = ? WHERE session_id = ? AND version = ?").run(retryAt, sessionId, version)
}

/**
 * When the next sendable update is due. Rows without a capability (Den's index is off for the session's org, or no
 * turn brought one yet) don't count: they can't be sent, so they would only keep waking the cell; they are dropped
 * after a week (dropIndexUpdatesBefore) or picked up once a capability arrives.
 */
export function nextIndexUpdateAt(db: SqlDriver): number | null {
  return numberRow.parse(
    db.prepare(`SELECT MIN(index_outbox.next_attempt_at) AS n FROM index_outbox LEFT JOIN sessions ON sessions.id = index_outbox.session_id WHERE ${CAPABILITY} IS NOT NULL`).get(),
  ).n
}

export function dropIndexUpdatesBefore(db: SqlDriver, createdBefore: number): number {
  return db.prepare("DELETE FROM index_outbox WHERE created_at < ?").run(createdBefore).changes
}

/** A fresh snapshot of every session (daily reconciliation). Call inside a transaction. */
export function indexSnapshotAll(db: SqlDriver, now: number) {
  const ids = db
    .prepare("SELECT id FROM sessions ORDER BY rowid")
    .all()
    .flatMap((row) => {
      const value = z.object({ id: z.string() }).safeParse(row)
      return value.success ? [value.data.id] : []
    })
  for (const id of ids) enqueueIndexUpdate(db, id, now)
}
