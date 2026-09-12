import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

// Launch a real HTTP gateway with in-memory persistence and a local upstream.
// No product-source imports, external providers, or database prerequisites.
const root = fileURLToPath(new URL("../../", import.meta.url))
const marker = "SECRET_MARKER_DO_NOT_LOG"
const syntheticText = "Synthetic transport sample: café."
const gatewayPath = "/api/v1/providers/ipr_fixture"
const gatewayKey = `ow_gw_${"A".repeat(43)}`
type FixtureState = {
  requests: { url: string; bytes: number[]; headers: Record<string, string | string[]> }[]
  rows: { completed_at?: string | null; first_byte_at?: string | null; outcome: string; status?: number | null; response_bytes?: number | null; usage_source: string; total_tokens?: number | null; error_code?: string | null; upstream_request_id?: string | null; upstream_model?: string | null }[]
  reports: unknown[]; cancelled: number; lookups: number; buckets: number; upstreamReads: number; credentialReads: number; tokenCalls: number
}
async function readState(url: string): Promise<FixtureState> {
  // Wire boundary for this spec's private, local fixture (not product data).
  const state: FixtureState = await (await fetch(`${url}/__test/state`, { signal: AbortSignal.timeout(5_000) })).json()
  expect(Array.isArray(state.requests) && Array.isArray(state.rows)).toBe(true)
  return state
}

