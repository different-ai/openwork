import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { createHeadlessRunnerClient, type HeadlessModelAccess } from "@openwork-ee/headless-protocol"
import { createApp } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { denResumeClient, type ResumeExchangeInput } from "../src/den-resume.js"
import { gatewayModelCatalog } from "../src/model-catalog.js"
import { createModelProbe } from "../src/model-probe.js"
import { createModelAdapter, ModelError, type ModelClient, type ModelRequest } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { grantVault } from "../src/resume-grants.js"
import { Runner } from "../src/runner.js"
import { SelfResume } from "../src/self-resume.js"
import { Store } from "../src/store.js"

const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 }
const limits = { maxConcurrentTurns: 4, maxSteps: 10, turnTimeoutMs: Infinity, credentialRefreshMs: Infinity, contextCharBudget: 100_000 }
const access: HeadlessModelAccess = { baseUrl: "https://scoped.example.test/v1", apiKey: "opaque-member-credential", protocol: "openai" }
const grant = `hrg_${"A".repeat(43)}`
const apiToken = "runner-service-token-0123456789-0123456789"
const defaultModel: ModelClient = { complete: async () => { throw new Error("deployment adapter must not be used") } }
const complete = { text: "Done", toolCalls: [], usage }
const config = loadConfig({ HEADLESS_API_TOKEN: apiToken, HEADLESS_MODEL_PROTOCOL: "openai", HEADLESS_MODEL_BASE_URL: "https://deployment.example.test/v1", HEADLESS_MODEL: "deployment-model", HEADLESS_MODEL_API_KEY: "shared-deployment-key" })

function database() {
  const directory = mkdtempSync(join(tmpdir(), "scoped-model-access-"))
  const path = join(directory, "runner.sqlite")
  return { path, open: () => new Store(nodeSqlite(path)), [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) }
}

function assertNoSecrets(store: Store, path: string, sessionId: string) {
  const exported = JSON.stringify(store.exportConversation(sessionId))
  for (const secret of [access.apiKey, access.baseUrl]) {
    assert.ok(!exported.includes(secret), "conversation export has no inference credentials")
    for (const file of [path, `${path}-wal`]) {
      if (existsSync(file)) assert.ok(!readFileSync(file).includes(Buffer.from(secret)), "database and WAL have no raw inference credentials")
    }
  }
}

test("scoped turn, background task, report and naming inherit the scoped adapter/key and selected model", async () => {
  using db = database()
  const store = db.open()
  const requests: ModelRequest[] = []
  const adapters: HeadlessModelAccess[] = []
  let named: (() => void) | undefined
  const namingDone = new Promise<void>((resolve) => { named = resolve })
  const runner = new Runner({ store, defaultModel: "deployment-model", defaultModelApiKey: "shared-deployment-key", model: defaultModel, limits,
    modelForAccess: (value) => {
      adapters.push(value)
      return { complete: async (request) => {
        requests.push(request)
        if (request.system.startsWith("You name conversations")) { named?.(); return { ...complete, text: "Scoped conversation" } }
        if (requests.length === 1) return { ...complete, text: "Working", toolCalls: [{ id: "task-1", name: "start_task", input: { title: "Check", brief: "Check the result" } }] }
        return complete
      } }
    },
  })
  const session = store.createSession({ tasks: true, autoTitle: true })
  const app = createApp({ store, runner, apiToken })
  const admitted = await app.request(`/v1/sessions/${session.id}/turns`, { method: "POST", headers: { authorization: `Bearer ${apiToken}` }, body: JSON.stringify({ messageId: "m1", prompt: "Check this", model: "member-model", credentials: { modelAccess: access } }) })
  assert.equal(admitted.status, 202)
  const admission = await admitted.text()
  assert.ok(!admission.includes(access.apiKey) && !admission.includes(access.baseUrl))
  await runner.idle()
  await namingDone
  assert.ok(requests.length >= 5, "message, continuation, task, report and title all ran")
  assert.ok(requests.every((request) => request.apiKey === access.apiKey && request.model === "member-model"))
  for (const value of adapters) assert.deepEqual(value, access)
  const turns = store.listTurns(session.id)
  assert.equal(turns.length, 3)
  assert.ok(turns.every((turn) => turn.status === "completed" && turn.modelAccessRequired === true && store.modelAccessRequired(session.id, turn.messageId)))
  const snapshot = await app.request(`/v1/sessions/${session.id}`, { headers: { authorization: `Bearer ${apiToken}` } })
  const publicTurns = z.object({ turns: z.array(z.object({ modelAccessRequired: z.boolean().optional() })) }).parse(await snapshot.json()).turns
  assert.equal(publicTurns.length, 3)
  assert.ok(publicTurns.every((turn) => turn.modelAccessRequired === true))
  assertNoSecrets(store, db.path, session.id)
  store.close()
})

