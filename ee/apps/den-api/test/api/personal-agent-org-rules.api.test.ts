import assert from "node:assert/strict"
import { after, test } from "node:test"
import { automationRunReceiptSchema } from "@openwork/types/automations"
import { personalAgentDetailSchema, personalAgentEventListSchema, personalAgentRequestListSchema, personalAgentRunResponseSchema, personalAgentToolCatalogSchema } from "@openwork/types/den/personal-agents"
import { bootDen, field, list, startFakeHttpServer, startFakeMcpServer, summary, text } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const turns: { sessionId: string; messageId: string; token: string; prompt: string; model: string }[] = []
let holdRun = false
let releaseRun: (() => Promise<void>) | undefined
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  response.setHeader("content-type", "application/json")
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    response.writeHead(201).end(JSON.stringify({ id: `fixture-session-${turns.length + 1}` })); return
  }
  const sessionId = decodeURIComponent(url.pathname.split("/")[3] ?? "")
  if (request.method === "POST" && url.pathname.endsWith("/turns")) {
    const body: unknown = JSON.parse(raw)
    turns.push({ sessionId, messageId: text(field(body, "messageId"), "message id"), token: text(field(body, "credentials", "mcpToken"), "run token"), prompt: text(field(body, "prompt"), "prompt"), model: text(field(body, "model"), "model") })
    response.writeHead(202).end(JSON.stringify({ state: "queued" })); return
  }
  const turn = turns.find((entry) => entry.sessionId === sessionId)
  response.end(JSON.stringify({
    turns: turn ? [{ messageId: turn.messageId, status: holdRun ? "running" : "completed", model: turn.model, error: null, usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 30 } }] : [],
    messages: [], finalAssistantText: "Checked the tracker.", status: holdRun ? "running" : "idle",
  }))
})
const tracker = await startFakeMcpServer({ tools: [
  { name: "list_issues", description: "List bug tracker issues", text: "Listed issues", annotations: { readOnlyHint: true } },
  { name: "create_issue", description: "Create a bug tracker issue", text: "Created issue" },
] })
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_DEPLOYMENT: "cloud", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters" } })
after(async () => { await runner.close(); await tracker.close(); await den.close(); restoreCatalog() })
const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana Reyes", "dana@acme.test"), "Organization rules fixture")
const priya = await den.newMember(dana, orgId, "Priya Nair")
const sam = await den.newMember(dana, orgId, "Sam Okafor")
await grantGatewayModels(den, dana, orgId, [dana, priya, sam])
const asDana = den.as(dana, orgId)
const asPriya = den.as(priya, orgId)
const asSam = den.as(sam, orgId)

async function expectStatus<T extends { status: number; body: unknown }>(pending: Promise<T>, status: number) {
  const result = await pending
  assert.equal(result.status, status, JSON.stringify(result.body))
  return result.body
}

assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
const connected = await expectStatus(asDana("POST", "/v1/mcp-connections", {
  name: "Bug tracker", url: `${tracker.url}/mcp`, authType: "apikey", credentialMode: "per_member",
  access: { orgWide: false, memberIds: [dana.memberId, sam.memberId, priya.memberId], teamIds: [] },
}), 200)
const connectionId = text(field(connected, "id"), "connection id")
const credentialPath = `/v1/mcp-connections/${connectionId}/my-credential`
const samKey = "fixture-sam-tracker-key"
const priyaKey = "fixture-priya-tracker-key"
for (const [as, apiKey] of [[asDana, "fixture-dana-tracker-key"], [asSam, samKey], [asPriya, priyaKey]] as const) {
  await expectStatus(as("PUT", credentialPath, { apiKey }), 200)
}
const brief = "Check the bug tracker."
const agent = personalAgentDetailSchema.parse(await expectStatus(asDana("POST", "/v1/personal-agents", { name: "Bug watcher", brief }), 201))
const path = `/v1/personal-agents/${agent.agent.id}`
await expectStatus(asDana("POST", `${path}/routines`, {
  name: "Morning", instructions: "Check for new issues.", schedule: { kind: "daily", hour: 8, minute: 0, timezone: "UTC" },
}), 201)
await expectStatus(asDana("PUT", `${path}/shares/${priya.memberId}`, { role: "collaborator" }), 200)
await expectStatus(asDana("PUT", `${path}/shares/${sam.memberId}`, { role: "manager" }), 200)

