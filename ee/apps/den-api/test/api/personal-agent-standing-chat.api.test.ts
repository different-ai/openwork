import assert from "node:assert/strict"
import { after, test } from "node:test"
import { personalAgentChatTurnResponseSchema, personalAgentDetailSchema, personalAgentStandingChatSchema } from "@openwork/types/den/personal-agents"
import { bootDen, field, startFakeHttpServer, startFakeMcpServer, summary, text } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const owners = new Map<string, string>()
const sent: { session: string; id: string; token: string; status: "running" | "completed" }[] = []
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  const session = url.pathname.split("/")[3] ?? ""
  response.setHeader("content-type", "application/json")
  if (request.method === "PUT") {
    const body: unknown = JSON.parse(raw)
    assert.equal(field(body, "profile"), "agent_chat")
    owners.set(session, text(field(body, "owner"), "chat owner"))
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
  const turn = sent.find((entry) => entry.session === session && entry.id === url.searchParams.get("messageId"))
  response.end(JSON.stringify({ turns: turn ? [{ messageId: turn.id, status: turn.status, error: null }] : [], messages: [], finalAssistantText: "Private reply" }))
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
