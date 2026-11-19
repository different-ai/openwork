import assert from "node:assert/strict"
import { test } from "node:test"
import { createSlackRunner, type HeadlessDeps } from "../src/slack-assistant/headless.js"

/** Which failures of a Slack send end the task, and which the run loop tries again. */

const actor = { userId: "user_1", organizationId: "organization_1" }
const turn = { sessionId: "session_1", messageId: "message_1", prompt: "hello" }

function deps(overrides: Partial<HeadlessDeps>): HeadlessDeps {
  return {
    config: { url: "https://runner.test", token: "t".repeat(32) },
    fetch: async () => new Response(JSON.stringify({ state: "accepted" }), { status: 202, headers: { "content-type": "application/json" } }),
    mintToken: async () => ({ token: "token" }),
    maxTokenTtlMs: 60_000,
    ...overrides,
  }
}

test("a dropped connection to the runner is tried again", async () => {
  const runner = createSlackRunner(actor, deps({ fetch: async () => { throw new TypeError("fetch failed") } }))
  const sent = await runner.send(turn)
  assert.deepEqual(sent, { ok: false, error: "headless_send_unavailable", retryable: true, retryAfterMs: 5_000 })
})

test("a dropped connection while reading the saved turn is tried again", async () => {
  const runner = createSlackRunner(actor, deps({ fetch: async () => { throw new TypeError("fetch failed") } }))
  const sent = await runner.send({ ...turn, resolveModel: async () => "model" })
  assert.equal(sent.ok, false)
  assert.equal(!sent.ok && sent.retryable, true)
})

test("a model the member may not use ends the task", async () => {
  for (const reason of ["cloud_agent_model_unavailable", "cloud_model_unavailable", "model_access_unavailable"]) {
    const runner = createSlackRunner(actor, deps({
      fetch: async () => new Response(JSON.stringify({ turns: [], messages: [], finalAssistantText: "" }), { status: 200, headers: { "content-type": "application/json" } }),
    }))
    const sent = await runner.send({ ...turn, resolveModel: async () => { throw new Error(reason) } })
    assert.deepEqual(sent, { ok: false, error: "model_access_unavailable", retryable: false })
  }
})

test("a Gateway refusal while minting the token ends the task", async () => {
  const runner = createSlackRunner(actor, deps({ mintToken: async () => { throw new Error("cloud_agent_gateway_model_unavailable") } }))
  const sent = await runner.send(turn)
  assert.deepEqual(sent, { ok: false, error: "model_access_unavailable", retryable: false })
})
