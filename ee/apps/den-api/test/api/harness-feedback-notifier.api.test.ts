import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { after, test } from "node:test"
import { eq, getTableColumns, sql } from "@openwork-ee/den-db/drizzle"
import { HarnessFeedbackGroupTable as Groups, HarnessFeedbackReportTable as Reports } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { HarnessFeedbackSender } from "../../src/harness-feedback/slack.js"
import type { EvaluationModel } from "../../src/llm/evaluation-model.js"
import { bootDen } from "./harness.js"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const webhook = "https://hooks.slack.com/services/T000/B000/XXXX"
const webUrl = "https://den.example.test"
const den = await bootDen({ env: {
  DEN_HARNESS_FEEDBACK_ORG_IDS: organizationId, DEN_AGENT_EVALUATION_API_KEY: "", DEN_HARNESS_FEEDBACK_SLACK_WEBHOOK_URL: "",
} })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { env } = await import("../../src/env.js")
const { claimDueHarnessFeedback, claimDueHarnessFeedbackGroups, settleHarnessFeedbackGroup } = await import("../../src/harness-feedback/repository.js")
const { processHarnessFeedbackReport } = await import("../../src/harness-feedback/worker.js")
const { notifyHarnessFeedbackTick, startHarnessFeedbackNotifier } = await import("../../src/harness-feedback/notifier.js")
const { createHarnessFeedbackSlackSender } = await import("../../src/harness-feedback/slack.js")
const makeSender = (fetch: typeof globalThis.fetch) => createHarnessFeedbackSlackSender({ webhookUrl: webhook, webUrl, fetch })

let time = Date.now()
const clock = () => time
const now = () => new Date(time)
const fixture = { symptom: "Fixture-only symptom: fluorescent umbrella.", workaround: "Fixture-only workaround: copper teapot." }
const clear: EvaluationModel = async ({ questions }) => ({
  durationMs: 1, inputTokens: null,
  answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "boolean", probability: ["actionable", "tool_error"].includes(key) ? 0.95 : 0.1 }])),
})

async function classifyFixture() {
  const id = createDenTypeId("harnessFeedbackReport")
  await db.insert(Reports).values({ ...fixture, id, organizationId, memberId, clientKind: "app", surface: "tool", tool: "demo_tool", nextAttemptAt: now() })
  const [report] = await claimDueHarnessFeedback(1, now())
  assert.ok(report)
  assert.equal(report.id, id)
  assert.equal(await processHarnessFeedbackReport(report, clear, clock), true)
  const [classified] = await db.$primary.select().from(Reports).where(eq(Reports.id, id))
  assert.ok(classified?.groupId)
  return classified.groupId
}

async function addGroup(overrides: Partial<typeof Groups.$inferInsert> = {}) {
  const id = createDenTypeId("harnessFeedbackGroup")
  await db.insert(Groups).values({ id, organizationId, fingerprint: id, title: "Tool error (tool)", category: "tool_error", surface: "tool", ...overrides })
  return id
}

async function group(id: Awaited<ReturnType<typeof addGroup>>) {
  const [row] = await db.$primary.select({ ...getTableColumns(Groups), deliveredAtSeconds: sql<number>`unix_timestamp(${Groups.notifiedAt})` })
    .from(Groups).where(eq(Groups.id, id))
  assert.ok(row)
  return row
}

test("new classified group is delivered once across concurrent ticks; a matching report does not send again", async () => {
  const groupId = await classifyFixture()
  const requests: string[] = []
  const sender = makeSender(async (url, request) => {
    assert.equal(url, webhook)
    assert.equal(request?.redirect, "manual")
    assert.equal(request?.method, "POST")
    assert.equal(typeof request?.body, "string")
    if (typeof request?.body === "string") requests.push(request.body)
    return new Response("ok")
  })
  await Promise.all([notifyHarnessFeedbackTick(sender, clock), notifyHarnessFeedbackTick(sender, clock)])
  assert.equal(requests.length, 1)
  const [request] = requests
  assert.ok(request)
  assert.match(request, /New harness issue/)
  assert.match(request, /Category: Tool error/)
  assert.match(request, /Surface: Tool/)
  assert.match(request, /Tool: demo_tool/)
  assert.ok(request.includes(`${webUrl}/admin/harness-feedback?group=${groupId}`))
  for (const disallowed of [...Object.values(fixture), organizationId, memberId, "judgmentDetail"]) assert.ok(!request.includes(disallowed))
  const delivered = await group(groupId)
  assert.equal(delivered.notifyState, "delivered")
  assert.equal(delivered.notifyAttempts, 1)
  assert.equal(Number(delivered.deliveredAtSeconds), time / 1000)
  assert.equal(await classifyFixture(), groupId)
  await notifyHarnessFeedbackTick(sender, clock)
  assert.equal(requests.length, 1)
  assert.equal((await group(groupId)).reportCount, 2)
})

