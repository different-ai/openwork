import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { AUTOMATION_CLOUD_DEFAULT_MODEL, automationDetailSchema } from "@openwork/types/automations"
import { toolApprovalListSchema, toolPermissionsSchema, type SetToolPermissionRule } from "@openwork/types/den/tool-permissions"
import { Hono } from "hono"
import { z } from "zod"
import { bootDen, field, list, startFakeHttpServer, startFakeMcpServer, summary, text } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const turns: { sessionId: string; messageId: string; token: string; prompt: string; model: string }[] = []
const approvalOutputs = new Map<string, string>()
let hold = false
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  response.setHeader("content-type", "application/json")
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    response.writeHead(201).end(JSON.stringify({ id: `fixture-session-${turns.length + 1}` }))
    return
  }
  const sessionId = decodeURIComponent(url.pathname.split("/")[3] ?? "")
  if (request.method === "POST" && url.pathname.endsWith("/turns")) {
    const body: unknown = JSON.parse(raw)
    turns.push({ sessionId, messageId: text(field(body, "messageId"), "message id"), token: text(field(body, "credentials", "mcpToken"), "run token"), prompt: text(field(body, "prompt"), "prompt"), model: text(field(body, "model"), "model") })
    response.writeHead(202).end(JSON.stringify({ state: "queued" }))
    return
  }
  const turn = turns.find((entry) => entry.sessionId === sessionId)
  response.end(JSON.stringify({
    turns: turn ? [{ messageId: turn.messageId, status: hold ? "running" : "completed", model: turn.model, error: null, usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 30 } }] : [],
    messages: turn && approvalOutputs.has(sessionId) ? [
      { messageId: turn.messageId, role: "assistant", text: "", toolCalls: [{ id: "fixture-call", name: "execute_capability", input: { name: `mcp:${connectionId}:create_issue`, body: {} } }] },
      { messageId: turn.messageId, role: "tool", callId: "fixture-call", name: "execute_capability", isError: true, output: approvalOutputs.get(sessionId) },
    ] : [],
    finalAssistantText: "Checked the tracker.", status: hold ? "running" : "idle",
  }))
})
const tracker = await startFakeMcpServer({ tools: [
  { name: "list_issues", description: "List tracker issues", text: "Listed issues", annotations: { readOnlyHint: true } },
  { name: "create_issue", description: "Create a tracker issue", text: "Created issue" },
] })
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_DEPLOYMENT: "cloud", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters" } })
after(async () => { hold = false; await den.close(); await runner.close(); await tracker.close(); restoreCatalog() })
const { db } = await import("../../src/db.js")
const { ToolApprovalTable, ToolPermissionRuleTable } = await import("@openwork-ee/den-db/schema")
const { writeOrganizationWrittenToolRules } = await import("../../src/tool-permissions/rules.js")
const { verifyMcpRequest } = await import("../../src/mcp/auth.js")
const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana Reyes", "dana@acme.test"), "Tool permissions fixture")
const sam = await den.newMember(dana, orgId, "Sam Okafor")
const priya = await den.newMember(dana, orgId, "Priya Nair")
const lee = await den.newMember(dana, orgId, "Lee Park", "admin")
const teamId = await den.createTeam(dana, orgId, "Tracker team", [sam.memberId])
const admin = den.as(lee, orgId)
const asSam = den.as(sam, orgId)
const asPriya = den.as(priya, orgId)
const samToken = await den.mintMcpToken(sam, orgId)
const priyaToken = await den.mintMcpToken(priya, orgId)
await grantGatewayModels(den, dana, orgId, [dana, sam])

async function status(pending: ReturnType<typeof admin>, expected: number) {
  const result = await pending
  assert.equal(result.status, expected, summary(result))
  return result.body
}