async function fixture(config: Record<string, unknown> = {}, timeoutMs = 30_000, overrides: Record<string, string> = {}) {
  // Do not inherit operator credentials/policy into an isolated witness.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GATEWAY_") && !key.startsWith("INFERENCE_")))
  const child = spawn("pnpm", ["--filter", "@openwork-ee/gateway", "exec", "tsx", "test/helpers/transport-server.ts"], {
    cwd: root,
    env: { ...inherited, OPENWORK_DEV_MODE: "1", DATABASE_URL: "mysql://fixture:fixture@127.0.0.1:1/gateway_transport_fixture", DB_MODE: "mysql", SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off", NODE_OPTIONS: "--conditions=development", INFERENCE_UPSTREAM_TIMEOUT_MS: String(timeoutMs), ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  let output = ""
  child.stdout.on("data", (chunk) => { output += String(chunk) })
  child.stderr.on("data", (chunk) => { output += String(chunk) })
  const stop = () => { if (child.pid) { try { process.kill(-child.pid, "SIGTERM") } catch { /* already exited */ } } }
  let url = ""
  try {
    for (let i = 0; i < 200; i++) {
      url = /TRANSPORT_FIXTURE_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1] ?? ""
      if (url) break
      if (child.exitCode !== null) throw new Error(`Fixture exited: ${output}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!url) throw new Error(`Fixture did not start: ${output}`)
    await fetch(`${url}/__test/config`, { method: "POST", body: JSON.stringify(config), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5_000) })
  } catch (error) { stop(); throw error }
  return {
    url,
    async request(path = "/responses", init: RequestInit = {}) {
      const body = path.startsWith("/models/") ? '{"contents":[]}' : path.startsWith("/model/") ? '{"messages":[]}' : path.startsWith("/chat/") ? '{"model":"x","messages":[]}' : '{"model":"x","input":"inline text"}'
      return fetch(`${url}${gatewayPath}${path}`, { method: "POST", headers: { "x-goog-api-key": gatewayKey, "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000), ...init })
    },
    async openwork(init: RequestInit = {}) {
      return fetch(`${url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer ow_inf_fixture", "content-type": "application/json" }, body: '{"model":"z-ai/glm-5.2","messages":[]}', signal: AbortSignal.timeout(10_000), ...init })
    },
    async state() { return readState(url) },
    async waitFor(predicate: (state: FixtureState) => boolean) {
      for (let i = 0; i < 100; i++) {
        const state = await readState(url)
        if (predicate(state)) return state
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`Fixture condition timed out: ${output}`)
    },
    async release() { await fetch(`${url}/__test/release`, { method: "POST" }) },
    get output() { return output },
    async [Symbol.asyncDispose]() { stop() },
  }
}

test("native Google/Azure headers authenticate Gateway keys; conflicting credentials never reach the provider", async () => {
  await using f = await fixture()
  // Native auth requests use permitted inline JSON, not a file-management API.
  const body = '{"model":"x","input":"inline text"}'
  for (const header of ["x-goog-api-key", "api-key", "x-api-key"]) {
    const response = await f.request("/responses", { body, headers: { "content-type": "application/json", [header]: gatewayKey } })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
  }
  const query = await f.request(`/responses?key=${gatewayKey}&alt=sse`, { body, headers: { "content-type": "application/json" } })
  expect(query.status).toBe(200)
  await query.arrayBuffer()
  const good = await f.state()
  expect(good.requests).toHaveLength(4)
  expect(good.requests[3].url).toBe("/v1/responses?alt=sse")
  expect(good.requests.every((r) => r.headers.authorization === "Bearer UPSTREAM_ONLY_KEY")).toBe(true)
  const conflictingHeaders: Record<string, string>[] = [
    { authorization: `Bearer ${gatewayKey}`, "api-key": "other" },
    { "x-goog-api-key": `${gatewayKey}, other` },
    { authorization: "Basic bad", "x-api-key": gatewayKey },
  ]
  for (const headers of conflictingHeaders) {
    const response = await f.request("/responses", { body, headers: { "content-type": "application/json", ...headers } })
    expect(response.status).toBe(401)
    expect(response.headers.get("x-openwork-request-id")).toMatch(/^[a-f0-9]{32}$/)
    expect(await response.json()).toMatchObject({ error: { code: "invalid_api_key" } })
  }
  const duplicateQuery = await f.request(`/responses?key=${gatewayKey}&key=other`, { body, headers: { "content-type": "application/json", "x-goog-api-key": gatewayKey } })
  expect(duplicateQuery.status).toBe(401)
  expect(await duplicateQuery.json()).toMatchObject({ error: { code: "invalid_api_key" } })
  expect((await f.state()).requests).toHaveLength(4)
})

test("Gateway keeps operator routes and separates Models keys; new admin and webhook config replaces deprecated aliases", async () => {
  for (const canonical of [false, true]) {
    const overrides: Record<string, string> = {
      INFERENCE_ADMIN_TOKEN: "legacy-admin-fixture",
      INFERENCE_WEBHOOK_SECRET: "legacy-webhook-fixture",
    }
    if (canonical) {
      overrides.GATEWAY_ADMIN_TOKEN = "canonical-admin-fixture"
      overrides.GATEWAY_WEBHOOK_SECRET = "canonical-webhook-fixture"
    }
    await using f = await fixture({}, 30_000, overrides)
    const health = await fetch(`${f.url}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, service: "gateway" })
    const operatorRequest = (path: string, token: string, body: string) => fetch(`${f.url}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body,
    })
    const prefix = canonical ? "canonical" : "legacy"
    // An authorized malformed body reaches validation, never executes a DB rollup.
    const accepted = await operatorRequest("/internal/rollups/run", `${prefix}-admin-fixture`, "{")
    expect(accepted.status).toBe(400)
    expect(await accepted.json()).toEqual({ error: "invalid_json" })
    expect((await operatorRequest("/internal/rollups/run", canonical ? "legacy-admin-fixture" : "wrong", "{")).status).toBe(401)
    const webhook = await operatorRequest("/webhooks/openrouter", `${prefix}-webhook-fixture`, '{"resourceSpans":[]}')
    expect(webhook.status).toBe(200)
    expect(await webhook.json()).toEqual({ ok: true, ingested: 0, skipped: 0, deferred: 0, invalid: 0, failed: 0 })
    expect((await operatorRequest("/webhooks/openrouter", canonical ? "legacy-webhook-fixture" : "wrong", "{}")).status).toBe(401)
    const validKey = await f.request()
    expect(validKey.status).toBe(200)
    await validKey.arrayBuffer()
    const invalidKey = await f.request("/responses", { headers: { authorization: "Bearer ow_inf_fixture" } })
    expect(invalidKey.status).toBe(401)
    const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
    expect(state.rows[0]).toMatchObject({ inference_key_id: null, gateway_key_id: "gky_fixture", gateway_provider_id: "ipr_fixture" })
    expect(state.requests).toHaveLength(1)
    expect(JSON.stringify(state.requests)).not.toContain(gatewayKey)
    expect(f.output).not.toMatch(/legacy-admin-fixture|canonical-admin-fixture|legacy-webhook-fixture|canonical-webhook-fixture/)
  }
})

test("empty canonical Gateway credentials disable legacy tokens rather than silently restoring access", async () => {
  await using f = await fixture({}, 30_000, {
    GATEWAY_ADMIN_TOKEN: "", INFERENCE_ADMIN_TOKEN: "legacy-admin-fixture",
    GATEWAY_WEBHOOK_SECRET: "", INFERENCE_WEBHOOK_SECRET: "legacy-webhook-fixture",
  })
  for (const { path, token, status } of [
    { path: "/internal/rollups/run", token: "legacy-admin-fixture", status: 404 },
    { path: "/webhooks/openrouter", token: "legacy-webhook-fixture", status: 503 },
  ]) {
    const response = await fetch(`${f.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })
    expect(response.status).toBe(status)
  }
  expect((await f.state()).requests).toHaveLength(0)
})

test("Gateway timeout takes precedence and invalid canonical numbers cannot fall back to valid legacy config", async () => {
  await using f = await fixture({ mode: "headers-hang" }, 30_000, { GATEWAY_UPSTREAM_TIMEOUT_MS: "1000" })
  const response = await f.request()
  expect(response.status).toBe(502)
  await f.waitFor((s) => s.cancelled === 1)
  await expect(fixture({}, 1000, { GATEWAY_UPSTREAM_TIMEOUT_MS: "invalid" })).rejects.toThrow(/GATEWAY_UPSTREAM_TIMEOUT_MS/)
  await expect(fixture({}, 1000, { GATEWAY_CREDITS_PER_DOLLAR: "invalid", INFERENCE_CREDITS_PER_DOLLAR: "1000000" })).rejects.toThrow(/GATEWAY_CREDITS_PER_DOLLAR/)
})

test("Gateway egress config overrides rather than unions legacy exceptions; an empty canonical list fails closed", async () => {
  await using allowed = await fixture({ egressAlias: "canonical" })
  const response = await allowed.request()
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  expect((await allowed.state()).requests).toHaveLength(1)
  await fetch(`${allowed.url}/__test/config`, { method: "POST", body: JSON.stringify({ egressAlias: "canonical", target: "http://127.0.0.1:1" }) })
  const deniedLegacy = await allowed.request()
  expect(deniedLegacy.status).toBe(502)
  expect(await deniedLegacy.json()).toMatchObject({ error: { code: "provider_misconfigured" } })
  expect((await allowed.state()).upstreamReads).toBe(0)
  await using empty = await fixture({ egressAlias: "empty" })
  expect((await empty.request()).status).toBe(502)
  expect((await empty.state()).requests).toHaveLength(0)
})

test("credential retry yields a correlated 503 without forwarding tokens or asking the member to reconnect", async () => {
  for (const retryReason of ["refresh_busy", "refresh_unavailable", "credential_changed"]) {
    await using f = await fixture({ retryReason, provider: "google-vertex", settings: { project: "test-project", location: "us-central1" } })
    const response = await f.request("/models/gemini:generateContent")
    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("5")
    expect(response.headers.get("x-openwork-request-id")).toMatch(/^[a-f0-9]{32}$/)
    expect(response.headers.has("x-openwork-auth-required")).toBe(false)
    expect(await response.json()).toMatchObject({ error: { code: "provider_credential_retry" } })
    const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
    expect(state.requests).toHaveLength(0)
    expect(state.upstreamReads).toBe(0)
    expect(state.rows[0]).toMatchObject({ status: 503, outcome: "rejected", error_code: retryReason })
    expect(f.output + JSON.stringify(state.reports)).not.toMatch(/EXPIRED_TOKEN_NEVER_FORWARD|REFRESH_TOKEN_NEVER_FORWARD|openwork_auth_required/)
  }
})

test("both routes record semantic stream errors; Models sanitizes the provider error while Gateway preserves native bytes", async () => {
  for (const route of ["gateway", "openwork"]) {
    await using f = await fixture({ mode: "semantic-error" })
    const response = await (route === "gateway"
      ? f.request("/chat/completions", { headers: { "api-key": gatewayKey, "content-type": "application/json" }, body: '{"model":"x","stream":true}' })
      : f.openwork({ body: '{"model":"z-ai/glm-5.2","messages":[],"stream":true}' }))
    expect(response.status).toBe(200)
    const text = await response.text()
    if (route === "gateway") expect(text).toBe('data: {"id":"body-request-id","error":{"message":"redacted-provider-error"}}\n\n')
    else {
      expect(text).toContain("upstream_unavailable")
      expect(text).not.toContain("redacted-provider-error")
      expect(text).not.toContain("[DONE]")
    }
    const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
    expect(state.rows[0]).toMatchObject({ status: 200, outcome: "upstream_error", error_code: route === "gateway" ? "upstream_stream_error" : "upstream_unavailable", upstream_request_id: "body-request-id",
      upstream_model: route === "gateway" ? "x" : "z-ai/glm-5.2" })
  }
})

test("managed Chat JSON and SSE preserve bytes and independent generation outcomes",  async () => {
  for (const stream of [false, true]) {
    for (const [finishReason, generationOutcome] of [["stop", "completed"], ["length", "length_limited"], ["tool_calls", "tool_calls"], ["content_filter", "content_filtered"]]) {
      const message = { role: "assistant", content: syntheticText }
      const responseBody = stream
        ? [
          { choices: [{ index: 0, delta: message, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
        ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"
        : JSON.stringify({ choices: [{ index: 0, message, finish_reason: finishReason }] })
      await using f = await fixture({ mode: stream ? "synthetic-sse" : "synthetic-json", responseBody })
      const response = await f.openwork({ body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [], stream }) })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain(stream ? "text/event-stream" : "application/json")
      expect(await response.text()).toBe(responseBody)
      const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
      expect(state.requests).toHaveLength(1)
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({ status: 200, outcome: "ok", error_code: null })
      expect(state.reports).toEqual(expect.arrayContaining([expect.objectContaining({ payloadMode: "summary" })]))
      expect(state.reports.filter((report) => typeof report === "object" && report !== null && "transportOutcome" in report)).toEqual([
        expect.objectContaining({ transportOutcome: "ok", generationOutcome, providerTerminalReason: finishReason }),
      ])
      const diagnostics = f.output + JSON.stringify([state.rows, state.reports])
      expect(diagnostics).not.toContain(syntheticText)
      expect(state.rows[0]).toMatchObject({ generation_outcome: generationOutcome, provider_terminal_reason: finishReason })
    }
  }
})

test("org-provider Anthropic JSON and SSE refusal retains native bytes and transport-ok accounting",  async () => {
  for (const stream of [false, true]) {
    const message = { id: "msg_fixture", type: "message", role: "assistant", model: "claude", content: [{ type: "text", text: syntheticText }], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
    const responseBody = stream
      ? [
        { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: syntheticText } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ].map((frame) => `event: ${frame.type}\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`).join("")
      : ` ${JSON.stringify(message)}\n`
    await using f = await fixture({ provider: "anthropic", mode: stream ? "synthetic-sse" : "synthetic-json", responseBody })
    const response = await f.request("/messages", { body: JSON.stringify({ model: "claude", messages: [], max_tokens: 8, stream }) })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain(stream ? "text/event-stream" : "application/json")
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(bytes).toEqual(new TextEncoder().encode(responseBody))
    expect(new TextDecoder().decode(bytes)).toContain('"stop_reason":"refusal"')
    const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
    expect(state.requests).toHaveLength(1)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ status: 200, outcome: "ok", error_code: null })
    const diagnostics = f.output + JSON.stringify([state.rows, state.reports])
    expect(diagnostics).not.toContain(syntheticText)
    expect(state.rows[0]).toMatchObject({ generation_outcome: "refused", provider_terminal_reason: "refusal", input_tokens: 1, output_tokens: 1, total_tokens: 2 })
  }
})

test("malformed and truncated managed SSE retain partial output and distinct protocol errors, never an invented content_filter", async () => {
  const partial = { choices: [{ index: 0, delta: { role: "assistant", content: syntheticText }, finish_reason: null }] }
  for (const { ending, code } of [
    { ending: 'data: {"choices":\n\n', code: "upstream_malformed_stream" },
    { ending: 'data: {"choices":', code: "upstream_incomplete" },
  ]) {
    await using f = await fixture({ mode: "synthetic-sse", responseBody: `data: ${JSON.stringify(partial)}\n\n${ending}` })
    const response = await f.openwork({ body: '{"model":"z-ai/glm-5.2","messages":[],"stream":true}' })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    const frames: unknown[] = text.trimEnd().split("\n\n").map((frame) => JSON.parse(frame.slice("data: ".length)))
    expect(frames).toEqual([partial, { error: expect.objectContaining({ code, type: "api_error" }) }])
    const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
    expect(state.requests).toHaveLength(1)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ status: 200, outcome: "upstream_error", error_code: code })
    expect(state.reports.filter((report) => typeof report === "object" && report !== null && "transportOutcome" in report)).toEqual([
      expect.objectContaining({ transportOutcome: "upstream_error", generationOutcome: "unknown", providerTerminalReason: "unknown" }),
    ])
    const diagnostics = f.output + JSON.stringify([state.rows, state.reports])
    expect(diagnostics).not.toContain(syntheticText)
    expect(text + diagnostics).not.toMatch(/content_filter|refusal|\[DONE\]/)
  }
})

test("permitted inline JSON retains exact bytes; files, multipart, unknown endpoints and oversized invocation bodies are rejected", async () => {
  await using f = await fixture()
  const rawJson = ' { "model": "x", "input": "inline text", "metadata": { "file_id": "client-data" } } '
  const response = await f.request("/responses", { body: rawJson })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(rawJson)
  expect((await f.state()).requests[0].bytes).toEqual([...new TextEncoder().encode(rawJson)])
  const bytes = new Uint8Array([...new TextEncoder().encode('--boundary\r\nContent-Disposition: form-data; name="file"\r\n\r\n'), 255, 254, 0, 128, ...new TextEncoder().encode('\r\n--boundary--\r\n')])
  const upload = await f.request("/files", { headers: { "api-key": gatewayKey, "content-type": "multipart/form-data; boundary=boundary" }, body: bytes })
  expect(upload.status).toBe(400)
  expect(await upload.json()).toMatchObject({ error: { code: "unsupported_gateway_operation" } })
  const unknown = await f.request("/files/responses", { body: rawJson })
  expect(unknown.status).toBe(400)
  expect(await unknown.json()).toMatchObject({ error: { code: "unsupported_gateway_operation" } })
  const multipart = await f.request("/images/edits", { headers: { "api-key": gatewayKey, "content-type": "multipart/form-data; boundary=boundary" }, body: bytes })
  expect(multipart.status).toBe(415)
  const oversized = await f.request("/responses", { body: JSON.stringify({ model: "x", input: "x".repeat(32 * 1024 * 1024) }) })
  expect(oversized.status).toBe(413)
  expect((await f.state()).requests).toHaveLength(1)
})

test("model metadata stays local and forbidden operations or provider resources never load credentials or dispatch", async () => {
  await using f = await fixture()
  for (const path of ["/models", "/v1/models", "/v1beta/models/"]) {
    const response = await f.request(path, { method: "GET", body: undefined })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body: { data: { id: string; upstreamModelId: string }[] } = await response.json()
    expect(body.data).toHaveLength(5)
    expect(body.data.every((model) => model.id.startsWith("gwm_") && ["x", "fixture", "gpt-4o", "gemini", "claude"].includes(model.upstreamModelId))).toBe(true)
  }
  expect(await f.state()).toMatchObject({ requests: [], rows: [], upstreamReads: 0, credentialReads: 0, tokenCalls: 0 })
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown>; code: string }> = [
    ...["/files", "/files/file-other/content", "/fine_tuning/jobs", "/batches", "/threads/thread-other/runs", "/conversations", "/vector_stores", "/containers", "/organization/admin_api_keys", "/responses/resp-other", "/unknown"].flatMap((path) => ["GET", "POST", "DELETE"].map((method) => ({ path, method, code: "unsupported_gateway_operation" }))),
    ...["GET", "PUT", "PATCH", "DELETE", "OPTIONS"].map((method) => ({ path: "/responses", method, code: "unsupported_gateway_operation" })),
    ...[
      { previous_response_id: marker }, { conversation: { id: marker } },
      { input: [{ type: "item_reference", id: marker }] },
      { input: [{ role: "user", content: [{ type: "input_file", file_id: marker }] }] },
      { type: "tool_use", input: [{ role: "user", content: [{ type: "input_file", file_id: marker }] }] },
      { tools: [{ type: "file_search", vector_store_ids: [marker] }] },
      { tools: [{ type: "code_interpreter", container: marker }] },
    ].map((body) => ({ path: "/responses", method: "POST", body, code: "unsupported_gateway_resource" })),
  ]
  let count = 0
  for (const entry of requests) {
    const response = await f.request(`${entry.path}?note=${marker}`, {
      method: entry.method,
      body: entry.method === "GET" ? undefined : JSON.stringify({ model: "x", input: marker, ...entry.body }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: entry.code } })
    count++
    const state = await f.waitFor((s) => s.rows.length === count && Boolean(s.rows[count - 1]?.completed_at))
    expect(state).toMatchObject({ requests: [], upstreamReads: 0, credentialReads: 0, tokenCalls: 0 })
    expect(state.rows[count - 1]).toMatchObject({ status: 400, outcome: "rejected", error_code: entry.code })
    expect(f.output + JSON.stringify([state.rows, state.reports])).not.toContain(marker)
    expect(f.output + JSON.stringify(state.reports)).not.toContain(gatewayKey)
  }
  await using vertex = await fixture({ retryReason: "refresh_busy", provider: "google-vertex", settings: { project: "test-project", location: "us-central1" } })
  const response = await vertex.request("/models/gemini:generateContent", { body: JSON.stringify({ cachedContent: marker, contents: [] }) })
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: { code: "unsupported_gateway_resource" } })
  expect(await vertex.state()).toMatchObject({ requests: [], upstreamReads: 0, credentialReads: 0, tokenCalls: 0 })
  for (const header of ["openai-organization", "openai-project", "x-amzn-bedrock-guardrailidentifier"]) {
    await using scoped = await fixture()
    const denied = await scoped.request("/responses", { headers: { "content-type": "application/json", "api-key": gatewayKey, [header]: marker } })
    expect(denied.status).toBe(400)
    expect(await denied.json()).toMatchObject({ error: { code: "unsupported_gateway_resource" } })
    expect(await scoped.state()).toMatchObject({ requests: [], upstreamReads: 0, credentialReads: 0, tokenCalls: 0 })
  }
  await using bedrock = await fixture({ provider: "amazon-bedrock", settings: { region: "us-east-1" } })
  const guardrail = await bedrock.request("/model/claude/converse", { body: JSON.stringify({ messages: [], guardrailConfig: { guardrailIdentifier: marker, guardrailVersion: "1" } }) })
  expect(guardrail.status).toBe(400)
  expect(await guardrail.json()).toMatchObject({ error: { code: "unsupported_gateway_resource" } })
  expect(await bedrock.state()).toMatchObject({ requests: [], upstreamReads: 0, credentialReads: 0, tokenCalls: 0 })
})

test("native inline client tools retain their schemas, arguments and results without provider resource access", async () => {
  const schema = { type: "object", properties: { file_id: { type: "string" }, model: { type: "string" } } }
  for (const entry of [
    { config: {}, path: "/responses", body: { model: "x", input: [{ type: "function_call", id: "fc-local", call_id: "call-local", name: "local", arguments: '{"file_id":"client-data"}' }, { type: "function_call_output", call_id: "call-local", output: '{"model":"math-model"}' }], tools: [{ type: "function", name: "local", parameters: schema }] } },
    { config: { provider: "anthropic" }, path: "/messages", body: { model: "claude", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "tool-local", name: "local", input: { file_id: "client-data", model: "math-model" } }] }], tools: [{ name: "local", input_schema: schema }] } },
    { config: { provider: "google" }, path: "/models/gemini:generateContent", body: { contents: [{ parts: [{ functionCall: { name: "local", args: { file_id: "client-data" } } }, { functionResponse: { name: "local", response: { model: "math-model" } } }] }], tools: [{ functionDeclarations: [{ name: "local", parameters: schema }] }] } },
    { config: { provider: "amazon-bedrock", settings: { region: "us-east-1" }, mode: "inline-bedrock" }, path: "/model/claude/converse", body: { messages: [{ role: "assistant", content: [{ toolUse: { toolUseId: "tool-local", name: "local", input: { file_id: "client-data", model: "math-model" } } }] }, { role: "user", content: [{ toolResult: { toolUseId: "tool-local", content: [{ json: { file_id: "client-data" } }] } }] }], toolConfig: { tools: [{ toolSpec: { name: "local", inputSchema: { json: schema } } }] } } },
    { config: { provider: "amazon-bedrock", settings: { region: "us-east-1" }, mode: "inline-bedrock" }, path: "/model/claude/invoke", body: { anthropic_version: "bedrock-2023-05-31", messages: [{ role: "assistant", content: [{ type: "tool_use", id: "tool-local", name: "local", input: { file_id: "client-data", model: "math-model" } }] }], tools: [{ name: "local", input_schema: schema }] } },
  ]) {
    await using f = await fixture(entry.config)
    const response = await f.request(entry.path, { body: JSON.stringify(entry.body) })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0].bytes).toEqual([...new TextEncoder().encode(JSON.stringify(entry.body))])
    // Initial credential read plus post-materialization and pre-dispatch rechecks.
    expect(state).toMatchObject({ credentialReads: 3, tokenCalls: 0 })
    expect(state.rows[0].outcome).toBe("ok")
  }
})

test("JSON-labelled 204 stays bodyless with its upstream status and completed log", async () => {
  await using f = await fixture({ mode: "bodyless" })
  const response = await f.request()
  expect(response.status).toBe(204)
  expect(await response.text()).toBe("")
  const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  expect(state.rows[0]).toMatchObject({ status: 204, outcome: "ok", response_bytes: 0 })
})

test("JSON bytes arrive before EOF, with first-byte time preceding completion", async () => {
  await using f = await fixture({ mode: "json-delayed" })
  const response = await f.request("/chat/completions")
  expect(response.status).toBe(202)
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe('{"usage":')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const releasedAt = Date.now()
  await f.release()
  let remaining = ""
  while (true) { const chunk = await reader.read(); if (chunk.done) break; remaining += new TextDecoder().decode(chunk.value) }
  expect(remaining).toBe('{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}')
  const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  expect(Date.parse(state.rows[0].first_byte_at!)).toBeLessThan(releasedAt)
  expect(state.rows[0]).toMatchObject({ outcome: "ok", usage_source: "json", total_tokens: 9 })
})

test("JSON body read failures preserve headers and finalize an error row without leaking exception text", async () => {
  await using f = await fixture({ mode: "json-failure" })
  const response = await f.request("/chat/completions")
  expect(response.status).toBe(201)
  expect(response.headers.get("x-openwork-request-id")).toMatch(/^[a-f0-9]{32}$/)
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  await f.release()
  await expect(reader.read()).rejects.toThrow()
  const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  expect(state.rows[0]).toMatchObject({ status: 201, outcome: "upstream_error" })
  expect(f.output + JSON.stringify(state.reports)).not.toContain(marker)
})

test("incoming cancellation before headers stops the upstream socket and finalizes the request", async () => {
  await using f = await fixture({ mode: "headers-hang" })
  const abort = new AbortController()
  const pending = f.request("/responses", { signal: abort.signal }).catch(() => null)
  await f.waitFor((s) => s.requests.length === 1)
  abort.abort()
  expect(await pending).toBeNull()
  const state = await f.waitFor((s) => s.cancelled === 1 && Boolean(s.rows[0]?.completed_at))
  expect(state.rows[0].outcome).toBe("client_aborted")
})

test("operator upstream timeout also stops a provider that never sends headers", async () => {
  await using f = await fixture({ mode: "headers-hang" }, 1000)
  const response = await f.request()
  expect(response.status).toBe(502)
  const state = await f.waitFor((s) => s.cancelled === 1 && Boolean(s.rows[0]?.completed_at))
  expect(state.rows[0].outcome).toBe("upstream_unreachable")
})

test("error responses are not buffered for logging and response cancellation closes the provider", async () => {
  for (const route of ["gateway", "openwork"]) {
    await using f = await fixture({ mode: "error-hang" })
    const response = await (route === "gateway" ? f.request() : f.openwork())
    expect(response.status).toBe(429)
    if (route === "gateway") {
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(marker)
      await reader.cancel()
    } else {
      const text = await response.text()
      expect(text).toContain("upstream_rate_limited")
      expect(text).not.toContain(marker)
    }
    const state = await f.waitFor((s) => s.cancelled === 1 && Boolean(s.rows[0]?.completed_at))
    expect(state.rows[0].outcome).toBe(route === "gateway" ? "client_aborted" : "upstream_error")
    expect(f.output + JSON.stringify(state.reports)).not.toContain(marker)
  }
})

test("invalid UTF-8 JSON and malformed event-stream responses retain every original byte", async () => {
  await using json = await fixture({ mode: "invalid-json" })
  const response = await json.request("/chat/completions")
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 254, 0, 128]))
  expect((await json.waitFor((s) => Boolean(s.rows[0]?.completed_at))).rows[0].usage_source).toBe("missing")
  await using binary = await fixture({ provider: "amazon-bedrock", settings: { region: "us-east-1" }, mode: "malformed-eventstream" })
  const stream = await binary.request("/model/claude/converse-stream")
  expect(stream.status).toBe(200)
  expect([...new Uint8Array(await stream.arrayBuffer())]).toEqual([0, 0, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 255, 1, 2, 3, 4, 5, 6, 7])
  await binary.waitFor((s) => Boolean(s.rows[0]?.completed_at))
})

test("OpenWork rejects bodyless or broken completions and supports cancellation before headers", async () => {
  await using bodyless = await fixture({ mode: "bodyless" })
  const empty = await bodyless.openwork()
  expect(empty.status).toBe(502)
  expect(await empty.json()).toMatchObject({ error: { code: "upstream_malformed_response" } })
  await bodyless.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  await using broken = await fixture({ mode: "json-failure" })
  const pendingResponse = broken.openwork()
  await broken.waitFor((s) => s.requests.length === 1)
  await broken.release()
  const response = await pendingResponse
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ error: { code: "upstream_malformed_response" } })
  expect((await broken.waitFor((s) => Boolean(s.rows[0]?.completed_at))).rows[0].outcome).toBe("upstream_error")
  await using waiting = await fixture({ mode: "headers-hang" })
  const abort = new AbortController()
  const pending = waiting.openwork({ signal: abort.signal }).catch(() => null)
  await waiting.waitFor((s) => s.requests.length === 1)
  abort.abort()
  expect(await pending).toBeNull()
  await waiting.waitFor((s) => s.cancelled === 1 && Boolean(s.rows[0]?.completed_at))
})

test("public-only egress rejects private literals, DNS answers, host injection, unsafe bases and redirects", async () => {
  await using f = await fixture()
  const configs = [
    { allow: false },
    ...["http://169.254.169.254", "https://127.0.0.1", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://[fc00::1]", "https://[fe80::1]", "https://public.test"].map((target) => ({ target })),
    { target: "https://user:pass@public.test" }, { target: "https://public.test?key=bad" }, { target: "https://public.test#fragment" },
    { provider: "azure", settings: { resourceName: "evil.test/path?" } },
    { provider: "google-vertex", settings: { project: "test-project", location: "evil.test/path?" } },
    { provider: "google-vertex", settings: { project: "../../bad", location: "us-central1" } },
    { mode: "redirect" },
  ]
  for (const config of configs) {
    await fetch(`${f.url}/__test/config`, { method: "POST", body: JSON.stringify(config) })
    const response = await f.request()
    expect(response.status).toBe(502)
    await response.arrayBuffer()
    const state = await f.state()
    expect(state.requests.length).toBe("mode" in config ? 1 : 0)
    expect(state.requests.some((r) => r.url === "/redirect-target")).toBe(false)
    if ("target" in config && config.target === "https://public.test") expect(state.lookups).toBe(1)
  }
})

test("access logs and reporters omit query secrets, prompts and free-text transport/storage errors", async () => {
  await using f = await fixture({ mode: "fetch-failure" })
  const response = await f.request(`/responses?arbitrary=${marker}`, { headers: { "api-key": gatewayKey, "x-extra": marker, "content-type": "application/json" }, body: JSON.stringify({ model: "x", input: marker }) })
  expect(response.status).toBe(502)
  const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  expect(f.output).toContain("[gateway-http]")
  expect(f.output + JSON.stringify(state.reports)).not.toContain(marker)
  await using failedLog = await fixture({ logFailure: true })
  expect((await failedLog.request()).status).toBe(503)
  expect(failedLog.output + JSON.stringify((await failedLog.state()).reports)).not.toContain(marker)
  expect((await failedLog.state()).requests).toHaveLength(0)
})

test("OpenWork Models requires enabled metadata independently of bucket gating; org providers do not require a tier", async () => {
  for (const config of [{ enabled: false }, { enabled: true, noTier: true }, { enabled: true }]) {
    await using f = await fixture({ ...config, mode: "managed-json" })
    const response = await fetch(`${f.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer ow_inf_fixture", "content-type": "application/json" }, body: '{"model":"z-ai/glm-5.2","messages":[]}' })
    expect(response.status).toBe(config.enabled === false ? 403 : "noTier" in config ? 429 : 200)
    expect(response.headers.get("x-openwork-request-id")).toMatch(/^[a-f0-9]{32}$/)
    await response.arrayBuffer()
    expect((await f.state()).buckets).toBe(config.enabled === false ? 0 : 1)
    const orgProvider = await f.request()
    expect(orgProvider.status).toBe(200)
    await orgProvider.arrayBuffer()
  }
})

test("optional observers cannot alter ordinary inference bytes", async () => {
  await using f = await fixture({ observerFailure: true, mode: "managed-json" })
  const response = await fetch(`${f.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer ow_inf_fixture", "content-type": "application/json" }, body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: marker }] }) })
  expect(response.status).toBe(200)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: marker }, finish_reason: "stop" }] }))
  expect(new TextDecoder().decode(bytes)).toContain(marker)
  expect(f.output + JSON.stringify(state.reports)).not.toContain(marker)
})
