import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import { canonicalArguments, subscribedSchema, controlSchema, eventMessageId, eventPrompt, verifyWebhook, MAX_EVENT_BYTES } from "../src/mcp-events/protocol.js"
import { receiveMcpEvent, type WebhookSubscription } from "../src/mcp-events/receiver.js"

const now = 1_800_000_000_000
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`
const subscription: WebhookSubscription = { id: "local-subscription", name: "document.changed", connectionId: "connection", instruction: "Summarize the change", remoteId: "remote-subscription", secret, status: "active", expiresAt: new Date(now + 60_000) }
const event = { eventId: "event-1", name: subscription.name, timestamp: new Date(now).toISOString(), data: { text: "untrusted source content" } }
function signed(body = JSON.stringify(event), options: { timestamp?: number; id?: string; signature?: string } = {}) {
  const timestamp = String(options.timestamp ?? now / 1000)
  const id = options.id ?? "delivery-1"
  const mac = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")
  return new Request("https://example.com/webhook", { method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": options.signature ?? `v1,${mac}`, "x-mcp-subscription-id": "remote-subscription" } })
}
const deps = (overrides: Partial<Parameters<typeof receiveMcpEvent>[2]> = {}) => ({ find: async () => subscription, enabled: async () => true, accept: async () => {}, acceptControl: async () => {}, now: () => now, ...overrides })

test("Standard Webhooks verifies exact bytes, rotated signatures and separate delivery ids", async () => {
  const request = signed()
  const bytes = new Uint8Array(await request.arrayBuffer())
  assert.equal(verifyWebhook(secret, request.headers, bytes, now), true)
  request.headers.set("webhook-signature", `v1,bad ${request.headers.get("webhook-signature")}`)
  assert.equal(verifyWebhook(secret, request.headers, bytes, now), true)
  assert.equal(verifyWebhook(secret, request.headers, new TextEncoder().encode(JSON.stringify({ ...event, data: {} })), now), false)
  assert.equal(verifyWebhook(secret, request.headers, bytes, now + 301_000), false)
  assert.equal(verifyWebhook(secret, request.headers, bytes, now - 301_000), false)
})

test("signed verification works before events/subscribe returns", async () => {
  const response = await receiveMcpEvent(signed(JSON.stringify({ type: "verification", challenge: "nonce" })), subscription.id, deps({ find: async () => ({ ...subscription, status: "pending", remoteId: null }) }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { challenge: "nonce" })
})

test("verification refuses invalid signatures and flag-off callbacks", async () => {
  const request = () => signed(JSON.stringify({ type: "verification", challenge: "nonce" }), { signature: "v1,invalid" })
  assert.equal((await receiveMcpEvent(request(), subscription.id, deps())).status, 401)
  assert.equal((await receiveMcpEvent(signed(), subscription.id, deps({ enabled: async () => false }))).status, 410)
})

test("acknowledges only after durable acceptance and retries a failed write", async () => {
  let accepted = false
  const response = await receiveMcpEvent(signed(), subscription.id, deps({ accept: async (_subscription, received) => { assert.deepEqual(received, event); accepted = true } }))
  assert.equal(accepted, true)
  assert.equal(response.status, 202)
  assert.equal((await receiveMcpEvent(signed(), subscription.id, deps({ accept: async () => { throw new Error("database unavailable") } }))).status, 503)
})

test("rejects wrong subscription, wrong event name, stopped, expired and pending deliveries", async () => {
  const wrongId = signed(); wrongId.headers.set("x-mcp-subscription-id", "other")
  assert.equal((await receiveMcpEvent(wrongId, subscription.id, deps())).status, 400)
  assert.equal((await receiveMcpEvent(signed(JSON.stringify({ ...event, name: "other" })), subscription.id, deps())).status, 400)
  for (const patch of [{ status: "stopped" }, { expiresAt: new Date(now) }]) {
    assert.equal((await receiveMcpEvent(signed(), subscription.id, deps({ find: async () => ({ ...subscription, ...patch }) }))).status, 410)
  }
  assert.equal((await receiveMcpEvent(signed(), subscription.id, deps({ find: async () => ({ ...subscription, status: "pending" }) }))).status, 503)
})

test("bounds actual streamed bytes and rejects malformed payloads", async () => {
  assert.equal((await receiveMcpEvent(signed("x".repeat(MAX_EVENT_BYTES + 1)), subscription.id, deps())).status, 413)
  assert.equal((await receiveMcpEvent(signed("{"), subscription.id, deps())).status, 400)
  assert.equal((await receiveMcpEvent(signed(JSON.stringify({ ...event, timestamp: "yesterday" })), subscription.id, deps())).status, 400)
})

test("canonical filter identity and turn id are stable and scoped to one subscription", () => {
  assert.equal(canonicalArguments({ z: 1, a: { d: 2, c: [3, 2] } }), canonicalArguments({ a: { c: [3, 2], d: 2 }, z: 1 }))
  assert.equal(eventMessageId("a", "1"), eventMessageId("a", "1"))
  assert.notEqual(eventMessageId("a", "1"), eventMessageId("b", "1"))
})


test("event prompts project public source fields, never subscription credentials", () => {
  const prompt = eventPrompt(subscription.instruction, subscription, event)
  assert.ok(!prompt.includes(secret))
  const envelope = JSON.parse(prompt.split("\n\n").at(-1) ?? "")
  assert.deepEqual(envelope, { source: { connectionId: subscription.connectionId, name: subscription.name }, event })
})

test("event turn ids fit Workbot retry, edit and delete message ids", () => {
  assert.match(eventMessageId("subscription", "event").slice(3), /^[A-Za-z0-9_-]{8,64}$/)
})

test("refuses a signed payload that cannot fit the runner prompt before durable acceptance", async () => {
  const oversized = { ...event, data: "x".repeat(100_000) }
  let accepted = false
  assert.equal((await receiveMcpEvent(signed(JSON.stringify(oversized)), subscription.id, deps({ accept: async () => { accepted = true } }))).status, 413)
  assert.equal(accepted, false)
  const fitting = { ...event, data: "x".repeat(99_000) }
  assert.equal((await receiveMcpEvent(signed(JSON.stringify(fitting)), subscription.id, deps())).status, 202)
})


test("signed gap and termination notices reach the durable control handler", async () => {
  for (const notice of [{ type: "gap", cursor: "fresh-position" }, { type: "terminated", error: { code: -32024, message: "Access revoked" } }]) {
    let accepted = false
    const result = await receiveMcpEvent(signed(JSON.stringify(notice)), subscription.id, deps({ acceptControl: async (_subscription, received, deliveryId) => {
      assert.deepEqual(received, notice)
      assert.equal(deliveryId, "delivery-1")
      accepted = true
    } }))
    assert.equal(result.status, 202)
    assert.equal(accepted, true)
  }
  assert.equal((await receiveMcpEvent(signed(JSON.stringify({ type: "gap", cursor: "fresh" })), subscription.id, deps({ acceptControl: async () => { throw new Error("unavailable") } }))).status, 503)
  const wrong = signed(JSON.stringify({ type: "terminated", error: { code: -32024, message: "Forbidden" } })); wrong.headers.set("x-mcp-subscription-id", "other")
  assert.equal((await receiveMcpEvent(wrong, subscription.id, deps())).status, 400)
})


test("absent and null cursors are equivalent on non-replay subscriptions and gap controls", () => {
  const fields = { id: "subscription", refreshBefore: null, truncated: false }
  assert.equal(subscribedSchema.parse(fields).cursor, null)
  assert.equal(subscribedSchema.parse({ ...fields, cursor: null }).cursor, null)
  assert.equal(controlSchema.parse({ type: "gap" }).cursor, null)
  assert.equal(controlSchema.parse({ type: "gap", cursor: null }).cursor, null)
})
