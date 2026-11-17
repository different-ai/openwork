import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
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
let outside = ""

/** A token an outside MCP client holds after the person authorizes it, as Claude or ChatGPT does. */
async function outsideClientToken() {
  const { DEN_MCP_OAUTH_RESOURCE } = await import("../../src/auth.js")
  const scope = "openid profile email mcp:read mcp:write offline_access"
  const redirect = "http://127.0.0.1:9/callback"
  const registered = await den.request(null, "POST", "/api/auth/oauth2/register", { body: { client_name: "Outside MCP client", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope } })
  assert.equal(registered.status, 201, summary(registered))
  const clientId = text(field(registered.body, "client_id"), "client id")
  const headers = { cookie: org.owner.cookie }
  assert.equal((await den.request(org.owner.token, "POST", "/api/auth/organization/set-active", { headers, body: { organizationId: org.orgId } })).status, 200)
  const verifier = randomBytes(32).toString("base64url")
  const authorize = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope, resource: DEN_MCP_OAUTH_RESOURCE, state: randomBytes(8).toString("hex"), code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })
  const consentPage = await den.request(org.owner.token, "GET", `/api/auth/oauth2/authorize?${authorize}`, { headers })
  const consent = new URL(text(consentPage.headers.get("location"), `consent redirect (${summary(consentPage)})`))
  const consented = await den.request(org.owner.token, "POST", "/api/auth/oauth2/consent", { headers, body: { accept: true, scope, oauth_query: consent.search.slice(1) } })
  assert.equal(consented.status, 200, summary(consented))
  const code = text(new URL(text(field(consented.body, "url"), "consent redirect")).searchParams.get("code"), "code")
  const exchanged = await den.request(null, "POST", "/api/auth/oauth2/token", { headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: new URLSearchParams({ client_id: clientId, resource: DEN_MCP_OAUTH_RESOURCE, grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect }).toString() })
  assert.equal(exchanged.status, 200, summary(exchanged))
  return text(field(exchanged.body, "access_token"), "access token")
}
const toolNames = async (bearer: string) => list(field((await rpc("tools/list", {}, bearer)).result, "tools")).map(tool => String(tool.name))
const threadTools = (names: string[]) => names.filter(name => name.startsWith("remote_session_")).sort()

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
  assert.equal(created.raw.includes("MCP Events"), false, "the result is the one every client gets today")
  outside = await outsideClientToken()
  assert.deepEqual(threadTools(await toolNames(outside)), [], "an outside client finds remote sessions through search, as before")
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

test("an outside client lists and runs the thread tools; OpenWork's own token keeps capability search", async () => {
  const listed = threadTools(await toolNames(outside))
  for (const action of ["create", "send", "read", "status", "stop", "list", "targets"]) assert.ok(listed.includes(`remote_session_${action}`), `${action} is listed: ${listed.join(", ")}`)
  assert.deepEqual(threadTools(await toolNames(token)), [])
  const created = await den.callMcpTool(outside, "remote_session_create", { target: "registered", computerId, workspaceId: "fixture-workspace", title: "Outside task" })
  assert.equal(created.isError, false, created.raw)
  const commandId = text(field(created.body, "commandId"), "command")
  assert.deepEqual(field(created.body, "event", "arguments"), { commandId }, "an outside client is told the event; it has no chat for Den to watch")
  const status = await den.callMcpTool(outside, "remote_session_status", { threads: [{ commandId }] })
  assert.equal(status.isError, false, status.raw)
  assert.equal(list(field(status.body, "threads")).length, 1)
  assert.equal(typeof field(list(field(status.body, "threads"))[0], "state"), "string", status.raw)
  const polled = await rpc("events/poll", { name: SESSION, arguments: { commandId }, cursor: null }, outside)
  assert.equal(polled.error, undefined, summary(polled))
})

test("turning the flag off restores today's tools, results and catalog", async () => {
  assert.equal((await den.setFeature(org.orgId, "mcpThreads", false)).status, 200)
  assert.deepEqual(threadTools(await toolNames(outside)), [])
  const created = await den.callMcpTool(outside, "execute_capability", { name: "remote-session:create", body: { target: "registered", computerId, workspaceId: "fixture-workspace", title: "Plain task" } })
  assert.equal(created.isError, false, created.raw)
  assert.equal(field(created.body, "event"), undefined)
  assert.equal(field(created.body, "watch"), undefined)
  assert.equal(field((await rpc("events/poll", { name: SESSION, arguments: { commandId: text(field(created.body, "commandId"), "command") } })).error, "code"), -32601)
  assert.deepEqual(list(field((await rpc("events/list")).result, "events")).map(event => event.delivery), [["webhook"], ["webhook"]])
})
