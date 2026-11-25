import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq, getTableColumns, sql } from "@openwork-ee/den-db/drizzle"
import { HarnessFeedbackGroupTable as Groups, HarnessFeedbackReportTable as Reports } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { HarnessFeedbackSender } from "../../src/harness-feedback/slack.js"
import type { EvaluationModel } from "../../src/llm/evaluation-model.js"
import { bootDen, summary, type Method } from "./harness.js"

const memberId = createDenTypeId("member")
const webhook = "https://hooks.slack.com/services/T000/B000/XXXX"
const den = await bootDen({ env: { DEN_AGENT_EVALUATION_API_KEY: "", DEN_AUDIT_CAPTURE_ENABLED: "true" } })
after(() => den.close())
const { db, client } = await import("../../src/db.js")
const { env } = await import("../../src/env.js")
const owner = await den.signUp("Notifier Fixture Owner")
const context = await den.createOrg(owner, "Notifier Fixture Organization")
const organizationId = normalizeDenTypeId("organization", context.orgId)
const outside = await den.createOrg(await den.signUp("Outside Fixture Owner"), "Outside Fixture Organization")
const outsideId = normalizeDenTypeId("organization", outside.orgId)
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const settings = "/v1/admin/harness-feedback/settings"
const slack = `${settings}/slack`
async function configure(method: Method, endpoint: string, body?: unknown) {
  const result = await den.request(admin.token, method, endpoint, { body })
  assert.equal(result.status, 200, summary(result))
  assert.equal(result.headers.get("cache-control"), "no-store")
  assert.ok(!result.text.includes(webhook))
  return result.body
}
const orgSettings = (id: string) => `${settings}/organizations/${id}`
await configure("PUT", orgSettings(organizationId))
await configure("PUT", slack, { webhookUrl: webhook })
const { claimDueHarnessFeedback, claimDueHarnessFeedbackGroups, settleHarnessFeedbackGroup } = await import("../../src/harness-feedback/repository.js")
const { processHarnessFeedbackReport } = await import("../../src/harness-feedback/worker.js")
const { notifyHarnessFeedbackTick, startHarnessFeedbackNotifier } = await import("../../src/harness-feedback/notifier.js")
const { createHarnessFeedbackSlackSender } = await import("../../src/harness-feedback/slack.js")
const makeSender = (fetch: typeof globalThis.fetch) => createHarnessFeedbackSlackSender({ webhookUrl: webhook, webUrl: env.webUrl, fetch })

let time = Date.now()
const clock = () => time
const now = () => new Date(time)
const fixture = { symptom: "Fixture-only symptom: fluorescent umbrella.", workaround: "Fixture-only workaround: copper teapot." }
const clear: EvaluationModel = async ({ questions }) => ({
  durationMs: 1, inputTokens: null,
  answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "boolean", probability: ["actionable", "tool_error", "c1"].includes(key) ? 0.95 : 0.1 }])),
})

async function classifyFixture() {
  const id = createDenTypeId("harnessFeedbackReport")
  await db.insert(Reports).values({ ...fixture, id, organizationId, memberId, clientKind: "app", surface: "tool", tool: "demo_tool", nextAttemptAt: sql`from_unixtime(${time / 1000})` })
  const [report] = await claimDueHarnessFeedback(1, now())
  assert.ok(report)
  assert.equal(report.id, id)
  assert.equal(await processHarnessFeedbackReport(report, clear, async () => ({ title: "Demo tool drops page selection", theme: "browser" }), clock), true)
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
  await Promise.all([notifyHarnessFeedbackTick(clock, () => sender), notifyHarnessFeedbackTick(clock, () => sender)])
  assert.equal(requests.length, 1)
  const [request] = requests
  assert.ok(request)
  assert.match(request, /New harness issue/)
  assert.match(request, /Category: Tool error/)
  assert.match(request, /New harness issue\\nDemo tool drops page selection\\nTheme: Browser\\nCategory: Tool error\\nTool: demo_tool/)
  assert.match(request, /Tool: demo_tool/)
  assert.ok(request.includes(`${env.webUrl}/admin/harness-feedback?group=${groupId}`))
  for (const disallowed of [...Object.values(fixture), organizationId, memberId, "judgmentDetail"]) assert.ok(!request.includes(disallowed))
  const delivered = await group(groupId)
  assert.equal(delivered.notifyState, "delivered")
  assert.equal(delivered.notifyAttempts, 1)
  assert.equal(Number(delivered.deliveredAtSeconds), time / 1000)
  assert.equal(await classifyFixture(), groupId)
  await notifyHarnessFeedbackTick(clock, () => sender)
  assert.equal(requests.length, 1)
  assert.equal((await group(groupId)).reportCount, 2)
})

