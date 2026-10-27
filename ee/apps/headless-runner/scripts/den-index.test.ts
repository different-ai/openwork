/**
 * The Den index flusher (den-index.ts, background job `den-index`): sends the outbox
 * in batches of at most 50 with each session's capability, acknowledges `ok`/`stale`, keeps `index_disabled` and
 * `rate_limited`, drops other rejections, backs off (immediately, 30 s, 2 min, 10 min, hourly), drops rows older than
 * 7 days and snapshots the cell daily. The turn route takes `credentials.indexCapability` and keeps it with the
 * session only: never with the turn, never in an export.
 */
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createApp } from "../src/app.js"
import { BackgroundJobs } from "../src/background.js"
import { DEN_INDEX_MAX_AGE_MS, DEN_INDEX_PATH, DEN_INDEX_SNAPSHOT_EVERY_MS, denIndexBackoff, denIndexClient, denIndexJob, type IndexOutbox, type IndexSend, type IndexUpdate } from "../src/den-index.js"
import type { ErrorReport } from "../src/error-reporting.js"
import { SessionEvents } from "../src/events.js"
import type { ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import type { IndexFields } from "../src/storage/index-outbox.js"
import { Store } from "../src/store.js"

const fields: IndexFields = { title: "Chat", createdAt: 1, updatedAt: 2, hotBytes: 3, segmentCount: 0, totalBytes: 3, activeTurnSince: null, deleted: false }

type Row = { sessionId: string; version: number; capability: string | null; fields: IndexFields; nextAt: number; createdAt: number }

/** An in-memory outbox with the store's semantics, recording what the flusher does to it. */
function fakeOutbox(rows: Row[]) {
  const log: string[] = []
  const deferred: Array<{ sessionId: string; retryAt: number }> = []
  let snapshots = 0
  const outbox: IndexOutbox = {
    pendingIndexUpdates: (now, limit) =>
      rows.filter((row) => row.nextAt <= now).sort((a, b) => Number(a.capability === null) - Number(b.capability === null)).slice(0, limit)
        .map(({ sessionId, version, capability, fields }) => ({ sessionId, version, capability, fields })),
    ackIndexUpdate: (sessionId, version) => {
      const index = rows.findIndex((row) => row.sessionId === sessionId && row.version === version)
      if (index >= 0) rows.splice(index, 1)
      log.push(`ack ${sessionId}`)
    },
    deferIndexUpdate: (sessionId, version, retryAt) => {
      const row = rows.find((entry) => entry.sessionId === sessionId && entry.version === version)
      if (row) row.nextAt = retryAt
      deferred.push({ sessionId, retryAt })
      log.push(`defer ${sessionId}`)
    },
    nextIndexUpdateAt: () => {
      const due = rows.filter((row) => row.capability !== null).map((row) => row.nextAt)
      return due.length ? Math.min(...due) : null
    },
    dropIndexUpdatesBefore: (createdBefore) => {
      const before = rows.length
      for (let index = rows.length - 1; index >= 0; index -= 1) if ((rows[index]?.createdAt ?? 0) < createdBefore) rows.splice(index, 1)
      return before - rows.length
    },
    indexSnapshotAll: () => {
      snapshots += 1
    },
  }
  return { outbox, rows, log, deferred, snapshots: () => snapshots }
}

const row = (sessionId: string, extra: Partial<Row> = {}): Row => ({ sessionId, version: 1, capability: `hic1.${sessionId}.mac`, fields, nextAt: 0, createdAt: 0, ...extra })

function recordingDen(answer: (updates: IndexUpdate[]) => Awaited<ReturnType<IndexSend>>) {
  const requests: IndexUpdate[][] = []
  const send: IndexSend = async (updates) => {
    requests.push(updates)
    return answer(updates)
  }
  return { send, requests }
}

test("sends only rows with a capability, in batches of at most 50, and acknowledges ok and stale", async () => {
  const rows = [...Array.from({ length: 120 }, (_, index) => row(`hs_s${index}`)), row("hs_nocap", { capability: null })]
  const outbox = fakeOutbox(rows)
  const den = recordingDen((updates) => ({ ok: true, results: updates.map((update, index) => ({ sessionId: update.sessionId, version: update.version, status: index % 2 ? "stale" : "ok" })) }))
  const job = denIndexJob({ outbox: outbox.outbox, send: den.send, now: () => 1_000 })
  await job.run()
  assert.deepEqual(den.requests.map((batch) => batch.length), [50, 50, 20])
  assert.ok(den.requests.flat().every((update) => update.capability.startsWith("hic1.") && Object.keys(update).sort().join() === "capability,fields,sessionId,version"))
  assert.deepEqual(outbox.rows.map((entry) => entry.sessionId), ["hs_nocap"], "a row without a capability waits (dropped after 7 days)")
})

test("keeps index_disabled and rate_limited, drops other rejections, defers missing results", async () => {
  const rows = [row("hs_off"), row("hs_busy"), row("hs_bad"), row("hs_missing"), row("hs_fine")]
  const outbox = fakeOutbox(rows)
  const reports: ErrorReport[] = []
  const den = recordingDen(() => ({
    ok: true,
    results: [
      { sessionId: "hs_off", version: 1, status: "rejected", error: "index_disabled" },
      { sessionId: "hs_busy", version: 1, status: "rejected", error: "rate_limited" },
      { sessionId: "hs_bad", version: 1, status: "rejected", error: "capability_expired" },
      { sessionId: "hs_fine", version: 1, status: "ok" },
    ],
  }))
  const job = denIndexJob({ outbox: outbox.outbox, send: den.send, errors: { report: async (report) => void reports.push(report) }, now: () => 5_000 })
  await job.run()
  assert.deepEqual(outbox.rows.map((entry) => entry.sessionId).sort(), ["hs_busy", "hs_missing", "hs_off"])
  assert.deepEqual(reports.map((report) => [report.code, report.tags?.reason]), [["index_update_rejected", "capability_expired"]])
  assert.ok(!JSON.stringify(reports).includes("hic1."), "never reports a capability")
})

test("a failed request keeps every row and backs off: immediately, 30 s, 2 min, 10 min, then hourly", async () => {
  let now = 0
  const outbox = fakeOutbox([row("hs_one")])
  const reports: ErrorReport[] = []
  const den = recordingDen(() => ({ ok: false, code: "den_unreachable" }))
  const job = denIndexJob({ outbox: outbox.outbox, send: den.send, errors: { report: async (report) => void reports.push(report) }, now: () => now })
  const delays: number[] = []
  for (let attempt = 0; attempt < 6; attempt += 1) {
    now = outbox.rows[0]?.nextAt ?? now
    await job.run()
    delays.push((outbox.deferred.at(-1)?.retryAt ?? 0) - now)
  }
  assert.deepEqual(delays, [0, 30_000, 120_000, 600_000, 3_600_000, 3_600_000])
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(denIndexBackoff), [0, 30_000, 120_000, 600_000, 3_600_000, 3_600_000])
  assert.equal(outbox.rows.length, 1, "nothing is lost while Den is down")
  assert.equal(reports[0]?.code, "index_flush_failed")
  assert.equal(reports[0]?.tags?.reason, "den_unreachable")
  assert.ok(reports.length < 6, "one report per minute, not one per try")
  // Den answers again: the row goes and the next failure starts over at "immediately".
  const recovered = denIndexJob({ outbox: outbox.outbox, send: async (updates) => ({ ok: true, results: updates.map((update) => ({ ...update, status: "ok" as const })) }), now: () => now })
  now = outbox.rows[0]?.nextAt ?? now
  await recovered.run()
  assert.equal(outbox.rows.length, 0)
})

