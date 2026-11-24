import assert from "node:assert/strict"
import { after, test } from "node:test"
import { workbotOwner, workbotSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { bootDen, field, list, startFakeHttpServer, summary, text } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const sessions = new Map<string, string>()
const turns: { sessionId: string; prompt: string }[] = []
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  const sessionId = decodeURIComponent(url.pathname.split("/")[3] ?? "")
  if (sessions.get(sessionId) !== request.headers["x-openwork-headless-owner"]) { response.writeHead(404).end(); return }
  response.setHeader("content-type", "application/json")
  if (request.method === "POST" && url.pathname.endsWith("/turns")) {
    turns.push({ sessionId, prompt: text(field(JSON.parse(raw), "prompt"), "prompt") })
    response.writeHead(202).end(JSON.stringify({ state: "queued" })); return
  }
  response.end(JSON.stringify({ turns: [], messages: [], finalAssistantText: "", status: "idle" }))
})
const den = await bootDen({ env: { ...gatewayFixtureEnv, LINEAR_API_KEY: "", DEN_WORKBOT_URL: "http://localhost:3020", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters", DEN_AUDIT_SELF_HOSTED_ENABLED: "true", DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "fixture-callback-token-at-least-thirty-two-characters" } })
after(async () => { await runner.close(); await den.close(); restoreCatalog() })
const { client } = await import("../../src/db.js")
const { observeNativeEvent, deliverNativeEvent } = await import("../../src/native-mcp-events/worker.js")
const { dispatchMcpEvent } = await import("../../src/mcp-events/worker.js")
const { automationRunnerRowId } = await import("../../src/automations/repository.js")
const { remoteSessionDirectTools } = await import("../../src/mcp/remote-session-tools.js")
const org = await den.createOrg(await den.signUp("Thread Owner"), "Thread fixture workspace")
const other = await den.newMember(org.owner, org.orgId, "Thread Other")
const models = await grantGatewayModels(den, org.owner, org.orgId, [org.owner])
const token = await den.mintMcpToken(org.owner, org.orgId)
const otherToken = await den.mintMcpToken(other, org.orgId)
const SESSION = "openwork.remote_session.status_changed"
const chat = workbotSessionId(org.orgId, org.owner.memberId)
const runnerId = "thread-test-runner"
const computerId = automationRunnerRowId({ organizationId: org.orgId, ownerMemberId: org.owner.memberId, runnerId })
let desktop = ""

async function rpc(method: string, params: Record<string, unknown> = {}, bearer = token) {
  const response = await den.request(bearer, "POST", "/mcp/agent", { headers: { accept: "application/json, text/event-stream" }, body: { jsonrpc: "2.0", id: 1, method, params } })
  const line = response.text.split("\n").find(value => value.startsWith("data:"))
  const body: unknown = line ? JSON.parse(line.slice(5)) : response.body
  return { ...response, result: field(body, "result"), error: field(body, "error") }
}
const report = (method: "POST" | "PUT", path: string, body: unknown) => den.request(desktop, method, path, { body })
const create = (bearer: string) => den.callMcpTool(bearer, "execute_capability", { name: "remote-session:create", body: { target: "registered", computerId, workspaceId: "fixture-workspace", title: "Thread task" } })
/** The desktop takes the command, then reports the session's state. */
async function settle(commandId: string, sessionId: string, status: "running" | "idle") {
  if (status === "running") {
    assert.equal((await report("POST", `/v1/remote-session-commands/${commandId}/claim`, {})).status, 200)
    assert.equal((await report("POST", `/v1/remote-session-commands/${commandId}/complete`, { status: "delivered", sessionId, workspaceId: "fixture-workspace" })).status, 200)
    return
  }
  const reported = await report("POST", `/v1/remote-session-commands/${commandId}/session`, { status, finalText: "Private result stays in the normal read", observedAt: Date.now(), messageCount: 2 })
  assert.equal(reported.status, 200, summary(reported))
}
async function runWorkers() {
  if (!("getConnection" in client)) throw new Error("needs MySQL")
  await client.query("UPDATE mcp_native_subscription SET available_at = '2000-01-01' WHERE status = 'active'")
  for (let i = 0; i < 25 && await observeNativeEvent(); i++) { /* drain due observations */ }
  for (let i = 0; i < 25 && await deliverNativeEvent(); i++) { /* drain due receipts */ }
  for (let i = 0; i < 25 && await dispatchMcpEvent(); i++) { /* drain thread turns */ }
}

test("the remote-session actions are tools of their own, named for clients that take plain names", () => {
  const tools = remoteSessionDirectTools({ answer: true, attach: false })
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["answer", "create", "list", "read", "send", "status", "stop", "targets"].map(action => `remote_session_${action}`))
  assert.ok(tools.every(tool => /^[a-z_]+$/.test(tool.name)))
  assert.equal(tools.find(tool => tool.name === "remote_session_create")?.capability, "remote-session:create")
  assert.equal(tools.find(tool => tool.name === "remote_session_status")?.annotations.readOnlyHint, true)
  assert.equal(tools.find(tool => tool.name === "remote_session_send")?.annotations.readOnlyHint, false)
  assert.equal(tools.some(tool => tool.name === "remote_session_attach"), false)
})

test("without the flag a started session says nothing about events and poll delivery is not offered", async () => {
  const minted = await den.as(org.owner, org.orgId)("POST", "/v1/session-runners/token", {
    runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.6.0", platform: "darwin", concurrency: 1,
    capabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"],
  })
  assert.equal(minted.status, 200, summary(minted))
  desktop = text(field(minted.body, "token"), "desktop token")
  assert.equal((await report("PUT", "/v1/session-runners/inventory", {
    computer: { label: "Thread laptop", platform: "darwin", appVersion: "1.6.0" },
    workspaces: [{ workspaceId: "fixture-workspace", name: "Fixture", active: true, engine: "v2", defaultModel: null, models: [] }],
  })).status, 200)
  assert.equal((await den.setFeature(org.orgId, "nativeMcpEvents", true)).status, 200)
  const created = await create(token)
  assert.equal(created.isError, false, created.raw)
  assert.equal(field(created.body, "event"), undefined)
  assert.deepEqual(list(field((await rpc("events/list")).result, "events")).map(event => event.delivery), [["webhook"], ["webhook"]])
  assert.equal(field((await rpc("events/poll", { name: SESSION, arguments: { commandId: text(field(created.body, "commandId"), "command") } })).error, "code"), -32601)
  assert.equal((await den.setFeature(org.orgId, "mcpThreads", true)).status, 200)
})

test("a started session names its event, and a poll reports each settled change once", async () => {
  assert.deepEqual(list(field((await rpc("events/list")).result, "events")).map(event => event.delivery), [["webhook", "poll"], ["webhook", "poll"]])
  const created = await create(token)
  assert.equal(created.isError, false, created.raw)
  const commandId = text(field(created.body, "commandId"), "command")
  assert.deepEqual(field(created.body, "event"), { name: SESSION, arguments: { commandId }, delivery: ["webhook", "poll"] })
  assert.match(text(field(created.body, "note"), "note"), /MCP Events/)
  const subscription = { name: SESSION, arguments: { commandId } }
  assert.equal(field((await rpc("events/poll", subscription, otherToken)).error, "code"), -32024, "another member cannot poll this session")

  const first = await rpc("events/poll", { ...subscription, cursor: null })
  assert.equal(first.error, undefined, summary(first))
  assert.deepEqual(field(first.result, "events"), [], "the first poll starts from now")
  assert.equal(field(first.result, "truncated"), false)
  assert.equal(field(first.result, "hasMore"), false)
  assert.equal(field(first.result, "nextPollMs"), 5000)
  const start = text(field(first.result, "cursor"), "cursor")

  await settle(commandId, "ses_thread_fixture", "running")
  const running = await rpc("events/poll", { ...subscription, cursor: start })
  assert.deepEqual(field(running.result, "events"), [], "running is not one of the default states")
  await settle(commandId, "ses_thread_fixture", "idle")
  const idle = await rpc("events/poll", { ...subscription, cursor: text(field(running.result, "cursor"), "cursor") })
  const [event] = list(field(idle.result, "events"))
  assert.equal(list(field(idle.result, "events")).length, 1, summary(idle))
  assert.equal(field(event, "name"), SESSION)
  assert.equal(field(event, "data", "state"), "idle")
  assert.equal(field(event, "data", "sessionId"), "ses_thread_fixture")
  assert.equal(JSON.stringify(idle.result).includes("Private result"), false, "the event carries state, not the answer")
  const retried = await rpc("events/poll", { ...subscription, cursor: text(field(running.result, "cursor"), "cursor") })
  assert.equal(field(list(field(retried.result, "events"))[0], "eventId"), field(event, "eventId"), "a retried poll returns the same event")
  const after = await rpc("events/poll", { ...subscription, cursor: text(field(idle.result, "cursor"), "cursor") })
  assert.deepEqual(field(after.result, "events"), [])

  const foreign = await rpc("events/poll", { name: SESSION, arguments: { commandId, states: ["idle"] }, cursor: start })
  assert.equal(field(foreign.result, "truncated"), true, "a cursor from another subscription starts from now")
  assert.deepEqual(field(foreign.result, "events"), [])
})

test("a hosted chat that starts a session is watched at once and gets one turn when it settles", async () => {
  await den.setFeature(org.orgId, "mcpThreadEvents", true)
  sessions.set(chat, workbotOwner(org.orgId, org.owner.memberId))
  const minted = await den.request(token, "POST", "/v1/workbot/run-token", { body: { sessionId: chat, messageId: "fixture-thread-initial", model: models["gpt-6-luna"] } })
  assert.equal(minted.status, 200, summary(minted))
  const threadToken = text(field(minted.body, "token"), "thread token")
  const created = await create(threadToken)
  assert.equal(created.isError, false, created.raw)
  const commandId = text(field(created.body, "commandId"), "command")
  assert.equal(field(created.body, "event"), undefined)
  assert.match(text(field(created.body, "watch", "id"), "watch"), /^[a-f0-9]{48}$/)
  assert.match(text(field(created.body, "note"), "note"), /end your turn/)
  const watches = await den.callMcpTool(threadToken, "list_mcp_event_subscriptions", {})
  assert.deepEqual(list(watches.body).map(watch => [watch.name, watch.status]), [[SESSION, "active"]])

  await settle(commandId, "ses_thread_watched", "running")
  await runWorkers()
  assert.equal(turns.length, 0, "a running session does not wake the chat")
  await settle(commandId, "ses_thread_watched", "idle")
  await runWorkers(); await runWorkers()
  assert.equal(turns.length, 1)
  assert.equal(turns[0].sessionId, chat)
  assert.match(turns[0].prompt, /remote session this chat started/)
  assert.match(turns[0].prompt, /"state":"idle"/)
  assert.equal(turns[0].prompt.includes("Private result"), false)
})