async function run() {
  const release = releaseRun
  releaseRun = undefined
  await release?.()
  const before = turns.length
  holdRun = true
  const started = personalAgentRunResponseSchema.parse(await expectStatus(asPriya("POST", `${path}/run`, {}), 202))
  const receipt = async () => automationRunReceiptSchema.parse(await expectStatus(asPriya("GET", `${path}/runs/${started.run.id}`), 200))
  releaseRun = async () => {
    holdRun = false
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await receipt()).run.status === "succeeded") return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Run did not finish")
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const turn = turns[before]
    if (turn && (await receipt()).run.status === "running") return { ...turn, runId: started.run.id }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Run did not start")
}

const policyPath = "/v1/org/personal-agent-policy"
const policy = (choice?: "allow" | "ask" | "block") => ({ toolPolicy: { tools: choice ? { [connectionId]: { create_issue: choice } } : {} } })
const updateOrg = (change: object) => expectStatus(asDana("PUT", policyPath, change), 200)
const updateAgent = (choice?: "allow" | "ask" | "block") => expectStatus(asDana("PATCH", path, policy(choice)), 200)
const execute = (token: string, tool = "create_issue") => den.callMcpTool(token, "execute_capability", { name: `mcp:${connectionId}:${tool}`, body: {} })
const providerCalls = () => tracker.wire.filter((entry) => entry.rpcMethod === "tools/call")
const requests = async () => personalAgentRequestListSchema.parse(await expectStatus(asPriya("GET", `${path}/requests`), 200)).items
const connectionFrom = (body: unknown) => {
  const found = personalAgentToolCatalogSchema.parse(body).connections.find((connection) => connection.connectionId === connectionId)
  assert.ok(found)
  return found
}
const catalog = async () => connectionFrom(await expectStatus(asPriya("GET", `${path}/tools`), 200))

async function refused(token: string, error: "needs_approval" | "policy_blocked") {
  const before = providerCalls().length
  const result = await execute(token)
  assert.equal(result.isError, true, result.raw)
  assert.equal(field(result.body, "error"), error, result.raw)
  assert.equal(providerCalls().length, before)
}

