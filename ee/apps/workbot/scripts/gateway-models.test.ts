import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { Hono } from "hono"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema, WorkbotTurnAccessError } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

const session = {
  user: { id: "user_test", name: "Test", email: "person@example.test" },
  organization: { id: "org_test", name: "Test Org", brandAppName: null },
  memberId: "member_test", enabled: true, canSchedule: false,
}
const modelAccess = { baseUrl: "https://inference.example.test/v1", apiKey: "secret-model-key", protocol: "openai-responses" }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function fixture(handler: (path: string, method: string, body: unknown) => { status?: number; body: unknown }) {
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const result = handler(request.url ?? "", request.method ?? "GET", raw ? JSON.parse(raw) : undefined)
    response.writeHead(result.status ?? 200, { "content-type": "application/json" })
    response.end(JSON.stringify(result.body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not start")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function gatewayApp(url: string, model: string, gatewayModels = true) {
  const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: url, WORKBOT_DEN_WEB_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: url, WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const den = { ...createDen({ apiUrl: url, publicUrl: config.publicUrl }), webUrl: async () => "http://localhost:3091" }
  const auth = createAuth({ config, den })
  const app = new Hono<AppEnv>()
  app.onError((error, c) => error instanceof WorkbotTurnAccessError ? error.response() : c.json({ error: "internal_error" }, 500))
  registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
    const who = denSessionSchema.parse({ ...session, gatewayModels, verifyModel: true, model })
    c.set("member", { session: { id: "session_test", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "access", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "access", den: who })
    await next()
  } })
  return app
}

test("credential refusals preserve only allowlisted recovery facts through Workbot HTTP, before execution", async () => {
  let denial: { status: number; body: unknown } = { status: 403, body: {} }
  let turns = 0
  const server = await fixture((path, method) => {
    if (path === "/v1/workbot/run-token") return denial
    if (method === "GET" && path.startsWith("/v1/sessions?")) return { body: { sessions: [] } }
    if (method === "GET" && path.startsWith("/v1/sessions/")) return { status: 404, body: { error: "unknown_session" } }
    if (method === "PUT") return { body: { id: decodeURIComponent(path.split("/").at(-1) ?? "") } }
    if (method === "POST" && path.endsWith("/turns")) { turns++; return { status: 202, body: { state: "accepted" } } }
    return { status: 404, body: {} }
  })
  try {
    const app = gatewayApp(server.url, "saved-alias")
    for (const reason of ["gateway_not_configured", "gateway_provider_missing", "gateway_member_access_missing", "gateway_model_unavailable", "gateway_authentication_required", "gateway_credentials_unavailable", "oauth_scope_missing", "rate_limited", "unknown-private-detail"]) {
      denial = { status: reason === "rate_limited" ? 429 : 403, body: { error: "workbot_turn_access_denied", reason, apiKey: "fixture-private-credential", message: "fixture-private-response-body" } }
      const response = await app.request("http://localhost:3090/v1/workbot/messages", { method: "POST", headers: { origin: "http://localhost:3090", "content-type": "application/json" }, body: JSON.stringify({ id: "message_refused", text: "Keep this message" }) })
      assert.equal(response.status, denial.status)
      assert.equal(response.headers.get("cache-control"), "no-store")
      assert.deepEqual(await response.json(), { error: "workbot_turn_access_denied", reason: reason === "unknown-private-detail" ? "model_access_unavailable" : reason })
    }
    denial = { status: 403, body: { error: "insufficient_scope", message: "fixture-private-response-body" } }
    const hello = await app.request("http://localhost:3090/v1/workbot/hello", { method: "POST", headers: { origin: "http://localhost:3090", "content-type": "application/json" }, body: "{}" })
    assert.equal(hello.status, 403)
    assert.deepEqual(await hello.json(), { error: "workbot_turn_access_denied", reason: "oauth_scope_missing" })
    assert.equal(turns, 0)
  } finally { await server.close() }
})

