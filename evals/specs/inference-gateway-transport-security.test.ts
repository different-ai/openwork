import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

// Launch a real HTTP gateway with in-memory persistence and a local upstream.
// No product-source imports, external providers, or database prerequisites.
const root = fileURLToPath(new URL("../../", import.meta.url))
const marker = "SECRET_MARKER_DO_NOT_LOG"
const gatewayPath = "/api/v1/providers/ipr_fixture"
type FixtureState = {
  requests: { url: string; bytes: number[]; headers: Record<string, string | string[]> }[]
  rows: { completed_at?: string | null; first_byte_at?: string | null; outcome: string; status?: number | null; response_bytes?: number | null; usage_source: string; total_tokens?: number | null; error_code?: string | null; upstream_request_id?: string | null; upstream_model?: string | null }[]
  reports: unknown[]; cancelled: number; lookups: number; buckets: number; upstreamReads: number
}
async function readState(url: string): Promise<FixtureState> {
  // Wire boundary for this spec's private, local fixture (not product data).
  const state: FixtureState = await (await fetch(`${url}/__test/state`)).json()
  expect(Array.isArray(state.requests) && Array.isArray(state.rows)).toBe(true)
  return state
}

async function fixture(config: Record<string, unknown> = {}, timeoutMs = 30_000, overrides: Record<string, string> = {}) {
  // Do not inherit operator credentials/policy into an isolated witness.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GATEWAY_") && !key.startsWith("INFERENCE_")))
  const child = spawn("pnpm", ["--filter", "@openwork-ee/gateway", "exec", "tsx", "test/helpers/transport-server.ts"], {
    cwd: root,
    env: { ...inherited, OPENWORK_DEV_MODE: "1", SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off", NODE_OPTIONS: "--conditions=development", INFERENCE_UPSTREAM_TIMEOUT_MS: String(timeoutMs), ...overrides },
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
    await fetch(`${url}/__test/config`, { method: "POST", body: JSON.stringify(config), headers: { "content-type": "application/json" } })
  } catch (error) { stop(); throw error }
  return {
    url,
    async request(path = "/files", init: RequestInit = {}) {
      return fetch(`${url}${gatewayPath}${path}`, { method: "POST", headers: { "x-goog-api-key": "ow_inf_fixture" }, body: new Uint8Array([0xff, 0xfe, 0, 128]), signal: AbortSignal.timeout(10_000), ...init })
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

test("native Google/Azure keys authenticate as OpenWork keys; conflicting credentials never reach the provider", async () => {
  await using f = await fixture()
  // Native auth requests use JSON. Node 25.6's fetch re-extracts a detached
  // Uint8Array body on 401; binary round-trip/limit coverage stays separate.
  const body = '{"contents":[]}'
  for (const header of ["x-goog-api-key", "api-key", "x-api-key"]) {
    const response = await f.request("/files", { body, headers: { "content-type": "application/json", [header]: "ow_inf_fixture" } })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
  }
  const query = await f.request("/files?key=ow_inf_fixture&alt=sse", { body, headers: { "content-type": "application/json" } })
  expect(query.status).toBe(200)
  await query.arrayBuffer()
  const good = await f.state()
  expect(good.requests).toHaveLength(4)
  expect(good.requests[3].url).toBe("/v1/files?alt=sse")
  expect(good.requests.every((r) => r.headers.authorization === "Bearer UPSTREAM_ONLY_KEY")).toBe(true)
  const conflictingHeaders: Record<string, string>[] = [
    { authorization: "Bearer ow_inf_fixture", "api-key": "other" },
    { "x-goog-api-key": "ow_inf_fixture, other" },
    { authorization: "Basic bad", "x-api-key": "ow_inf_fixture" },
  ]
  for (const headers of conflictingHeaders) {
    const response = await f.request("/files", { body, headers: { "content-type": "application/json", ...headers } })
    expect(response.status).toBe(401)
    expect(response.headers.get("x-openwork-request-id")).toMatch(/^[a-f0-9]{32}$/)
    expect(await response.json()).toMatchObject({ error: { code: "ambiguous_api_key" } })
  }
  const duplicateQuery = await f.request("/files?key=ow_inf_fixture&key=other", { body, headers: { "content-type": "application/json", "x-goog-api-key": "ow_inf_fixture" } })
  expect(duplicateQuery.status).toBe(401)
  expect(await duplicateQuery.json()).toMatchObject({ error: { code: "ambiguous_api_key" } })
  expect((await f.state()).requests).toHaveLength(4)
})

test("Gateway keeps operator routes and old keys; new admin and webhook config replaces deprecated aliases", async () => {
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
    const webhook = await operatorRequest("/webhooks/openrouter", `${prefix}-webhook-fixture`, "{}")
    expect(webhook.status).toBe(200)
    expect(await webhook.json()).toEqual({ ok: true, ingested: 0, skipped: 0 })
    expect((await operatorRequest("/webhooks/openrouter", canonical ? "legacy-webhook-fixture" : "wrong", "{}")).status).toBe(401)
    const validKey = await f.request("/files", { body: "{}" })
    expect(validKey.status).toBe(200)
    await validKey.arrayBuffer()
    const invalidKey = await f.request("/files", { body: "{}", headers: { authorization: "Bearer ow_gw_fixture" } })
    expect(invalidKey.status).toBe(401)
    const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
    expect(state.rows[0]).toMatchObject({ inference_key_id: "ink_fixture", inference_provider_id: "ipr_fixture" })
    expect(state.requests).toHaveLength(1)
    expect(JSON.stringify(state.requests)).not.toContain("ow_inf_fixture")
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

test("both routes record body request IDs and semantic stream errors without changing the HTTP response", async () => {
  for (const route of ["gateway", "openwork"]) {
    await using f = await fixture({ mode: "semantic-error" })
    const response = await (route === "gateway"
      ? f.request("/chat/completions", { headers: { "api-key": "ow_inf_fixture", "content-type": "application/json" }, body: '{"model":"requested-model","stream":true}' })
      : f.openwork())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('data: {"id":"body-request-id","error":{"message":"redacted-provider-error"}}\n\n')
    const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
    expect(state.rows[0]).toMatchObject({ status: 200, outcome: "upstream_error", error_code: "upstream_stream_error", upstream_request_id: "body-request-id",
      upstream_model: route === "gateway" ? "requested-model" : "z-ai/glm-5.2" })
  }
})

test("multipart invalid UTF-8 and unknown JSON endpoints retain exact bytes; oversized uploads are rejected", async () => {
  await using f = await fixture()
  const bytes = new Uint8Array([...new TextEncoder().encode('--boundary\r\nContent-Disposition: form-data; name="file"\r\n\r\n'), 255, 254, 0, 128, ...new TextEncoder().encode('\r\n--boundary--\r\n')])
  const response = await f.request("/files", { headers: { "api-key": "ow_inf_fixture", "content-type": "multipart/form-data; boundary=boundary" }, body: bytes })
  expect(response.status).toBe(200)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  const rawJson = ' { "stream": true, "model": "untouched", "stream_options": {} } '
  const unknown = await f.request("/files/responses", { headers: { "api-key": "ow_inf_fixture", "content-type": "application/json" }, body: rawJson })
  expect(await unknown.text()).toBe(rawJson)
  const oversized = await f.request("/files", { body: new Uint8Array(32 * 1024 * 1024 + 1) })
  expect(oversized.status).toBe(413)
  expect((await f.state()).requests).toHaveLength(2)
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
  const pending = f.request("/files", { signal: abort.signal }).catch(() => null)
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
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(marker)
    await reader.cancel()
    const state = await f.waitFor((s) => s.cancelled === 1 && Boolean(s.rows[0]?.completed_at))
    expect(state.rows[0].outcome).toBe("client_aborted")
    expect(f.output + JSON.stringify(state.reports)).not.toContain(marker)
  }
})

test("invalid UTF-8 JSON and malformed event-stream responses retain every original byte", async () => {
  await using json = await fixture({ mode: "echo-json" })
  const response = await json.request("/chat/completions")
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([255, 254, 0, 128]))
  expect((await json.waitFor((s) => Boolean(s.rows[0]?.completed_at))).rows[0].usage_source).toBe("missing")
  await using binary = await fixture({ provider: "amazon-bedrock", settings: { region: "us-east-1" }, mode: "malformed-eventstream" })
  const stream = await binary.request("/model/claude/converse-stream")
  expect(stream.status).toBe(200)
  expect([...new Uint8Array(await stream.arrayBuffer())]).toEqual([0, 0, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 255, 1, 2, 3, 4, 5, 6, 7])
  await binary.waitFor((s) => Boolean(s.rows[0]?.completed_at))
})

test("OpenWork relay handles bodyless responses, broken JSON and cancellation before headers", async () => {
  await using bodyless = await fixture({ mode: "bodyless" })
  const empty = await bodyless.openwork()
  expect(empty.status).toBe(204)
  expect(await empty.text()).toBe("")
  await bodyless.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  await using broken = await fixture({ mode: "json-failure" })
  const response = await broken.openwork()
  expect(response.status).toBe(201)
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  await broken.release()
  await expect(reader.read()).rejects.toThrow()
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
  const response = await f.request(`/files?arbitrary=${marker}`, { headers: { "api-key": "ow_inf_fixture", "x-extra": marker, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ content: marker }] }) })
  expect(response.status).toBe(502)
  const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  expect(f.output).toContain("[gateway-access] request")
  expect(f.output).toContain("[gateway-access] response")
  expect(f.output + JSON.stringify(state.reports)).not.toContain(marker)
  await using failedLog = await fixture({ logFailure: true })
  expect((await failedLog.request()).status).toBe(503)
  expect(failedLog.output + JSON.stringify((await failedLog.state()).reports)).not.toContain(marker)
  expect((await failedLog.state()).requests).toHaveLength(0)
})

test("OpenWork Models requires enabled metadata independently of bucket gating; org providers do not require a tier", async () => {
  for (const config of [{ enabled: false }, { enabled: true, noTier: true }, { enabled: true }]) {
    await using f = await fixture(config)
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
  await using f = await fixture({ observerFailure: true })
  const response = await fetch(`${f.url}/api/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer ow_inf_fixture", "content-type": "application/json" }, body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: marker }] }) })
  expect(response.status).toBe(200)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const state = await f.waitFor((s) => Boolean(s.rows[0]?.completed_at))
  expect([...bytes]).toEqual(state.requests[0].bytes)
  expect(new TextDecoder().decode(bytes)).toContain(marker)
  expect(f.output + JSON.stringify(state.reports)).not.toContain(marker)
})
