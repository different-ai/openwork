import assert from "node:assert/strict"
import { test } from "node:test"
import type { InferenceReporter } from "../src/inference-reporting.js"
import { createRequestLogRecorder } from "../src/request-log.js"
import type { InferenceRequestLogRow, RequestLogStartInput } from "../src/request-log.js"

const identity: RequestLogStartInput["identity"] = {
  organizationId: "org_01krnrcabhe8htwpbnsw0zk0bw",
  orgMembershipId: "mem_01krnrcabhe8htwpbnsw0zk0bw",
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
