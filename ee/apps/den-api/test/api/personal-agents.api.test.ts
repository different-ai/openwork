import assert from "node:assert/strict"
import { after, test } from "node:test"
import { automationRevisionDigest } from "@openwork/automations"
import { AUTOMATION_CLOUD_DEFAULT_MODEL, automationDetailSchema, automationListSchema, automationRunReceiptSchema } from "@openwork/types/automations"
import {
  personalAgentDetailSchema,
  personalAgentListSchema,
  personalAgentRoutineListSchema,
  personalAgentRunResponseSchema,
} from "@openwork/types/den/personal-agents"
import { bootDen, field, list, startFakeHttpServer, startFakeMcpServer, summary, text, type McpToolResult } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

/**
 * Dana makes an agent that watches a bug tracker, gives it a morning routine,
 * and runs it. The runner is a stand-in that records what Den sends it for the
 * run: the prompt, and the credential the run uses to reach Dana's connections.
 */
const restoreCatalog = stubPublicModelCatalog()
type Turn = { sessionId: string; messageId: string; prompt: string; mcpToken: string; model: string }
const turns: Turn[] = []
let holdRun = false
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  response.setHeader("content-type", "application/json")
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    response.writeHead(201).end(JSON.stringify({ id: `fixture-session-${turns.length + 1}` })); return
  }
  const sessionId = decodeURIComponent(url.pathname.split("/")[3] ?? "")
  if (request.method === "POST" && url.pathname.endsWith("/turns")) {
    const body: unknown = JSON.parse(raw)
    turns.push({
      sessionId,
      messageId: text(field(body, "messageId"), "message id"),
      prompt: text(field(body, "prompt"), "prompt"),
      mcpToken: text(field(body, "credentials", "mcpToken"), "run credential"),
      model: text(field(body, "model"), "model"),
    })
    response.writeHead(202).end(JSON.stringify({ state: "queued" })); return
  }
  const turn = turns.find((entry) => entry.sessionId === sessionId)
  const answer = "Filed 2 issues from #bugs."
  response.end(JSON.stringify(turn
    ? {
        turns: [{ messageId: turn.messageId, status: holdRun ? "running" : "completed", model: turn.model, error: null, usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 30 } }],
        messages: [{ role: "user", messageId: turn.messageId, text: turn.prompt }, { role: "assistant", text: answer, toolCalls: [] }],
        finalAssistantText: answer,
        status: "idle",
      }
    : { turns: [], messages: [], finalAssistantText: "", status: "idle" }))
})
const tracker = await startFakeMcpServer({ tools: [
  { name: "list_bug_reports", description: "List bug reports posted in the bugs channel", text: "2 new bug reports", annotations: { readOnlyHint: true } },
  { name: "create_issue", description: "File an issue in the bug tracker", text: "issue filed" },
  { name: "delete_issue", description: "Delete an issue from the bug tracker", text: "issue deleted" },
] })
const den = await bootDen({ env: {
  ...gatewayFixtureEnv,
  DEN_DEPLOYMENT: "cloud",
  DEN_HEADLESS_RUNNER_URL: runner.url,
  DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters",
} })
after(async () => { await runner.close(); await tracker.close(); await den.close(); restoreCatalog() })

const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana"), "Personal agents fixture")
const lee = await den.newMember(dana, orgId, "Lee")
const gatewayModels = await grantGatewayModels(den, dana, orgId, [dana, lee])
const asDana = den.as(dana, orgId)
const asLee = den.as(lee, orgId)
const connected = await asDana("POST", "/v1/mcp-connections", {
  name: "Bug tracker", url: `${tracker.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] },
})
assert.equal(connected.status, 200, summary(connected))
const trackerId = text(field(connected.body, "id"), "connection id")

const BRIEF = "# Bug watcher\n\nYou watch #bugs for Dana. File one issue per new report, never delete anything, and reply with what you filed."
const BRIEF_V2 = `${BRIEF}\n\nTag every issue you file with \`from-slack\`.`
const morning = { kind: "daily", hour: 8, minute: 0, timezone: "America/Los_Angeles" }
const names = (result: McpToolResult) => list(field(result.body, "matches")).map((match) => text(match.name, "capability name"))
const searchTracker = (token: string) => den.callMcpTool(token, "search_capabilities", { query: "bug tracker issue reports", limit: 20 })
const capability = (tool: string) => `mcp:${trackerId}:${tool}`
const searchApi = (token: string, query: string) => den.callMcpTool(token, "search_capabilities", { query, type: "api", limit: 20 })

async function connectInstructions(token: string): Promise<string> {
  const started = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } },
  })
  assert.equal(started.status, 200, summary(started))
  const line = started.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : started.body
  return text(field(envelope, "result", "instructions"), "instructions")
}

