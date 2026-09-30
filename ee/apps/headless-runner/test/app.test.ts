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
  assert.deepEqual(loadConfig({ ...base, HEADLESS_MCP_URL: "https://api.openworklabs.com/mcp/agent" }).mcp?.toolAllowlist, [
    "search_capabilities",
    "execute_capability",
    "list_skills",
    "get_skill",
  ])
  assert.deepEqual(loadConfig({ ...base, HEADLESS_MCP_URL: "https://x.example/mcp", HEADLESS_MCP_TOOL_ALLOWLIST: "*" }).mcp?.toolAllowlist, [])
  assert.throws(() => loadConfig({ ...base, HEADLESS_API_TOKEN: "short" }))
  assert.throws(() => loadConfig({ ...base, HEADLESS_MCP_URL: "http://evil.example/mcp" }))
})