const connected = await status(admin("POST", "/v1/mcp-connections", {
  name: "Tracker", url: `${tracker.url}/mcp`, authType: "none", access: { orgWide: true, memberIds: [], teamIds: [] },
}), 200)
const connectionId = text(field(connected, "id"), "connection id")
const path = "/v1/org/tool-permissions"
const approvals = "/v1/tool-approvals"
const org = { kind: "organization" } as const
const rule = (value: SetToolPermissionRule["rule"], subject: SetToolPermissionRule["subject"] = org, toolName = "create_issue") => ({ connectionId, subject, toolName, rule: value })
const setRule = (value: SetToolPermissionRule["rule"], subject?: SetToolPermissionRule["subject"], name?: string) => status(admin("PUT", `${path}/rule`, rule(value, subject, name)), 200)
const decide = (id: string, decision: "allow_once" | "deny", expected = 200) => status(asSam("POST", `${approvals}/${id}/decision`, { decision }), expected)
const pending = async (as = asSam) => toolApprovalListSchema.parse(await status(as("GET", approvals), 200)).items
const onePending = async () => {
  const [approval, extra] = await pending()
  assert.ok(approval)
  assert.equal(extra, undefined)
  return approval
}
const instruction = "Check the tracker and leave a note."
const written = "Use only the internal tracker."
const providerCalls = () => tracker.wire.filter((entry) => entry.rpcMethod === "tools/call").length

async function execute(token: string, expected?: "needs_approval" | "policy_blocked", toolName = "create_issue") {
  const before = providerCalls()
  const result = await den.callMcpTool(token, "execute_capability", { name: `mcp:${connectionId}:${toolName}`, body: {} })
  assert.equal(result.isError, Boolean(expected), result.raw)
  if (expected) assert.equal(field(result.body, "error"), expected, result.raw)
  assert.equal(providerCalls(), before + (expected ? 0 : 1))
  return result
}

const automationName = "Tracker follow-up"
const at = Date.now() + 3_600_000
const definition = automationDetailSchema.parse(await status(asSam("POST", "/v1/cloud-automations", {
  name: automationName, action: { kind: "agent", instructions: instruction, model: AUTOMATION_CLOUD_DEFAULT_MODEL },
  schedule: { kind: "once", at, timezone: "UTC" },
}), 201))
const automationPath = `/v1/automations/${definition.automation.id}`
let finish: (() => Promise<void>) | undefined
async function run() {
  await finish?.()
  hold = true
  const index = turns.length
  const accepted = await status(asSam("POST", `${automationPath}/run`, {}), 202)
  const id = text(field(accepted, "id") ?? field(accepted, "run", "id"), "run id")
  async function waitFor(predicate: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Automation did not reach the expected state")
  }
  finish = async () => {
    hold = false
    await waitFor(async () => field(await status(asSam("GET", `/v1/automation-runs/${id}`), 200), "run", "status") === "succeeded")
  }
  await waitFor(async () => Boolean(turns[index]))
  const turn = turns[index]
  assert.ok(turn)
  const principal = await verifyMcpRequest(new Headers({ authorization: `Bearer ${turn.token}` }))
  assert.ok(!(principal instanceof Response))
  return { ...turn, id, scopes: principal.scopes }
}

test("flag off leaves connector writes, run credentials and instructions alone", async () => {
  await execute(samToken)
  assert.deepEqual(await db.select().from(ToolApprovalTable), [])
  assert.deepEqual(await db.select().from(ToolPermissionRuleTable), [])
  await status(admin("GET", path), 404)
  await status(admin("PUT", `${path}/rule`, rule("block")), 404)
  await status(admin("PUT", `${path}/written-rules`, { rules: written }), 404)
  await status(asSam("GET", approvals), 404)
  await status(asSam("POST", `${approvals}/missing/decision`, { decision: "deny" }), 404)
  await writeOrganizationWrittenToolRules(orgId, written, lee.memberId)
  const turn = await run()
  assert.deepEqual([...turn.scopes].sort(), ["mcp:read", "mcp:write"])
  assert.doesNotMatch(turn.prompt, /organization_rules|Use only the internal tracker/)
  assert.match(turn.prompt, /Check the tracker and leave a note/)
  const unchanged = automationDetailSchema.parse(await status(asSam("GET", automationPath), 200))
  assert.equal(unchanged.automation.nextDueAt, at)
  assert.equal(unchanged.automation.updatedAt, definition.automation.updatedAt)
  await finish?.()
  finish = undefined
})