async function activeTurn(index: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (turns[index]) return turns[index]
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Runner did not start")
}

async function connectionTools(token: string): Promise<string[]> {
  const searched = await den.request(token, "POST", `/mcp/agent/connections/${trackerId}`, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_capabilities", arguments: { query: "bug issue reports tracker", limit: 20 } } },
  })
  assert.equal(searched.status, 200, summary(searched))
  const line = searched.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : searched.body
  return list(field(envelope, "result", "structuredContent", "matches")).map((match) => text(match.name, "tool name"))
}

async function settled(runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = await asDana("GET", `/v1/automation-runs/${runId}`)
    assert.equal(read.status, 200, summary(read))
    const receipt = automationRunReceiptSchema.parse(read.body)
    if (["succeeded", "failed", "cancelled", "skipped"].includes(receipt.run.status)) return receipt
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`run ${runId} did not finish`)
}

test("with the flag off, personal agents do not exist for the organization: no route, no capability", async () => {
  for (const [method, path, body] of [
    ["GET", "/v1/personal-agents", undefined],
    ["POST", "/v1/personal-agents", { name: "Bug watcher", brief: BRIEF }],
    ["GET", "/v1/personal-agents/pga_missing", undefined],
    ["POST", "/v1/personal-agents/pga_missing/routines", { name: "Morning", instructions: "Check #bugs.", schedule: morning }],
    ["POST", "/v1/personal-agents/pga_missing/run", {}],
  ] as const) {
    const refused = await asDana(method, path, body)
    assert.equal(refused.status, 404, `${method} ${path}: ${summary(refused)}`)
    assert.deepEqual(refused.body, { error: "feature_disabled", feature: "personalAgents" })
  }
  const token = await den.mintMcpToken(dana, orgId)
  const found = await den.callMcpTool(token, "search_capabilities", { query: "personal agent create routine", type: "api", limit: 20 })
  assert.equal(found.isError, false, found.raw)
  assert.deepEqual(names(found).filter((name) => /PersonalAgent/.test(name)), [])
  const called = await den.callMcpTool(token, "execute_capability", { name: "listPersonalAgents" })
  assert.equal(called.isError, true, called.raw)
  assert.equal(field(called.body, "error"), "unknown_capability")
  assert.equal((await connectInstructions(token)).includes("createPersonalAgent"), false, "a chat is not told about agents it cannot make")
})

let ordinaryAutomationId = ""

test("ordinary Automations carry no agent fields, before and after the flag is on", async () => {
  const created = await asDana("POST", "/v1/cloud-automations", {
    name: "Weekly summary", schedule: { kind: "weekly", daysOfWeek: [1], hour: 9, minute: 0, timezone: "UTC" },
    action: { kind: "agent", instructions: "Summarize last week.", model: AUTOMATION_CLOUD_DEFAULT_MODEL },
  })
  assert.equal(created.status, 201, summary(created))
  const before = automationDetailSchema.parse(created.body)
  ordinaryAutomationId = before.automation.id
  assert.equal("agentId" in before.automation, false)
  assert.equal("agentRevisionId" in before.revision, false)
  assert.equal(before.revision.digest, automationRevisionDigest({
    instructions: "Summarize last week.",
    schedule: { kind: "weekly", daysOfWeek: [1], hour: 9, minute: 0, timezone: "UTC" },
    model: { providerId: AUTOMATION_CLOUD_DEFAULT_MODEL.providerId, modelId: AUTOMATION_CLOUD_DEFAULT_MODEL.modelId },
    action: before.revision.action,
    executionTarget: "cloud",
    maximumRuntimeMs: before.revision.maximumRuntimeMs,
  }), "an ordinary Automation's digest has no agent in it")

  assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
  const read = await asDana("GET", `/v1/automations/${before.automation.id}`)
  assert.deepEqual(read.body, created.body, "turning the flag on changes nothing about an existing Automation")
})

let agentId = ""
let routineId = ""
let firstRevisionId = ""

