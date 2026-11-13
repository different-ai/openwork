import assert from "node:assert/strict"
import { createHmac, randomBytes } from "node:crypto"
import { after, test } from "node:test"
import { workbotOwner, workbotSessionId, workbotSideChatSessionId } from "@openwork-ee/headless-protocol/workbot-routing"
import { bootDen, field, startFakeHttpServer, summary, text, type Member, list } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

const restoreCatalog = stubPublicModelCatalog()
const sessions = new Map<string, string>()
const turns = new Map<string, { sessionId: string; prompt: string; model: string; mcpToken: string; resumeGrant: string }>()
let ambiguousSend = false
const runner = await startFakeHttpServer((request, raw, response) => {
  const url = new URL(request.url ?? "/", "http://runner")
  const sessionId = decodeURIComponent(url.pathname.split("/")[3] ?? "")
  const owner = sessions.get(sessionId)
  if (!owner || request.headers["x-openwork-headless-owner"] !== owner || (url.searchParams.has("expectedOwner") && url.searchParams.get("expectedOwner") !== owner)) {
    response.writeHead(404).end(); return
  }
  response.setHeader("content-type", "application/json")
  if (request.method === "POST" && url.pathname.endsWith("/turns")) {
    const body: unknown = JSON.parse(raw)
    const messageId = text(field(body, "messageId"), "message id")
    assert.equal(field(body, "interrupt"), undefined)
    assert.equal(field(body, "execution"), "steps")
    turns.set(messageId, { sessionId, prompt: text(field(body, "prompt"), "prompt"), model: text(field(body, "model"), "model"), mcpToken: text(field(body, "credentials", "mcpToken"), "MCP token"), resumeGrant: text(field(body, "credentials", "resumeGrant"), "resume grant") })
    if (ambiguousSend) { ambiguousSend = false; response.writeHead(503).end("{}"); return }
    response.writeHead(202).end(JSON.stringify({ state: "queued" })); return
  }
  const messageId = url.searchParams.get("messageId")
  const saved = messageId ? turns.get(messageId) : null
  response.end(JSON.stringify({ turns: saved ? [{ messageId, status: "queued", model: saved.model }] : [], messages: [], finalAssistantText: "", status: "idle" }))
})
const den = await bootDen({ env: { ...gatewayFixtureEnv, LINEAR_API_KEY: "", DEN_WORKBOT_URL: "http://localhost:3020", DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "fixture-runner-token-at-least-thirty-two-characters", DEN_AUDIT_SELF_HOSTED_ENABLED: "true", DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "fixture-callback-token-at-least-thirty-two-characters" } })
const deliveries: { raw: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = []
let challenges = 0
let rejectChallenge = false
let callbackStatus = 202
let waitForChallenge: Promise<void> | null = null
let onChallenge: (() => void) | null = null
const callback = await startFakeHttpServer(async (request, raw, response) => {
  const body: unknown = JSON.parse(raw)
  if (field(body, "type") === "verification") {
    challenges++
    onChallenge?.()
    if (waitForChallenge) await waitForChallenge
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ challenge: rejectChallenge ? "incorrect" : field(body, "challenge") }))
    return
  }
  deliveries.push({ raw, headers: request.headers, body })
  response.writeHead(callbackStatus).end()
})
after(async () => { await callback.close(); await runner.close(); await den.close(); restoreCatalog() })
const { client, db } = await import("../../src/db.js")
const { eq } = await import("@openwork-ee/den-db/drizzle")
const { McpNativeSubscriptionTable: Publisher, McpNativeDeliveryTable: Outbox, RemoteDeviceTable } = await import("@openwork-ee/den-db/schema")
const { observeNativeEvent, deliverNativeEvent } = await import("../../src/native-mcp-events/worker.js")
const { dispatchMcpEvent } = await import("../../src/mcp-events/worker.js")
const { signingSecretSchema } = await import("../../src/native-mcp-events/service.js")
const org = await den.createOrg(await den.signUp("Lifecycle Owner"), "Lifecycle fixture workspace")
const other = await den.newMember(org.owner, org.orgId, "Lifecycle Other")
const models = await grantGatewayModels(den, org.owner, org.orgId, [org.owner])
const token = await den.mintMcpToken(org.owner, org.orgId)
const otherToken = await den.mintMcpToken(other, org.orgId)
const COMPUTER = "openwork.computer.state_changed"
const SESSION = "openwork.remote_session.status_changed"
const secret = `whsec_${randomBytes(24).toString("base64")}`
const newSecret = `whsec_${randomBytes(64).toString("base64")}`
const sourceSession = workbotSideChatSessionId(org.orgId, org.owner.memberId, "0123456789abcdef")
const destinationSession = workbotSessionId(org.orgId, org.owner.memberId)
let deviceId = ""
let subscriptionId = ""
let watchId = ""
let threadToken = ""

