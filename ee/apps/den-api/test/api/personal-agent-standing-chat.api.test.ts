import assert from "node:assert/strict"
import { after, test } from "node:test"
import { personalAgentChatTurnResponseSchema, personalAgentDetailSchema, personalAgentStandingChatSchema } from "@openwork/types/den/personal-agents"
import { bootDen, field, startFakeHttpServer, startFakeMcpServer, summary, text } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const owners = new Map<string, string>()
const computers: unknown[] = []
const sent: { session: string; id: string; token: string; status: "running" | "completed" }[] = []
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  const session = url.pathname.split("/")[3] ?? ""
  response.setHeader("content-type", "application/json")
  if (request.method === "PUT") {
    const body: unknown = JSON.parse(raw)
    assert.equal(field(body, "profile"), "agent_chat")
    owners.set(session, text(field(body, "owner"), "chat owner"))
    computers.push(field(body, "computer"))
    response.writeHead(201).end(JSON.stringify({ id: session, profile: "agent_chat" }))
    return
  }
  if (request.method === "POST") {
    const body: unknown = JSON.parse(raw)
    assert.equal(field(body, "credentials", "mcpToken"), undefined)
    assert.equal(field(body, "credentials", "resumeGrant"), undefined)
    sent.push({ session, id: text(field(body, "messageId"), "turn id"), token: text(field(body, "credentials", "agentChatToken"), "chat token"), status: "running" })
    response.writeHead(202).end(JSON.stringify({ state: "accepted", turn: { profile: "agent_chat" } }))
    return
  }
  if (owners.has(session)) assert.equal(url.searchParams.get("expectedOwner"), owners.get(session))
  const messageId = url.searchParams.get("messageId")
  const matches = sent.filter((entry) => entry.session === session && (!messageId || entry.id === messageId))
  const messages = matches.filter((entry) => entry.status === "completed").flatMap((entry) => [
    { role: "assistant", messageId: entry.id, text: "", toolCalls: [{ id: "tracker-call", name: "read_ticket", input: { secret: "fixture secret" } }] },
    { role: "tool", messageId: entry.id, callId: "tracker-call", name: "read_ticket", isError: false, output: "fixture output" },
    { role: "assistant", messageId: entry.id, text: "Private reply", toolCalls: [] },
  ])
  response.end(JSON.stringify({ turns: matches.map((turn) => ({ messageId: turn.id, status: turn.status, error: null })), messages, finalAssistantText: "Private reply" }))
})
const connector = await startFakeMcpServer({ tools: [{ name: "read_ticket", description: "Read a tracker ticket", annotations: { readOnlyHint: true }, text: "Tracker result" }] })
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_DEPLOYMENT: "cloud", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters" } })
after(async () => { await den.close(); await connector.close(); await runner.close(); restoreCatalog() })

function call(token: string, name: string, args: object, endpoint = "/mcp/agent-chat") {
  return den.request(token, "POST", endpoint, { headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } })
}

function result(response: Awaited<ReturnType<typeof call>>) {
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : response.body
  return field(envelope, "result")
}