test("Dana creates an agent from chat through OpenWork Connect, lists it, and an update makes version 2", async () => {
  const token = await den.mintMcpToken(dana, orgId)
  const found = await den.callMcpTool(token, "search_capabilities", { query: "create personal agent", type: "api", limit: 20 })
  assert.ok(names(found).includes("createPersonalAgent"), found.raw)
  assert.match(await connectInstructions(token), /do not propose an Automation.*agent\.propose.*createPersonalAgent.*createPersonalAgentRoutine/, "the chat is told to make an agent when asked for one")

  const created = await den.callMcpTool(token, "execute_capability", { name: "createPersonalAgent", body: { name: "Bug watcher", brief: BRIEF } })
  assert.equal(created.isError, false, created.raw)
  const agent = personalAgentDetailSchema.parse(field(created.body, "data") ?? created.body)
  assert.equal(agent.agent.name, "Bug watcher")
  assert.equal(agent.agent.ownerMemberId, dana.memberId)
  assert.equal(agent.revision.version, 1)
  assert.equal(agent.revision.brief, BRIEF)
  assert.deepEqual(agent.revision.toolPolicy, { connections: {}, tools: {} })
  assert.equal(agent.revision.defaultExecutionTarget, "cloud")
  assert.equal(agent.routineCount, 0)
  agentId = agent.agent.id
  firstRevisionId = agent.revision.id

  const listed = personalAgentListSchema.parse((await asDana("GET", "/v1/personal-agents")).body)
  assert.deepEqual(listed.items.map((item) => item.agent.id), [agentId])

  const renamed = personalAgentDetailSchema.parse((await asDana("PATCH", `/v1/personal-agents/${agentId}`, { name: "Bug triage" })).body)
  assert.equal(renamed.agent.name, "Bug triage")
  assert.equal(renamed.revision.id, firstRevisionId, "a rename keeps the version")

  const updated = await asDana("PATCH", `/v1/personal-agents/${agentId}`, { brief: BRIEF_V2, monthlyBudgetMicros: 25_000_000 })
  assert.equal(updated.status, 200, summary(updated))
  const second = personalAgentDetailSchema.parse(updated.body)
  assert.equal(second.revision.version, 2)
  assert.notEqual(second.revision.id, firstRevisionId)
  assert.equal(second.revision.brief, BRIEF_V2)
  assert.equal(second.revision.monthlyBudgetMicros, 25_000_000)

  const { client } = await import("../../src/db.js")
  const [stored] = await client.query("SELECT brief FROM personal_agent_revision WHERE id = ?", [second.revision.id])
  const briefAtRest = text(list(JSON.parse(JSON.stringify(stored)))[0]?.brief, "stored brief")
  assert.match(briefAtRest, /^enc:v1:/, "the brief is encrypted at rest")
  assert.equal(briefAtRest.includes("Bug watcher"), false)
})

test("an agent is its owner's alone", async () => {
  assert.deepEqual(personalAgentListSchema.parse((await asLee("GET", "/v1/personal-agents")).body).items, [])
  for (const [method, path, body] of [
    ["GET", `/v1/personal-agents/${agentId}`, undefined],
    ["PATCH", `/v1/personal-agents/${agentId}`, { name: "Mine now" }],
    ["POST", `/v1/personal-agents/${agentId}/routines`, { name: "Morning", instructions: "Check #bugs.", schedule: morning }],
    ["POST", `/v1/personal-agents/${agentId}/run`, {}],
    ["DELETE", `/v1/personal-agents/${agentId}`, undefined],
  ] as const) {
    const refused = await asLee(method, path, body)
    assert.equal(refused.status, 404, `${method} ${path}: ${summary(refused)}`)
  }
})

