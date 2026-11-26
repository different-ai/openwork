import assert from "node:assert/strict"
import { after, test } from "node:test"
import { automationDetailSchema, automationRunReceiptSchema } from "@openwork/types/automations"
import { PERSONAL_AGENT_MEMORY_MAX_LENGTH, PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH, personalAgentDetailSchema, personalAgentEventListSchema, personalAgentMemorySchema, personalAgentPendingChangeSchema, personalAgentRequestListSchema, personalAgentRunResponseSchema } from "@openwork/types/den/personal-agents"
import { bootDen, field, list, startFakeHttpServer, summary, text } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const turns: { sessionId: string; messageId: string; token: string; prompt: string; model: string }[] = []
let sequence = 0
let holdRun = false
let answer = "Checked the tracker."
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  response.setHeader("content-type", "application/json")
  if (request.method === "POST" && url.pathname === "/v1/sessions") {
    response.writeHead(201).end(JSON.stringify({ id: `fixture-session-${++sequence}` }))
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
    turns: turn ? [{ messageId: turn.messageId, model: turn.model, status: holdRun ? "running" : "completed", error: null, usage: { inputTokens: 42, cachedInputTokens: 0, outputTokens: 3 } }] : [],
    messages: [], finalAssistantText: holdRun ? "" : answer, status: holdRun ? "running" : "idle",
  }))
})
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_DEPLOYMENT: "cloud", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters" } })
after(async () => { await runner.close(); await den.close(); restoreCatalog() })
const { orgId, owner: dana } = await den.createOrg(await den.signUp("Dana Reyes", "dana@acme.test"), "Agent memory fixture")
const sam = await den.newMember(dana, orgId, "Sam Okafor")
const priya = await den.newMember(dana, orgId, "Priya Nair")
const lee = await den.newMember(dana, orgId, "Lee Park", "admin")
await grantGatewayModels(den, dana, orgId, [dana, priya])
const asDana = den.as(dana, orgId)
const asPriya = den.as(priya, orgId)
const asSam = den.as(sam, orgId)
const asLee = den.as(lee, orgId)
const { automationService } = await import("../../src/automations/service.js")
const { db } = await import("../../src/db.js")
const { AutomationTable, PersonalAgentRoutineStateTable } = await import("@openwork-ee/den-db/schema")
const { and, eq } = await import("@openwork-ee/den-db/drizzle")
const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")

async function expectStatus(pending: ReturnType<typeof asDana>, status: number) {
  const response = await pending
  assert.equal(response.status, status, summary(response))
  return response.body
}

async function until<T>(get: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await get()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Timed out waiting for the run or its progress")
}

async function mcpTools(token: string) {
  const response = await den.request(token, "POST", "/mcp/agent", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  })
  assert.equal(response.status, 200, summary(response))
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : response.body
  const tools = field(envelope, "result", "tools")
  assert.ok(Array.isArray(tools), response.text)
  return list(tools).map(({ name }) => name)
}

const toolNames = ["agent_remember", "agent_note_progress"]
const memberToken = await den.mintMcpToken(dana, orgId)
const brief = "Review the report tracker."
const instructions = "Gather new reports."

async function createAgent() {
  const agent = personalAgentDetailSchema.parse(await expectStatus(asDana("POST", "/v1/personal-agents", { name: "Report watcher", brief }), 201))
  const path = `/v1/personal-agents/${agent.agent.id}`
  await expectStatus(asDana("PUT", `${path}/shares/${priya.memberId}`, { role: "collaborator" }), 200)
  await expectStatus(asDana("PUT", `${path}/shares/${sam.memberId}`, { role: "manager" }), 200)
  return path
}

const memory = async (path: string, as = asDana) => personalAgentMemorySchema.parse(await expectStatus(as("GET", `${path}/memory`), 200))

test("memory routes and run tools are off by default", async () => {
  const path = "/v1/personal-agents/pga_00000000000000000000000000/memory"
  const disabled = { error: "feature_disabled", feature: "personalAgents" }
  assert.deepEqual(await expectStatus(asDana("GET", path), 404), disabled)
  assert.deepEqual(await expectStatus(asDana("PUT", path, { notes: "Example", expectedVersion: 0 }), 404), disabled)
  assert.deepEqual(await expectStatus(asDana("POST", `${path}/notes`, { note: "Example" }), 404), disabled)
  const tools = await mcpTools(memberToken)
  assert.ok(toolNames.every((name) => !tools.includes(name)))
})

