import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { anthropicModel, ModelError, openAIModel, openAIResponsesModel, type ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"
import { loadConfig } from "../src/config.js"
import { workbotTelemetryReporter, type WorkbotTurnFact } from "../src/workbot-telemetry.js"

const limits = { maxConcurrentTurns: 2, maxSteps: 2, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 10_000 }
const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const sessionId = `hs_wb_${"a".repeat(40)}`
const configEnv = { HEADLESS_API_TOKEN: "runner-test-service-token-000000000000", HEADLESS_MODEL_PROTOCOL: "anthropic", HEADLESS_MODEL_BASE_URL: "https://model.example.test/v1", HEADLESS_MODEL: "test-model" }
const accepted: WorkbotTurnFact = { event: "accepted", sessionId, messageId: "wb_hello", timestamp: 1, model: "test-model", attachmentCount: 0, hasContext: false }

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test("a generic MCP URL never opts a runner into telemetry or receives its service token", async () => {
  let deliveries = 0
  const transport: typeof fetch = async () => { deliveries += 1; return new Response(null, { status: 204 }) }
  for (const mcp of [undefined, "https://foreign-mcp.example.test/agent", "https://den.example.test/mcp/agent"]) {
    for (const origin of [undefined, "", "  "]) {
      const config = loadConfig({ ...configEnv, HEADLESS_MCP_URL: mcp, HEADLESS_WORKBOT_DEN_API_URL: origin })
      assert.equal(config.workbotTelemetryUrl, undefined)
      assert.equal(workbotTelemetryReporter(config, transport), undefined)
    }
  }
  assert.equal(deliveries, 0)
})

test("only an explicitly configured Den origin receives telemetry credentials, without following redirects", async () => {
  let foreignRequests = 0
  const foreign = createServer((_request, response) => { foreignRequests += 1; response.writeHead(204).end() })
  const foreignOrigin = await listen(foreign)
  const deliveries: { path: string | undefined; authorization: string | undefined; service: string | string[] | undefined }[] = []
  let redirect = false
  const den = createServer((request, response) => {
    deliveries.push({ path: request.url, authorization: request.headers.authorization, service: request.headers["x-openwork-workbot-service"] })
    request.resume()
    if (redirect) response.writeHead(307, { location: `${foreignOrigin}/stolen` }).end()
    else response.writeHead(204).end()
  })
  try {
    const denOrigin = await listen(den)
    const config = loadConfig({ ...configEnv, HEADLESS_MCP_URL: `${foreignOrigin}/mcp/agent`, HEADLESS_WORKBOT_DEN_API_URL: `${denOrigin}/` })
    assert.equal(config.workbotTelemetryUrl, `${denOrigin}/v1/workbot/telemetry`)
    const reporter = workbotTelemetryReporter(config)
    assert.ok(reporter)
    await reporter(accepted, "test-member-token")
    redirect = true
    await reporter(accepted, "test-member-token")
    assert.deepEqual(deliveries, [0, 1].map(() => ({ path: "/v1/workbot/telemetry", authorization: "Bearer test-member-token", service: configEnv.HEADLESS_API_TOKEN })))
    assert.equal(foreignRequests, 0, "neither generic MCP configuration nor a Den redirect can receive telemetry credentials")
  } finally { await close(den); await close(foreign) }
})

test("telemetry configuration requires a trusted HTTPS origin, with loopback-only HTTP for development", () => {
  for (const origin of ["https://den.example.test", "https://den.example.test/", "http://127.0.0.1:8790", "http://localhost:8790", "http://[::1]:8790"]) {
    assert.equal(loadConfig({ ...configEnv, HEADLESS_WORKBOT_DEN_API_URL: origin }).workbotTelemetryUrl, `${new URL(origin).origin}/v1/workbot/telemetry`)
  }
  for (const origin of ["http://den.example.test", "ftp://den.example.test", "https://user:password@den.example.test", "https://den.example.test/mcp/agent", "https://den.example.test/?token=test", "https://den.example.test/#fragment"]) {
    assert.throws(() => loadConfig({ ...configEnv, HEADLESS_WORKBOT_DEN_API_URL: origin }), /HEADLESS_WORKBOT_DEN_API_URL/)
  }
})

function setup(model: ModelClient, failTelemetry = false) {
  const directory = mkdtempSync(join(tmpdir(), "workbot-telemetry-"))
  const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
  store.putSession(sessionId, {})
  const facts: WorkbotTurnFact[] = []
  const runner = new Runner({ store, model, defaultModel: "configured-default", defaultModelApiKey: "test-key", limits,
    // No SessionEvents, browser stream or host relay exists in this world.
    workbotTelemetry: async (fact, token) => {
      assert.equal(token, "member-token")
      facts.push(fact)
      if (failTelemetry) throw new Error("offline")
    },
  })
  return { store, runner, facts, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }) } }
}

test("a greeting completes with its answering model when the browser is closed; duplicate sends are not new firsts", async () => {
  const world = setup({ complete: async () => ({ text: "private greeting body", model: "actual-answer-model", toolCalls: [], usage }) })
  try {
    const input = { sessionId, messageId: "wb_hello", prompt: "private greeting prompt", credentials: { mcpToken: "member-token" } }
    assert.equal(world.runner.send(input).ok, true)
    await world.runner.idle()
    assert.equal(world.runner.send(input).ok, true)
    await world.runner.idle()
    assert.deepEqual(world.facts.map((fact) => fact.event), ["accepted", "completed"])
    const outcome = world.facts[1]
    assert.ok(outcome.event === "completed")
    assert.equal(outcome.model, "actual-answer-model")
    assert.equal(outcome.modelSource, "response")
    assert.equal(JSON.stringify(world.facts).includes("private greeting"), false)
  } finally { world.close() }
})

