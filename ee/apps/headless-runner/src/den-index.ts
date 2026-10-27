import { z } from "zod"
import type { BackgroundJob } from "./background.js"
import type { ErrorReporter } from "./error-reporting.js"
import type { IndexFields } from "./storage/index-outbox.js"

/**
 * The Den index flusher (background job `den-index`): sends the index outbox (storage/index-outbox.ts) to Den's
 * content-free session index, `POST {HEADLESS_DEN_API_URL}/v1/internal/headless/index`, with the runner's callback
 * token and each session's index capability (minted by Den with the session's turn tokens). Off unless HEADLESS_DEN_API_URL and HEADLESS_DEN_CALLBACK_TOKEN are set.
 *
 * - Only rows with a capability are sent, at most 50 per request. `ok` and `stale` are acknowledged; `rejected` rows
 *   are dropped, except `index_disabled` and `rate_limited`, which are kept and retried (`index_disabled` only comes from Dens from before the index was always on).
 * - Failures back off per row: immediately, 30 s, 2 min, 10 min, then hourly. A Den outage delays the index, never a
 *   turn: nothing here runs inside a turn.
 * - Rows older than 7 days are dropped (also those that never got a capability). Once a day the whole cell is
 *   snapshotted again (`indexSnapshotAll`) so Den's index converges after anything it missed.
 *
 * Never log or report a capability or any field value; reports carry codes only.
 */

export const DEN_INDEX_PATH = "/v1/internal/headless/index"
export const DEN_INDEX_BATCH = 50
/** Delay before the next try after the n-th failure in a row (n from 1); the last value repeats. */
export const DEN_INDEX_BACKOFF_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000] as const
export const DEN_INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const DEN_INDEX_SNAPSHOT_EVERY_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 10_000
/** Rows read per run: enough to fill several requests while rows without a capability are skipped. */
const READ_LIMIT = DEN_INDEX_BATCH * 4
/** Kept by the runner and sent again later; any other rejection is permanent for that row. */
const KEEP_ON_REJECTION = new Set(["index_disabled", "rate_limited"])

/** What the flusher needs of the store (the storage worker's outbox methods). */
export type IndexOutbox = {
  pendingIndexUpdates(now: number, limit: number): Array<{ sessionId: string; version: number; capability: string | null; fields: IndexFields; attempt?: number }>
  ackIndexUpdate(sessionId: string, version: number): void
  deferIndexUpdate(sessionId: string, version: number, retryAt: number): void
  nextIndexUpdateAt(): number | null
  dropIndexUpdatesBefore(createdBefore: number): number
  indexSnapshotAll(now: number): void
}

export type IndexUpdate = { capability: string; sessionId: string; version: number; fields: IndexFields }
export type IndexResult = { sessionId: string; version: number; status: "ok" | "stale" | "rejected"; error?: string }
export type IndexSendResult =
  | { ok: true; results: IndexResult[] }
  /** Den is busy or unreachable, or refused the whole request: keep every row and try again later. */
  | { ok: false; code: string; status?: number }
export type IndexSend = (updates: IndexUpdate[]) => Promise<IndexSendResult>

const resultSchema = z.object({
  sessionId: z.string(),
  version: z.number(),
  status: z.enum(["ok", "stale", "rejected"]),
  error: z.string().regex(/^[a-z_]{1,64}$/).optional(),
})
const responseSchema = z.object({ results: z.array(resultSchema) })