test("standing chat keeps a private serialized thread and dispatches approved connectors only on a later turn", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Agent Owner", "owner@acme.test"), "Standing chat fixture")
  const teammate = await den.newMember(owner, orgId, "Teammate")
  const asOwner = den.as(owner, orgId)
  const asTeammate = den.as(teammate, orgId)
  await grantGatewayModels(den, owner, orgId, [owner, teammate])
  assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
  const created = await asOwner("POST", "/v1/personal-agents", { name: "Tracker assistant", brief: "Answer questions about the tracker." })
  assert.equal(created.status, 201, summary(created))
  const path = `/v1/personal-agents/${personalAgentDetailSchema.parse(created.body).agent.id}`
  const chat = `${path}/standing-chat`
  const createdConnection = await asOwner("POST", "/v1/mcp-connections", {
    name: "Tracker", url: `${connector.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  assert.equal(createdConnection.status, 200, summary(createdConnection))
  const connectionId = text(field(createdConnection.body, "id"), "connection id")
  assert.equal((await asOwner("PUT", `${path}/shares/${teammate.memberId}`, { role: "collaborator" })).status, 200)
  const message = { clientMessageId: "first", message: "Look up the ticket." }
  assert.equal((await asOwner("POST", chat, { ...message, sessionId: "from-client" })).status, 400)
  const concurrent = await Promise.all([asOwner("POST", chat, message), asOwner("POST", chat, message)])
  for (const response of concurrent) assert.equal(response.status, 202, summary(response))
  const [first, repeat] = concurrent.map((response) => personalAgentChatTurnResponseSchema.parse(response.body).turn)
  assert.equal(repeat.id, first.id)
  assert.equal(sent.length, 1)
  const firstRun = sent[0]
  assert.equal(firstRun.id, first.id)
  assert.equal((await asOwner("POST", chat, { ...message, message: "Changed" })).status, 409)
  assert.equal((await asOwner("POST", chat, { ...message, clientMessageId: "second" })).status, 409)
  assert.deepEqual(personalAgentStandingChatSchema.parse((await asTeammate("GET", chat)).body).turns, [])

  assert.equal((await call(await den.mintMcpToken(owner, orgId), "search_capabilities", { query: "tracker" })).status, 403)
  for (const endpoint of ["/mcp", "/mcp/agent", `/mcp/agent/connections/${connectionId}`]) {
    assert.equal((await call(firstRun.token, "search_capabilities", { query: "tracker" }, endpoint)).status, 403)
  }
  const args = { name: `mcp:${connectionId}:read_ticket`, body: {} }
  const blocked = await call(firstRun.token, "execute_capability", args)
  assert.equal(field(result(blocked), "isError"), true, blocked.text)
  assert.equal(connector.wire.filter((call) => call.rpcMethod === "tools/call").length, 0)
  const asked = await call(firstRun.token, "request_agent_connector_access", { connectionName: "Tracker", action: "read_ticket" })
  const approvalId = text(field(result(asked), "structuredContent", "requestId"), asked.text)
  assert.equal((await asOwner("POST", `${path}/requests/${approvalId}/decision`, { decision: "allow_once" })).status, 200)
  assert.equal(field(result(await call(firstRun.token, "execute_capability", args)), "isError"), true)
  firstRun.status = "completed"
  const history = personalAgentStandingChatSchema.parse((await asOwner("GET", chat)).body).turns
  assert.equal(history[0]?.reply, "Private reply")
  assert.equal(history[0]?.status, "succeeded")
  assert.deepEqual(history[0]?.parts, [
    { type: "tool", id: "tracker-call", name: "read_ticket", status: "completed", input: null, output: null, error: null, truncated: false },
    { type: "text", text: "Private reply" },
  ])
  assert.deepEqual(personalAgentStandingChatSchema.parse((await asTeammate("GET", chat)).body).turns, [])
  assert.equal((await call(firstRun.token, "execute_capability", args)).status, 403)

  const continued = await asOwner("POST", chat, { clientMessageId: "second", message: "I approved it; continue." })
  assert.equal(continued.status, 202, summary(continued))
  assert.equal(sent.length, 2)
  assert.equal(sent[1].session, firstRun.session)
  assert.equal(field(result(await call(sent[1].token, "execute_capability", args)), "isError"), false)
  assert.equal(field(result(await call(sent[1].token, "execute_capability", args)), "isError"), true)
  assert.equal(connector.wire.filter((call) => call.rpcMethod === "tools/call").length, 1)
  assert.equal((await den.setFeature(orgId, "personalAgents", false)).status, 200)
  assert.equal((await call(sent[1].token, "execute_capability", args)).status, 403)
  assert.equal((await asOwner("GET", chat)).status, 404)
})

test("OpenWork's own tools start off for an agent: its owner gives it one tool, one use, or the whole connection, and an admin can block it", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Routine Owner", "routines@acme.test"), "OpenWork tools fixture")
  const asOwner = den.as(owner, orgId)
  await grantGatewayModels(den, owner, orgId, [owner])
  assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
  const created = await asOwner("POST", "/v1/personal-agents", { name: "Pipeline assistant", brief: "Keep the pipeline tidy." })
  assert.equal(created.status, 201, summary(created))
  const agentId = personalAgentDetailSchema.parse(created.body).agent.id
  const path = `/v1/personal-agents/${agentId}`
  const chat = `${path}/standing-chat`
  const names = (response: Awaited<ReturnType<typeof call>>) => {
    const content = field(result(response), "content")
    const payload: unknown = JSON.parse(text(field(Array.isArray(content) ? content[0] : null, "text"), response.text))
    const matches = field(payload, "matches")
    const off = field(payload, "offConnectors")
    return {
      matches: Array.isArray(matches) ? matches.map((match) => text(field(match, "name"), "match name")) : [],
      off: Array.isArray(off) ? off.map((name) => text(name, "connector name")) : [],
    }
  }
  const turn = async (clientMessageId: string) => {
    const before = sent.length
    const response = await asOwner("POST", chat, { clientMessageId, message: "Add a routine that lists the pipeline every morning." })
    assert.equal(response.status, 202, summary(response))
    assert.equal(sent.length, before + 1)
    return sent[before]
  }
  const finish = async (entry: (typeof sent)[number]) => {
    entry.status = "completed"
    assert.equal((await asOwner("GET", chat)).status, 200)
  }
  const routine = { name: "createPersonalAgentRoutine", path: { id: agentId }, body: {
    name: "Morning pipeline", instructions: "List every open deal.", schedule: { kind: "daily", timezone: "America/Los_Angeles", hour: 8, minute: 0 },
  } }
  const errorText = (response: Awaited<ReturnType<typeof call>>) => JSON.stringify(result(response))

  const pendingRoutine = async () => {
    const items = field((await asOwner("GET", `${path}/requests`)).body, "items")
    const waiting = Array.isArray(items) ? items.find((item) => field(item, "status") === "pending" && field(item, "toolName") === "createPersonalAgentRoutine") : null
    return text(field(waiting, "id"), "a pending request to add the routine")
  }

  const openWorkTools = async () => {
    const connections = field((await asOwner("GET", `${path}/tools`)).body, "connections")
    const openWork: unknown = Array.isArray(connections) ? connections[0] : null
    assert.equal(field(openWork, "name"), "OpenWork")
    return openWork
  }
  const search = async (token: string, query = "agent routine") => names(await call(token, "search_capabilities", { query }))
  const list = (token: string) => call(token, "execute_capability", { name: "listPersonalAgentRoutines", path: { id: agentId } })
  const ask = async (token: string, action: string) => {
    const asked = await call(token, "request_agent_connector_access", { connectionName: "OpenWork", action })
    return text(field(result(asked), "structuredContent", "requestId"), asked.text)
  }
  const decide = (requestId: string, decision: string) => asOwner("POST", `${path}/requests/${requestId}/decision`, { decision })

  const start = await openWorkTools()
  assert.equal(field(start, "blocked"), true)
  assert.equal(field(start, "onlyChosenTools"), false)
  const startTools = field(start, "tools")
  assert.ok(Array.isArray(startTools) && startTools.some((tool) => field(tool, "name") === "listPersonalAgentRoutines" && field(tool, "access") === "block"), JSON.stringify(startTools).slice(0, 400))

  const payloadOf = (response: Awaited<ReturnType<typeof call>>): unknown => {
    const content = field(result(response), "content")
    return JSON.parse(text(field(Array.isArray(content) ? content[0] : null, "text"), response.text))
  }
  const offTools = async (token: string, query: string) => {
    const tools = field(payloadOf(await call(token, "search_capabilities", { query })), "offTools")
    return Array.isArray(tools) ? tools.map((tool) => `${text(field(tool, "connector"), "connector")}:${text(field(tool, "tool"), "tool")}`) : []
  }
  const readSkill = (token: string) => call(token, "execute_capability", { name: "skill:create-skill" })

  const first = await turn("openwork-first")
  const closed = await search(first.token)
  assert.deepEqual(closed.matches, [])
  assert.ok(closed.off.includes("OpenWork"), JSON.stringify(closed))
  assert.ok((await offTools(first.token, "list agent routines")).includes("OpenWork:listPersonalAgentRoutines"))
  assert.deepEqual((await offTools(first.token, "do you have access to my skills?")).slice(0, 1), ["OpenWork:get_skill"])
  assert.equal(field(payloadOf(await call(first.token, "search_capabilities", { query: "skills" })), "skills"), undefined)
  assert.equal(field(result(await readSkill(first.token)), "isError"), true)
  assert.equal((await decide(await ask(first.token, "get_skill"), "always_allow")).status, 200)
  assert.equal(field(result(await list(first.token)), "isError"), true)
  const listAsk = await ask(first.token, "listPersonalAgentRoutines")
  const items = field((await asOwner("GET", `${path}/requests`)).body, "items")
  const waiting: unknown = Array.isArray(items) ? items.find((item) => field(item, "id") === listAsk) : null
  assert.deepEqual(field(waiting, "canDecide"), ["deny", "allow_once", "always_allow", "turn_on"])
  assert.equal((await decide(listAsk, "always_allow")).status, 200)
  const picked = personalAgentDetailSchema.parse((await asOwner("GET", path)).body).revision.toolPolicy
  assert.deepEqual(picked, { connections: { openwork: "ask" }, tools: { openwork: { get_skill: "allow", listPersonalAgentRoutines: "allow" } } })
  const limited = await openWorkTools()
  assert.equal(field(limited, "blocked"), true)
  assert.equal(field(limited, "onlyChosenTools"), true)
  await finish(first)

  const second = await turn("openwork-second")
  const listed = field(payloadOf(await call(second.token, "search_capabilities", { query: "skills" })), "skills")
  assert.ok(Array.isArray(listed) && listed.some((skill) => field(skill, "name") === "skill:create-skill"), JSON.stringify(listed))
  assert.ok(!(await offTools(second.token, "skills")).includes("OpenWork:get_skill"))
  const skillRead = await readSkill(second.token)
  assert.equal(field(result(skillRead), "isError"), false, skillRead.text)
  assert.match(skillRead.text, /name: create-skill/)
  assert.ok(!(await offTools(second.token, "list agent routines")).includes("OpenWork:listPersonalAgentRoutines"))
  assert.ok((await offTools(second.token, "add agent routine")).includes("OpenWork:createPersonalAgentRoutine"))
  assert.deepEqual((await search(second.token, "list agent routines")).matches, ["listPersonalAgentRoutines"])
  assert.equal(field(result(await list(second.token)), "isError"), false)
  assert.equal(field(result(await call(second.token, "execute_capability", routine)), "isError"), true)
  assert.deepEqual(personalAgentDetailSchema.parse((await asOwner("GET", path)).body).routines, [])
  assert.equal((await decide(await ask(second.token, "createPersonalAgentRoutine"), "allow_once")).status, 200)
  await finish(second)

  const third = await turn("openwork-third")
  const made = await call(third.token, "execute_capability", routine)
  assert.equal(field(result(made), "isError"), false, made.text)
  assert.deepEqual(personalAgentDetailSchema.parse((await asOwner("GET", path)).body).routines.map(({ name }) => name), ["Morning pipeline"])
  assert.equal(field(result(await call(third.token, "execute_capability", routine)), "isError"), true)
  await finish(third)

  const chosenInPanel = await asOwner("PATCH", path, { toolPolicy: { connections: { openwork: "ask" }, tools: { openwork: { listPersonalAgentRoutines: "ask" } } } })
  assert.equal(chosenInPanel.status, 200, summary(chosenInPanel))
  const asksFirst = await turn("openwork-asks-first")
  assert.match(errorText(await list(asksFirst.token)), /needs a yes from a person first/)
  await finish(asksFirst)

  const on = await asOwner("PATCH", path, { toolPolicy: { connections: { openwork: "allow" }, tools: {} } })
  assert.equal(on.status, 200, summary(on))
  assert.equal(field(await openWorkTools(), "blocked"), false)
  const fourth = await turn("openwork-fourth")
  const open = await search(fourth.token)
  assert.ok(open.matches.includes("listPersonalAgentRoutines") && open.matches.includes("createPersonalAgentRoutine"), JSON.stringify(open))
  assert.ok(!open.off.includes("OpenWork"))
  assert.equal(field(result(await list(fourth.token)), "isError"), false)
  assert.match(errorText(await call(fourth.token, "execute_capability", routine)), /needs a yes from a person first/)
  assert.equal((await decide(await pendingRoutine(), "deny")).status, 200)
  await finish(fourth)

  const adminBlock = await asOwner("PUT", "/v1/org/personal-agent-policy", { toolPolicy: { connections: { openwork: "block" }, tools: {} } })
  assert.equal(adminBlock.status, 200, summary(adminBlock))
  assert.equal(field(await openWorkTools(), "lockedByOrganization"), true)
  const blocked = await turn("openwork-admin-blocked")
  const shut = await search(blocked.token)
  assert.deepEqual(shut.matches, [])
  assert.ok(!shut.off.includes("OpenWork"), JSON.stringify(shut))
  assert.equal(field(result(await list(blocked.token)), "isError"), true)
  assert.equal(field(result(await call(blocked.token, "request_agent_connector_access", { connectionName: "OpenWork", action: "listPersonalAgentRoutines" })), "structuredContent", "status"), "unavailable")
  await finish(blocked)
  assert.equal((await asOwner("PUT", "/v1/org/personal-agent-policy", { toolPolicy: { connections: {}, tools: {} } })).status, 200)

  const fifth = await turn("openwork-fifth")
  const widened = await call(fifth.token, "execute_capability", { name: "updatePersonalAgent", path: { id: agentId }, body: { toolPolicy: { connections: {}, tools: {} } } })
  assert.match(errorText(widened), /cannot change what it is allowed to use or spend/)
  const another = await call(fifth.token, "execute_capability", { name: "createPersonalAgent", body: { name: "Second", brief: "Another agent." } })
  assert.match(errorText(another), /cannot make another agent/)
  assert.deepEqual(personalAgentDetailSchema.parse((await asOwner("GET", path)).body).routines.map(({ name }) => name), ["Morning pipeline"])
})

test("an agent's computer is a connector: offered only where the organization has computers, off until its owner turns it on, and an admin can block it", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Computer Owner", "computer@acme.test"), "Agent computer fixture")
  const asOwner = den.as(owner, orgId)
  await grantGatewayModels(den, owner, orgId, [owner])
  assert.equal((await den.setFeature(orgId, "personalAgents", true)).status, 200)
  const created = await asOwner("POST", "/v1/personal-agents", { name: "Numbers helper", brief: "Work through spreadsheets." })
  assert.equal(created.status, 201, summary(created))
  const path = `/v1/personal-agents/${personalAgentDetailSchema.parse(created.body).agent.id}`
  const listed = async () => {
    const connections = field((await asOwner("GET", `${path}/tools`)).body, "connections")
    return Array.isArray(connections) ? connections.find((connection) => field(connection, "connectionId") === "computer") : undefined
  }
  const turn = async (clientMessageId: string) => {
    const before = sent.length
    const response = await asOwner("POST", `${path}/standing-chat`, { clientMessageId, message: "Add up the totals in this sheet." })
    assert.equal(response.status, 202, summary(response))
    const entry = sent[before]
    assert.ok(entry)
    return { entry, computer: computers.at(-1) }
  }
  const finish = async (entry: (typeof sent)[number]) => {
    entry.status = "completed"
    assert.equal((await asOwner("GET", `${path}/standing-chat`)).status, 200)
  }
  const off = async (token: string) => {
    const content = field(result(await call(token, "search_capabilities", { query: "computer" })), "content")
    const names = field(JSON.parse(text(field(Array.isArray(content) ? content[0] : null, "text"), "search result")), "offConnectors")
    return Array.isArray(names) ? names : []
  }
  const ask = (token: string) => call(token, "request_agent_connector_access", { connectionName: "Computer" })

  assert.equal(await listed(), undefined)
  const without = await turn("computer-not-offered")
  assert.equal(without.computer, false)
  assert.ok(!(await off(without.entry.token)).includes("Computer"))
  assert.equal(field(result(await ask(without.entry.token)), "structuredContent", "status"), "unavailable")
  await finish(without.entry)

  assert.equal((await den.setFeature(orgId, "remoteComputers", true)).status, 200)
  const start = await listed()
  assert.equal(field(start, "name"), "Computer")
  assert.equal(field(start, "blocked"), true)
  const tools = field(start, "tools")
  assert.deepEqual(Array.isArray(tools) ? tools.map((tool) => [field(tool, "name"), field(tool, "write")]) : null, [["bash", false], ["look", false]])
  const first = await turn("computer-off")
  assert.equal(first.computer, false)
  assert.ok((await off(first.entry.token)).includes("Computer"))
  const asked = await ask(first.entry.token)
  const requestId = text(field(result(asked), "structuredContent", "requestId"), asked.text)
  assert.equal((await asOwner("POST", `${path}/requests/${requestId}/decision`, { decision: "turn_on" })).status, 200)
  assert.deepEqual(personalAgentDetailSchema.parse((await asOwner("GET", path)).body).revision.toolPolicy, { connections: { computer: "allow" }, tools: {} })
  await finish(first.entry)

  const second = await turn("computer-on")
  assert.equal(second.computer, true)
  assert.ok(!(await off(second.entry.token)).includes("Computer"))
  await finish(second.entry)

  assert.equal((await asOwner("PUT", "/v1/org/personal-agent-policy", { toolPolicy: { connections: { computer: "block" }, tools: {} } })).status, 200)
  assert.equal(field(await listed(), "lockedByOrganization"), true)
  const blocked = await turn("computer-admin-blocked")
  assert.equal(blocked.computer, false)
  assert.ok(!(await off(blocked.entry.token)).includes("Computer"))
  assert.equal(field(result(await ask(blocked.entry.token)), "structuredContent", "status"), "unavailable")
})