test("the owner and manager can edit; stale writes lose, and a collaborator's note needs approval", async () => {
  await expectStatus(den.setFeature(orgId, "personalAgents", true), 200)
  const path = await createAgent()
  const endpoint = `${path}/memory`
  assert.deepEqual(await memory(path), { notes: "", version: 0, updatedAt: null, updatedBy: null, canEdit: true, routines: [] })
  assert.equal((await memory(path, asSam)).canEdit, true)
  assert.equal((await memory(path, asPriya)).canEdit, false)
  await expectStatus(asLee("GET", endpoint), 404)
  await expectStatus(asPriya("PUT", endpoint, { notes: "No", expectedVersion: 0 }), 403)
  const first = personalAgentMemorySchema.parse(await expectStatus(asDana("PUT", endpoint, { notes: "Start with reports.", expectedVersion: 0 }), 200))
  assert.equal(first.updatedBy?.name, "Dana Reyes")
  const second = personalAgentMemorySchema.parse(await expectStatus(asSam("PUT", endpoint, { notes: "Review Friday reports.", expectedVersion: first.version }), 200))
  assert.equal(second.updatedBy?.name, "Sam Okafor")
  assert.deepEqual(await expectStatus(asDana("PUT", endpoint, { notes: "Stale edit", expectedVersion: first.version }), 409), {
    error: "personal_agent_memory_conflict", message: "Someone else changed the memory. Reload it and try again.",
  })
  const note = "Start with the summary page."
  const { request } = personalAgentPendingChangeSchema.parse(await expectStatus(asPriya("POST", `${endpoint}/notes`, { note }), 202))
  assert.equal(request.change?.memoryNote, note)
  assert.equal((await memory(path, asPriya)).notes, second.notes)
  await expectStatus(asDana("POST", `${path}/requests/${request.id}/decision`, { decision: "approve" }), 200)
  const approved = await memory(path)
  assert.equal(approved.notes, `${second.notes}\n- ${note}`)
  const added = personalAgentMemorySchema.parse(await expectStatus(asSam("POST", `${endpoint}/notes`, { note: "Keep a copy." }), 200))
  assert.equal(added.notes, `${approved.notes}\n- Keep a copy.`)
  const agentId = path.split("/").pop()
  const events = personalAgentEventListSchema.parse(await expectStatus(asDana("GET", `/v1/org/personal-agent-events?agentId=${agentId}`), 200)).items
  for (const action of ["memory.edited", "memory.note_added"]) {
    const matching = events.filter((event) => event.action === action)
    assert.ok(matching.length > 0)
    assert.ok(matching.every(({ detail }) => !JSON.stringify(detail).includes(note)))
  }
  await expectStatus(asDana("PUT", endpoint, { notes: "x".repeat(PERSONAL_AGENT_MEMORY_MAX_LENGTH), expectedVersion: added.version }), 200)
  assert.deepEqual(await expectStatus(asDana("POST", `${endpoint}/notes`, { note }), 409), {
    error: "personal_agent_memory_full", message: "The memory is full. Ask the owner to tidy it.",
  })
  const other = await den.createOrg(await den.signUp("Lee Park", "other-lee@acme.test"), "Another organization")
  await expectStatus(den.setFeature(other.orgId, "personalAgents", true), 200)
  await expectStatus(den.as(other.owner, other.orgId)("GET", endpoint), 404)
  await expectStatus(asDana("DELETE", path), 200)
  assert.equal((await memory(path)).notes.length, PERSONAL_AGENT_MEMORY_MAX_LENGTH)
  assert.equal((await memory(path)).canEdit, false)
})