test("a routine is an ordinary Automation that carries the agent's id and pins its current version", async () => {
  const none = await asDana("POST", `/v1/personal-agents/${agentId}/run`, {})
  assert.equal(none.status, 409, summary(none))
  assert.equal(field(none.body, "error"), "personal_agent_routine_required")

  const created = await asDana("POST", `/v1/personal-agents/${agentId}/routines`, {
    name: "Morning bug sweep", instructions: "Read today's reports in #bugs and file an issue for each new one.", schedule: morning, executionTarget: "cloud",
  })
  const onDesktop = await asDana("POST", `/v1/personal-agents/${agentId}/routines`, { name: "Desktop sweep", instructions: "Check #bugs.", schedule: morning, executionTarget: "desktop" })
  assert.equal(onDesktop.status, 400, summary(onDesktop))
  assert.equal(created.status, 201, summary(created))
  const routine = automationDetailSchema.parse(created.body)
  routineId = routine.automation.id
  assert.equal(routine.automation.agentId, agentId)
  assert.equal(routine.automation.state, "active")
  assert.equal(routine.revision.executionTarget, "cloud")
  assert.deepEqual(routine.revision.schedule, morning)
  assert.ok(routine.automation.nextDueAt, "the routine is scheduled")
  const agent = personalAgentDetailSchema.parse((await asDana("GET", `/v1/personal-agents/${agentId}`)).body)
  assert.equal(routine.revision.agentRevisionId, agent.revision.id)
  assert.equal(agent.revision.version, 2)
  assert.equal(agent.routineCount, 1)

  // The Automation capabilities see it as one of Dana's Automations.
  const automations = automationListSchema.parse((await asDana("GET", "/v1/automations")).body)
  assert.equal(automations.items.find((item) => item.automation.id === routineId)?.automation.agentId, agentId)
  assert.deepEqual(automations.items.filter((item) => item.automation.agentId).map((item) => item.automation.id), [routineId])
  const routines = personalAgentRoutineListSchema.parse((await asDana("GET", `/v1/personal-agents/${agentId}/routines`)).body)
  assert.deepEqual(routines.items.map((item) => item.automation.id), [routineId])

  // It stays where the agent's brief and tool limits can be applied.
  const moved = await asDana("PATCH", `/v1/automations/${routineId}`, { executionTarget: "desktop" })
  assert.equal(moved.status, 400, summary(moved))
  assert.equal(field(moved.body, "error"), "personal_agent_routine_cloud_agent_only")
  const edited = automationDetailSchema.parse((await asDana("PATCH", `/v1/automations/${routineId}`, { name: "Morning sweep" })).body)
  assert.equal(edited.revision.agentRevisionId, agent.revision.id, "an ordinary edit keeps the pin")
  const reworded = automationDetailSchema.parse((await asDana("PATCH", `/v1/automations/${routineId}`, { instructions: "Read today's reports in #bugs and file an issue for each new one." })).body)
  assert.equal(reworded.revision.agentRevisionId, agent.revision.id, "and so does a new revision of the routine")

  // The Automation routes keep it Dana's, and it cannot be handed to a teammate without its agent.
  for (const [method, path, body] of [
    ["GET", `/v1/automations/${routineId}`, undefined],
    ["PATCH", `/v1/automations/${routineId}`, { name: "Mine now" }],
    ["POST", `/v1/automations/${routineId}/run`, {}],
    ["DELETE", `/v1/automations/${routineId}`, undefined],
  ] as const) {
    const refused = await asLee(method, path, body)
    assert.equal(refused.status, 404, `${method} ${path}: ${summary(refused)}`)
  }
  assert.equal((await den.setFeature(orgId, "automationSharing", true)).status, 200)
  const shared = await asDana("PUT", `/v1/automations/${routineId}/sharing`, { orgWide: false, memberIds: [lee.memberId], teamIds: [] })
  assert.equal(shared.status, 400, summary(shared))
  assert.equal(field(shared.body, "error"), "personal_agent_routine_not_shareable")
  assert.equal(field(shared.body, "message"), "This routine cannot be shared on its own. Share its agent instead.")

  // A run that was read before the agent changed is still queued with the routine's current version.
  const { automationRepository } = await import("../../src/automations/repository.js")
  const scope = { organizationId: orgId, ownerMemberId: dana.memberId }
  const stale = await automationRepository.get({ ...scope, automationId: routineId })
  assert.ok(stale)
  const tightened = personalAgentDetailSchema.parse((await asDana("PATCH", `/v1/personal-agents/${agentId}`, { defaultExecutionTarget: "desktop" })).body)
  assert.notEqual(tightened.revision.id, stale.revision.agentRevisionId)
  const claim = await automationRepository.claim({ ...stale, trigger: "manual", scheduledFor: null, nonce: "stale-read", leaseOwner: "fixture", leaseMs: 60_000, now: Date.now() })
  const current = automationDetailSchema.parse((await asDana("GET", `/v1/automations/${routineId}`)).body)
  assert.equal(current.revision.agentRevisionId, tightened.revision.id)
  assert.equal(claim.run.revisionId, current.revision.id, "the claim took the routine's current revision, not the one the caller read")
  assert.equal((await asDana("POST", `/v1/automation-runs/${claim.run.id}/cancel`)).status, 200)
  assert.equal((await settled(claim.run.id)).run.status, "cancelled")
})