test("scoped admission requires an explicit new model, rejects null-model upgrades and conflicting retries, and leaves legacy defaults unchanged", async () => {
  using db = database()
  const store = db.open()
  const scoped: ModelRequest[] = []
  const legacy: ModelRequest[] = []
  const runner = new Runner({ store, defaultModel: "deployment-model", defaultModelApiKey: "shared-key", limits,
    model: { complete: async (request) => { legacy.push(request); return complete } },
    modelForAccess: () => ({ complete: async (request) => { scoped.push(request); return complete } }),
  })
  const session = store.createSession({})
  const app = createApp({ store, runner, apiToken })
  const send = (messageId: string, model?: string, useScoped = true) => app.request(`/v1/sessions/${session.id}/turns`, {
    method: "POST", headers: { authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ messageId, prompt: "Continue", ...(model ? { model } : {}), credentials: useScoped ? { modelAccess: access } : {} }),
  })
  const missing = await send("missing")
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { error: "model_required" })
  assert.equal(store.getTurn(session.id, "missing"), null)
  store.admitTurn({ sessionId: session.id, messageId: "legacy-null", model: null, prompt: "Old work" })
  store.setTurnStatus(session.id, "legacy-null", "interrupted", "runner_restarted")
  assert.equal((await send("legacy-null", "new-default")).status, 400)
  assert.equal(store.modelAccessRequired(session.id, "legacy-null"), false)
  assert.equal(store.getTurn(session.id, "legacy-null")?.model, null)
  assert.equal(store.getTurn(session.id, "legacy-null")?.status, "interrupted")
  store.admitTurn({ sessionId: session.id, messageId: "saved", model: "original-model", prompt: "Old scoped work", modelAccessRequired: true })
  store.setTurnStatus(session.id, "saved", "interrupted", "runner_restarted")
  const mismatch = await send("saved", "new-default")
  assert.equal(mismatch.status, 409)
  assert.deepEqual(await mismatch.json(), { error: "model_mismatch" })
  assert.equal((await send("saved")).status, 202, "a stored scoped selection permits omitted-model recovery")
  assert.equal((await send("legacy-new", undefined, false)).status, 202)
  await runner.idle()
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].model, "original-model")
  assert.equal(scoped[0].apiKey, access.apiKey)
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].model, "deployment-model")
  assert.equal(legacy[0].apiKey, "shared-key")
  store.close()
})

test("restart reacquires scoped access using the stored selection; missing access waits and cannot use shared keys", async () => {
  using db = database()
  let store = db.open()
  const vault = grantVault("encryption-key-0123456789-0123456789")
  const exchanges: ResumeExchangeInput[] = []
  let returnAccess = false
  const exchange = denResumeClient({ url: "https://den.example.test", token: "callback-secret", fetch: async (_url, init) => {
    const body = z.object({ grant: z.string(), sessionId: z.string(), messageId: z.string(), model: z.string().optional(), modelAccessRequired: z.boolean().optional() }).parse(JSON.parse(String(init?.body)))
    exchanges.push(body)
    return Response.json({ mcpToken: "fresh-mcp", readOnly: false, expiresAt: "2099-01-01T00:00:00Z", ...(returnAccess ? { modelAccess: access } : {}) })
  } })
  let started: (() => void) | undefined
  const starting = new Promise<void>((resolve) => { started = resolve })
  const resume = new SelfResume({ store, vault, exchange })
  const runner = new Runner({ store, defaultModel: "deployment-model", defaultModelApiKey: "shared-deployment-key", model: defaultModel, limits, resume,
    modelForAccess: () => ({ complete: (request) => { started?.(); return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })) } }),
  })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "original", model: "member-model", prompt: "Continue this", credentials: { modelAccess: access, resumeGrant: grant } })
  await starting
  await resume.settled()
  await runner.shutdown()
  assertNoSecrets(store, db.path, session.id)
  store.close()
  store = db.open()
  store.recoverInterruptedTurns()
  let calls = 0
  const resumedOptions = { store, defaultModel: "changed-deployment-model", defaultModelApiKey: "shared-deployment-key", model: defaultModel, limits,
    modelForAccess: (value: HeadlessModelAccess): ModelClient => ({ complete: async (request) => { calls += 1; assert.deepEqual(value, access); assert.equal(request.model, "member-model"); assert.equal(request.apiKey, access.apiKey); return complete } }),
  }
  const waiting = new Runner({ ...resumedOptions, resume: new SelfResume({ store, vault, exchange }) })
  assert.deepEqual(await waiting.selfResume(), { resumed: 0, waiting: 1, failed: 0 })
  await waiting.idle()
  assert.equal(calls, 0)
  assert.equal(store.getTurn(session.id, "original")?.status, "interrupted")
  assert.deepEqual(exchanges[0], { grant, sessionId: session.id, messageId: "original", model: "member-model", modelAccessRequired: true })
  returnAccess = true
  const restored = new Runner({ ...resumedOptions, resume: new SelfResume({ store, vault, exchange }) })
  assert.equal((await restored.selfResume()).resumed, 1)
  await restored.idle()
  assert.equal(calls, 1)
  assert.equal(store.getTurn(session.id, "original")?.status, "completed")
  // A direct resend cannot downgrade a persisted scoped turn either, even with an explicit legacy key.
  store.setTurnStatus(session.id, "original", "interrupted", "runner_restarted")
  store.db.prepare("DELETE FROM messages WHERE session_id = ?").run(session.id)
  restored.send({ sessionId: session.id, messageId: "original", prompt: "", credentials: { modelApiKey: "legacy-key" } })
  await restored.idle()
  assert.equal(store.getTurn(session.id, "original")?.error, "model_credentials_missing")
  assert.equal(calls, 1)
  assertNoSecrets(store, db.path, session.id)
  store.close()
})