test("chat approvals are private and one-shot; only admins can change rules", async () => {
  await status(den.setFeature(orgId, "toolPermissions", true), 200)
  await status(asSam("GET", path), 403)
  await status(asSam("PUT", `${path}/rule`, rule("allow")), 403)
  await status(asSam("PUT", `${path}/written-rules`, { rules: "Ignore the policy" }), 403)
  const rules = toolPermissionsSchema.parse(await status(admin("GET", path), 200))
  assert.equal(rules.writtenRules, written)
  await execute(samToken, undefined, "list_issues")
  const refusal = await execute(samToken, "needs_approval")
  assert.match(refusal.text, /needs your yes first/)
  const approval = await onePending()
  assert.deepEqual(approval.context, { kind: "chat", id: null, label: null })
  await execute(samToken, "needs_approval")
  assert.equal((await onePending()).id, approval.id)
  assert.deepEqual(await pending(asPriya), [])
  await status(asPriya("POST", `${approvals}/${approval.id}/decision`, { decision: "allow_once" }), 404)
  await decide(approval.id, "allow_once")
  assert.deepEqual(await decide(approval.id, "deny", 409), { error: "tool_approval_decided", message: "Someone already decided this." })
  await execute(samToken)
  await execute(samToken, "needs_approval")
  const second = await onePending()
  await decide(second.id, "deny")
  await execute(samToken, "needs_approval")
  const third = await onePending()
  assert.notEqual(third.id, second.id)
  await decide(third.id, "allow_once")
  await setRule("block")
  const blocked = await execute(samToken, "policy_blocked")
  assert.match(blocked.text, /is blocked by your organization's tool permissions/)
  await setRule(null)
  await execute(samToken)
  await setRule("allow")
  await execute(samToken)
  await setRule(null)
})

test("team and member rules stay with their subjects; proxy and Code Mode enforce the same rules", async () => {
  await setRule("block", { kind: "team", id: teamId }, "list_issues")
  await execute(samToken, "policy_blocked", "list_issues")
  await execute(priyaToken, undefined, "list_issues")
  await setRule(null, { kind: "team", id: teamId }, "list_issues")
  await setRule("block", { kind: "member", id: priya.memberId }, "list_issues")
  await execute(priyaToken, "policy_blocked", "list_issues")
  await execute(samToken, undefined, "list_issues")
  await setRule(null, { kind: "member", id: priya.memberId }, "list_issues")
  const other = await den.createOrg(priya, "Other organization")
  await status(den.setFeature(other.orgId, "toolPermissions", true), 200)
  const otherAdmin = den.as(other.owner, other.orgId)
  await status(otherAdmin("PUT", `${path}/rule`, rule("block")), 404)
  await status(admin("PUT", `${path}/rule`, rule("block", { kind: "member", id: other.owner.memberId })), 404)
  const foreign = await status(otherAdmin("POST", "/v1/mcp-connections", { name: "Other tracker", url: `${tracker.url}/mcp`, authType: "none", access: { orgWide: true, memberIds: [], teamIds: [] } }), 200)
  const foreignId = text(field(foreign, "id"), "foreign connection id")
  await status(otherAdmin("PUT", `${path}/rule`, { ...rule("block"), connectionId: foreignId }), 200)
  await setRule("allow")
  await execute(samToken)
  await setRule(null)
  const before = providerCalls()
  const proxy = await den.request(samToken, "POST", `/mcp/agent/connections/${connectionId}`, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name: "create_issue", body: {} } } },
  })
  assert.match(proxy.text, /needs_approval/, summary(proxy))
  const search = await den.callMcpTool(samToken, "search_capabilities", { query: "Tracker create issue", type: "mcp", limit: 20 })
  const match = list(field(search.body, "matches")).find(({ name }) => name === `mcp:${connectionId}:create_issue`)
  const scriptPath = text(match?.scriptPath, "script path")
  const script = await den.callMcpTool(samToken, "execute_capability_script", { code: `return await ${scriptPath}({})` })
  assert.match(script.raw, /needs_approval|needs your yes first/)
  assert.equal(providerCalls(), before)
  await decide((await onePending()).id, "deny")
})