test("429 and 5xx back off for one and two minutes, then fail after three attempts", async () => {
  const id = await addGroup()
  let calls = 0
  const sender = makeSender(async () => new Response(null, { status: ++calls === 1 ? 429 : 503 }))
  for (const [index, delay] of [60_000, 120_000, 1].entries()) {
    await notifyHarnessFeedbackTick(sender, clock)
    const current = await group(id)
    assert.equal(current.notifyAttempts, index + 1)
    assert.equal(current.notifyState, index === 2 ? "failed" : "pending")
    assert.equal(current.notifyLeaseOwner, null)
    time += delay - 1
    await notifyHarnessFeedbackTick(sender, clock)
    assert.equal(calls, index + 1)
    time += 1
  }
})

test("4xx and a timeout both fail immediately and do not send again", async () => {
  for (const fetch of [async () => new Response(null, { status: 400 }), async () => { throw new DOMException("Fixture timeout", "TimeoutError") }]) {
    const id = await addGroup()
    let calls = 0
    const sender = makeSender(async () => { calls++; return fetch() })
    await notifyHarnessFeedbackTick(sender, clock)
    assert.equal((await group(id)).notifyState, "failed")
    assert.equal((await group(id)).notifyAttempts, 1)
    time += 300_000
    await notifyHarnessFeedbackTick(sender, clock)
    assert.equal(calls, 1)
  }
})

test("expired in-flight claims are failed without resending and a stale owner cannot settle", async () => {
  const id = await addGroup()
  const [claim] = await claimDueHarnessFeedbackGroups(1, now())
  assert.ok(claim)
  assert.equal(claim.id, id)
  time = claim.expiresAt
  assert.equal(await settleHarnessFeedbackGroup(claim, { state: "delivered" }, now()), false)
  const sender: HarnessFeedbackSender = async () => assert.fail("expired in-flight delivery must not be posted again")
  await notifyHarnessFeedbackTick(sender, clock)
  assert.equal((await group(id)).notifyState, "failed")
})

test("groups are not sent after their organization leaves the allowlist", async () => {
  const removedOrg = createDenTypeId("organization")
  env.harnessFeedbackOrgIds.add(removedOrg)
  const id = await addGroup({ organizationId: removedOrg })
  env.harnessFeedbackOrgIds.delete(removedOrg)
  const sender: HarnessFeedbackSender = async () => assert.fail("outside group should not send")
  await notifyHarnessFeedbackTick(sender, clock)
  assert.equal((await group(id)).notifyState, "pending")
  assert.equal((await group(id)).notifyAttempts, 0)
})

test("Slack payloads escape controls and neutralize mentions; only definite pre-connect errors can retry", async () => {
  const tool = "demo&<> @channel @here <!everyone> <@U000>"
  const row = { id: createDenTypeId("harnessFeedbackGroup"), title: `Tool error (${tool})`, surface: "tool", category: "tool_error", tool } satisfies Parameters<HarnessFeedbackSender>[0]
  let inspected = false
  assert.equal(await makeSender(async (_url, options) => {
    const body = String(options?.body)
    assert.ok(!body.includes("@channel") && !body.includes("@here"))
    assert.ok(body.includes("demo&amp;&lt;&gt; @\u200bchannel @\u200bhere &lt;!everyone&gt; &lt;@U000&gt;"))
    inspected = true
    return new Response()
  })(row), "delivered")
  assert.ok(inspected)
  for (const [code, outcome] of [["ENOTFOUND", "transient"], ["ECONNRESET", "uncertain"], ["UND_ERR_SOCKET", "uncertain"]]) {
    assert.equal(await makeSender(async () => { throw new TypeError("fetch failed", { cause: { code } }) })(row), outcome)
  }
  assert.equal(await makeSender(async () => new Response(null, { status: 307 }))(row), "permanent")
})

test("webhook validation rejects non-Slack and non-HTTPS endpoints without echoing them", () => {
  for (const configured of ["https://hooks.slack.com.example.test/services/T000/B000/XXXX", webhook.replace("https:", "http:")]) {
    const child = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", "await import('./src/env.ts')"], {
      env: { ...process.env, DEN_HARNESS_FEEDBACK_SLACK_WEBHOOK_URL: configured }, encoding: "utf8",
    })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /DEN_HARNESS_FEEDBACK_SLACK_WEBHOOK_URL must be an HTTPS webhook URL/)
    assert.ok(!child.stderr.includes(configured))
  }
})

test("notifier requires the webhook and allowlist, but not the evaluation key", async (t) => {
  const timers = t.mock.method(globalThis, "setInterval")
  await startHarnessFeedbackNotifier()()
  assert.equal(timers.mock.callCount(), 0)
  env.harnessFeedbackSlackWebhookUrl = webhook
  try {
    assert.equal(env.agentEvaluationApiKey, undefined)
    await startHarnessFeedbackNotifier()()
    assert.equal(timers.mock.callCount(), 1)
    env.harnessFeedbackOrgIds.clear()
    await startHarnessFeedbackNotifier()()
    assert.equal(timers.mock.callCount(), 1)
  } finally {
    env.harnessFeedbackSlackWebhookUrl = undefined
    env.harnessFeedbackOrgIds.add(organizationId)
  }
})