test("session parser keeps the nonsecret gateway flag but strips credentials", () => {
  assert.equal(denSessionSchema.parse(session).gatewayModels, false)
  const parsed = denSessionSchema.parse({ ...session, gatewayModels: true, model: "exact-alias", modelAccess })
  assert.equal(parsed.gatewayModels, true)
  assert.equal(parsed.model, "exact-alias")
  assert.equal("modelAccess" in parsed, false)
  assert.equal(JSON.stringify(parsed).includes(modelAccess.apiKey), false)
})

test("Den run tokens preserve typed model access and only forward selected models in gateway mode", async () => {
  let payload: unknown = { token: "mcp-token" }
  const bodies: unknown[] = []
  const server = await fixture((_path, _method, body) => { bodies.push(body); return { body: payload } })
  try {
    const den = createDen({ apiUrl: server.url, publicUrl: "http://localhost:3090" })
    assert.deepEqual(await den.runToken("access", { model: "exact-alias" }), { token: "mcp-token" })
    assert.deepEqual(bodies[0], {})
    for (const protocol of ["anthropic", "openai", "openai-responses"]) {
      const access = { ...modelAccess, protocol }
      payload = { token: "mcp-token", resumeGrant: "resume-grant", modelAccess: access, ignoredSecret: "drop-me" }
      assert.deepEqual(await den.runToken("access", { gatewayModels: true, model: "exact-alias", sessionId: "session_test", messageId: "message_test", readOnly: true }), { token: "mcp-token", resumeGrant: "resume-grant", modelAccess: access })
      assert.deepEqual(bodies.at(-1), { model: "exact-alias", sessionId: "session_test", messageId: "message_test", readOnly: true })
    }
    for (const access of [{ ...modelAccess, ignoredSecret: "reject-me" }, { ...modelAccess, protocol: "unsupported" }, { ...modelAccess, apiKey: "" }, { ...modelAccess, baseUrl: "not-a-url" }]) {
      payload = { token: "mcp-token", modelAccess: access }
      await assert.rejects(den.runToken("access"), { message: "den_run_token_200" })
    }
  } finally { await server.close() }
})

test("gateway routes skip the runner catalog and keep model credentials only in turn credentials", async (t) => {
  const minted: unknown[] = []
  const sessions: unknown[] = []
  const turns: Record<string, unknown>[] = []
  let catalogReads = 0
  const logs: unknown[][] = []
  t.mock.method(console, "warn", (...args: unknown[]) => { logs.push(args) })
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args) })
  const server = await fixture((path, method, body) => {
    if (path === "/v1/workbot/run-token") {
      minted.push(body)
      return { body: { token: "mcp-token", modelAccess } }
    }
    if (path === "/v1/models") { catalogReads++; return { status: 503, body: {} } }
    // Workbot lists the person's chats (none yet) and, before creating the main chat, checks it isn't in a cell.
    if (method === "GET" && path.startsWith("/v1/sessions?")) return { body: { sessions: [] } }
    if (method === "GET" && path.startsWith("/v1/sessions/hs_c_")) return { status: 404, body: { error: "unknown_session" } }
    if (method === "GET" && path.startsWith("/v1/sessions/")) {
      const url = new URL(path, "http://runner")
      assert.equal(url.searchParams.get("messageId"), "wb_message_001")
      assert.equal(url.searchParams.get("outputs"), "none")
      return { body: { turns: [], messages: [], finalAssistantText: "" } }
    }
    if (method === "PUT") { sessions.push(body); return { body: { id: decodeURIComponent(path.split("/").at(-1) ?? "") } } }
    if (method === "POST" && path.endsWith("/turns")) {
      assert.ok(isRecord(body))
      turns.push(body)
      return { status: 202, body: { state: "accepted" } }
    }
    return { status: 404, body: { error: "unknown_session" } }
  })
  try {
    const app = gatewayApp(server.url, "exact-alias")
    const response = await app.request("http://localhost:3090/v1/workbot/messages", { method: "POST", headers: { origin: "http://localhost:3090", "content-type": "application/json" }, body: JSON.stringify({ id: "message_001", text: "Hello" }) })
    assert.equal(response.status, 202)
    const browserBody = await response.text()
    const me = await (await app.request("http://localhost:3090/v1/workbot/me")).text()
    assert.equal(catalogReads, 0)
    assert.equal(turns.length, 1)
    const turn = turns[0]
    assert.ok(turn)
    assert.equal(turn.model, "exact-alias")
    assert.deepEqual(turn.credentials, { mcpToken: "mcp-token", modelAccess })
    assert.ok(isRecord(minted[0]))
    assert.equal(minted[0].model, "exact-alias")
    assert.equal(typeof minted[0].sessionId, "string")
    assert.match(String(minted[0].sessionId), /^hs_wb_/)
    assert.equal(minted[0].messageId, turn.messageId)
    const { credentials: _credentials, ...nonsecretTurn } = turn
    for (const visible of [browserBody, me, JSON.stringify(sessions), JSON.stringify(nonsecretTurn), JSON.stringify(logs)]) {
      assert.equal(visible.includes(modelAccess.apiKey), false)
      assert.equal(visible.includes(modelAccess.baseUrl), false)
      assert.equal(visible.includes("modelAccess"), false)
    }
  } finally { await server.close() }
})

