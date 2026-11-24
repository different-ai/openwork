import { z } from "zod"
import type { BackgroundJob } from "./background.js"
import type { ErrorReporter } from "./error-reporting.js"
import type { IndexFields } from "./storage/index-outbox.js"

export const DEN_INDEX_PATH = "/v1/internal/headless/index"
export const DEN_INDEX_BATCH = 50
export const DEN_INDEX_BACKOFF_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000] as const
export const DEN_INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const DEN_INDEX_SNAPSHOT_EVERY_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 10_000
const READ_LIMIT = DEN_INDEX_BATCH * 4
const KEEP_ON_REJECTION = new Set(["index_disabled", "rate_limited"])

export type IndexOutbox = {
  pendingIndexUpdates(now: number, limit: number): Array<{ sessionId: string; version: number; capability: string | null; fields: IndexFields; attempt?: number }>
  ackIndexUpdate(sessionId: string, version: number): void
  deferIndexUpdate(sessionId: string, version: number, retryAt: number): void
  nextIndexUpdateAt(): number | null
  dropIndexUpdatesBefore(createdBefore: number): number
  indexSnapshotAt(): number | null
  indexSnapshotAll(now: number): void
}

export type IndexUpdate = { capability: string; sessionId: string; version: number; fields: IndexFields }
export type IndexResult = { sessionId: string; version: number; status: "ok" | "stale" | "rejected"; error?: string }
export type IndexSendResult =
  | { ok: true; results: IndexResult[] }
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
      const code = response.status === 401 ? "unauthorized" : response.status === 404 ? "not_configured" : `den_http_${response.status}`
      return { ok: false, code, status: response.status }
    }
    const parsed = responseSchema.safeParse(body)
    return parsed.success ? { ok: true, results: parsed.data.results } : { ok: false, code: "invalid_response", status: 200 }
  }
}

export function denIndexBackoff(failures: number) {
  const index = Math.min(Math.max(failures, 1), DEN_INDEX_BACKOFF_MS.length) - 1
  return DEN_INDEX_BACKOFF_MS[index] ?? DEN_INDEX_BACKOFF_MS[DEN_INDEX_BACKOFF_MS.length - 1]
}

export function denIndexJob(input: { outbox: IndexOutbox; send: IndexSend; errors?: Pick<ErrorReporter, "report">; now?: () => number }): BackgroundJob {
  const { outbox, send } = input
  const now = input.now ?? Date.now
  const failures = new Map<string, number>()
  let nextDropAt = now()

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
      return outbox.nextIndexUpdateAt()
    },
    async run() {
      const at = now()
      if (at >= nextDropAt) {
        nextDropAt = at + DEN_INDEX_SNAPSHOT_EVERY_MS
        outbox.dropIndexUpdatesBefore(at - DEN_INDEX_MAX_AGE_MS)
      }
      const snapshotAt = outbox.indexSnapshotAt()
      if (snapshotAt === null || at - snapshotAt >= DEN_INDEX_SNAPSHOT_EVERY_MS) outbox.indexSnapshotAll(at)
      const due = outbox.pendingIndexUpdates(at, READ_LIMIT).flatMap((update) => (update.capability ? [{ ...update, capability: update.capability }] : []))
      for (let start = 0; start < due.length; start += DEN_INDEX_BATCH) {
        const batch = due.slice(start, start + DEN_INDEX_BATCH)
        const sent = await send(batch.map(({ capability, sessionId, version, fields }) => ({ capability, sessionId, version, fields })))
        const answered = now()
        if (!sent.ok) {
          for (const update of batch) defer(update, answered)
          report("index_flush_failed", { reason: sent.code, ...(sent.status !== undefined ? { status: sent.status } : {}) })
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
          outbox.ackIndexUpdate(update.sessionId, update.version)
          settled(update.sessionId)
          report("index_update_rejected", { reason: error })
        }
      }
    },
  }
}
