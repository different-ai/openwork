import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import { canonicalArguments, eventMessageId, verifyWebhook, MAX_EVENT_BYTES } from "../src/mcp-events/protocol.js"
import { receiveMcpEvent, type WebhookSubscription } from "../src/mcp-events/receiver.js"

const now = 1_800_000_000_000
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`
const subscription: WebhookSubscription = { id: "local-subscription", name: "document.changed", remoteId: "remote-subscription", secret, status: "active", expiresAt: new Date(now + 60_000) }
const event = { eventId: "event-1", name: subscription.name, timestamp: new Date(now).toISOString(), data: { text: "untrusted source content" } }
function signed(body = JSON.stringify(event), options: { timestamp?: number; id?: string; signature?: string } = {}) {
  const timestamp = String(options.timestamp ?? now / 1000)
  const id = options.id ?? "delivery-1"
  const mac = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")
  return new Request("https://example.com/webhook", { method: "POST", body, headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": options.signature ?? `v1,${mac}`, "x-mcp-subscription-id": "remote-subscription" } })
}
const deps = (overrides: Partial<Parameters<typeof receiveMcpEvent>[2]> = {}) => ({ find: async () => subscription, enabled: async () => true, accept: async () => {}, now: () => now, ...overrides })

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
