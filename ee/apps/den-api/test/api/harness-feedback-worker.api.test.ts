import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { HarnessFeedbackGroupTable as Groups, HarnessFeedbackReportTable as Reports } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { EvaluationModel } from "../../src/llm/evaluation-model.js"
import { bootDen, summary } from "./harness.js"

const outsideOrgId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const den = await bootDen({ env: { DEN_AGENT_EVALUATION_API_KEY: "" } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { claimDueHarnessFeedback } = await import("../../src/harness-feedback/repository.js")
const { processHarnessFeedbackReport, startHarnessFeedbackWorker } = await import("../../src/harness-feedback/worker.js")
const { harnessFeedbackGroupKey } = await import("../../src/harness-feedback/grouping.js")
const { env } = await import("../../src/env.js")

const context = await den.createOrg(await den.signUp("Worker Fixture Owner"), "Worker Fixture Organization")
const organizationId = normalizeDenTypeId("organization", context.orgId)
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
async function setEnabled(enabled: boolean) {
  const result = await den.request(admin.token, enabled ? "PUT" : "DELETE", `/v1/admin/harness-feedback/settings/organizations/${organizationId}`)
  assert.equal(result.status, 200, summary(result))
}
await setEnabled(true)

let time = Date.now()
const clock = () => time
const now = () => new Date(time)
const fixture = { symptom: "The fixture tool failed.", workaround: "Used the fixture guide." }

async function addReport(overrides: Partial<typeof Reports.$inferInsert> = {}) {
  const id = createDenTypeId("harnessFeedbackReport")
  await db.insert(Reports).values({
    id, organizationId, memberId, clientKind: "app", surface: "tool", tool: "demo_tool", errorCode: "DEMO_ERROR",
    nextAttemptAt: now(), ...fixture, ...overrides,
  })
  return id
}

async function readReport(id: Awaited<ReturnType<typeof addReport>>) {
  const [report] = await db.$primary.select().from(Reports).where(eq(Reports.id, id))
  assert.ok(report)
  return report
}

function fake(probabilities: Record<string, number>): EvaluationModel {
  return async ({ state, questions }) => {
    assert.deepEqual(state, { report: {
      surface: "tool", tool: "demo_tool", errorCode: "DEMO_ERROR", ...fixture,
    } })
    return {
      durationMs: 1, inputTokens: null,
      answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => {
        assert.match(question.instructions, /untrusted evidence/)
        return [key, { type: question.type, probability: probabilities[key] ?? 0.1 }]
      })),
    }
  }
}

const clear: EvaluationModel = async ({ questions }) => ({
  durationMs: 1, inputTokens: null,
  answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "boolean", probability: ["actionable", "tool_error"].includes(key) ? 0.95 : 0.1 }])),
})

async function runOne(id: Awaited<ReturnType<typeof addReport>>, model: EvaluationModel) {
  const [claimed] = await claimDueHarnessFeedback(1, now())
  assert.equal(claimed?.id, id)
  assert.ok(claimed)
  assert.equal(await processHarnessFeedbackReport(claimed, model, clock), true)
  return readReport(id)
}

test("rejects a clear gate-no and sends ambiguous or low-confidence judgments to review", async () => {
  const cases: { probabilities: Record<string, number>; state: "rejected" | "needs_review" }[] = [
    { probabilities: { actionable: 0.1, tool_error: 0.95 }, state: "rejected" },
    { probabilities: { actionable: 0.5, tool_error: 0.95 }, state: "needs_review" },
    { probabilities: { actionable: 0.95, tool_error: 0.74 }, state: "needs_review" },
    { probabilities: { actionable: 0.95, tool_error: 0.91, performance: 0.8 }, state: "needs_review" },
    { probabilities: { actionable: 0.95, tool_error: 0.91, performance: 0.75 }, state: "needs_review" },
  ]
  for (const { probabilities, state } of cases) {
    const result = await runOne(await addReport(), fake(probabilities))
    assert.equal(result.state, state)
    assert.equal(result.groupId, null)
    assert.equal(result.category, null)
    assert.ok(result.judgmentDetail)
  }
  assert.deepEqual(await db.$primary.select().from(Groups), [])
})

test("initializes a group, increments matches without touching notification fields, and splits on metadata", async () => {
  const first = await runOne(await addReport(), clear)
  assert.equal(first.state, "classified")
  assert.equal(first.category, "tool_error")
  assert.ok(first.groupId)
  const [created] = await db.$primary.select().from(Groups).where(eq(Groups.id, first.groupId))
  assert.ok(created)
  assert.equal(created.reportCount, 1)
  assert.equal(created.notifyState, "pending")
  assert.equal(created.title, "Tool error (tool: demo_tool)")

  const notify = { notifyState: "delivered", notifyAttempts: 1, notifiedAt: now(), notifyLeaseOwner: "fixture-notifier", notifyLeaseExpiresAt: now() } satisfies Partial<typeof Groups.$inferInsert>
  await db.update(Groups).set(notify).where(eq(Groups.id, created.id))
  time += 1_000
  const second = await runOne(await addReport({ tool: " DEMO_TOOL ", errorCode: " demo_error " }), clear)
  assert.equal(second.groupId, created.id)
  const [updated] = await db.$primary.select().from(Groups).where(eq(Groups.id, created.id))
  assert.deepEqual(updated, { ...created, ...notify, reportCount: 2, lastSeenAt: now() })

  const differentTool = await runOne(await addReport({ tool: "another_tool" }), clear)
  const differentCode = await runOne(await addReport({ errorCode: "ANOTHER_ERROR" }), clear)
  assert.ok(differentTool.groupId && differentCode.groupId)
  assert.equal(new Set([created.id, differentTool.groupId, differentCode.groupId]).size, 3)
})