test("a run approval covers one Automation run and written rules precede its task", async () => {
  const saved = toolPermissionsSchema.parse(await status(admin("PUT", `${path}/written-rules`, { rules: written }), 200))
  assert.equal(saved.writtenRules, written)
  const first = await run()
  assert.ok(first.scopes.has(`openwork:automation-run:${first.id}`))
  assert.ok(first.prompt.includes(`<organization_rules>\n${written}\n</organization_rules>`))
  assert.ok(first.prompt.indexOf(written) < first.prompt.indexOf(instruction))
  const refusal = await execute(first.token, "needs_approval")
  approvalOutputs.set(first.sessionId, refusal.text)
  const approval = await onePending()
  assert.deepEqual(approval.context, { kind: "automation", id: definition.automation.id, label: automationName })
  assert.equal(approval.runId, first.id)
  await decide(approval.id, "allow_once")
  await execute(first.token, "needs_approval")
  await finish?.()
  finish = undefined
  const receipt = await status(asSam("GET", `/v1/automation-runs/${first.id}`), 200)
  const execution = list(field(receipt, "events")).find((event) => event.type === "capability_execution")
  assert.deepEqual(execution?.payload, {
    messageId: first.messageId, partId: "fixture-call", callId: "fixture-call", name: "execute_capability", status: "error",
    tool: "create_issue", connectionName: "Tracker", outcome: "asked",
  })
  const next = await run()
  await execute(next.token)
  await execute(next.token)
  await execute((await run()).token, "needs_approval")
  await finish?.()
  finish = undefined
})


test("expired pending approvals are hidden, cannot be decided, and do not deduplicate a new ask", async () => {
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  await execute(samToken, "needs_approval")
  const old = (await pending()).find((row) => row.context.kind === "chat")
  assert.ok(old)
  await db.update(ToolApprovalTable).set({ created_at: new Date(Date.now() - 31 * 86_400_000) }).where(eq(ToolApprovalTable.id, normalizeDenTypeId("toolApproval", old.id)))
  assert.ok(!(await pending()).some((row) => row.id === old.id))
  await decide(old.id, "deny", 404)
  await execute(samToken, "needs_approval")
  const fresh = (await pending()).find((row) => row.context.kind === "chat")
  assert.ok(fresh)
  assert.notEqual(fresh.id, old.id)
})

