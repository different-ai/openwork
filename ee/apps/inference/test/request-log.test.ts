import assert from "node:assert/strict"
import { test } from "node:test"
import type { InferenceReporter } from "../src/inference-reporting.js"
import { createRequestLogRecorder } from "../src/request-log.js"
import type { InferenceRequestLogRow, RequestLogStartInput } from "../src/request-log.js"

const identity: RequestLogStartInput["identity"] = {
  organizationId: "org_01krnrcabhe8htwpbnsw0zk0bw",
  orgMembershipId: "om_01krnrcabhe8htwpbnsw0zk0bw",
  inferenceKeyId: "ink_01krnrcabhe8htwpbnsw0zk0bw",
}

const startInput: RequestLogStartInput = {
  identity,
  openworkRequestId: "req-1",
  route: "openwork_openrouter",
  protocol: "openai_chat",
  upstreamProviderId: "openrouter",
  upstreamHost: "openrouter.ai",
  upstreamPath: "/api/v1/chat/completions",
  method: "POST",
  requestedModel: "alias",
  upstreamModel: "upstream/model",
  stream: true,
}

function createHarness(insert?: (row: InferenceRequestLogRow) => Promise<void>) {
  const rows: InferenceRequestLogRow[] = []
  const handled: string[] = []
  const reporter: InferenceReporter = {
    request() {},
    handledError(report) {
      handled.push(report.reason)
    },
  }
  const recorder = createRequestLogRecorder({
    insertRequestLog: insert ?? (async (row) => { rows.push(row) }),
    updateRequestLog: async (row) => {
      const index = rows.findIndex((candidate) => candidate.id === row.id)
      if (index < 0) return false
      rows[index] = row
      return true
    },
    reporter,
  })
  return { recorder, rows, handled }
}

test("finish inserts one row and is idempotent", async () => {
  const { recorder, rows } = createHarness()
  recorder.start(startInput)
  recorder.markFirstByte()
  recorder.setUsage({ usageSource: "stream", inputTokens: 5, outputTokens: 7, upstreamModel: "response/model", costUsd: 0.000001 })
  await recorder.finish({ status: 200, outcome: "ok" })
  await recorder.finish({ status: 500, outcome: "upstream_error" })

  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.ok(row)
  assert.equal(row.total_tokens, 12)
  assert.equal(row.upstream_model, "response/model")
  assert.equal(row.cost_micro_usd, 1)
  assert.equal(row.outcome, "ok")
  assert.equal(row.usage_source, "stream")
  assert.ok(row.first_byte_at)
})

test("finish without start is a no-op and missing usage defaults to missing", async () => {
  const { recorder, rows } = createHarness()
  await recorder.finish({ status: 200, outcome: "ok" })
  assert.equal(rows.length, 0)

  recorder.start(startInput)
  await recorder.finish({ status: 404, outcome: "rejected", errorCode: "model_not_found" })
  const row = rows[0]
  assert.ok(row)
  assert.equal(row.usage_source, "missing")
  assert.equal(row.total_tokens, null)
  assert.equal(row.cost_micro_usd, null)
  assert.equal(row.error_code, "model_not_found")
  assert.equal(row.first_byte_at, null)
})

test("insert failures are reported and never thrown", async () => {
  const { recorder, handled } = createHarness(async () => {
    throw new Error("db down")
  })
  recorder.start(startInput)
  await recorder.finish({ status: 200, outcome: "ok" })
  assert.deepEqual(handled, ["request_log_insert_failed"])
})

test("pending write starts before finish; completion waits for start and racing finishes share one result", async () => {
  const rows: InferenceRequestLogRow[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let updates = 0
  const recorder = createRequestLogRecorder({
    insertRequestLog: async (row) => { rows.push(row); await gate },
    updateRequestLog: async (row) => { updates += 1; rows[0] = row; return true },
    reporter: { request() {}, handledError() {} },
  })
  recorder.start(startInput)
  const id = rows[0]?.id
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.completed_at, null)
  const finish = recorder.finish({ status: 200, outcome: "ok" })
  assert.equal(updates, 0)
  const duplicate = recorder.finish({ status: 500, outcome: "upstream_error" })
  assert.equal(duplicate, finish)
  release()
  await finish
  assert.equal(await recorder.whenStarted?.(), true)
  assert.equal(updates, 1)
  assert.equal(rows[0]?.id, id)
  assert.equal(rows[0]?.outcome, "ok")
})

test("ambiguous writes retry the same identity, failures are bounded and never disclose exception payloads", async () => {
  const stored = new Map<string, InferenceRequestLogRow>()
  const reports: unknown[] = []
  const ids: string[] = []
  let attempts = 0
  const recorder = createRequestLogRecorder({
    insertRequestLog: async (row) => {
      ids.push(row.id)
      stored.set(row.id, row)
      if (ids.length === 1) throw new Error("INSERT values FAKE_SECRET_BODY")
    },
    updateRequestLog: async () => { attempts += 1; throw new Error("SQL params FAKE_SECRET_BODY") },
    reporter: { request() {}, handledError(report) { reports.push(report) } },
  })
  recorder.start(startInput)
  await recorder.finish({ status: 200, outcome: "ok" })
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, 1)
  assert.equal(stored.size, 1)
  assert.equal(attempts, 3)
  assert.equal([...stored.values()][0]?.completed_at, null)
  assert.equal(JSON.stringify(reports).includes("FAKE_SECRET_BODY"), false)
  assert.equal(JSON.stringify(reports).includes("exception"), false)
  await recorder.finish({ status: 200, outcome: "ok" })
  assert.equal(attempts, 3)
})

test("retention-consumed pending rows are not reinserted; body id and stream errors can be recorded", async () => {
  let inserts = 0
  let completed: InferenceRequestLogRow | null = null
  const reports: string[] = []
  const recorder = createRequestLogRecorder({
    insertRequestLog: async () => { inserts += 1 },
    updateRequestLog: async (row) => { completed = row; return false },
    reporter: { request() {}, handledError(report) { reports.push(report.reason) } },
  })
  recorder.start(startInput)
  recorder.setUsage({ usageSource: "stream", upstreamRequestId: "body_request", streamError: "upstream_stream_error" })
  await recorder.finish({ status: 200, outcome: "ok" })
  assert.equal(inserts, 1)
  assert.ok(completed)
  // Callback-assigned values are observed through a snapshot for TS narrowing.
  const snapshot = () => completed
  assert.equal(snapshot()?.outcome, "upstream_error")
  assert.equal(snapshot()?.error_code, "upstream_stream_error")
  assert.equal(snapshot()?.upstream_request_id, "body_request")
  assert.equal(snapshot()?.usage_source, "missing")
  assert.deepEqual(reports, ["request_log_not_finalized"])
})
