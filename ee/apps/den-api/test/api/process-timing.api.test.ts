import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { ProcessTimingRunTable } from "@openwork-ee/den-db/schema"
import { processTimingSummarySchema, type ProcessTimingReport } from "@openwork/types/den/diagnostics"
import { bootDen, summary } from "./harness.js"

const key = "process-timing-test-ingest-key"
const den = await bootDen({ env: { PROCESS_TIMING_INGEST_KEY: key } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { env } = await import("../../src/env.js")
const path = "/v1/diagnostics/process-timing"
const report = (): ProcessTimingReport => ({
  version: 1,
  runId: randomUUID(),
  process: "check",
  environment: "local",
  commit: null,
  startedAt: new Date().toISOString(),
  totalSeconds: 10,
  outcome: "ok",
  steps: [{ step: "typecheck", seconds: 5, outcome: "ok" }],
})
const post = (body: unknown, token: string | null = key) => den.request(token, "POST", path, { body })

test("valid report is stored and duplicate runId preserves the original once", async () => {
  const body = report()
  const accepted = await post(body)
  assert.equal(accepted.status, 202, summary(accepted))
  assert.equal((await post({ ...body, totalSeconds: 99 })).status, 202)
  const rows = await db.select().from(ProcessTimingRunTable).where(eq(ProcessTimingRunTable.runId, body.runId))
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.totalSeconds, 10)
  assert.deepEqual(rows[0]?.steps, body.steps)
})

test("stores ISO dates outside the MySQL timestamp range and normalizes offsets", async () => {
  const body = { ...report(), startedAt: "2045-01-02T03:00:00+03:00" }
  const result = await post(body)
  assert.equal(result.status, 202, summary(result))
  const [row] = await db.select().from(ProcessTimingRunTable).where(eq(ProcessTimingRunTable.runId, body.runId))
  assert.equal(row?.startedAt, "2045-01-02T00:00:00.000Z")
})

test("unknown keys, invalid step names and malformed JSON return 400 without storage", async () => {
  const body = report()
  assert.equal((await post({ ...body, hostname: "invalid" })).status, 400)
  assert.equal((await post({ ...body, steps: [{ step: "bad name", seconds: 1, outcome: "ok" }] })).status, 400)
  const malformed = await den.request(key, "POST", path, { rawBody: "{" })
  assert.equal(malformed.status, 400, summary(malformed))
  assert.equal((await db.select().from(ProcessTimingRunTable).where(eq(ProcessTimingRunTable.runId, body.runId))).length, 0)
})

test("missing and wrong ingest keys return 401", async () => {
  assert.equal((await post(report(), null)).status, 401)
  assert.equal((await post(report(), "wrong-key")).status, 401)
})

test("unset ingest key returns 404 and stores nothing", async () => {
  const body = report()
  env.processTimingIngestKey = undefined
  try {
    assert.equal((await post(body)).status, 404)
    assert.equal((await db.select().from(ProcessTimingRunTable).where(eq(ProcessTimingRunTable.runId, body.runId))).length, 0)
  } finally {
    env.processTimingIngestKey = key
  }
})

test("large bodies return 413", async () => {
  const result = await den.request(key, "POST", path, { rawBody: JSON.stringify({ payload: "a".repeat(33_000) }) })
  assert.equal(result.status, 413, summary(result))
})

test("staff aggregates median, p90, failure rate and filters by environment", async () => {
  for (const [index, seconds] of [10, 20, 30, 40].entries()) {
    const body = report()
    body.process = "evals"
    body.environment = "ci"
    body.totalSeconds = seconds
    body.outcome = index === 0 ? "fail" : "ok"
    body.steps = [{ step: "runner", seconds, outcome: body.outcome }]
    assert.equal((await post(body)).status, 202)
  }
  const response = await den.asPlatformAdmin("GET", "/v1/admin/process-timing?days=14&process=evals&environment=ci")
  assert.equal(response.status, 200, summary(response))
  const data = processTimingSummarySchema.parse(response.body)
  assert.deepEqual(data.processes, [{ process: "evals", environment: "ci", runCount: 4, medianSeconds: 25, p90Seconds: 40, failureRate: 0.25 }])
  assert.deepEqual(data.steps, [{ process: "evals", environment: "ci", step: "runner", runCount: 4, medianSeconds: 25, p90Seconds: 40, failureRate: 0.25 }])
  assert.equal(data.latestRuns.length, 4)
  const empty = await den.asPlatformAdmin("GET", "/v1/admin/process-timing?process=world")
  assert.equal(processTimingSummarySchema.parse(empty.body).processes.length, 0)
})

test("only staff can read timing reports; invalid windows are rejected", async () => {
  assert.equal((await den.request(null, "GET", "/v1/admin/process-timing")).status, 401)
  const member = await den.signUp("Teammate")
  assert.equal((await den.request(member.token, "GET", "/v1/admin/process-timing")).status, 403)
  assert.equal((await den.asPlatformAdmin("GET", "/v1/admin/process-timing?days=91")).status, 400)
})

test("ingest prunes reports received more than 90 days ago", async () => {
  const body = report()
  const receivedAt = new Date(Date.now() - 91 * 86_400_000)
  await db.insert(ProcessTimingRunTable).values({ ...body, startedAt: receivedAt.toISOString(), receivedAt })
  assert.equal((await post(report())).status, 202)
  assert.equal((await db.select().from(ProcessTimingRunTable).where(eq(ProcessTimingRunTable.runId, body.runId))).length, 0)
})