async function rpc(method: string, params: Record<string, unknown> = {}, bearer = token, headers: Record<string, string> = {}) {
  const response = await den.request(bearer, "POST", "/mcp/agent", { headers: { accept: "application/json, text/event-stream", ...headers }, body: { jsonrpc: "2.0", id: 1, method, params: { ...params, ...(headers["mcp-protocol-version"] ? { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) } } })
  const line = response.text.split("\n").find(value => value.startsWith("data:"))
  const body: unknown = line ? JSON.parse(line.slice(5)) : response.body
  return { ...response, result: field(body, "result"), error: field(body, "error") }
}
const input = () => ({ name: COMPUTER, arguments: { deviceId }, delivery: { mode: "webhook", url: `${callback.url}/events`, secret }, ttlMs: 60_000 })
async function report(event: string, sessionId = sourceSession, chat = "0123456789abcdef") {
  const response = await den.request(token, "POST", "/v1/workbot/devices/computer", { body: { sessionId, chat, event, ...(event === "viewer_opened" ? { view: "computer" } : {}) } })
  assert.equal(response.status, 204, summary(response))
}
async function due() {
  if (!("getConnection" in client)) throw new Error("needs MySQL")
  await client.query("UPDATE mcp_native_subscription SET available_at = '2000-01-01' WHERE status = 'active'")
  await client.query("UPDATE mcp_native_delivery SET available_at = '2000-01-01' WHERE status = 'pending'")
}
async function observeAll() {
  await due()
  for (let i = 0; i < 25 && await observeNativeEvent(); i++) { /* drain due observations */ }
}
async function deliverAll() {
  for (let i = 0; i < 25 && await deliverNativeEvent(); i++) { /* drain due receipts */ }
}
function verifies(delivery: typeof deliveries[number], key: string) {
  const id = delivery.headers["webhook-id"]
  const timestamp = delivery.headers["webhook-timestamp"]
  const signature = createHmac("sha256", Buffer.from(key.slice(6), "base64")).update(`${id}.${timestamp}.${delivery.raw}`).digest("base64")
  return String(delivery.headers["webhook-signature"]).split(" ").includes(`v1,${signature}`)
}

test("flag off hides methods and capability; existing computer reports and reads still work", async () => {

  await report("resumed")
  const devices = await den.request(token, "GET", "/v1/workbot/devices")
  deviceId = text(field(list(field(devices.body, "devices")).find(device => device.workbotChat === "0123456789abcdef"), "id"), "computer")
  const disabled = await rpc("events/list")
  assert.equal(field(disabled.error, "code"), -32601, summary(disabled))
  const discovered = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })
  assert.equal(field(discovered.result, "capabilities", "events"), undefined)
  assert.equal((await den.setFeature(org.orgId, "nativeMcpEvents", true)).status, 200)
})

test("advertises both event profiles and webhook-only catalog; validates modern routing headers", async () => {
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } })
  assert.deepEqual(field(initialized.result, "capabilities", "events"), {}, summary(initialized))
  assert.deepEqual(field(initialized.result, "capabilities", "extensions", "io.modelcontextprotocol/events"), {})
  const modern = await rpc("server/discover", {}, token, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" })
  assert.deepEqual(field(modern.result, "capabilities", "events"), {}, summary(modern))
  assert.deepEqual(field(modern.result, "capabilities", "extensions", "io.modelcontextprotocol/events"), {})
  const catalog = await rpc("events/list")
  assert.deepEqual(list(field(catalog.result, "events")).map(event => [event.name, event.delivery]), [[SESSION, ["webhook"]], [COMPUTER, ["webhook"]]])
  const bad = await rpc("events/subscribe", input(), token, { "mcp-protocol-version": "2026-07-28", "mcp-method": "events/subscribe", "mcp-name": "wrong" })
  assert.equal(field(bad.error, "code"), -32020, summary(bad))
  assert.equal(challenges, 0)
})