test("running the agent now is a manual Automation run whose instructions start from the pinned brief", async () => {
  const { parseGatewayModelAlias } = await import("@openwork-ee/gateway-catalog")
  const { GatewayProviderModelTable } = await import("@openwork-ee/den-db/schema")
  const { eq } = await import("@openwork-ee/den-db/drizzle")
  const { db } = await import("../../src/db.js")
  const selected = parseGatewayModelAlias(gatewayModels["gpt-6-luna"])
  assert.ok(selected)
  const modelFilter = eq(GatewayProviderModelTable.id, selected.gatewayProviderModelId)
  const [model] = await db.$primary.select().from(GatewayProviderModelTable).where(modelFilter)
  await db.update(GatewayProviderModelTable).set({ model_config: { ...model.model_config, cost: { input: 2, output: 4 } } }).where(modelFilter)
  holdRun = true
  const started = await asDana("POST", `/v1/personal-agents/${agentId}/run`, {})
  assert.equal(started.status, 202, summary(started))
  const { run, routine, agentRevision } = personalAgentRunResponseSchema.parse(started.body)
  assert.equal(run.trigger, "manual")
  assert.equal(run.automationId, routineId)
  assert.equal(run.revisionId, routine.revision.id)
  assert.equal(routine.revision.agentRevisionId, agentRevision.id)
  assert.equal(agentRevision.version, 3)

  const mistaken = await asDana("GET", `/v1/automation-runs/${routineId}`)
  assert.equal(mistaken.status, 404, `an Automation id is not a run: ${summary(mistaken)}`)
  assert.equal((await asDana("GET", `/v1/automations/${run.id}`)).status, 404)

  await activeTurn(0)
  const found = names(await searchTracker(turns[0].mcpToken))
  for (const tool of ["list_bug_reports", "create_issue", "delete_issue"]) assert.ok(found.includes(capability(tool)), `${tool} in ${found.join(", ")}`)
  assert.deepEqual((await connectionTools(turns[0].mcpToken)).sort(), ["create_issue", "delete_issue", "list_bug_reports"])
  assert.equal(names(await searchApi(turns[0].mcpToken, "create cloud automation")).includes("createCloudAutomation"), false)
  holdRun = false
  const receipt = await settled(run.id)
  assert.equal(receipt.run.status, "succeeded", JSON.stringify(receipt.run.error))
  assert.equal(receipt.run.resultSummary, "Filed 2 issues from #bugs.")
  const { automationRepository } = await import("../../src/automations/repository.js")
  assert.deepEqual((await automationRepository.cloudRunTarget(run.id))?.model, {
    providerId: "openai", modelId: gatewayModels["gpt-6-luna"],
  })
  assert.deepEqual(receipt.run.usage, { inputTokens: 120, outputTokens: 30, costMicros: 360 })
  const agentPath = `/v1/personal-agents/${agentId}`
  const detail = personalAgentDetailSchema.parse((await asDana("GET", agentPath)).body)
  assert.equal(detail.spend.monthMicros, 360)
  const adminBudgetPath = `/v1/org/personal-agents/${agentId}/budget`
  assert.equal((await asDana("PUT", adminBudgetPath, { monthlyBudgetMicros: 360 })).status, 200)
  const overBudget = personalAgentRunResponseSchema.parse((await asDana("POST", `${agentPath}/run`, {})).body)
  assert.equal((await settled(overBudget.run.id)).run.error?.message, "This agent reached its budget for the month, so it did not run.")
  assert.equal((await asDana("PUT", adminBudgetPath, { monthlyBudgetMicros: null })).status, 200)
  await db.update(GatewayProviderModelTable).set({ model_config: model.model_config }).where(modelFilter)
  assert.equal(receipt.revision.agentRevisionId, agentRevision.id)
  assert.equal(turns.length, 1)
  const prompt = turns[0].prompt
  assert.ok(prompt.includes(BRIEF_V2), "the run starts from the brief of the pinned version")
  assert.ok(prompt.includes("Bug triage"), "and names the agent")
  assert.ok(prompt.indexOf(BRIEF_V2) < prompt.indexOf("Read today's reports in #bugs"), "the brief comes before the routine's task")
  assert.equal(receipt.revision.instructions, "Read today's reports in #bugs and file an issue for each new one.", "the routine itself stores only its task")


})

