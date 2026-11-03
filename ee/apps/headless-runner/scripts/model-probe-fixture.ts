import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { loadConfig, type Config } from "../src/config.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { createRuntime } from "../src/runtime.js"
import { Store } from "../src/store.js"

export type ProbeFixtureMode = "answered" | "unauthorized" | "payment_required" | "unavailable" | "empty" | "timeout" | "free_limit" | "usage_limit" | "models_allowance" | "rate_limited"
export type ProbeFixtureProtocol = Config["model"]["protocol"]

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>, port = 0) {
  const server = createServer((request, response) => { void handler(request, response).catch(() => { response.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Local fixture did not start")
  return { url: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

/** Real Node runner/runtime/adapter, synthetic localhost provider, memory-only SQLite, no external credentials. */
export async function modelProbeFixture(options: {
  mode?: ProbeFixtureMode
  lunaAvailable?: boolean
  catalogVerified?: boolean
  protocol?: ProbeFixtureProtocol
  modelKey?: string
  reportedModel?: string
  basePath?: string
  answer?: string
  /** Serve the synthetic provider on this port, e.g. the address Den hands out as the AI Gateway. */
  providerPort?: number
  /** Also accept keys this matches, e.g. per-member Gateway keys Den mints during the test. */
  acceptKey?: (key: string) => boolean
} = {}) {
  let mode = options.mode ?? "answered"
  const modelKey = options.modelKey ?? "fixture-model-key"
  const reportedModel = options.reportedModel ?? "gpt-6-luna-fixture-snapshot"
  const calls: { path: string; body: unknown; authorized: boolean }[] = []
  // Keys the synthetic provider accepts: the runner's configured key, plus any scoped per-member key a test adds.
  const acceptedKeys = new Set([modelKey])
  const provider = await listen(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk
    const presented = options.protocol === "anthropic" ? request.headers["x-api-key"] : request.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    const authorized = typeof presented === "string" && (acceptedKeys.has(presented) || options.acceptKey?.(presented) === true)
    response.setHeader("content-type", "application/json")
    if (request.url === `${options.basePath ?? ""}/models`) {
      if (!authorized || options.catalogVerified === false) { response.writeHead(401).end(JSON.stringify({ error: "catalog_denied" })); return }
      response.end(JSON.stringify({ data: [{ id: "gateway/other", name: "Another model" }, ...(options.lunaAvailable === false ? [] : [{ id: "gateway/luna", name: "GPT-6 Luna" }])] })); return
    }
    const body: unknown = raw ? JSON.parse(raw) : null
    calls.push({ path: request.url ?? "", body, authorized })
    if (mode === "models_allowance") {
      // The gateway's answer when the organization used its OpenWork Models allowance (ee/apps/gateway/src/models-allowance.ts).
      for (const [name, value] of Object.entries({ "X-OpenWork-Error-Code": "openwork_models_allowance_reached", "X-OpenWork-Usage-State": "blocked", "X-Should-Retry": "false", "Retry-After": "4200", "X-OpenWork-Limit-Window-Type": "five_hour", "X-OpenWork-Limit-Bucket-Id": "iob_fixture" })) response.setHeader(name, value)
      response.writeHead(429).end(JSON.stringify({ error: { message: "Your workspace used its OpenWork Models allowance.", type: "usage_limit_error", param: null, code: "openwork_models_allowance_reached", source: "openwork_models" } })); return
    }
    if (mode === "free_limit" || mode === "usage_limit" || mode === "rate_limited") {
      if (mode !== "rate_limited") {
        response.setHeader("X-OpenWork-Error-Code", mode === "free_limit" ? "free_allowance_exhausted" : "openwork_gateway_usage_limit_exceeded")
        response.setHeader("X-OpenWork-Usage-State", "blocked")
      }
      // An untrusted body alone must never cause a purchase prompt.
      response.writeHead(429).end(JSON.stringify({ error: { code: "free_allowance_exhausted" } })); return
    }
    if (!authorized || mode === "unauthorized") { response.writeHead(401).end(JSON.stringify({ error: { message: "fixture-private-provider-detail fixture-model-key" } })); return }
    if (mode === "payment_required") { response.writeHead(402).end(JSON.stringify({ error: "fixture-private-billing-detail" })); return }
    if (mode === "unavailable") { response.writeHead(503).end(JSON.stringify({ error: "fixture-private-provider-detail" })); return }
    if (mode === "timeout") return
    const protocol = request.url?.endsWith("/chat/completions") ? "openai" : options.protocol;
    const text = mode === "empty" ? "" : options.answer ?? "READY. fixture-answer-must-stay-private"
    if (protocol === "openai" && typeof body === "object" && body !== null && "stream" in body && body.stream === true) {
      response.setHeader("content-type", "text/event-stream")
      response.end([{ model: reportedModel, choices: [{ delta: { content: text }, finish_reason: null }] },
        { model: reportedModel, choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n")
      return
    }
    if (protocol === "openai-responses" && typeof body === "object" && body !== null && "stream" in body && body.stream === true) {
      response.setHeader("content-type", "text/event-stream")
      const result = { model: reportedModel, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1, output_tokens: 1 } }
      response.end([{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response: result }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
      return
    }
    response.end(JSON.stringify(protocol === "anthropic"
      ? { model: reportedModel, content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } }
      : protocol === "openai-responses"
        ? { model: reportedModel, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1, output_tokens: 1 } }
        : { model: reportedModel, choices: [{ message: { role: "assistant", content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  }, options.providerPort)
  const sql = nodeSqlite(":memory:")
  try {
    const runtime = await createRuntime(loadConfig({ HEADLESS_API_TOKEN: "r".repeat(32), HEADLESS_MODEL_PROTOCOL: options.protocol ?? "openai", HEADLESS_MODEL_BASE_URL: `${provider.url}${options.basePath ?? ""}`, HEADLESS_MODEL: "gateway/other", HEADLESS_MODEL_API_KEY: modelKey }), new Store(sql))
    const runner = await listen(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value)
      const result = await runtime.app.request(`${request.url ?? "/"}`, { method: request.method, headers, ...(body ? { body } : {}) })
      response.statusCode = result.status
      result.headers.forEach((value, name) => response.setHeader(name, value))
      response.end(Buffer.from(await result.arrayBuffer()))
    })
    return {
      url: runner.url,
      /** The synthetic provider, e.g. as a scoped modelAccess base URL. */
      providerUrl: provider.url,
      /** Accept one more provider key, e.g. the per-member Gateway key a scoped modelAccess presents. */
      acceptModelKey: (key: string) => { acceptedKeys.add(key) },
      app: runtime.app,
      modelAccess: { baseUrl: `${provider.url}${options.basePath ?? ""}`, apiKey: modelKey, protocol: options.protocol ?? "openai" },
      calls: () => [...calls],
      setMode: (next: ProbeFixtureMode) => { mode = next },
      sessionCount: () => sql.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count,
      async close() { await runner.close(); await provider.close(); sql.close() },
    }
  } catch (error) { await provider.close(); sql.close(); throw error }
}