test("owner and write scope are enforced before callbacks; secret sizes and TTL follow the webhook profile", async () => {
  assert.ok(signingSecretSchema.safeParse(secret).success)
  assert.ok(signingSecretSchema.safeParse(newSecret).success)
  assert.equal(signingSecretSchema.safeParse(`whsec_${randomBytes(65).toString("base64")}`).success, false)
  assert.equal(signingSecretSchema.safeParse(`whsec_${randomBytes(23).toString("base64")}`).success, false)
  assert.equal(field((await rpc("events/subscribe", input(), otherToken)).error, "code"), -32024)
  const issued = await den.request(org.owner.token, "POST", "/v1/mcp/token", { orgId: org.orgId, body: { scopes: ["mcp:read"] } })
  assert.equal(field((await rpc("events/subscribe", input(), text(field(issued.body, "token"), "read token"))).error, "code"), -32024)
  assert.equal(challenges, 0)
  const subscribed = await rpc("events/subscribe", { ...input(), ttlMs: null }, token, { "mcp-protocol-version": "2026-07-28", "mcp-method": "events/subscribe", "mcp-name": COMPUTER })
  assert.equal(subscribed.error, undefined, summary(subscribed))
  subscriptionId = text(field(subscribed.result, "id"), "subscription id")
  assert.equal(field(subscribed.result, "cursor"), null)
  assert.equal(field(subscribed.result, "truncated"), false)
  assert.ok(Date.parse(text(field(subscribed.result, "refreshBefore"), "expiry")) <= Date.now() + 3600_000)
  assert.equal(challenges, 1)
  const repeat = await rpc("events/subscribe", { ...input(), ttlMs: 1 })
  assert.equal(field(repeat.result, "id"), subscriptionId)
  assert.ok(Date.parse(text(field(repeat.result, "refreshBefore"), "expiry")) > Date.now() + 55_000)
  assert.equal(challenges, 1, "unchanged credential verification is cached")
})

test("observed cloud computer changes are signed and durable; retries preserve event ID and payload", async () => {
  await observeAll(); await deliverAll()
  assert.equal(deliveries.length, 0, "baseline is not an occurrence")
  await report("paused")
  await observeAll()
  const stored = await db.select().from(Outbox)
  assert.equal(stored.length, 1)
  callbackStatus = 503
  await deliverAll()
  assert.equal(deliveries.length, 1)
  assert.equal(field(deliveries[0].body, "data", "activity"), "paused")
  assert.equal(deliveries[0].headers["webhook-id"], field(deliveries[0].body, "eventId"))
  assert.equal(deliveries[0].headers["x-mcp-subscription-id"], subscriptionId)
  assert.ok(verifies(deliveries[0], secret))
  callbackStatus = 202
  await due(); await deliverAll()
  assert.equal(deliveries.length, 2)
  assert.equal(deliveries[0].raw, deliveries[1].raw)
  assert.equal((await db.select().from(Outbox))[0]?.payload, null)
})

test("failed key rotation preserves the watch; successful rotation dual-signs and 410 rejects only one event", async () => {
  rejectChallenge = true
  const failed = await rpc("events/subscribe", { ...input(), delivery: { ...input().delivery, secret: newSecret } })
  assert.equal(field(failed.error, "code"), -32027, summary(failed))
  const [unchanged] = await db.select().from(Publisher).where(eq(Publisher.id, subscriptionId))
  assert.equal(unchanged?.status, "active")
  assert.equal(unchanged?.secret, secret)
  rejectChallenge = false
  const rotated = await rpc("events/subscribe", { ...input(), delivery: { ...input().delivery, secret: newSecret } })
  assert.equal(field(rotated.result, "id"), subscriptionId)
  await report("resumed"); await observeAll()
  callbackStatus = 410
  await deliverAll()
  const last = deliveries.at(-1)!
  assert.ok(verifies(last, secret)); assert.ok(verifies(last, newSecret))
  assert.equal((await db.select().from(Publisher).where(eq(Publisher.id, subscriptionId)))[0]?.status, "active")
  callbackStatus = 202
  const count = deliveries.length
  await report("viewer_opened")
  await observeAll(); await deliverAll()
  assert.equal(deliveries.length, count, "viewing an already-running computer does not create lifecycle events")
})