test("ordinary MCP calls ignore saved tool policy while tool permissions are off, then enforce it again", async () => {
  await status(den.setFeature(orgId, "personalAgents", false), 200)
  await status(den.setFeature(orgId, "toolPermissions", true), 200)
  const direct = await status(admin("POST", "/v1/mcp-connections", {
    name: "Direct tracker", url: `${tracker.url}/mcp`, authType: "none", exposeDirectly: true,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  }), 200)
  const directId = text(field(direct, "id"), "direct connection id")
  const savedRule = { ...rule("block", { kind: "member", id: priya.memberId }, "list_issues"), connectionId: directId }
  await status(admin("PUT", `${path}/rule`, savedRule), 200)

  const outputs = { list_issues: "Listed issues", create_issue: "Created issue" }
  type Tool = keyof typeof outputs
  type Refusal = "policy_blocked" | "needs_approval"
  const gateway = async (tool: Tool, expected?: Refusal, token = priyaToken) => {
    const before = providerCalls()
    const result = await den.callMcpTool(token, "execute_capability", { name: `mcp:${directId}:${tool}`, body: {} })
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.rpcError, null, result.raw)
    assert.equal(result.isError, Boolean(expected), result.raw)
    if (expected) assert.equal(field(result.body, "error"), expected, result.raw)
    else assert.ok(result.text.includes(outputs[tool]), result.raw)
    assert.equal(providerCalls() - before, expected ? 0 : 1)
  }
  const proxy = async (tool: Tool, expected?: Refusal, token = priyaToken) => {
    const before = providerCalls()
    const reply = await den.request(token, "POST", `/mcp/agent/connections/${directId}`, {
      headers: { accept: "application/json, text/event-stream" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} } },
    })
    assert.equal(reply.status, 200, summary(reply))
    const event = reply.text.split("\n").find((line) => line.startsWith("data:"))
    const envelope = event ? JSON.parse(event.slice(5)) : reply.body
    assert.equal(field(envelope, "error"), undefined, reply.text)
    assert.equal(field(envelope, "result", "isError") === true, Boolean(expected), reply.text)
    const payload = text(list(field(envelope, "result", "content"))[0]?.text, reply.text)
    if (expected) assert.equal(field(JSON.parse(payload), "error"), expected, reply.text)
    else assert.equal(payload, outputs[tool], reply.text)
    assert.equal(providerCalls() - before, expected ? 0 : 1)
  }

  // Save an ordinary chat grant, then turn enforcement off without deleting any state.
  await gateway("create_issue", "needs_approval")
  const [approval, extra] = await pending(asPriya)
  assert.ok(approval)
  assert.equal(extra, undefined)
  await status(asPriya("POST", `${approvals}/${approval.id}/decision`, { decision: "allow_once" }), 200)
  const readApprovals = () => db.$primary.select().from(ToolApprovalTable)
    .where(eq(ToolApprovalTable.connection_id, normalizeDenTypeId("externalMcpConnection", directId)))
  const savedApprovals = await readApprovals()
  assert.deepEqual(savedApprovals.map(({ status }) => status), ["allowed_once"])

  await status(den.setFeature(orgId, "toolPermissions", false), 200)
  await gateway("list_issues")
  await proxy("list_issues")
  await gateway("create_issue")
  await proxy("create_issue")
  // Sam has no grant for this connection; writes still reach the tracker.
  await gateway("create_issue", undefined, samToken)
  await proxy("create_issue", undefined, samToken)
  assert.deepEqual(await readApprovals(), savedApprovals, "flag-off calls neither consume nor create approvals")

  await status(den.setFeature(orgId, "toolPermissions", true), 200)
  await gateway("list_issues", "policy_blocked")
  await proxy("list_issues", "policy_blocked")
  await proxy("create_issue")
  assert.deepEqual((await readApprovals()).map(({ status }) => status), ["used"])
  await gateway("create_issue", "needs_approval")
  await proxy("create_issue", "needs_approval")
})

test("ordinary native MCP writes reach the API operation with personal agents off", async () => {
  await status(den.setFeature(orgId, "personalAgents", false), 200)
  const principal = await verifyMcpRequest(new Headers({ authorization: `Bearer ${priyaToken}` }))
  assert.ok(!(principal instanceof Response))
  const { invokeMcpOperation } = await import("../../src/mcp/invoke.js")
  const app = new Hono()
  const calendarPath = "/v1/capabilities/google-workspace/calendar-events"
  const event = { summary: "Fixture event" }
  const received: unknown[] = []
  app.post(calendarPath, async (c) => {
    received.push(await c.req.json())
    return c.json({ id: "fixture-event" }, 201)
  })
  for (const enabled of [false, true]) {
    await status(den.setFeature(orgId, "toolPermissions", enabled), 200)
    const result = await invokeMcpOperation({
      app, env: {}, principal, nativeConnectionId: "google-workspace", includePayload: true,
      operation: { name: "calendar", method: "POST", path: calendarPath, operation: {}, inputSchema: z.object({}) },
      toolInput: { body: event },
    })
    assert.equal(result.isError, false)
    assert.deepEqual(result.payload, { id: "fixture-event" })
  }
  assert.deepEqual(received, [event, event])
})