test("uses the row's persisted attempt count when the store returns one", async () => {
  const outbox = fakeOutbox([row("hs_one")])
  const pending = outbox.outbox.pendingIndexUpdates
  const withAttempts: IndexOutbox = { ...outbox.outbox, pendingIndexUpdates: (now, limit) => pending(now, limit).map((update) => ({ ...update, attempt: 3 })) }
  const job = denIndexJob({ outbox: withAttempts, send: async () => ({ ok: false, code: "den_http_503" }), now: () => 0 })
  await job.run()
  assert.equal(outbox.deferred[0]?.retryAt, 600_000, "the fourth failure in a row waits 10 minutes")
})

test("drops rows older than 7 days at start and daily, and snapshots the cell once a day", async () => {
  const start = 10 * DEN_INDEX_MAX_AGE_MS
  let now = start
  const outbox = fakeOutbox([row("hs_old", { capability: null, createdAt: start - DEN_INDEX_MAX_AGE_MS - 1 }), row("hs_new", { capability: null, createdAt: start - 1000 })])
  const job = denIndexJob({ outbox: outbox.outbox, send: async () => ({ ok: true, results: [] }), now: () => now })
  assert.equal(job.nextAt(), start, "due at once: old rows are dropped when the cell starts")
  await job.run()
  assert.deepEqual(outbox.rows.map((entry) => entry.sessionId), ["hs_new"])
  assert.equal(outbox.snapshots(), 0)
  assert.equal(job.nextAt(), start + DEN_INDEX_SNAPSHOT_EVERY_MS)
  now = start + DEN_INDEX_SNAPSHOT_EVERY_MS
  await job.run()
  assert.equal(outbox.snapshots(), 1, "daily reconciliation")
  await job.run()
  assert.equal(outbox.snapshots(), 1, "once a day")
})

