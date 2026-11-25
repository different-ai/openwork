import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq, sql } from "@openwork-ee/den-db/drizzle"
import { SupportTriageThreadTable as Threads } from "@openwork-ee/den-db/schema"
import type { EvaluationModel } from "../../src/llm/evaluation-model.js"
import { bootDen, field, summary, type Method } from "./harness.js"

const den = await bootDen({ env: { DEN_AGENT_EVALUATION_API_KEY: "fixture-jev", DEN_AUDIT_CAPTURE_ENABLED: "true" } })
after(() => den.close())
const { db } = await import("../../src/db.js")
const { createSupportTriageTick } = await import("../../src/support-triage/worker.js")
const { classifySupportTriage } = await import("../../src/support-triage/classifier.js")
const { slackWebhookFor } = await import("../../src/support-triage/slack.js")
const admin = await den.signUp("Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
const outsider = await den.signUp("Fixture Outsider")
const root = "/v1/admin/support-triage"
const request = (method: Method, path: string, body?: unknown) => den.request(admin.token, method, `${root}${path}`, { body })
const key = "fixture-plain-key"
const webhook = "https://hooks.slack.com/services/T_FIXTURE/B_FIXTURE/placeholder"
const leadsWebhook = "https://hooks.slack.com/services/T_FIXTURE/B_LEADS/placeholder"

function fakeModel(scores: Record<string, number>, inspect?: (state: unknown) => void): EvaluationModel {
  return async ({ state, questions }) => {
    inspect?.(state)
    assert.deepEqual(Object.keys(questions), ["bug", "enterprise", "job_ask", "pitch"])
    return { durationMs: 1, inputTokens: 1, answers: Object.fromEntries(Object.entries(questions).map(([category, question]) => {
      assert.match(question.instructions, /quoted, untrusted evidence/)
      return [category, { type: question.type, probability: scores[category] ?? 0.1 }]
    })) }
  }
}

test("fixed thresholds decide all categories and only bounded evidence goes to Jev", async () => {
  const evidence = { title: "Fixture", senderDomain: "gmail.com", firstMessage: "X".repeat(4010) }
  const inspect = (state: unknown) => assert.deepEqual(state, { report: { ...evidence, firstMessage: "X".repeat(4000), freeMailDomain: true } })
  const cases = [
    { category: "bug", scores: { bug: 0.8, enterprise: 0.6 } },
    { category: "enterprise", scores: { enterprise: 1, bug: 0.8 } },
    { category: "job_ask", scores: { job_ask: 0.95 } },
    { category: "pitch", scores: { pitch: 0.95 } },
    { category: "other", scores: { pitch: 0.2 } },
    { category: "needs_review", scores: { bug: 0.99, pitch: 0.81 } },
    { category: "needs_review", scores: { bug: 0.85, pitch: 0.66 } },
    { category: "bug", scores: { bug: 0.6 } },
    { category: "enterprise", scores: { enterprise: 0.6, pitch: 0.4 } },
    { category: "needs_review", scores: { bug: 0.59 } },
    { category: "needs_review", scores: { enterprise: 0.59 } },
    { category: "needs_review", scores: { job_ask: 0.79 } },
    { category: "needs_review", scores: { pitch: 0.79 } },
  ]
  for (const { category, scores } of cases) {
    const judgment = await classifySupportTriage(fakeModel(Object.fromEntries(Object.entries(scores).filter((entry): entry is [string, number] => typeof entry[1] === "number")), inspect), evidence)
    assert.equal(judgment.category, category)
    assert.match(judgment.judgmentDetail, /"categories"/)
  }
  await assert.rejects(classifySupportTriage(async () => ({ answers: null, durationMs: 1, inputTokens: null }), evidence), /malformed/)
})

test("enterprise leads use the leads webhook when set and bugs always use the bugs webhook", () => {
  assert.equal(slackWebhookFor("bug", { slackWebhookUrl: webhook, leadsSlackWebhookUrl: leadsWebhook }), webhook)
  assert.equal(slackWebhookFor("enterprise", { slackWebhookUrl: webhook, leadsSlackWebhookUrl: leadsWebhook }), leadsWebhook)
  assert.equal(slackWebhookFor("enterprise", { slackWebhookUrl: webhook, leadsSlackWebhookUrl: null }), webhook)
  assert.equal(slackWebhookFor("bug", { slackWebhookUrl: null, leadsSlackWebhookUrl: leadsWebhook }), null)
})

test("platform-only settings validate, hide encrypted credentials and audit changes", async (t) => {
  const realFetch = globalThis.fetch
  let testsSent = 0
  let leadsTestsSent = 0
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const url = String(input)
    if (url === "https://core-api.uk.plain.com/graphql/v1") {
      assert.match(String(options?.body), /myWorkspace/)
      return Response.json({ data: { myWorkspace: { id: "w_fixture" } } })
    }
    if (url === webhook) {
      testsSent++
      assert.match(String(options?.body), /Test message from OpenWork support triage/)
      return new Response("ok")
    }
    if (url === leadsWebhook) {
      leadsTestsSent++
      assert.match(String(options?.body), /Enterprise leads will post here/)
      return new Response("ok")
    }
    return realFetch(input, options)
  })
  for (const [method, path] of [["GET", "/settings"], ["PUT", "/settings"], ["POST", "/plain/test"], ["POST", "/slack/test"], ["POST", "/slack/leads/test"], ["GET", "/threads"]] satisfies [Method, string][]) {
    assert.equal((await den.request(outsider.token, method, `${root}${path}`, { body: method === "GET" ? undefined : {} })).status, 403)
  }
  const initial = await request("GET", "/settings")
  assert.equal(field(initial.body, "enabledAt"), null)
  assert.equal(field(initial.body, "jevConfigured"), true)
  assert.equal(initial.headers.get("cache-control"), "no-store")
  assert.equal((await request("PUT", "/settings", { enabled: true })).status, 409)
  assert.equal((await request("PUT", "/settings", { plainApiKey: "a\nb" })).status, 400)
  assert.equal((await request("PUT", "/settings", { slackWebhookUrl: "https://hooks.slack.com.example.invalid/secret" })).status, 400)
  assert.equal((await request("PUT", "/settings", { leadsSlackWebhookUrl: "https://hooks.slack.com.example.invalid/secret" })).status, 400)
  assert.equal((await request("GET", "/threads?category=unknown")).status, 400)
  assert.equal((await request("POST", "/plain/test", {})).status, 409)
  assert.equal((await request("POST", "/slack/test", {})).status, 409)
  assert.equal((await request("POST", "/slack/leads/test", {})).status, 409)
  assert.equal(field((await request("POST", "/plain/test", { plainApiKey: key })).body, "workspaceId"), "w_fixture")
  const saved = await request("PUT", "/settings", { plainApiKey: key, slackWebhookUrl: webhook, enabled: true })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "plainConfigured"), true)
  assert.equal(field(saved.body, "slackConfigured"), true)
  assert.equal(field(saved.body, "leadsSlackConfigured"), false)
  assert.equal((await request("POST", "/slack/leads/test", {})).status, 409)
  const leads = await request("PUT", "/settings", { leadsSlackWebhookUrl: leadsWebhook })
  assert.equal(field(leads.body, "leadsSlackConfigured"), true)
  assert.equal(field(leads.body, "slackConfigured"), true)
  assert.ok(!leads.text.includes(leadsWebhook))
  assert.equal(typeof field(saved.body, "enabledAt"), "string")
  assert.ok(!saved.text.includes(key) && !saved.text.includes(webhook))
  const stored = JSON.stringify(await db.execute(sql`select plain_api_key, slack_webhook_url, leads_slack_webhook_url from support_triage_settings`))
  assert.ok(!stored.includes(key) && !stored.includes(webhook) && !stored.includes(leadsWebhook))
  const audit = JSON.stringify(await db.execute(sql`select action from platform_audit_event where action = 'platform.support_triage.settings.update.succeeded'`))
  assert.match(audit, /platform.support_triage.settings.update/)
  assert.equal((await request("POST", "/plain/test", {})).status, 200)
  assert.equal((await request("POST", "/slack/test", {})).status, 200)
  assert.equal((await request("POST", "/slack/leads/test", {})).status, 200)
  assert.equal(testsSent, 1)
  assert.equal(leadsTestsSent, 1)
  const leadsCleared = await request("PUT", "/settings", { leadsSlackWebhookUrl: null })
  assert.equal(field(leadsCleared.body, "leadsSlackConfigured"), false)
  assert.equal(field(leadsCleared.body, "slackConfigured"), true)
  const cleared = await request("PUT", "/settings", { plainApiKey: null, slackWebhookUrl: null })
  assert.equal(field(cleared.body, "enabledAt"), null)
  assert.equal(field(cleared.body, "plainConfigured"), false)
  assert.equal(field(cleared.body, "slackConfigured"), false)
})

