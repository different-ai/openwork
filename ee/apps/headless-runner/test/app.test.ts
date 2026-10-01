import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { createApp } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { calls, makeRunner, scriptedModel, text } from "./helpers.js"

const TOKEN = "t".repeat(40)

function setup() {
  const { model } = scriptedModel([
    calls({ id: "c1", name: "write_file", input: { path: "out/answer.md", content: "42" } }),
    text("The answer is in out/answer.md."),
  ])
  const { store, runner } = makeRunner({ model })
  const app = createApp({ store, runner, apiToken: TOKEN })
  const call = (method: string, path: string, body?: unknown, token = TOKEN) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { runner, call }
}

test("rejects requests without the service token", async () => {
  const { call } = setup()
  assert.equal((await call("POST", "/v1/sessions", {}, "wrong".repeat(10))).status, 401)
  assert.equal((await call("GET", "/health")).status, 200)
})

test("create → send → read → files, with a messageId-scoped transcript", async () => {
  const { runner, call } = setup()
  const created = z.object({ id: z.string() }).parse(await (await call("POST", "/v1/sessions", { title: "t" })).json())

  const sent = await call("POST", `/v1/sessions/${created.id}/turns`, {
    messageId: "msg_1",
    prompt: "What is the answer?",
    credentials: { modelApiKey: "k" },
  })
  assert.equal(sent.status, 202)
  await runner.idle()

  const snapshot = z
    .object({ status: z.string(), finalAssistantText: z.string(), messages: z.array(z.object({ role: z.string() })) })
    .parse(await (await call("GET", `/v1/sessions/${created.id}?messageId=msg_1`)).json())
  assert.equal(snapshot.status, "idle")
  assert.equal(snapshot.finalAssistantText, "The answer is in out/answer.md.")
  assert.deepEqual(snapshot.messages.map((message) => message.role), ["user", "assistant", "tool", "assistant"])

  const content = await call("GET", `/v1/sessions/${created.id}/files/content?path=out/answer.md`)
  assert.equal(await content.text(), "42")
  assert.equal((await call("GET", `/v1/sessions/${created.id}/files/content?path=../x`)).status, 400)
})

test("the snapshot reports image counts, not image data", async () => {
  const { model } = scriptedModel([calls({ id: "c1", name: "look", input: {} }), text("done")])
  const { store, runner } = makeRunner({
    model,
    mcp: async () => ({
      tools: [{ name: "look", description: "", inputSchema: { type: "object" } }],
      async call() {
        return { output: "img", isError: false, images: [{ mediaType: "image/png", data: "QUJD" }] }
      },
      async close() {},
    }),
  })
  const app = createApp({ store, runner, apiToken: TOKEN })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "msg_1", prompt: "go", credentials: { modelApiKey: "k", mcpToken: "t" } })
  await runner.idle()
  const response = await app.request(`/v1/sessions/${session.id}`, { headers: { authorization: `Bearer ${TOKEN}` } })
  const body = await response.text()
  assert.ok(!body.includes("QUJD"))
  const parsed = z.object({ messages: z.array(z.object({ imageCount: z.number().optional() })) }).parse(JSON.parse(body))
  assert.ok(parsed.messages.some((message) => message.imageCount === 1))
})

test("lists the models a caller can pick", async () => {
  const { store, runner } = makeRunner({ model: scriptedModel([]).model })
  const catalog = { defaultModel: "gwm_a", models: [{ id: "gwm_a", name: "Claude Fable 5.1" }] }
  const app = createApp({ store, runner, apiToken: TOKEN, models: async () => catalog })
  const response = await app.request("/v1/models", { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.deepEqual(await response.json(), catalog)
  assert.equal((await app.request("/v1/models")).status, 401)
})

test("a caller-named session is created once, then updated in place", async () => {
  const { call } = setup()
  const id = "hs_wb_0123456789abcdef"
  const created = await call("PUT", `/v1/sessions/${id}`, { title: "Workbot", instructions: "Be brief." })
  assert.equal(created.status, 201)
  assert.deepEqual(z.object({ id: z.string(), instructions: z.string() }).parse(await created.json()), { id, instructions: "Be brief." })
  const updated = await call("PUT", `/v1/sessions/${id}`, { instructions: "Be very brief." })
  assert.equal(updated.status, 200)
  const read = z.object({ session: z.object({ title: z.string(), instructions: z.string() }) }).parse(await (await call("GET", `/v1/sessions/${id}`)).json())
  assert.deepEqual(read.session, { title: "Workbot", instructions: "Be very brief." })
  assert.equal((await call("PUT", "/v1/sessions/not-a-runner-id", {})).status, 400)
  assert.equal((await call("PUT", "/v1/sessions/hs_short", {})).status, 400)
})

test("validates input and unknown sessions", async () => {
  const { call } = setup()
  assert.equal((await call("POST", "/v1/sessions/hs_missing/turns", { messageId: "m", prompt: "x" })).status, 404)
  assert.equal((await call("POST", "/v1/sessions/hs_missing/turns", { messageId: "bad id!", prompt: "x" })).status, 400)
  assert.equal(
    (await call("POST", "/v1/sessions/hs_missing/turns", { messageId: "m", prompt: "x", credentials: { other: "y" } })).status,
    400,
  )
})

test("config refuses weak tokens and non-https remote endpoints", () => {
  const base = {
    HEADLESS_API_TOKEN: TOKEN,
    HEADLESS_MODEL_PROTOCOL: "anthropic",
    HEADLESS_MODEL_BASE_URL: "https://gateway.openworklabs.com/api/v1/providers/ipr_x/",
    HEADLESS_MODEL: "gwm_x",
  }
  assert.equal(loadConfig(base).model.baseUrl, "https://gateway.openworklabs.com/api/v1/providers/ipr_x")
  assert.equal(loadConfig({ ...base, HEADLESS_MCP_URL: "http://127.0.0.1:8790/mcp/agent" }).mcp?.url, "http://127.0.0.1:8790/mcp/agent")
  assert.throws(() => loadConfig({ ...base, HEADLESS_API_TOKEN: "short" }))
  assert.throws(() => loadConfig({ ...base, HEADLESS_MCP_URL: "http://evil.example/mcp" }))
})