test("organization rules arrive before the brief and a blank rule leaves the runner prompt unchanged", async () => {
  const { prompt: original } = await run()
  assert.doesNotMatch(original, /organization_rules/)
  const rules = "Use only the internal tracker."
  await updateOrg({ rules: `  ${rules}\n ` })
  const { prompt } = await run()
  assert.match(prompt, /Follow them first if they conflict with the agent's brief or the task\./)
  assert.ok(prompt.includes(`<organization_rules>\n${rules}\n</organization_rules>`), prompt)
  assert.ok(prompt.indexOf(rules) < prompt.indexOf(brief), prompt)
  await updateOrg({ rules: "  " })
  assert.equal((await run()).prompt, original)
})

test("live organization ask beats permanent allow, but Allow once works for one run", async () => {
  await updateAgent("allow")
  const issued = await run()
  await updateOrg(policy("ask"))
  await refused(issued.token, "needs_approval")
  const tool = (await catalog()).tools.find(({ name }) => name === "create_issue")
  assert.equal(tool?.organizationRule, "ask")
  assert.equal(tool?.chosen, "allow")
  assert.equal(tool?.access, "ask")
  const waiting = (await requests()).find(({ status }) => status === "pending")
  assert.ok(waiting)
  assert.equal(waiting.runId, issued.runId)
  assert.equal(waiting.requestedBy.memberId, priya.memberId)
  await expectStatus(asPriya("POST", `${path}/requests/${waiting.id}/decision`, { decision: "allow_once" }), 200)
  const once = await execute((await run()).token)
  assert.equal(once.isError, false, once.raw)
  await refused((await run()).token, "needs_approval")
})

test("organization allow permits an unset write, agent ask and block win over allow, and organization block beats Allow once", async () => {
  await updateOrg(policy("allow"))
  await updateAgent()
  const tool = (await catalog()).tools.find(({ name }) => name === "create_issue")
  assert.equal(tool?.organizationRule, "allow")
  assert.equal(tool?.chosen, null)
  assert.equal(tool?.access, "allow")
  const enabled = await execute((await run()).token)
  assert.equal(enabled.isError, false, enabled.raw)
  await updateAgent("ask")
  await refused((await run()).token, "needs_approval")
  await updateAgent("block")
  await refused((await run()).token, "policy_blocked")
  await updateAgent("allow")
  const waiting = (await requests()).find(({ status }) => status === "pending")
  assert.ok(waiting)
  await expectStatus(asPriya("POST", `${path}/requests/${waiting.id}/decision`, { decision: "allow_once" }), 200)
  const once = await run()
  await updateOrg(policy("block"))
  await refused(once.token, "policy_blocked")
  assert.equal((await requests()).find(({ id }) => id === waiting.id)?.status, "allowed_once")
  const blocked = (await catalog()).tools.find(({ name }) => name === "create_issue")
  assert.equal(blocked?.lockedByOrganization, true)
  assert.equal(blocked?.organizationRule, null)
})

test("shared logins use the lender in both paths and do not return after revocation", async () => {
  const loginPath = `${path}/shared-logins/${connectionId}`
  const lend = (shared: boolean) => asSam("PUT", loginPath, { shared })
  assert.deepEqual(await expectStatus(lend(true), 403), { error: "personal_agent_shared_logins_off", message: "Your admin has not allowed shared logins." })
  await updateOrg({ sharedLogins: true })
  await expectStatus(asPriya("PUT", loginPath, { shared: true }), 403)
  const own = await run()
  async function readsWith(token: string, apiKey: string) {
    const before = providerCalls().length
    const result = await execute(token, "list_issues")
    assert.equal(result.isError, false, result.raw)
    assert.deepEqual(providerCalls().slice(before).map(({ authorization }) => authorization), [`Bearer ${apiKey}`])
  }
  await readsWith(own.token, priyaKey)
  const lent = connectionFrom(await expectStatus(lend(true), 200))
  assert.deepEqual(lent.sharedLogin, { memberId: sam.memberId, name: "Sam Okafor" })
  assert.equal(lent.canShareLogin, true)
  const collaborator = await catalog()
  assert.deepEqual(collaborator.sharedLogin, lent.sharedLogin)
  assert.equal(collaborator.canShareLogin, false)
  const shared = await run()
  await readsWith(shared.token, samKey)
  const discovered = await den.callMcpTool(shared.token, "search_capabilities", { query: "bug tracker list issues", type: "mcp", limit: 20 })
  assert.ok(list(field(discovered.body, "matches")).some((item) => item.name === `mcp:${connectionId}:list_issues`), discovered.raw)
  const beforeProxy = providerCalls().length
  const proxy = await den.request(shared.token, "POST", `/mcp/agent/connections/${connectionId}`, {
    headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name: "list_issues", body: {} } } },
  })
  assert.match(proxy.text, /Listed issues/, summary(proxy))
  assert.deepEqual(providerCalls().slice(beforeProxy).map(({ authorization }) => authorization), [`Bearer ${samKey}`])
  await updateOrg({ sharedLogins: false })
  await readsWith(shared.token, priyaKey)
  assert.equal((await catalog()).sharedLogin, null)
  await expectStatus(lend(false), 200)
  await updateOrg({ sharedLogins: true })
  assert.equal((await catalog()).sharedLogin, null)
  await expectStatus(lend(true), 200)
  await expectStatus(asSam("POST", `/v1/mcp-connections/${connectionId}/disconnect-my-account`), 200)
  assert.equal((await catalog()).sharedLogin, null)
  await expectStatus(lend(false), 200)
  await expectStatus(asSam("PUT", credentialPath, { apiKey: samKey }), 200)
  assert.equal((await catalog()).sharedLogin, null)
  await expectStatus(lend(true), 200)
  await expectStatus(asDana("PUT", loginPath, { shared: false }), 200)
  assert.equal((await catalog()).sharedLogin, null)
  await expectStatus(lend(true), 200)
  await expectStatus(asDana("PUT", `${path}/shares/${sam.memberId}`, { role: "collaborator" }), 200)
  await expectStatus(asDana("PUT", `${path}/shares/${sam.memberId}`, { role: "manager" }), 200)
  assert.equal((await catalog()).sharedLogin, null)
  await readsWith(shared.token, priyaKey)
  const removed = connectionFrom(await expectStatus(asDana("PUT", loginPath, { shared: false }), 200))
  assert.equal(removed.sharedLogin, null)
  await expectStatus(lend(true), 200)
  await expectStatus(asDana("DELETE", `/v1/members/${sam.memberId}`), 204)
  const { db } = await import("../../src/db.js")
  const { PersonalAgentSharedLoginTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  assert.deepEqual(await db.$primary.select().from(PersonalAgentSharedLoginTable).where(eq(PersonalAgentSharedLoginTable.agent_id, normalizeDenTypeId("personalAgent", agent.agent.id))), [])
  await releaseRun?.()
  const events = personalAgentEventListSchema.parse(await expectStatus(asDana("GET", `/v1/org/personal-agent-events?agentId=${agent.agent.id}`), 200)).items
  assert.ok(events.some(({ actor, action, detail }) => action === "share.changed" && actor.memberId === sam.memberId && detail.what === "shared_login" && detail.connection === "Bug tracker" && detail.on === true))
  assert.ok(events.some(({ action, detail }) => action === "share.changed" && detail.what === "shared_login" && detail.on === false))
})