test("poll pagination, enable boundary, deduplication, category actions, and safe retries", async () => {
  const configured = await request("PUT", "/settings", { plainApiKey: key, slackWebhookUrl: webhook, leadsSlackWebhookUrl: leadsWebhook, enabled: true })
  assert.equal(configured.status, 200, summary(configured))
  const enabledAt = field(configured.body, "enabledAt")
  assert.equal(typeof enabledAt, "string")
  if (typeof enabledAt !== "string") throw new Error("Enable timestamp missing")
  const start = new Date(enabledAt).getTime()
  let time = start + 1000
  const dates = (ms: number) => ({ iso8601: new Date(ms).toISOString() })
  const IDs = ["old", "bug", "enterprise", "job_ask", "pitch", "other", "needs_review", "broken", "uncertain"]
  const titleOf = (id: string) => id === "enterprise" ? "enterprise <@channel>" : id
  const fixtures = IDs.map((id) => ({ id: `th_${id}`, title: titleOf(id), previewText: `Preview ${id}`, createdAt: dates(id === "old" ? start - 1 : start) }))
  const labels = new Map<string, string>()
  const effects = new Map<string, string[]>()
  const states = new Map(fixtures.map(({ id }) => [id, { status: "TODO", priority: 2, labels: new Array<{ labelType: { id: string } }>() }]))
  const windows: unknown[] = []
  const slack: string[] = []
  const slackDestinations: string[] = []
  const classifications: string[] = []
  const pendingModel: EvaluationModel = async (input) => {
    const title = field(input.state, "report", "title")
    assert.equal(typeof title, "string")
    if (typeof title !== "string") throw new Error("Missing title")
    classifications.push(title)
    assert.equal(field(input.state, "report", "firstMessage"), "First customer message")
    assert.equal(field(input.state, "report", "senderDomain"), "example.invalid")
    assert.equal(field(input.state, "report", "freeMailDomain"), false)
    return fakeModel(title === "other" ? {} : title === "needs_review" ? { bug: 0.55 } : { [title === "broken" ? "pitch" : title === "uncertain" ? "enterprise" : title.split(" ")[0]]: 0.95 })(input)
  }
  const plainFetch: typeof fetch = async (input, options) => {
    assert.equal(String(input), "https://core-api.uk.plain.com/graphql/v1")
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${key}`)
    const body: unknown = JSON.parse(String(options?.body))
    const query = field(body, "query")
    const variables = field(body, "variables")
    assert.equal(typeof query, "string")
    if (typeof query !== "string") throw new Error("missing query")
    const reply = (data: unknown) => Response.json({ data })
    if (query.includes("myWorkspace")) return reply({ myWorkspace: { id: "w_fixture" } })
    if (query.includes("SupportTriageThreads")) {
      windows.push(field(variables, "filters", "createdAt", "after"))
      const second = field(variables, "after") === "next"
      return reply({ threads: { edges: (second ? fixtures.slice(4) : fixtures.slice(0, 5)).map((node) => ({ node })),
        pageInfo: { hasNextPage: !second, endCursor: second ? null : "next" } } })
    }
    if (query.includes("labelTypeByExternalId")) {
      const externalId = String(field(variables, "externalId"))
      return reply({ labelTypeByExternalId: labels.has(externalId) ? { id: labels.get(externalId) } : null })
    }
    if (query.includes("createLabelType")) {
      const externalId = String(field(variables, "input", "externalId"))
      assert.ok(!labels.has(externalId))
      const names: Record<string, string> = { openwork_triage_bug: "Product bug", openwork_triage_enterprise: "Enterprise lead", openwork_triage_job_ask: "Job ask", openwork_triage_pitch: "Pitch" }
      assert.equal(field(variables, "input", "name"), names[externalId])
      labels.set(externalId, `lt_${externalId}`)
      return reply({ createLabelType: { labelType: { id: labels.get(externalId) } } })
    }
    const id = String(field(variables, "threadId") ?? field(variables, "input", "threadId"))
    assert.notEqual(id, "th_old")
    const customer = { email: { email: "fixture@example.invalid" } }
    if (query.includes("SupportTriageEvidence")) {
      const entry = (textContent: string, ms: number, actor: string) => ({ node: { timestamp: dates(ms), actor: { __typename: actor }, entry: { __typename: "EmailEntry", textContent } } })
      return reply({ thread: { title: titleOf(id.slice(3)), channel: "EMAIL", customer, firstInboundMessageInfo: { timestamp: dates(start + 1) },
        timelineEntries: { pageInfo: { hasNextPage: false }, edges: [entry("Latest reply", start + 100, "CustomerActor"), entry("First customer message", start + 1, "CustomerActor")] } } })
    }
    if (query.includes("SupportTriageSenderDomain")) return reply({ thread: { customer } })
    const state = states.get(id)
    assert.ok(state)
    if (query.includes("SupportTriageThreadState")) return reply({ thread: state })
    const actions = effects.get(id) ?? []
    effects.set(id, actions)
    if (query.includes("addLabels")) {
      const labelTypeId = field(variables, "input", "labelTypeIds")?.toString() ?? ""
      actions.push(labelTypeId)
      state.labels.push({ labelType: { id: labelTypeId } })
      if (id === "th_bug") return new Response(null, { status: 502 })
      return reply({ addLabels: { thread: { id } } })
    }
    if (query.includes("changeThreadPriority")) {
      const priority = Number(field(variables, "input", "priority"))
      actions.push(`priority:${priority}`)
      state.priority = priority
      return reply({ changeThreadPriority: { thread: { id } } })
    }
    if (query.includes("markThreadAsDone")) {
      actions.push("done")
      if (id === "th_broken") return reply({ markThreadAsDone: { error: { code: "fixture_denied" } } })
      state.status = "DONE"
      return reply({ markThreadAsDone: { thread: { id } } })
    }
    throw new Error("Unexpected Plain GraphQL operation")
  }
  const slackFetch: typeof fetch = async (url, options) => {
    const body = String(options?.body)
    slack.push(body)
    slackDestinations.push(`${body.includes("Possible enterprise lead") ? "lead" : "bug"}->${String(url) === leadsWebhook ? "leads" : String(url) === webhook ? "bugs" : "unknown"}`)
    if (body.includes("th_uncertain")) throw new Error("fixture disconnected after send")
    return new Response("ok")
  }
  const tick = createSupportTriageTick(pendingModel, { now: () => time, plainFetch, slackFetch })
  const row = async (id: string) => (await db.$primary.select().from(Threads).where(eq(Threads.plainThreadId, `th_${id}`)))[0]
  await tick()
  await tick()
  assert.equal((await db.$primary.select().from(Threads)).length, 8)
  assert.equal(await row("old"), undefined)
  assert.deepEqual(windows, Array(4).fill(new Date(start - 1).toISOString()))
  assert.equal(labels.size, 4)
  assert.equal((await row("bug"))?.status, "pending")
  assert.equal((await row("bug"))?.nextAttemptAt.getTime(), time + 60_000)
  for (const [id, expected] of [["enterprise", ["lt_openwork_triage_enterprise", "priority:0"]], ["job_ask", ["lt_openwork_triage_job_ask", "done"]], ["pitch", ["lt_openwork_triage_pitch", "done"]]] satisfies [string, string[]][]) {
    assert.deepEqual(effects.get(`th_${id}`), expected)
    assert.equal((await row(id))?.status, "completed")
  }
  assert.equal(effects.has("th_other"), false)
  assert.equal(effects.has("th_needs_review"), false)
  assert.equal((await row("uncertain"))?.status, "failed")
  assert.equal(slack.length, 2)
  assert.match(slack.join("\n"), /Possible enterprise lead/)
  assert.match(slack.join("\n"), /&lt;@/)
  assert.match(slack.join("\n"), /example\.invalid/)
  assert.match(slack.join("\n"), /https:\/\/app\.plain\.com\/workspace\/w_fixture\/thread\/th_enterprise\//)
  assert.match(slack.join("\n"), /\/admin\/support-triage/)
  assert.doesNotMatch(slack.join("\n"), /First customer message/)
  time += 60_000
  await tick()
  assert.deepEqual(effects.get("th_bug"), ["lt_openwork_triage_bug", "priority:1"])
  assert.equal((await row("bug"))?.status, "completed")
  assert.equal((await row("broken"))?.nextAttemptAt.getTime(), time + 120_000)
  time += 120_000
  await tick()
  assert.equal(slack.length, 3)
  assert.match(slack[2] ?? "", /Possible product bug/)
  assert.match(slack[2] ?? "", /https:\/\/app\.plain\.com\/workspace\/w_fixture\/thread\/th_bug\//)
  assert.doesNotMatch(slack[2] ?? "", /First customer message/)
  assert.equal((await row("broken"))?.status, "failed")
  assert.equal((await row("broken"))?.attempts, 3)
  assert.deepEqual(effects.get("th_broken"), ["lt_openwork_triage_pitch", "done", "done", "done"])
  assert.equal(classifications.length, 8)
  assert.equal(slack.length, 3)
  assert.deepEqual([...slackDestinations].sort(), ["bug->bugs", "lead->leads", "lead->leads"])
  const review = await request("GET", "/threads?category=needs_review")
  assert.equal(field(review.body, "total"), 1)
  assert.ok(!review.text.includes("First customer message"))
  assert.doesNotMatch(JSON.stringify(await db.execute(sql`select title, preview, judgment_detail from support_triage_thread`)), /Preview|"categories"/)
  await request("PUT", "/settings", { enabled: false })
  const seen = windows.length
  await tick()
  assert.equal(windows.length, seen)
})