test("greeting failures record codes without text, and telemetry failure never fails a turn", async () => {
  const world = setup({ complete: async () => { throw new Error("private provider details") } }, true)
  try {
    world.runner.send({ sessionId, messageId: "wb_hello", prompt: "private prompt", credentials: { mcpToken: "member-token" } })
    await world.runner.idle()
    assert.equal(world.store.getTurn(sessionId, "wb_hello")?.status, "failed")
    const outcome = world.facts.find((fact) => fact.event === "failed")
    assert.ok(outcome?.event === "failed")
    assert.equal(outcome.errorCode, "runner_error")
    assert.equal(JSON.stringify(world.facts).includes("private"), false)
  } finally { world.close() }
  const successful = setup({ complete: async () => ({ text: "answer", toolCalls: [], usage }) }, true)
  try {
    successful.runner.send({ sessionId, messageId: "wb_message0001", prompt: "[OpenWork visible context v1]\nprivate context", credentials: { mcpToken: "member-token", readOnly: true } })
    await successful.runner.idle()
    assert.equal(successful.store.getTurn(sessionId, "wb_message0001")?.status, "completed")
    const first = successful.facts[0]
    assert.ok(first.event === "accepted")
    assert.equal(first.hasContext, true)
    assert.equal(first.attachmentCount, 0)
    successful.runner.send({ sessionId, messageId: "wb_message0002", prompt: "[OpenWork visible context v1]\njust typed text", credentials: { mcpToken: "member-token" } })
    await successful.runner.idle()
    const ordinary = successful.facts.find((fact) => fact.event === "accepted" && fact.messageId === "wb_message0002")
    assert.ok(ordinary?.event === "accepted")
    assert.equal(ordinary.hasContext, false, "typed text cannot impersonate server-supplied context metadata")
  } finally { successful.close() }
})

test("provider-defined error slugs are bucketed, not copied into telemetry", async () => {
  const world = setup({ complete: async () => { throw new ModelError("model_stream_private_marker_must_not_be_recorded", "private provider details", false) } })
  try {
    world.runner.send({ sessionId, messageId: "wb_hello", prompt: "private prompt", credentials: { mcpToken: "member-token" } })
    await world.runner.idle()
    const outcome = world.facts.find((fact) => fact.event === "failed")
    assert.ok(outcome?.event === "failed")
    assert.equal(outcome.errorCode, "model_stream_error")
    assert.equal(JSON.stringify(world.facts).includes("private_marker"), false)
  } finally { world.close() }
})

test("a provider cannot reflect a default key, per-turn key or member token fragment into model telemetry", async () => {
  for (const reflected of ["test-key", "test-ke", "est-key", "prefix-test-key", "turn-private-key", "urn-private-key", "turn-private-ke", "member-toke", "ember-token", "prefix-member-token"]) {
    const world = setup({ complete: async () => ({ text: "answer", model: reflected, toolCalls: [], usage }) })
    try {
      world.runner.send({ sessionId, messageId: "wb_hello", prompt: "private prompt", credentials: { mcpToken: "member-token", modelApiKey: "turn-private-key" } })
      await world.runner.idle()
      const outcome = world.facts.find((fact) => fact.event === "completed")
      assert.ok(outcome?.event === "completed")
      assert.equal(outcome.model, "unreported")
      assert.notEqual(outcome.modelSource, "response")
      assert.equal(JSON.stringify(world.facts).includes(reflected), false)
    } finally { world.close() }
  }
})

test("model adapters keep the provider-reported model for all protocols and streams", async () => {
  for (const stream of [false, true]) {
    const request = { system: "test", messages: [], tools: [], model: "requested-alias", apiKey: "test-key", signal: new AbortController().signal, ...(stream ? { onText: () => undefined } : {}) }
    const openAI = openAIModel({ baseUrl: "https://model.example.test/v1", maxOutputTokens: 256, fetch: async () => stream
      ? new Response('data: {"model":"actual-openai","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
      : Response.json({ model: "actual-openai", choices: [{ message: { content: "answer" } }] }) })
    assert.equal((await openAI.complete(request)).model, "actual-openai")
    const anthropic = anthropicModel({ baseUrl: "https://model.example.test/v1", maxOutputTokens: 256, fetch: async () => stream
      ? new Response('data: {"type":"message_start","message":{"model":"actual-anthropic","usage":{}}}\n\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
      : Response.json({ model: "actual-anthropic", content: [{ type: "text", text: "answer" }] }) })
    assert.equal((await anthropic.complete(request)).model, "actual-anthropic")
    const responses = openAIResponsesModel({ baseUrl: "https://model.example.test/v1", maxOutputTokens: 256, fetch: async () => stream
      ? new Response('data: {"type":"response.completed","response":{"model":"actual-responses","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"answer"}]}]}}\n\n', { headers: { "content-type": "text/event-stream" } })
      : Response.json({ model: "actual-responses", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }] }) })
    assert.equal((await responses.complete(request)).model, "actual-responses")
  }
})