test("400 organization tool blocks do not prevent admission and live removal allows the next call", async () => {
  const { replaceSubjectToolPolicy } = await import("../../src/tool-permissions/rules.js")
  const { toolPermissionRefusal } = await import("../../src/tool-permissions/dispatch.js")
  const { verifyMcpRequest } = await import("../../src/mcp/auth.js")
  const { toolsWithheld } = await import("../../src/mcp/workbot-turn-limits.js")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  const org = normalizeDenTypeId("organization", orgId)
  const subject = { organizationId: org, kind: "organization", id: org } as const
  const tools = ["list_issues", ...Array.from({ length: 399 }, (_, index) => `${"é".repeat(60)}_${index}`)]
  const rules = Object.fromEntries(tools.map((tool) => [tool, "block"] as const))
  await replaceSubjectToolPolicy(subject, { connections: {}, tools: { [connectionId]: rules } }, dana.memberId)
  try {
    const live = await run()
    const principal = await verifyMcpRequest(new Headers({ authorization: `Bearer ${live.token}` }))
    assert.ok(!(principal instanceof Response))
    const hidden = toolsWithheld(principal.scopes)?.get(connectionId)
    assert.ok(hidden && hidden.size <= 200 && hidden.size < tools.length)
    for (const toolName of tools) {
      const refusal = await toolPermissionRefusal({ scopes: principal.scopes, connection: { id: connectionId, name: "Bug tracker", organizationId: org },
        tool: { name: toolName, annotations: { readOnlyHint: true } }, actingMemberId: priya.memberId })
      assert.equal(refusal?.error, "policy_blocked", toolName)
    }
    const blocked = await execute(live.token, "list_issues")
    assert.equal(field(blocked.body, "error"), "policy_blocked", blocked.raw)
    await replaceSubjectToolPolicy(subject, { connections: {}, tools: {} }, dana.memberId)
    const unblocked = await execute(live.token, "list_issues")
    assert.equal(unblocked.isError, false, unblocked.raw)
    await replaceSubjectToolPolicy(subject, { connections: { [connectionId]: "block" }, tools: {} }, dana.memberId)
    const withheld = await run()
    await replaceSubjectToolPolicy(subject, { connections: {}, tools: {} }, dana.memberId)
    const allowed = await execute(withheld.token, "list_issues")
    assert.equal(allowed.isError, false, allowed.raw)
  } finally {
    await replaceSubjectToolPolicy(subject, { connections: {}, tools: {} }, dana.memberId)
    await releaseRun?.()
  }
})