test("malformed answers and a timeout back off, then move to review", async () => {
  const id = await addReport()
  const partial: EvaluationModel = async () => ({ durationMs: 1, inputTokens: null, answers: { actionable: { type: "boolean", probability: 0.1 } } })
  const timeout: EvaluationModel = async () => { throw new DOMException("Timed out", "TimeoutError") }
  const invalid: EvaluationModel = async (request) => {
    const result = await clear(request)
    return { ...result, answers: { ...result.answers, performance: { type: "boolean", probability: 1.2 } } }
  }
  for (const [attemptIndex, model] of [partial, timeout, invalid].entries()) {
    const result = await runOne(id, model)
    const terminal = attemptIndex === 2
    assert.equal(result.attempts, attemptIndex + 1)
    assert.equal(result.state, terminal ? "needs_review" : "pending")
    assert.equal(result.groupId, null)
    assert.equal(result.leaseOwner, null)
    assert.equal(result.leaseExpiresAt, null)
    assert.equal(result.nextAttemptAt.getTime(), terminal ? time : time + 60_000 * 2 ** attemptIndex)
    assert.deepEqual(await claimDueHarnessFeedback(1, now()), [])
    time = result.nextAttemptAt.getTime()
  }
})

test("concurrent claims do not overlap; concurrent matching settlements share a group", async () => {
  const first = await addReport({ errorCode: "CONCURRENT_ERROR" })
  const second = await addReport({ errorCode: "CONCURRENT_ERROR" })
  const outside = await addReport({ organizationId: outsideOrgId })
  const batches = await Promise.all([claimDueHarnessFeedback(2, now()), claimDueHarnessFeedback(2, now())])
  const claimed = batches.flat()
  assert.deepEqual(claimed.map((report) => report.id).sort(), [first, second].sort())
  assert.deepEqual(await claimDueHarnessFeedback(2, now()), [])
  assert.deepEqual(await Promise.all(claimed.map((report) => processHarnessFeedbackReport(report, clear, clock))), [true, true])
  const left = await readReport(first)
  assert.ok(left.groupId)
  assert.equal((await readReport(second)).groupId, left.groupId)
  const [group] = await db.$primary.select().from(Groups).where(eq(Groups.id, left.groupId))
  assert.equal(group?.reportCount, 2)
  assert.equal(group?.notifyState, "pending")
  assert.equal((await readReport(outside)).state, "pending")
})

test("does not settle a replaced lease or classify after allowlist removal", async () => {
  const id = await addReport()
  const [stale] = await claimDueHarnessFeedback(1, now())
  assert.ok(stale?.leaseExpiresAt)
  time = stale.leaseExpiresAt.getTime()
  const [current] = await claimDueHarnessFeedback(1, now())
  assert.ok(current)
  const replacedDuringEvaluation: EvaluationModel = async (request) => {
    time = current.leaseExpiresAt?.getTime() ?? time
    const [replacement] = await claimDueHarnessFeedback(1, now())
    assert.equal(replacement?.id, id)
    return clear(request)
  }
  assert.equal(await processHarnessFeedbackReport(current, replacedDuringEvaluation, clock), false)
  assert.equal((await readReport(id)).groupId, null)
  await setEnabled(false)
  try {
    assert.deepEqual(await claimDueHarnessFeedback(1, now()), [])
    const report = await readReport(id)
    assert.ok(report.leaseOwner)
    let calls = 0
    assert.equal(await processHarnessFeedbackReport({ ...report, leaseOwner: report.leaseOwner }, async (request) => {
      calls += 1
      return clear(request)
    }, clock), false)
    assert.equal(calls, 0)
  } finally {
    await db.delete(Reports).where(eq(Reports.id, id))
    await setEnabled(true)
  }
})

test("running worker picks up enabled organizations, but needs the evaluation key to start", async (t) => {
  const timers = t.mock.method(globalThis, "setInterval")
  await startHarnessFeedbackWorker()()
  assert.equal(timers.mock.callCount(), 0)
  const apiKey = env.agentEvaluationApiKey
  env.agentEvaluationApiKey = "fixture-key"
  await setEnabled(false)
  const id = await addReport({ nextAttemptAt: new Date(Date.now() - 1_000) })
  let calls = 0
  const stop = startHarnessFeedbackWorker(() => async (request) => { calls++; return clear(request) })
  try {
    const tick = timers.mock.calls[0]?.arguments[0]
    assert.ok(tick)
    await tick()
    assert.equal(calls, 0)
    assert.equal((await readReport(id)).state, "pending")
    await setEnabled(true)
    await tick()
    assert.equal(calls, 1)
    assert.equal((await readReport(id)).state, "classified")
  } finally {
    await stop()
    env.agentEvaluationApiKey = apiKey
  }
})

test("fingerprints normalize case, whitespace, and missing identifiers", () => {
  const base = { category: "tool_error", surface: "tool", tool: null, errorCode: "Error-Demo" } satisfies Parameters<typeof harnessFeedbackGroupKey>[0]
  const key = harnessFeedbackGroupKey(base)
  assert.match(key.fingerprint, /^v1:[0-9a-f]{64}$/)
  assert.deepEqual(harnessFeedbackGroupKey({ ...base, tool: "  ", errorCode: " error-demo " }), key)
  assert.notEqual(harnessFeedbackGroupKey({ ...base, category: "missing_capability" }).fingerprint, key.fingerprint)
  assert.notEqual(harnessFeedbackGroupKey({ ...base, surface: "environment" }).fingerprint, key.fingerprint)
  assert.equal(harnessFeedbackGroupKey({ ...base, errorCode: null }).fingerprint, harnessFeedbackGroupKey({ ...base, errorCode: " " }).fingerprint)
})