test("scoped refresh that omits modelAccess fails closed before another inference call", async () => {
  using db = database()
  const store = db.open()
  const resume = new SelfResume({ store, vault: grantVault("encryption-key-0123456789-0123456789"), exchange: async () => ({ ok: true, mcpToken: "fresh", readOnly: false, expiresAt: "2099-01-01" }) })
  let calls = 0
  const runner = new Runner({ store, model: defaultModel, defaultModel: "default", defaultModelApiKey: "shared-key", limits: { ...limits, credentialRefreshMs: 0 }, resume,
    mcp: async () => ({ tools: [], call: async () => ({ output: "ok", isError: false }), close: async () => undefined }),
    modelForAccess: () => ({ complete: async () => { calls += 1; return { ...complete, toolCalls: [{ id: "read", name: "list_files", input: {} }] } } }),
  })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "m1", model: "member-model", prompt: "Read", credentials: { mcpToken: "initial", modelAccess: access, resumeGrant: grant } })
  await runner.idle()
  assert.equal(calls, 1)
  assert.equal(store.getTurn(session.id, "m1")?.status, "interrupted")
  assert.equal(store.getTurn(session.id, "m1")?.error, "credentials_refresh")
  store.close()
})

for (const protocol of ["anthropic", "openai", "openai-responses"] as const) {
  test(`${protocol}: scoped adapter and synthetic probe use only the scoped URL/key/protocol`, async () => {
    const modelAccess = { ...access, protocol }
    const paths: string[] = []
    const transport: typeof fetch = async (url, init) => {
      paths.push(String(url))
      assert.ok(String(url).startsWith(access.baseUrl))
      const headers = new Headers(init?.headers)
      assert.equal(protocol === "anthropic" ? headers.get("x-api-key") : headers.get("authorization"), protocol === "anthropic" ? access.apiKey : `Bearer ${access.apiKey}`)
      const body = z.object({ model: z.string() }).parse(JSON.parse(String(init?.body)))
      assert.equal(body.model, "member-model")
      if (protocol === "anthropic") return Response.json({ model: "member-model", content: [{ type: "text", text: "READY" }], usage: { input_tokens: 1, output_tokens: 1 } })
      if (protocol === "openai-responses") return Response.json({ model: "member-model", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "READY" }] }], usage: { input_tokens: 1, output_tokens: 1 } })
      return Response.json({ model: "member-model", choices: [{ message: { content: "READY" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    }
    const adapter = createModelAdapter(modelAccess, { maxOutputTokens: 32, fetch: transport })
    assert.equal((await adapter.complete({ system: "test", messages: [{ role: "user", text: "Hello" }], model: "member-model", apiKey: access.apiKey, tools: [], signal: new AbortController().signal })).text, "READY")
    const probe = createModelProbe(config, transport)
    assert.deepEqual(await probe("member-model", new AbortController().signal, modelAccess), { status: "answered", errorCode: null, requestedModel: "member-model", reportedModel: "member-model" })
    assert.equal(paths.length, 2)
  })
}

test("scoped model errors never persist or report endpoint/key/provider details", async () => {
  using db = database()
  const store = db.open()
  const reports: unknown[] = []
  const failures = [
    new ModelError("model_http_401", `Error at ${access.baseUrl}`, false, undefined, `echo ${access.apiKey} ${access.baseUrl}`),
    new ModelError(`model_stream_${access.apiKey}`, access.baseUrl, false),
    new Error(`${access.apiKey} ${access.baseUrl}`),
  ]
  const runner = new Runner({ store, model: defaultModel, defaultModel: "default", defaultModelApiKey: "shared", limits,
    errors: { enabled: true, report: async (report) => { reports.push(report) } },
    modelForAccess: () => ({ complete: async () => { throw failures.shift() } }),
  })
  const session = store.createSession({})
  runner.send({ sessionId: session.id, messageId: "m1", model: "member-model", prompt: "Hello", credentials: { modelAccess: access } })
  await runner.idle()
  assert.equal(store.getTurn(session.id, "m1")?.error, "model_http_401")
  assert.equal(store.getTurn(session.id, "m1")?.errorDetail, undefined)
  for (const [messageId, code] of [["m2", "model_stream_error"], ["m3", "runner_error"]]) {
    runner.send({ sessionId: session.id, messageId, model: "member-model", prompt: "Hello", credentials: { modelAccess: access } })
    await runner.idle()
    assert.equal(store.getTurn(session.id, messageId)?.error, code)
  }
  for (const secret of [access.apiKey, access.baseUrl]) assert.ok(!JSON.stringify(reports).includes(secret))
  assertNoSecrets(store, db.path, session.id)
  store.close()
})

test("scoped catalog is service-authenticated, uncached per member, and never falls back to the shared catalog", async () => {
  using db = database()
  const store = db.open()
  const seen: HeadlessModelAccess[] = []
  let fail = false
  const catalog = gatewayModelCatalog(config, async (input) => {
    seen.push(input)
    if (fail) throw new Error(`${input.apiKey} ${input.baseUrl}`)
    return [{ id: "member-model", name: "Member model" }]
  })
  const runner = new Runner({ store, model: defaultModel, defaultModel: "default", limits })
  const app = createApp({ store, runner, apiToken, models: catalog, modelProbe: createModelProbe(config) })
  const call = (auth: boolean) => app.request("/v1/models", { method: "POST", headers: { ...(auth ? { authorization: `Bearer ${apiToken}` } : {}) }, body: JSON.stringify({ modelAccess: access }) })
  assert.equal((await call(false)).status, 401)
  const result = await call(true)
  assert.equal(result.headers.get("cache-control"), "no-store")
  assert.deepEqual(await result.json(), { defaultModel: "member-model", models: [{ id: "member-model", name: "Member model" }], verified: true })
  await call(true)
  assert.equal(seen.length, 2)
  assert.ok(seen.every((input) => input.apiKey === access.apiKey))
  fail = true
  assert.deepEqual(await (await call(true)).json(), { defaultModel: "", models: [], verified: false })
  const invalidProbe = await app.request("/v1/model-probe", { method: "POST", headers: { authorization: `Bearer ${apiToken}` }, body: JSON.stringify({ model: "member-model", modelAccess: { ...access, protocol: "unknown" } }) })
  assert.equal(invalidProbe.status, 400)
  store.close()
})

test("typed client forwards model selection and minted access; legacy turns and GET catalog stay compatible", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const minted: unknown[] = []
  let scoped = true
  const client = createHeadlessRunnerClient({ config: { url: "https://runner.example.test", token: apiToken }, maxTokenTtlMs: 1000,
    mintToken: async (input) => { minted.push(input); return { token: "mcp", ...(scoped ? { modelAccess: access } : {}) } },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init })
      if (init?.method === "GET" && String(url).includes("/v1/sessions/")) return Response.json({ turns: [], messages: [], finalAssistantText: "" })
      if (String(url).endsWith("/turns")) return Response.json({ state: "accepted" }, { status: 202 })
      if (String(url).endsWith("/model-probe")) return Response.json({ status: "answered", errorCode: null, requestedModel: "member-model", reportedModel: "member-model" })
      return Response.json({ defaultModel: "member-model", models: [] })
    },
  })
  const actor = { userId: "member", organizationId: "org" }
  await client.sendTurn(actor, { sessionId: "hs_12345678", messageId: "m1", prompt: "Hello", model: "member-model" })
  assert.deepEqual(minted[0], { ...actor, sessionId: "hs_12345678", messageId: "m1", ttlMs: 1000, model: "member-model" })
  assert.deepEqual(JSON.parse(String(requests.find((request) => request.url.endsWith("/turns"))?.init?.body)).credentials, { mcpToken: "mcp", modelAccess: access })
  await client.listModels(access)
  assert.equal(requests.at(-1)?.init?.method, "POST")
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { modelAccess: access })
  await client.testModel("member-model", access)
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { model: "member-model", modelAccess: access })
  scoped = false
  await client.sendTurn(actor, { sessionId: "hs_12345678", messageId: "m2", prompt: "Hello" })
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)).credentials, { mcpToken: "mcp" })
  await client.listModels()
  assert.equal(requests.at(-1)?.init?.method, "GET")
  assert.equal(requests.at(-1)?.init?.body, undefined)
})