test("429 and 5xx back off for one and two minutes, then fail after three attempts", async () => {
  const id = await addGroup()
  let calls = 0
  const sender = makeSender(async () => new Response(null, { status: ++calls === 1 ? 429 : 503 }))
  for (const [index, delay] of [60_000, 120_000, 1].entries()) {
    await notifyHarnessFeedbackTick(clock, () => sender)
    const current = await group(id)
    assert.equal(current.notifyAttempts, index + 1)
    assert.equal(current.notifyState, index === 2 ? "failed" : "pending")
    assert.equal(current.notifyLeaseOwner, null)
    time += delay - 1
    await notifyHarnessFeedbackTick(clock, () => sender)
    assert.equal(calls, index + 1)
    time += 1
  }
})

test("4xx and a timeout both fail immediately and do not send again", async () => {
  for (const fetch of [async () => new Response(null, { status: 400 }), async () => { throw new DOMException("Fixture timeout", "TimeoutError") }]) {
    const id = await addGroup()
    let calls = 0
    const sender = makeSender(async () => { calls++; return fetch() })
    await notifyHarnessFeedbackTick(clock, () => sender)
    assert.equal((await group(id)).notifyState, "failed")
    assert.equal((await group(id)).notifyAttempts, 1)
    time += 300_000
    await notifyHarnessFeedbackTick(clock, () => sender)
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
  await notifyHarnessFeedbackTick(clock, () => sender)
  assert.equal((await group(id)).notifyState, "failed")
})

test("groups are not sent after their organization leaves the allowlist", async () => {
  await configure("PUT", orgSettings(outsideId))
  const id = await addGroup({ organizationId: outsideId })
  await configure("DELETE", orgSettings(outsideId))
  const sender: HarnessFeedbackSender = async () => assert.fail("outside group should not send")
  await notifyHarnessFeedbackTick(clock, () => sender)
  assert.equal((await group(id)).notifyState, "pending")
  assert.equal((await group(id)).notifyAttempts, 0)
})

test("Slack payloads escape controls and neutralize mentions; only definite pre-connect errors can retry", async () => {
  const tool = "demo&<> @channel @here <!everyone> <@U000>"
  const row = { id: createDenTypeId("harnessFeedbackGroup"), title: `Tool error (${tool})`, theme: "browser", category: "tool_error", tool } satisfies Parameters<HarnessFeedbackSender>[0]
  let inspected = false
  assert.equal(await makeSender(async (_url, options) => {
    const body = String(options?.body)
    assert.ok(!body.includes("@channel") && !body.includes("@here"))
    assert.ok(body.includes("demo&amp;‹› ＠channel ＠here ‹!everyone› ‹＠U000›"))
    inspected = true
    return new Response()
  })(row), "delivered")
  assert.ok(inspected)
  for (const [code, outcome] of [["ENOTFOUND", "transient"], ["ECONNRESET", "uncertain"], ["UND_ERR_SOCKET", "uncertain"]]) {
    assert.equal(await makeSender(async () => { throw new TypeError("fetch failed", { cause: { code } }) })(row), outcome)
  }
  assert.equal(await makeSender(async () => new Response(null, { status: 307 }))(row), "permanent")
})

test("settings are admin-only; webhook validation, storage, audit and tests do not disclose credentials", async (t) => {
  const stdout = t.mock.method(process.stdout, "write")
  const stderr = t.mock.method(process.stderr, "write")
  const endpoints: [Method, string][] = [["GET", settings], ["PUT", orgSettings(organizationId)], ["DELETE", orgSettings(organizationId)],
    ["PUT", slack], ["DELETE", slack], ["POST", `${slack}/test`]]
  for (const [method, endpoint] of endpoints) {
    for (const [token, status] of [[null, 401], [owner.token, 403]] satisfies [string | null, number][]) {
      const result = await den.request(token, method, endpoint)
      assert.equal(result.status, status, summary(result))
      assert.equal(result.headers.get("cache-control"), "no-store")
      assert.ok(!result.text.includes(webhook))
    }
  }
  for (const method of ["PUT", "DELETE"] satisfies Method[]) {
    assert.equal((await den.request(admin.token, method, orgSettings(createDenTypeId("organization")))).status, 404)
  }
  const invalid = [webhook.replace("https:", "http:"), webhook.replace("slack.com", "slack.com.example.test"), `${webhook}?token=fixture`, `${webhook}#fixture`]
  for (const value of invalid) {
    const result = await den.request(admin.token, "PUT", slack, { body: { webhookUrl: value } })
    assert.equal(result.status, 400)
    assert.ok(!result.text.includes(value))
  }
  assert.deepEqual(await configure("GET", settings), {
    organizations: [{ id: organizationId, name: "Notifier Fixture Organization" }], webhookConfigured: true, jevConfigured: false,
  })
  if (!("getConnection" in client)) throw new Error("Harness fixture requires disposable MySQL")
  const [stored] = await client.execute("SELECT webhook_url FROM harness_feedback_slack")
  assert.ok(Array.isArray(stored) && stored.length === 1)
  assert.ok(!JSON.stringify(stored).includes(webhook))
  const [audited] = await client.execute("SELECT * FROM platform_audit_event WHERE action LIKE 'platform.harness_feedback.slack.%'")
  assert.ok(Array.isArray(audited) && audited.length > 0)
  assert.ok(!JSON.stringify(audited).includes(webhook))
  const fake = t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, webhook)
    assert.equal(init?.redirect, "manual")
    assert.equal(init?.method, "POST")
    assert.equal(init?.body, JSON.stringify({ text: "Test message from OpenWork harness feedback.", mrkdwn: false, link_names: 0, parse: "none", unfurl_links: false, unfurl_media: false }))
    return new Response("fake Slack OK")
  })
  assert.deepEqual(await configure("POST", `${slack}/test`), { ok: true })
  assert.equal(fake.mock.callCount(), 1)
  fake.mock.mockImplementation(async () => { throw new Error(webhook) })
  const failed = await den.request(admin.token, "POST", `${slack}/test`)
  assert.equal(failed.status, 502)
  assert.ok(!failed.text.includes(webhook))
  await configure("DELETE", slack)
  assert.equal((await den.request(admin.token, "POST", `${slack}/test`)).status, 409)
  assert.equal(fake.mock.callCount(), 2)
  assert.deepEqual(await configure("GET", settings), {
    organizations: [{ id: organizationId, name: "Notifier Fixture Organization" }], webhookConfigured: false, jevConfigured: false,
  })
  const logs = [...stdout.mock.calls, ...stderr.mock.calls].map((call) => String(call.arguments[0])).join("\n")
  for (const value of [webhook, ...invalid]) assert.ok(!logs.includes(value))
})

test("running notifier observes organization and webhook changes without restarting or requiring Jev", async (t) => {
  await configure("DELETE", orgSettings(organizationId))
  const id = await addGroup()
  const timers = t.mock.method(globalThis, "setInterval")
  let calls = 0
  const stop = startHarnessFeedbackNotifier((options) => {
    assert.equal(options.webhookUrl, webhook)
    return async () => { calls++; return "delivered" }
  })
  try {
    const tick = timers.mock.calls[0]?.arguments[0]
    assert.ok(tick)
    assert.equal(env.agentEvaluationApiKey, undefined)
    await configure("PUT", slack, { webhookUrl: webhook })
    await tick()
    assert.equal(calls, 0)
    assert.equal((await group(id)).notifyLeaseOwner, null)
    await configure("DELETE", slack)
    await configure("PUT", orgSettings(organizationId))
    await tick()
    assert.equal(calls, 0)
    assert.equal((await group(id)).notifyLeaseOwner, null)
    await configure("PUT", slack, { webhookUrl: webhook })
    await tick()
    assert.equal(calls, 1)
    assert.equal((await group(id)).notifyState, "delivered")
  } finally {
    await stop()
  }
})