test("hosted chat watches enter the existing same-thread harness once and cannot watch themselves", async () => {
  await den.setFeature(org.orgId, "mcpThreadEvents", true)
  sessions.set(destinationSession, workbotOwner(org.orgId, org.owner.memberId))
  const minted = await den.request(token, "POST", "/v1/workbot/run-token", { body: { sessionId: destinationSession, messageId: "fixture-native-initial", model: models["gpt-6-luna"] } })
  assert.equal(minted.status, 200, summary(minted))
  threadToken = text(field(minted.body, "token"), "thread token")
  const args = { source: "openwork", name: COMPUTER, arguments: { deviceId }, instruction: "Tell me when this computer pauses or resumes.", ttlMs: 60_000 }
  const watch = await den.callMcpTool(threadToken, "subscribe_mcp_event", args)
  assert.equal(watch.isError, false, watch.raw)
  watchId = text(field(watch.body, "id"), "watch id")
  const publicCallback = await den.request(null, "POST", `/v1/mcp-events/webhooks/${watchId}`, { body: {} })
  assert.equal(publicCallback.status, 404, "an internal watch has no public webhook entry point")
  const repeated = await den.callMcpTool(threadToken, "subscribe_mcp_event", args)
  assert.equal(field(repeated.body, "id"), watchId)
  const self = await den.callMcpTool(threadToken, "subscribe_mcp_event", { ...args, name: SESSION, arguments: { sessionId: destinationSession } })
  assert.equal(self.isError, true)
  await report("paused"); await observeAll(); await deliverAll()
  assert.equal(await dispatchMcpEvent(), true)
  assert.equal(await dispatchMcpEvent(), false)
  assert.equal(turns.size, 1)
  assert.equal([...turns.values()][0].sessionId, destinationSession)
  assert.match([...turns.values()][0].prompt, /untrusted data/)
  assert.match([...turns.values()][0].prompt, /Tell me when/)
  assert.ok(![...turns.values()][0].prompt.includes(secret))
})

test("unsubscribe cancels queued work; a killed publisher leaves computer reports working", async () => {
  await report("resumed"); await observeAll()
  const stopped = await den.callMcpTool(threadToken, "unsubscribe_mcp_event", { id: watchId })
  assert.equal(field(stopped.body, "remoteStopped"), true, stopped.raw)
  const cancelled = await rpc("events/unsubscribe", input())
  assert.equal(cancelled.error, undefined, summary(cancelled))
  assert.equal((await rpc("events/unsubscribe", input())).error, undefined)
  const count = deliveries.length
  await deliverAll(); await dispatchMcpEvent()
  assert.equal(turns.size, 1); assert.equal(deliveries.length, count)
  assert.equal((await rpc("events/subscribe", input())).error, undefined)
  await report("paused"); await observeAll()
  await den.setFeature(org.orgId, "nativeMcpEvents", false)
  await deliverAll()
  assert.equal(deliveries.length, count)
  assert.equal(field((await rpc("events/list")).error, "code"), -32601)
  await report("resumed")
  assert.equal((await den.request(token, "GET", "/v1/workbot/devices")).status, 200)
})

test("unsubscribe during callback verification wins and leaves the normal source untouched", { timeout: 15_000 }, async () => {
  await den.setFeature(org.orgId, "nativeMcpEvents", true)
  const args = { ...input(), delivery: { ...input().delivery, url: `${callback.url}/cancel-during-verification` } }
  let release = () => {}
  waitForChallenge = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { onChallenge = resolve })
  const subscribing = rpc("events/subscribe", args)
  try {
    await entered
    assert.equal((await rpc("events/unsubscribe", args)).error, undefined)
  } finally { release(); waitForChallenge = null; onChallenge = null }
  const cancelled = await subscribing
  assert.ok(cancelled.error, summary(cancelled))
  await observeAll(); await deliverAll()
  assert.equal((await den.request(token, "GET", "/v1/workbot/devices")).status, 200)
})