for (const gatewayModels of [true, false]) {
  test(`reading Workbot resumes a gateway turn with its saved model before minting (gateway rollout ${gatewayModels ? "on" : "off"})`, async () => {
    const originalModel = "original-anthropic-alias"
    const changedDefault = "new-openai-alias"
    const originalAccess = { ...modelAccess, protocol: "anthropic" }
    const minted: unknown[] = []
    const turns: unknown[] = []
    const sequence: string[] = []
    const server = await fixture((path, method, body) => {
      const url = new URL(path, "http://runner")
      if (method === "GET" && url.pathname.startsWith("/v1/sessions/")) {
        sequence.push(url.searchParams.has("messageId") ? "scoped-read" : "thread-read")
        if (url.searchParams.has("messageId")) {
          assert.equal(url.searchParams.get("messageId"), "wb_message_001")
          assert.equal(url.searchParams.get("outputs"), "none")
        }
        return { body: {
          turns: [{ messageId: "wb_message_001", status: "interrupted", model: originalModel, modelAccessRequired: true, createdAt: 100, error: "token_expired" }],
          messages: [{ role: "user", messageId: "wb_message_001", text: "Original question" }],
          finalAssistantText: "",
        } }
      }
      if (path === "/v1/workbot/run-token") {
        sequence.push("mint")
        minted.push(body)
        if (!isRecord(body) || body.model !== originalModel || body.modelAccessRequired !== true) return { status: 403, body: { error: "model_not_allowed" } }
        return { body: { token: "fresh-mcp-token", modelAccess: originalAccess } }
      }
      if (method === "POST" && path.endsWith("/turns")) {
        sequence.push("send")
        turns.push(body)
        return { status: 202, body: { state: "resumed" } }
      }
      return { status: 404, body: { error: "not_found" } }
    })
    try {
      const app = gatewayApp(server.url, changedDefault, gatewayModels)
      const response = await app.request("http://localhost:3090/v1/workbot")
      assert.equal(response.status, 200)
      assert.deepEqual(sequence, ["thread-read", "scoped-read", "mint", "send"])
      assert.equal(minted.length, 1, "never mint against the changed default first")
      assert.ok(isRecord(minted[0]))
      assert.equal(minted[0].model, originalModel)
      assert.equal(minted[0].modelAccessRequired, true, "the saved requirement survives killing the rollout")
      assert.equal(minted[0].messageId, "wb_message_001")
      assert.equal(turns.length, 1)
      assert.ok(isRecord(turns[0]))
      assert.equal(turns[0].model, originalModel)
      assert.equal(turns[0].messageId, "wb_message_001")
      assert.equal(turns[0].prompt, "resume")
      assert.deepEqual(turns[0].credentials, { mcpToken: "fresh-mcp-token", modelAccess: originalAccess })
      const visible = await response.text()
      assert.ok(visible.includes("Original question"))
      assert.equal(visible.includes(modelAccess.apiKey), false)
      assert.equal(visible.includes("modelAccess"), false)
      assert.equal(visible.includes(changedDefault), false)
    } finally { await server.close() }
  })
}