test("the job runs through BackgroundJobs and its failure is contained", async () => {
  const outbox = fakeOutbox([row("hs_one")])
  const failures: string[] = []
  const jobs = new BackgroundJobs((job) => void failures.push(job))
  jobs.register(denIndexJob({ outbox: outbox.outbox, send: async () => { throw new Error("boom") }, now: () => 0 }))
  await jobs.runDue(() => 0)
  assert.deepEqual(failures, ["den-index"])
})

test("denIndexClient posts to Den's internal endpoint with the callback token and reads results", async () => {
  const seen: Array<{ url: string | undefined; authorization: string | undefined; body: unknown }> = []
  let status = 200
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
    seen.push({ url: request.url, authorization: request.headers.authorization, body })
    const updates = typeof body === "object" && body !== null && "updates" in body && Array.isArray(body.updates) ? body.updates : []
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 200 ? { results: updates.map((update: { sessionId: string; version: number }) => ({ sessionId: update.sessionId, version: update.version, status: "ok" })) } : { error: "x" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  try {
    const send = denIndexClient({ url: `http://127.0.0.1:${address.port}`, token: "callback-token-0123456789-0123456789" })
    const update = { capability: "hic1.a.b", sessionId: "hs_client_test", version: 4, fields }
    assert.deepEqual(await send([update]), { ok: true, results: [{ sessionId: "hs_client_test", version: 4, status: "ok" }] })
    assert.equal(seen[0]?.url, DEN_INDEX_PATH)
    assert.equal(DEN_INDEX_PATH, "/v1/internal/headless/index")
    assert.equal(seen[0]?.authorization, "Bearer callback-token-0123456789-0123456789")
    assert.deepEqual(seen[0]?.body, { updates: [update] })
    status = 401
    assert.deepEqual(await send([update]), { ok: false, code: "unauthorized", status: 401 })
    status = 404
    assert.deepEqual(await send([update]), { ok: false, code: "not_configured", status: 404 })
    status = 503
    assert.deepEqual(await send([update]), { ok: false, code: "den_http_503", status: 503 })
  } finally {
    server.close()
  }
  const unreachable = denIndexClient({ url: "http://127.0.0.1:9", token: "t".repeat(32), timeoutMs: 1000 })
  assert.deepEqual(await unreachable([]), { ok: false, code: "den_unreachable" })
})

test("the turn route keeps credentials.indexCapability with the session only, and the outbox sends it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-den-index-"))
  try {
    const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
    const model: ModelClient = { complete: async () => ({ text: "Done.", toolCalls: [], usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }) }
    const limits = { maxConcurrentTurns: 2, maxSteps: 5, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
    const runner = new Runner({ store, model, defaultModel: "test-model", defaultModelApiKey: "test-key", limits, events: new SessionEvents() })
    const apiToken = "api-token-0123456789-0123456789-0123456789"
    const app = createApp({ store, runner, apiToken })
    const headers = { authorization: `Bearer ${apiToken}`, "content-type": "application/json" }
    const created = await app.request("/v1/sessions", { method: "POST", headers, body: JSON.stringify({}) })
    assert.equal(created.status, 201)
    const { id } = (await created.json()) as { id: string }
    const capability = "hic1.eyJ2IjoxfQ.c2lnbmF0dXJl"

    const refused = await app.request(`/v1/sessions/${id}/turns`, { method: "POST", headers, body: JSON.stringify({ messageId: "m0", prompt: "hi", credentials: { indexCapability: "not a capability!" } }) })
    assert.equal(refused.status, 400, "only an opaque base64url/dot string is accepted")

    const sent = await app.request(`/v1/sessions/${id}/turns`, { method: "POST", headers, body: JSON.stringify({ messageId: "m1", prompt: "hi", credentials: { indexCapability: capability } }) })
    assert.equal(sent.status, 202)
    await runner.idle()

    const pending = store.pendingIndexUpdates(Date.now() + 1000, 50).filter((update) => update.sessionId === id)
    assert.equal(pending.length, 1, "one row per session")
    assert.equal(pending[0]?.capability, capability, "kept with the session for the flusher")

    const den = recordingDen((updates) => ({ ok: true, results: updates.map((update) => ({ sessionId: update.sessionId, version: update.version, status: "ok" as const })) }))
    await denIndexJob({ outbox: store, send: den.send }).run()
    assert.equal(den.requests.flat().find((update) => update.sessionId === id)?.capability, capability)
    assert.equal(store.pendingIndexUpdates(Date.now() + 1000, 50).filter((update) => update.sessionId === id).length, 0, "acknowledged")

    const exported = await app.request(`/v1/sessions/${id}/export`, { headers })
    assert.equal(exported.status, 200)
    assert.ok(!(await exported.text()).includes(capability), "never exported")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