test("remote-session reports publish only matching state changes and preserve normal read/status behavior", async () => {
  const runnerId = "lifecycle-test-runner"
  const minted = await den.as(org.owner, org.orgId)("POST", "/v1/session-runners/token", {
    runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.6.0", platform: "darwin", concurrency: 1,
    capabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"],
  })
  assert.equal(minted.status, 200, summary(minted))
  const runnerToken = text(field(minted.body, "token"), "desktop token")
  const call = (method: "POST" | "PUT", path: string, body: unknown) => den.request(runnerToken, method, path, { body })
  assert.equal((await call("PUT", "/v1/session-runners/inventory", {
    computer: { label: "Lifecycle laptop", platform: "darwin", appVersion: "1.6.0" },
    workspaces: [{ workspaceId: "fixture-workspace", name: "Fixture", active: true, engine: "v2", defaultModel: null, models: [] }],
  })).status, 200)
  const { automationRunnerRowId } = await import("../../src/automations/repository.js")
  const computerId = automationRunnerRowId({ organizationId: org.orgId, ownerMemberId: org.owner.memberId, runnerId })
  const created = await den.callMcpTool(token, "execute_capability", { name: "remote-session:create", body: { target: "registered", computerId, workspaceId: "fixture-workspace", title: "Lifecycle task" } })
  assert.equal(created.isError, false, created.raw)
  const commandId = text(field(created.body, "commandId"), "command")
  const args = { name: SESSION, arguments: { commandId, states: ["idle"] }, delivery: input().delivery, ttlMs: 60_000 }
  assert.equal(field((await rpc("events/subscribe", args, otherToken)).error, "code"), -32024)
  const subscribed = await rpc("events/subscribe", args)
  assert.equal(subscribed.error, undefined, summary(subscribed))
  const id = field(subscribed.result, "id")
  assert.equal((await call("POST", `/v1/remote-session-commands/${commandId}/claim`, {})).status, 200)
  assert.equal((await call("POST", `/v1/remote-session-commands/${commandId}/complete`, { status: "delivered", sessionId: "ses_lifecycle_fixture", workspaceId: "fixture-workspace" })).status, 200)
  await observeAll(); await deliverAll()
  assert.equal(deliveries.filter(item => item.headers["x-mcp-subscription-id"] === id).length, 0, "running is filtered out")
  const reported = await call("POST", `/v1/remote-session-commands/${commandId}/session`, { status: "idle", finalText: "Private result stays in the normal read", observedAt: Date.now(), messageCount: 2 })
  assert.equal(reported.status, 200, summary(reported))
  await observeAll(); await deliverAll()
  const event = deliveries.filter(item => item.headers["x-mcp-subscription-id"] === id)
  assert.equal(event.length, 1)
  assert.equal(field(event[0].body, "data", "state"), "idle")
  assert.equal(field(event[0].body, "data", "sessionId"), "ses_lifecycle_fixture")
  assert.equal(event[0].raw.includes("Private result"), false)
  const read = await den.callMcpTool(token, "execute_capability", { name: "remote-session:read", body: { commandId } })
  assert.equal(read.isError, false, read.raw)
  assert.ok(read.text.includes("Private result"))
  const status = await den.as(org.owner, org.orgId)("POST", "/v1/remote-sessions/status", { threads: [{ commandId }] })
  assert.equal(field(list(field(status.body, "threads"))[0], "state"), "idle")
  assert.equal((await rpc("events/unsubscribe", args)).error, undefined)
})

test("access revocation after internal receipt acceptance suppresses the action and delivers a termination notice", async () => {
  const args = { source: "openwork", name: COMPUTER, arguments: { deviceId }, instruction: "Report computer changes.", ttlMs: 60_000 }
  const watching = await den.callMcpTool(threadToken, "subscribe_mcp_event", args)
  assert.equal(watching.isError, false, watching.raw)
  await report("paused"); await observeAll(); await deliverAll()
  const [device] = await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.externalId, sourceSession))
  assert.ok(device)
  await db.update(RemoteDeviceTable).set({ ownerMemberId: other.memberId }).where(eq(RemoteDeviceTable.id, device.id))
  const before = turns.size
  await dispatchMcpEvent()
  assert.equal(turns.size, before, "revoked source cannot run the saved action")
  await observeAll(); await deliverAll()
  await dispatchMcpEvent()
  assert.equal(turns.size, before + 1)
  assert.match([...turns.values()].at(-1)!.prompt, /watch ended/)
  await db.update(RemoteDeviceTable).set({ ownerMemberId: org.owner.memberId }).where(eq(RemoteDeviceTable.id, device.id))
})

test("current ownership is rechecked before queued delivery and organization deletion clears native state", async () => {
  await den.setFeature(org.orgId, "nativeMcpEvents", true)
  const created = await rpc("events/subscribe", input())
  assert.equal(created.error, undefined, summary(created))
  await report("paused"); await observeAll()
  const [device] = await db.select().from(RemoteDeviceTable).where(eq(RemoteDeviceTable.externalId, sourceSession))
  assert.ok(device)
  await db.update(RemoteDeviceTable).set({ ownerMemberId: other.memberId }).where(eq(RemoteDeviceTable.id, device.id))
  const count = deliveries.length
  await deliverAll()
  const later = deliveries.slice(count)
  assert.equal(later.filter(value => field(value.body, "type") !== "terminated").length, 0)
  assert.equal(later.filter(value => field(value.body, "type") === "terminated").length, 1)
  assert.equal((await den.as(org.owner, org.orgId)("DELETE", "/v1/org", { confirmation: "Lifecycle fixture workspace" })).status, 200)
  assert.equal((await db.select().from(Publisher)).length, 0)
  assert.equal((await db.select().from(Outbox)).length, 0)
})