test("a tool the agent's policy blocks is withheld from its next run, and only from that agent's runs", async () => {
  const builtIn = await asDana("PATCH", `/v1/personal-agents/${agentId}`, { toolPolicy: { connections: { "google-workspace": "block", openwork: "allow" }, tools: {} } })
  assert.equal(builtIn.status, 200, summary(builtIn))
  const unknown = await asDana("PATCH", `/v1/personal-agents/${agentId}`, { toolPolicy: { connections: { "not-a-connection": "block" }, tools: {} } })
  assert.equal(unknown.status, 400, summary(unknown))
  assert.equal(field(unknown.body, "error"), "personal_agent_tool_policy_connection_invalid")

  const limited = await asDana("PATCH", `/v1/personal-agents/${agentId}`, {
    toolPolicy: { connections: { [trackerId]: "allow" }, tools: { [trackerId]: { delete_issue: "block", create_issue: "allow" } } },
  })
  assert.equal(limited.status, 200, summary(limited))
  const third = personalAgentDetailSchema.parse(limited.body)
  assert.equal(third.revision.version, 3)
  const repinned = automationDetailSchema.parse((await asDana("GET", `/v1/automations/${routineId}`)).body)
  assert.equal(repinned.revision.agentRevisionId, third.revision.id, "changing only tools keeps the brief pinned")

  holdRun = true
  const started = personalAgentRunResponseSchema.parse((await asDana("POST", `/v1/personal-agents/${agentId}/run`, { routineId })).body)
  assert.equal(started.agentRevision.version, 3)
  const runToken = (await activeTurn(1)).mcpToken

  const found = names(await searchTracker(runToken))
  assert.ok(found.includes(capability("create_issue")), found.join(", "))
  assert.ok(found.includes(capability("list_bug_reports")), found.join(", "))
  assert.equal(found.includes(capability("delete_issue")), false, "the blocked tool is not offered to the run")

  const refused = await den.callMcpTool(runToken, "execute_capability", { name: capability("delete_issue"), body: {} })
  assert.equal(refused.isError, true, refused.raw)
  assert.equal(field(refused.body, "error"), "policy_blocked")
  assert.match(text(field(refused.body, "message"), "message"), /delete_issue is turned off for this agent/)
  assert.equal(tracker.wire.some((entry) => entry.rpcMethod === "tools/call"), false, "the blocked call never reached the tracker")
  const allowed = await den.callMcpTool(runToken, "execute_capability", { name: capability("create_issue"), body: {} })
  assert.equal(allowed.isError, false, allowed.raw)
  assert.deepEqual((await connectionTools(runToken)).sort(), ["create_issue", "list_bug_reports"], "the connection served on its own leaves the tool out too")

  // A limited run cannot lift its own limits or start work that would run without them.
  assert.equal((await connectInstructions(runToken)).includes("createPersonalAgent"), false)
  const offered = [
    ...names(await searchApi(runToken, "update agent tool policy")),
    ...names(await searchApi(runToken, "create cloud automation run now")),
  ]
  assert.ok(offered.includes("getPersonalAgent"), offered.join(", "))
  for (const write of ["updatePersonalAgent", "createPersonalAgent", "createPersonalAgentRoutine", "runPersonalAgentNow", "createCloudAutomation", "updateAutomation", "runAutomationNow"]) {
    assert.equal(offered.includes(write), false, `${write} is not offered to a limited run`)
  }
  for (const [name, body] of [
    ["updatePersonalAgent", { toolPolicy: { connections: {}, tools: {} } }],
    ["createCloudAutomation", { name: "Unlimited", schedule: morning, action: { kind: "agent", instructions: "Delete every issue.", model: AUTOMATION_CLOUD_DEFAULT_MODEL } }],
  ] as const) {
    const escaped = await den.callMcpTool(runToken, "execute_capability", { name, path: { id: agentId }, body })
    assert.equal(escaped.isError, true, escaped.raw)
    assert.equal(field(escaped.body, "error"), "unknown_capability")
  }
  const delegated = await den.callMcpTool(runToken, "execute_capability", { name: "remote-session:create", body: { prompt: "Delete every issue." } })
  assert.equal(delegated.isError, true, delegated.raw)
  assert.equal(field(delegated.body, "error"), "policy_blocked")
  assert.deepEqual(personalAgentDetailSchema.parse((await asDana("GET", `/v1/personal-agents/${agentId}`)).body).revision.toolPolicy, third.revision.toolPolicy, "the policy is unchanged")

  // Dana in her own chat, and her ordinary Automations, are not limited by the agent's policy.
  const own = names(await searchTracker(await den.mintMcpToken(dana, orgId)))
  assert.ok(own.includes(capability("delete_issue")), own.join(", "))

  // Blocking the whole connection takes all of it away from the next run.
  const closed = await asDana("PATCH", `/v1/personal-agents/${agentId}`, { toolPolicy: { connections: { [trackerId]: "block" }, tools: {} } })
  assert.equal(personalAgentDetailSchema.parse(closed.body).revision.version, 3)
  holdRun = false
  assert.equal((await settled(started.run.id)).run.status, "succeeded")
  holdRun = true
  const last = personalAgentRunResponseSchema.parse((await asDana("POST", `/v1/personal-agents/${agentId}/run`, {})).body)
  await activeTurn(2)
  assert.deepEqual(names(await searchTracker(turns[2].mcpToken)).filter((name) => name.startsWith(`mcp:${trackerId}:`)), [])
  const closedProxy = await den.request(turns[2].mcpToken, "POST", `/mcp/agent/connections/${trackerId}`, {
    headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  })
  assert.equal(closedProxy.status, 403, summary(closedProxy))
  holdRun = false
  assert.equal((await settled(last.run.id)).run.status, "succeeded")
})