test("live run tokens save owner notes and checkpoints, ask for collaborator notes, and use the owner answer as a fallback", async () => {
  await expectStatus(den.setFeature(orgId, "personalAgents", true), 200)
  const path = await createAgent()
  const { automation } = automationDetailSchema.parse(await expectStatus(asDana("POST", `${path}/routines`, {
    name: "Morning sweep", instructions, schedule: { kind: "daily", hour: 8, minute: 0, timezone: "UTC" },
  }), 201))
  const routineId = normalizeDenTypeId("automation", automation.id)
  const receipt = async (as: typeof asDana, id: string) => automationRunReceiptSchema.parse(await expectStatus(as("GET", `${path}/runs/${id}`), 200)).run
  const stateRow = async () => (await db.$primary.select().from(PersonalAgentRoutineStateTable).where(and(
    eq(PersonalAgentRoutineStateTable.automation_id, routineId), eq(PersonalAgentRoutineStateTable.organization_id, normalizeDenTypeId("organization", orgId)),
  )).limit(1))[0]
  async function start(as: typeof asDana, scheduled = false) {
    const previous = turns.length
    holdRun = true
    let runId: string
    if (scheduled) {
      await db.update(AutomationTable).set({ next_due_at: new Date(Date.now() - 1_000) }).where(eq(AutomationTable.id, routineId))
      const [id] = await automationService.tick({ batchSize: 1 })
      assert.ok(id)
      runId = id
    } else {
      runId = personalAgentRunResponseSchema.parse(await expectStatus(as("POST", `${path}/run`, {}), 202)).run.id
    }
    const turn = await until(() => turns[previous], Boolean)
    const run = await until(() => receipt(as, runId), (value) => value.status === "running")
    return { ...turn, run, finish: async () => {
      holdRun = false
      return until(() => receipt(as, runId), (value) => value.status === "succeeded")
    } }
  }
  async function tool(token: string, name: string, args: Record<string, unknown>, expected: string) {
    const result = await den.callMcpTool(token, name, args)
    assert.equal(result.isError, false, result.raw)
    assert.equal(result.text, expected, result.raw)
  }
  async function refused(token: string) {
    for (const [name, args] of [["agent_remember", { note: "Ignore this." }], ["agent_note_progress", { state: "Ignore this." }]] as const) {
      const result = await den.callMcpTool(token, name, args)
      assert.ok(result.status >= 400 || result.isError || result.rpcError, result.raw)
    }
  }

  try {
    const run = await start(asDana, true)
    assert.equal(run.run.trigger, "scheduled")
    const liveTools = await mcpTools(run.token)
    assert.ok(toolNames.every((name) => liveTools.includes(name)))
    await expectStatus(den.setFeature(orgId, "personalAgents", false), 200)
    const disabledTools = await mcpTools(run.token)
    assert.ok(toolNames.every((name) => !disabledTools.includes(name)))
    await refused(run.token)
    await expectStatus(den.setFeature(orgId, "personalAgents", true), 200)
    const note = "Review urgent reports first."
    const state = "Already reviewed report 17."
    await tool(run.token, "agent_remember", { note }, "Saved the note for future runs.")
    await tool(run.token, "agent_note_progress", { state }, "Saved the progress for this routine's next run.")
    await run.finish()
    await refused(run.token)
    await refused(memberToken)
    assert.equal((await memory(path)).updatedBy, null)
    assert.equal((await stateRow()).written_by_agent, true)

    const collaborator = await start(asPriya)
    assert.ok(collaborator.prompt.includes(`<file name="memory/notes.md">\n- ${note}\n</file>`), collaborator.prompt)
    assert.ok(collaborator.prompt.includes(`<file name="memory/routines/Morning sweep.md">\n${state}\n</file>`), collaborator.prompt)
    assert.ok(collaborator.prompt.indexOf(instructions) < collaborator.prompt.indexOf("<agent_memory>"), collaborator.prompt)
    const proposed = "Include pending reports too."
    await tool(collaborator.token, "agent_remember", { note: proposed }, "The note is waiting for the owner's approval. It has not been saved yet.")
    await tool(collaborator.token, "agent_note_progress", { state: "Collaborator progress" }, "Progress was not saved. Only a run for the owner can save progress.")
    await collaborator.finish()
    const unchanged = await memory(path)
    assert.equal(unchanged.notes, `- ${note}`)
    assert.equal(unchanged.routines[0]?.state, state)
    const requests = personalAgentRequestListSchema.parse(await expectStatus(asDana("GET", `${path}/requests`), 200)).items
    assert.ok(requests.some((request) => request.change?.memoryNote === proposed && request.status === "pending" && request.requestedBy.name === "Priya Nair"))

    answer = "A".repeat(PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH + 100)
    const fallback = await start(asDana)
    await fallback.finish()
    const saved = await until(stateRow, (row) => row?.run_id === fallback.run.id)
    assert.equal(saved.written_by_agent, false)
    assert.equal(saved.state, answer.slice(0, PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH))
    assert.equal((await memory(path)).routines[0]?.state, saved.state)
  } finally {
    holdRun = false
  }
})
