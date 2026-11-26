import assert from "node:assert/strict"
import { after, test } from "node:test"
import { automationDetailSchema, automationRunReceiptSchema } from "@openwork/types/automations"
import { personalAgentDetailSchema, personalAgentEventListSchema, personalAgentRequestListSchema, personalAgentRequestSchema, personalAgentRunResponseSchema, personalAgentToolCatalogSchema } from "@openwork/types/den/personal-agents"
import { bootDen, field, list, startFakeHttpServer, startFakeMcpServer, summary, text } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const turns: { sessionId: string; messageId: string; token: string; model: string }[] = []
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
    turns.push({ sessionId, messageId: text(field(body, "messageId"), "message id"), token: text(field(body, "credentials", "mcpToken"), "run token"), model: text(field(body, "model"), "model") })
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
  { name: "List_issues", description: "List Bug tracker issues with a different name", text: "Listed issues", annotations: { readOnlyHint: true } },
  { name: "create_issue", description: "Create a bug tracker issue", text: "Created issue" },
  { name: "delete_issue", description: "Delete a bug tracker issue", text: "Deleted issue", annotations: { readOnlyHint: true, destructiveHint: true } },
] })
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_DEPLOYMENT: "cloud", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters" } })
after(async () => { await runner.close(); await tracker.close(); await den.close(); restoreCatalog() })
const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana Reyes", "dana@acme.test"), "Permissions fixture")
const priya = await den.newMember(dana, orgId, "Priya Nair")
const sam = await den.newMember(dana, orgId, "Sam Okafor")
await grantGatewayModels(den, dana, orgId, [dana, priya, sam])
const asDana = den.as(dana, orgId)
const asPriya = den.as(priya, orgId)
const asSam = den.as(sam, orgId)
const enabled = await den.setFeature(orgId, "personalAgents", true)
assert.equal(enabled.status, 200, summary(enabled))
const connected = await asDana("POST", "/v1/mcp-connections", {
  name: "Bug tracker", url: `${tracker.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] },
})
assert.equal(connected.status, 200, summary(connected))
const connectionId = text(field(connected.body, "id"), "connection id")
const created = await asDana("POST", "/v1/personal-agents", { name: "Bug watcher", brief: "Check the bug tracker." })
assert.equal(created.status, 201, summary(created))
const agent = personalAgentDetailSchema.parse(created.body)
const path = `/v1/personal-agents/${agent.agent.id}`
const schedule = { kind: "daily", hour: 8, minute: 0, timezone: "UTC" }
const routine = await asDana("POST", `${path}/routines`, { name: "Morning", instructions: "Check for new issues.", schedule })
assert.equal(routine.status, 201, summary(routine))
const routineId = automationDetailSchema.parse(routine.body).automation.id
for (const [member, role] of [[priya, "collaborator"], [sam, "manager"]] as const) {
  const share = await asDana("PUT", `${path}/shares/${member.memberId}`, { role })
  assert.equal(share.status, 200, summary(share))
}

async function run(as = asPriya, hold = false) {
  const release = releaseRun
  releaseRun = undefined
  await release?.()
  const before = turns.length
  holdRun = hold
  const started = await as("POST", `${path}/run`, {})
  assert.equal(started.status, 202, summary(started))
  const result = personalAgentRunResponseSchema.parse(started.body)
  const receiptPath = `${path}/runs/${result.run.id}`
  async function wait(active: boolean) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const read = await as("GET", receiptPath)
      assert.equal(read.status, 200, summary(read))
      const receipt = automationRunReceiptSchema.parse(read.body)
      if (active ? receipt.run.status === "running" && turns[before] : receipt.run.finishedAt !== null) return receipt
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Run did not reach the expected state")
  }
  const receipt = await wait(hold)
  if (hold) releaseRun = async () => { holdRun = false; await wait(false) }
  return { ...result, receipt, token: turns[before]?.token }
}

async function admitted(as = asPriya) {
  const result = await run(as, true)
  assert.equal(result.receipt.run.status, "running", JSON.stringify(result.receipt.run.error))
  assert.ok(result.token)
  return { ...result, token: result.token }
}

function execute(token: string, tool = "create_issue") {
  return den.callMcpTool(token, "execute_capability", { name: `mcp:${connectionId}:${tool}`, body: {} })
}

async function asks(token: string, tool?: string) {
  const refused = await execute(token, tool)
  assert.equal(refused.isError, true, refused.raw)
  assert.equal(field(refused.body, "error"), "needs_approval", refused.raw)
  assert.equal(field(refused.body, "retryable"), false, refused.raw)
}

async function requests(as = asPriya) {
  const res = await as("GET", `${path}/requests`)
  assert.equal(res.status, 200, summary(res))
  return personalAgentRequestListSchema.parse(res.body).items
}

function decide(as: typeof asDana, id: string, decision: string) {
  return as("POST", `${path}/requests/${id}/decision`, { decision })
}

function providerCalls() {
  return tracker.wire.filter((entry) => entry.rpcMethod === "tools/call").length
}

test("the shared native dispatch used by direct and Code Mode calls only allows reads", async () => {
  const { Hono } = await import("hono")
  const { z } = await import("zod")
  const { invokeMcpOperation } = await import("../../src/mcp/invoke.js")
  const { personalAgentRunScope } = await import("../../src/mcp/workbot-turn-limits.js")
  const { automationRepository } = await import("../../src/automations/repository.js")
  const routine = await automationRepository.get({ organizationId: orgId, ownerMemberId: dana.memberId, automationId: routineId })
  assert.ok(routine)
  const claim = await automationRepository.claim({ ...routine, trigger: "manual", scheduledFor: null, nonce: "native-dispatch", leaseOwner: "fixture", leaseMs: 60_000, now: Date.now() })
  const { db } = await import("../../src/db.js")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  const { AutomationRunTable } = await import("@openwork-ee/den-db/schema")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  await db.update(AutomationRunTable).set({ status: "claimed" }).where(eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", claim.run.id)))
  const app = new Hono()
  const path = "/v1/capabilities/google-workspace/calendar-events"
  let calls = 0
  app.all(path, (c) => { calls += 1; return c.json({ read: true }) })
  const principal = { organizationId: orgId, userId: dana.userId, scopes: new Set(["mcp:read", "mcp:write", personalAgentRunScope(claim.run.id)]), payload: {} }
  const call = (method: string) => invokeMcpOperation({ app, env: {}, operation: { name: "calendar", method, path, operation: {}, inputSchema: z.object({}) }, principal, nativeConnectionId: "google-workspace", toolInput: {}, includePayload: true })
  const refused = await call("POST")
  assert.equal(refused.isError, true)
  assert.equal(field(refused.payload, "error"), "policy_blocked")
  assert.equal(field(refused.payload, "retryable"), false)
  assert.equal(field(refused.payload, "message"), "Built-in connectors cannot ask first yet, so an agent can only read them.")
  assert.equal(calls, 0)
  assert.equal((await call("GET")).isError, false)
  assert.equal(calls, 1)
  await db.update(AutomationRunTable).set({ status: "queued" }).where(eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", claim.run.id)))
  const cancelled = await asDana("POST", `/v1/automation-runs/${claim.run.id}/cancel`)
  assert.equal(cancelled.status, 200, summary(cancelled))
})

test("writes are listed but ask without a provider call and only one pending card is recorded", async () => {
  const { run: receipt, token } = await admitted()
  const slack = await den.callMcpTool(token, "execute_capability", { name: "slack_send_as_bot", body: { target: "me", text: "Fixture note" } })
  assert.equal(field(slack.body, "error"), "policy_blocked", slack.raw)
  assert.equal(field(slack.body, "retryable"), false, slack.raw)
  const skill = await den.callMcpTool(token, "create_skill", { pluginName: "Fixture skill", skillMarkdown: "# Fixture skill" })
  assert.equal(field(skill.body, "error"), "policy_blocked", skill.raw)
  assert.equal((await den.callMcpTool(token, "list_skills", {})).isError, false)
  const found = await den.callMcpTool(token, "search_capabilities", { query: "bug tracker create issue", limit: 20 })
  assert.ok(list(field(found.body, "matches")).some((row) => row.name === `mcp:${connectionId}:create_issue`), found.raw)
  const catalog = personalAgentToolCatalogSchema.parse((await asPriya("GET", `${path}/tools`)).body)
  assert.deepEqual(catalog.connections[0].tools.find((tool) => tool.name === "create_issue"), { name: "create_issue", title: "create_issue", write: true, access: "ask", chosen: null, lockedByOrganization: false, organizationRule: null })
  const calls = providerCalls()
  await Promise.all([asks(token), asks(token)])
  const proxy = await den.request(token, "POST", `/mcp/agent/connections/${connectionId}`, {
    headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name: "create_issue", body: {} } } },
  })
  assert.match(proxy.text, /needs_approval/)
  assert.equal(providerCalls(), calls)
  const rows = await requests()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].runId, receipt.id)
  assert.equal(rows[0].requestedBy.memberId, priya.memberId)
  assert.deepEqual(rows[0].canDecide, ["deny", "allow_once"])
  assert.deepEqual((await requests(asSam))[0].canDecide, [])
  assert.equal((await decide(asSam, rows[0].id, "deny")).status, 403)
  assert.ok((await requests(asDana))[0].canDecide.includes("always_allow"))
  const forbidden = await decide(asPriya, rows[0].id, "always_allow")
  assert.equal(forbidden.status, 403, summary(forbidden))
  assert.deepEqual(forbidden.body, { error: "personal_agent_forbidden" })
  const read = await execute(token, "list_issues")
  assert.equal(read.isError, false, read.raw)
  assert.equal(providerCalls(), calls + 1)
})

test("allow once is for the requester and applies to exactly one run; only Dana can always allow", async () => {
  const [waiting] = await requests()
  const once = await decide(asPriya, waiting.id, "allow_once")
  assert.equal(once.status, 200, summary(once))
  assert.equal(personalAgentRequestSchema.parse(once.body).status, "allowed_once")
  const already = await decide(asSam, waiting.id, "deny")
  assert.equal(already.status, 403, summary(already))
  const ownerRun = await admitted(asDana)
  await asks(ownerRun.token)
  const unused = await run()
  assert.equal(unused.receipt.run.status, "succeeded")
  assert.equal((await requests()).find((row) => row.id === waiting.id)?.status, "allowed_once")
  const first = await admitted()
  assert.equal((await requests()).find((row) => row.id === waiting.id)?.status, "allowed_once")
  for (const allowed of await Promise.all([execute(first.token), execute(first.token)])) assert.equal(allowed.isError, false, allowed.raw)
  assert.equal((await requests()).find((row) => row.id === waiting.id)?.status, "used")
  const second = await admitted()
  await asks(second.token)
  const pending = (await requests()).find((row) => row.status === "pending")
  assert.ok(pending)
  const revision = second.agentRevision.version
  assert.equal((await decide(asSam, pending.id, "always_allow")).status, 403)
  const permanent = await decide(asDana, pending.id, "always_allow")
  assert.equal(permanent.status, 200, summary(permanent))
  assert.equal(personalAgentRequestSchema.parse(permanent.body).status, "always_allowed")
  const later = await admitted()
  assert.equal(later.agentRevision.version, revision)
  const next = await execute(later.token)
  assert.equal(next.isError, false, next.raw)
})

test("agent and organization blocks beat allowances and explicit Ask works on reads", async () => {
  await asks((await admitted()).token, "delete_issue")
  const pending = (await requests()).find((row) => row.status === "pending" && row.toolName === "delete_issue")
  assert.ok(pending)
  const once = await decide(asPriya, pending.id, "allow_once")
  assert.equal(once.status, 200, summary(once))
  const changed = await asDana("PATCH", path, { toolPolicy: { tools: { [connectionId]: { create_issue: "allow", delete_issue: "block", list_issues: "ask" } } } })
  assert.equal(changed.status, 200, summary(changed))
  const run = await admitted()
  const calls = providerCalls()
  const refused = await execute(run.token, "delete_issue")
  assert.equal(field(refused.body, "error"), "policy_blocked", refused.raw)
  assert.match(refused.raw, /delete_issue is turned off for this agent/)
  await asks(run.token, "list_issues")
  const orgBlock = await asDana("PUT", "/v1/org/personal-agent-policy", { toolPolicy: { tools: { [connectionId]: { create_issue: "block" } } } })
  assert.equal(orgBlock.status, 200, summary(orgBlock))
  const blocked = await execute((await admitted()).token)
  assert.equal(field(blocked.body, "error"), "policy_blocked", blocked.raw)
  assert.equal(providerCalls(), calls)
})

test("a collaborator can request a schedule change and only the owner can approve it", async () => {
  const moved = { ...schedule, hour: 11 }
  const created = await asPriya("POST", `${path}/requests`, { summary: "Run at eleven.", change: { schedule: moved } })
  assert.equal(created.status, 201, summary(created))
  const waiting = personalAgentRequestSchema.parse(created.body)
  assert.deepEqual(waiting.canDecide, [])
  assert.equal(waiting.requestedByCaller, true)
  assert.equal((await requests(asSam)).find((entry) => entry.id === waiting.id)?.requestedByCaller, false)
  const refused = await decide(asPriya, waiting.id, "approve")
  assert.equal(refused.status, 403, summary(refused))
  const managerRefused = await decide(asSam, waiting.id, "approve")
  assert.equal(managerRefused.status, 403, summary(managerRefused))
  const accepted = await decide(asDana, waiting.id, "approve")
  assert.equal(accepted.status, 200, summary(accepted))
  const approved = personalAgentRequestSchema.parse(accepted.body)
  assert.equal(approved.status, "approved")
  assert.equal(approved.requestedByCaller, false)
  const events = personalAgentEventListSchema.parse((await asDana("GET", `/v1/org/personal-agent-events?agentId=${agent.agent.id}`)).body).items
  const details = events.filter(({ action, detail }) => action.startsWith("request.") && detail.kind === "change")
  assert.deepEqual(details.map(({ detail }) => detail), [
    { requester: "Priya Nair", kind: "change", changes: "schedule" },
    { requester: "Priya Nair", kind: "change", changes: "schedule" },
  ])
  assert.doesNotMatch(JSON.stringify(events), /Run at eleven/)
  const routine = await asDana("GET", `/v1/automations/${routineId}`)
  assert.deepEqual(automationDetailSchema.parse(routine.body).revision.schedule, moved)
})

test("admin pause and tool blocks apply to an already issued run credential", async () => {
  const admin = `/v1/org/personal-agents/${agent.agent.id}`
  const policy = "/v1/org/personal-agent-policy"
  assert.equal((await asDana("PUT", policy, { toolPolicy: { tools: {} } })).status, 200)
  const { token } = await admitted()
  assert.equal((await execute(token)).isError, false)
  const before = providerCalls()
  assert.equal((await asDana("PUT", policy, { toolPolicy: { tools: { [connectionId]: { create_issue: "block" } } } })).status, 200)
  const blocked = await execute(token)
  assert.equal(field(blocked.body, "error"), "policy_blocked", blocked.raw)
  assert.equal((await asDana("PUT", policy, { toolPolicy: { tools: {} } })).status, 200)
  assert.equal((await asDana("POST", `${admin}/pause`)).status, 200)
  const paused = await execute(token)
  assert.equal(field(paused.body, "message"), "An admin paused this agent.", paused.raw)
  assert.equal(providerCalls(), before)
  assert.equal((await asDana("POST", `${admin}/resume`)).status, 200)
  assert.equal((await execute(token)).isError, false)
})

test("paused and over-budget agents do not start a runner turn", async () => {
  const admin = `/v1/org/personal-agents/${agent.agent.id}`
  await releaseRun?.()
  releaseRun = undefined
  const before = turns.length
  const paused = await asDana("POST", `${admin}/pause`)
  assert.equal(paused.status, 200, summary(paused))
  assert.equal(turns.length, before)
  const resumed = await asDana("POST", `${admin}/resume`)
  assert.equal(resumed.status, 200, summary(resumed))
  const budget = await asDana("PUT", `${admin}/budget`, { monthlyBudgetMicros: 0 })
  assert.equal(budget.status, 200, summary(budget))
  const failed = await run(asDana)
  assert.equal(failed.receipt.run.status, "failed")
  assert.equal(failed.receipt.run.error?.message, "This agent reached its budget for the month, so it did not run.")
  assert.equal(turns.length, before)
})

test("never matches all words ignoring case and punctuation and falls back to write tools", async () => {
  const { matchPersonalAgentNeverTools } = await import("../../src/personal-agents/never.js")
  const tools = [
    { name: "post_message", title: "Send note", write: true },
    { name: "delete_message", title: "Remove a note", write: true },
    { name: "get_message", title: "Read a message", write: false },
  ]
  assert.deepEqual(matchPersonalAgentNeverTools(tools, "MESSAGE, post!"), ["post_message"])
  assert.deepEqual(matchPersonalAgentNeverTools(tools, "read message"), ["get_message"])
  assert.deepEqual(matchPersonalAgentNeverTools(tools, "send message"), ["post_message", "delete_message"])
  const { personalAgentNeverBlocks } = await import("../../src/personal-agents/never.js")
  const caller = { organizationId: orgId, memberId: dana.memberId }
  assert.deepEqual(await personalAgentNeverBlocks(caller, [{ app: "Bug tracker" }]), {
    connections: { [connectionId]: "block" }, tools: {},
  })
  assert.deepEqual(await personalAgentNeverBlocks(caller, [{ app: "Bug tracker", action: "Not matched" }]), {
    connections: {}, tools: { [connectionId]: { create_issue: "block", delete_issue: "block" } },
  })
})


test("team and member rules apply to an agent run only when toolPermissions is on, and names stay case-sensitive", async () => {
  const { setSubjectToolRule } = await import("../../src/tool-permissions/rules.js")
  const teamId = await den.createTeam(dana, orgId, "Triage", [priya.memberId])
  const member = { organizationId: orgId, kind: "member", id: priya.memberId } as const
  const team = { organizationId: orgId, kind: "team", id: teamId } as const
  await setSubjectToolRule(team, { connectionId, toolName: "list_issues", rule: "block" }, dana.memberId)
  await setSubjectToolRule(member, { connectionId, toolName: "List_issues", rule: "block" }, dana.memberId)
  await setSubjectToolRule(member, { connectionId, toolName: "list_issues", rule: "ask" }, dana.memberId)
  const clear = await asDana("PATCH", path, { toolPolicy: {} })
  assert.equal(clear.status, 200, summary(clear))
  assert.equal((await asDana("PUT", `/v1/org/personal-agents/${agent.agent.id}/budget`, { monthlyBudgetMicros: null })).status, 200)
  const { token } = await admitted()
  const reads = () => Promise.all([execute(token, "list_issues"), execute(token, "List_issues")])
  for (const result of await reads()) assert.equal(result.isError, false, result.raw)
  assert.equal((await den.setFeature(orgId, "toolPermissions", true)).status, 200)
  for (const result of await reads()) assert.equal(field(result.body, "error"), "policy_blocked", result.raw)
  await setSubjectToolRule(member, { connectionId, toolName: "List_issues", rule: null }, dana.memberId)
  const [lower, upper] = await reads()
  assert.equal(field(lower.body, "error"), "policy_blocked", lower.raw)
  assert.equal(upper.isError, false, upper.raw)
  await setSubjectToolRule(team, { connectionId, toolName: "list_issues", rule: null }, dana.memberId)
  const [asksLower, allowsUpper] = await reads()
  assert.equal(field(asksLower.body, "error"), "needs_approval", asksLower.raw)
  assert.equal(allowsUpper.isError, false, allowsUpper.raw)
  const asked = (await requests(asDana)).find((row) => row.toolName === "list_issues" && row.status === "pending")
  assert.ok(asked)
  const assertNoAlwaysAllow = async () => {
    assert.deepEqual((await requests(asDana)).find((row) => row.id === asked.id)?.canDecide, ["deny", "allow_once"])
    const refused = await decide(asDana, asked.id, "always_allow")
    assert.equal(refused.status, 409, summary(refused))
  }
  await assertNoAlwaysAllow()
  await setSubjectToolRule(member, { connectionId, toolName: "list_issues", rule: null }, dana.memberId)
  await setSubjectToolRule(team, { connectionId, toolName: "list_issues", rule: "ask" }, dana.memberId)
  await assertNoAlwaysAllow()
  await setSubjectToolRule(team, { connectionId, toolName: "list_issues", rule: null }, dana.memberId)
  const { PERSONAL_AGENT_TOOL_POLICY_MAX_TOOLS } = await import("@openwork/types/den/personal-agents")
  const full = await asDana("PATCH", path, { toolPolicy: { tools: { [connectionId]: Object.fromEntries(
    Array.from({ length: PERSONAL_AGENT_TOOL_POLICY_MAX_TOOLS }, (_, index) => [`tool_${index}`, "allow"]),
  ) } } })
  assert.equal(full.status, 200, summary(full))
  const tooMany = await decide(asDana, asked.id, "always_allow")
  assert.equal(tooMany.status, 409, summary(tooMany))
  assert.match(text(field(tooMany.body, "message"), "tool limit message"), /reached the tool limit/)

  await setSubjectToolRule(member, { connectionId, toolName: "list_issues", rule: null }, dana.memberId)
  assert.equal((await den.setFeature(orgId, "toolPermissions", false)).status, 200)
  await releaseRun?.()
})

test("a live token is refused when the organization turns agents off or the routine is archived", async () => {
  const { db } = await import("../../src/db.js")
  const { AutomationTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  const selector = eq(AutomationTable.id, normalizeDenTypeId("automation", routineId))
  const { token } = await admitted()
  const denied = async () => {
    const count = providerCalls()
    for (const refusal of [await execute(token, "list_issues"), await den.callMcpTool(token, "agent_remember", { note: "Not saved" }),
      await den.callMcpTool(token, "agent_note_progress", { state: "Not saved" })]) {
      assert.equal(field(refusal.body, "error"), "policy_blocked", refusal.raw)
    }
    assert.equal(providerCalls(), count)
  }
  try {
    assert.equal((await execute(token, "list_issues")).isError, false)
    assert.equal((await den.setFeature(orgId, "personalAgents", false)).status, 200)
    await denied()
    assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
    assert.equal((await execute(token, "list_issues")).isError, false)
    await db.update(AutomationTable).set({ state: "archived" }).where(selector)
    await denied()
  } finally {
    await db.update(AutomationTable).set({ state: "active" }).where(selector)
    await den.setFeature(orgId, "personalAgents", true)
    await releaseRun?.()
  }
})

test("Priya's live run loses tool and discovery access after share removal or archive", async () => {
  assert.equal((await asDana("PUT", `/v1/org/personal-agents/${agent.agent.id}/budget`, { monthlyBudgetMicros: null })).status, 200)
  assert.equal((await asDana("PATCH", path, { toolPolicy: { tools: {} } })).status, 200)
  const first = await admitted()
  assert.equal((await execute(first.token, "list_issues")).isError, false)
  assert.equal((await asDana("DELETE", `${path}/shares/${priya.memberId}`)).status, 200)
  const refused = await execute(first.token, "list_issues")
  assert.equal(refused.isError, true, refused.raw)
  assert.match(refused.raw, /no longer has access/)
  const list = await den.request(first.token, "POST", `/mcp/agent/connections/${connectionId}`, {
    headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  })
  assert.equal(list.status, 403, summary(list))
  assert.equal((await asDana("PUT", `${path}/shares/${priya.memberId}`, { role: "collaborator" })).status, 200)
  const second = await admitted()
  assert.match((await execute(first.token, "list_issues")).raw, /no longer active/)
  assert.equal((await asDana("DELETE", path)).status, 200)
  const archived = await execute(second.token, "list_issues")
  assert.equal(archived.isError, true, archived.raw)
  assert.match(archived.raw, /no longer has access/)
  holdRun = false
})