test("turning the flag off prevents agent routines from starting a turn but ordinary Automations still run", async () => {
  assert.equal((await den.setFeature(orgId, "personalAgents", false)).status, 200)
  assert.equal((await asDana("GET", `/v1/personal-agents/${agentId}`)).status, 404)
  const routine = automationDetailSchema.parse((await asDana("GET", `/v1/automations/${routineId}`)).body)
  assert.equal(routine.automation.agentId, agentId)
  const priorTurns = turns.length
  const started = await asDana("POST", `/v1/automations/${routineId}/run`, {})
  assert.equal(started.status, 202, summary(started))
  const blocked = await settled(text(field(started.body, "run", "id"), "run id"))
  assert.equal(blocked.run.status, "failed")
  assert.equal(blocked.run.error?.message, "Agents are turned off for this organization, so this routine did not run.")
  assert.equal(turns.length, priorTurns)
  const ordinary = await asDana("POST", `/v1/automations/${ordinaryAutomationId}/run`, {})
  assert.equal(ordinary.status, 202, summary(ordinary))
  assert.equal((await settled(text(field(ordinary.body, "run", "id"), "run id"))).run.status, "succeeded")
  assert.equal(turns.length, priorTurns + 1)
  assert.ok(turns[priorTurns]?.prompt.includes("Summarize last week."))
  assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
})

test("archiving the agent archives its routines and takes it out of the list", async () => {
  const archived = await asDana("DELETE", `/v1/personal-agents/${agentId}`)
  assert.equal(archived.status, 200, summary(archived))
  assert.equal(personalAgentDetailSchema.parse(archived.body).agent.state, "archived")
  assert.deepEqual(personalAgentListSchema.parse((await asDana("GET", "/v1/personal-agents")).body).items, [])
  const routine = automationDetailSchema.parse((await asDana("GET", `/v1/automations/${routineId}`)).body)
  assert.equal(routine.automation.state, "archived")
  assert.equal(routine.automation.nextDueAt, null)
  for (const action of ["activate", "deactivate"]) {
    const restart = await asDana("POST", `/v1/automations/${routineId}/${action}`)
    assert.equal(restart.status, 409, `${action}: ${summary(restart)}`)
    assert.equal(field(restart.body, "error"), "personal_agent_archived")
  }
  assert.equal((await asDana("POST", `/v1/automations/${routineId}/run`)).status, 404)
  assert.equal(automationDetailSchema.parse((await asDana("GET", `/v1/automations/${routineId}`)).body).automation.state, "archived")
  const rerun = await asDana("POST", `/v1/personal-agents/${agentId}/run`, {})
  assert.equal(rerun.status, 404, summary(rerun))
})