export function denIndexClient(input: { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number }): IndexSend {
  // A native Workers fetch needs its global receiver.
  const send = input.fetch ?? ((request, init) => fetch(request, init))
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return async (updates) => {
    let response: Response
    try {
      response = await send(`${input.url}${DEN_INDEX_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        body: JSON.stringify({ updates }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return { ok: false, code: "den_unreachable" }
    }
    const body: unknown = await response.json().catch(() => null)
    if (response.status !== 200) {
      // 401: wrong callback token; 404: not set up on Den (or an older Den); 400: the batch itself refused.
      const code = response.status === 401 ? "unauthorized" : response.status === 404 ? "not_configured" : `den_http_${response.status}`
      return { ok: false, code, status: response.status }
    }
    const parsed = responseSchema.safeParse(body)
    return parsed.success ? { ok: true, results: parsed.data.results } : { ok: false, code: "invalid_response", status: 200 }
  }
}

/** Delay after `failures` failures in a row (1 = the first failure: retried at once). */
export function denIndexBackoff(failures: number) {
  const index = Math.min(Math.max(failures, 1), DEN_INDEX_BACKOFF_MS.length) - 1
  return DEN_INDEX_BACKOFF_MS[index] ?? DEN_INDEX_BACKOFF_MS[DEN_INDEX_BACKOFF_MS.length - 1]
}

/**
 * The `den-index` background job. `attempt` comes from the outbox row when the store returns it; otherwise failures
 * in a row are counted here, per session, for the life of the process.
 */
export function denIndexJob(input: { outbox: IndexOutbox; send: IndexSend; errors?: Pick<ErrorReporter, "report">; now?: () => number }): BackgroundJob {
  const { outbox, send } = input
  const now = input.now ?? Date.now
  const failures = new Map<string, number>()
  const started = now()
  // Dropping old rows is one cheap delete: due at start (a cell may live only minutes), then daily.
  let nextDropAt = started
  let nextSnapshotAt = started + DEN_INDEX_SNAPSHOT_EVERY_MS

  // At most one report per code and reason per minute: a Den outage or a stale key is one alert, not one per row.
  const reported = new Map<string, number>()
  const report = (code: string, tags: { reason: string; status?: number }) => {
    const key = `${code}:${tags.reason}`
    const at = now()
    const last = reported.get(key)
    if (last !== undefined && at - last < 60_000) return
    reported.set(key, at)
    void Promise.resolve(input.errors?.report({ code, tags })).catch(() => undefined)
  }

  const defer = (update: { sessionId: string; version: number; attempt?: number }, at: number) => {
    const count = (update.attempt ?? failures.get(update.sessionId) ?? 0) + 1
    failures.set(update.sessionId, count)
    outbox.deferIndexUpdate(update.sessionId, update.version, at + denIndexBackoff(count))
  }

  const settled = (sessionId: string) => {
    failures.delete(sessionId)
  }

  return {
    name: "den-index",
    nextAt() {
      const pending = outbox.nextIndexUpdateAt()
      return Math.min(pending ?? Number.POSITIVE_INFINITY, nextDropAt, nextSnapshotAt)
    },
    async run() {
      const at = now()
      if (at >= nextDropAt) {
        nextDropAt = at + DEN_INDEX_SNAPSHOT_EVERY_MS
        outbox.dropIndexUpdatesBefore(at - DEN_INDEX_MAX_AGE_MS)
      }
      if (at >= nextSnapshotAt) {
        nextSnapshotAt = at + DEN_INDEX_SNAPSHOT_EVERY_MS
        outbox.indexSnapshotAll(at)
      }
      const due = outbox.pendingIndexUpdates(at, READ_LIMIT).flatMap((update) => (update.capability ? [{ ...update, capability: update.capability }] : []))
      for (let start = 0; start < due.length; start += DEN_INDEX_BATCH) {
        const batch = due.slice(start, start + DEN_INDEX_BATCH)
        const sent = await send(batch.map(({ capability, sessionId, version, fields }) => ({ capability, sessionId, version, fields })))
        const answered = now()
        if (!sent.ok) {
          for (const update of batch) defer(update, answered)
          report("index_flush_failed", { reason: sent.code, ...(sent.status !== undefined ? { status: sent.status } : {}) })
          // Den is not taking updates now; the rest wait for their own next try.
          return
        }
        const results = new Map(sent.results.map((result) => [`${result.sessionId}\n${result.version}`, result]))
        for (const update of batch) {
          const result = results.get(`${update.sessionId}\n${update.version}`)
          if (!result) {
            defer(update, answered)
            continue
          }
          if (result.status === "ok" || result.status === "stale") {
            outbox.ackIndexUpdate(update.sessionId, update.version)
            settled(update.sessionId)
            continue
          }
          const error = result.error ?? "rejected"
          if (KEEP_ON_REJECTION.has(error)) {
            defer(update, answered)
            continue
          }
          // A permanent rejection (bad or expired capability, invalid fields, another owner's session): drop the row.
          // The session's next change, or the daily snapshot after its next turn's fresh capability, reports it again.
          outbox.ackIndexUpdate(update.sessionId, update.version)
          settled(update.sessionId)
          report("index_update_rejected", { reason: error })
        }
      }
    },
  }
}
