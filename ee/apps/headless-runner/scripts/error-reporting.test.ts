import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { loadConfig } from "../src/config.js"
import { buildEnvelope, buildEvent, createErrorReporter, parseDsn, type ErrorReporter } from "../src/error-reporting.js"
import { ModelError, type ModelClient } from "../src/model.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { createRuntime } from "../src/runtime.js"
import { Store } from "../src/store.js"

const DSN = "https://publickey@o123.ingest.sentry.io/4567"
const PROMPT = "Draft a reply to Alex about the merger"

type Sent = { url: string; headers: Headers; body: string }
function capturingFetch() {
  const sent: Sent[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" })
    return new Response("{}", { status: 200 })
  }
  return { sent, fetchImpl }
}

/** The envelope's three lines: envelope header, item header, event. */
function parseEnvelope(body: string) {
  const [header, item, payload, ...rest] = body.split("\n")
  assert.equal(rest.length, 0, "one event per envelope")
  assert.ok(header && item && payload)
  return { header: JSON.parse(header), item: JSON.parse(item), event: JSON.parse(payload), payload }
}

test("DSNs parse to the project's envelope endpoint", () => {
  assert.deepEqual(parseDsn(DSN), { envelopeUrl: "https://o123.ingest.sentry.io/api/4567/envelope/", publicKey: "publickey" })
  assert.deepEqual(parseDsn("http://key@127.0.0.1:9000/sentry/12"), { envelopeUrl: "http://127.0.0.1:9000/sentry/api/12/envelope/", publicKey: "key" })
  for (const invalid of ["", "not a dsn", "https://o1.ingest.sentry.io/1", "https://key@o1.ingest.sentry.io/", "https://key@o1.ingest.sentry.io/abc", "ftp://key@host/1"]) {
    assert.equal(parseDsn(invalid), null, invalid)
  }
})

test("config: no DSN reports nothing; a DSN is validated and tags the runner version", () => {
  const base = { HEADLESS_API_TOKEN: "t".repeat(32), HEADLESS_MODEL_PROTOCOL: "anthropic", HEADLESS_MODEL_BASE_URL: "https://gateway.test", HEADLESS_MODEL: "m" }
  assert.equal(loadConfig(base).errorReporting, undefined)
  assert.equal(loadConfig({ ...base, HEADLESS_SENTRY_DSN: "" }).errorReporting, undefined)
  assert.throws(() => loadConfig({ ...base, HEADLESS_SENTRY_DSN: "https://no-key.example/1" }), /HEADLESS_SENTRY_DSN/)
  assert.deepEqual(loadConfig({ ...base, HEADLESS_SENTRY_DSN: DSN, HEADLESS_SENTRY_ENVIRONMENT: "staging", HEADLESS_RUNNER_VERSION: "0.9.1" }).errorReporting, {
    dsn: DSN,
    environment: "staging",
    release: "headless-runner@0.9.1",
    runnerVersion: "0.9.1",
  })
})

test("without a DSN the reporter is off and never calls fetch", async () => {
  const { sent, fetchImpl } = capturingFetch()
  for (const config of [undefined, { dsn: "garbage" }]) {
    const reporter = createErrorReporter(config, { fetch: fetchImpl })
    assert.equal(reporter.enabled, false)
    await reporter.report({ code: "turn_timeout" })
  }
  assert.equal(sent.length, 0)
})

test("a report is one event in one envelope, with the auth header, tags and grouping", async () => {
  const { sent, fetchImpl } = capturingFetch()
  const reporter = createErrorReporter({ dsn: DSN, environment: "production", release: "headless-runner@1.0.0", runnerVersion: "1.0.0" }, { fetch: fetchImpl, now: () => 1_700_000_000_000 })
  await reporter.report({ kind: "turn_failed", code: "model_http_429", tags: { sessionId: "hs_abc12345", messageId: "m1", turnKind: "message", steps: 2, skipped: undefined } })
  assert.equal(sent.length, 1)
  const [request] = sent
  assert.ok(request)
  assert.equal(request.url, "https://o123.ingest.sentry.io/api/4567/envelope/")
  assert.equal(request.headers.get("content-type"), "application/x-sentry-envelope")
  assert.match(request.headers.get("x-sentry-auth") ?? "", /^Sentry sentry_version=7, sentry_key=publickey, sentry_client=openwork\.headless-runner\//)
  const { header, item, event, payload } = parseEnvelope(request.body)
  assert.equal(header.event_id, event.event_id)
  assert.match(event.event_id, /^[0-9a-f]{32}$/)
  assert.equal(header.dsn, DSN)
  assert.equal(header.sent_at, "2023-11-14T22:13:20.000Z")
  assert.deepEqual(item, { type: "event", content_type: "application/json", length: new TextEncoder().encode(payload).length })
  assert.equal(event.timestamp, 1_700_000_000)
  assert.equal(event.level, "error")
  assert.equal(event.environment, "production")
  assert.equal(event.release, "headless-runner@1.0.0")
  assert.deepEqual(event.message, { formatted: "turn_failed: model_http_429" })
  assert.deepEqual(event.fingerprint, ["turn_failed", "model_http_429"])
  assert.deepEqual(event.tags, { sessionId: "hs_abc12345", messageId: "m1", turnKind: "message", steps: "2", errorCode: "model_http_429", runnerVersion: "1.0.0" })
})

test("never content: error messages that aren't codes, request data and people are left out", () => {
  const error = Object.assign(new Error(`Tool call failed for "${PROMPT}" with Bearer sk-live-secret`), { code: "ERR_SQLITE_ERROR" })
  const event = buildEvent({ code: "runner_error", error, tags: { sessionId: "hs_1", prompt: undefined } }, { dsn: DSN }, "0".repeat(32), 0)
  const body = buildEnvelope(event, DSN, new Date(0).toISOString())
  assert.ok(!body.includes(PROMPT) && !body.includes("sk-live-secret") && !body.includes("Tool call failed"))
  for (const field of ["request", "user", "breadcrumbs", "contexts"]) assert.ok(!(field in event), `has ${field}`)
  assert.deepEqual(event.exception?.values, [{ type: "Error", value: "[redacted]", mechanism: { type: "generic", handled: true } }])
  assert.equal(event.extra?.errorCode, "ERR_SQLITE_ERROR")
  assert.ok(event.extra?.stack?.every((line) => line.startsWith("at ")))
  // A plain code stays readable.
  assert.equal(buildEvent({ code: "x", error: new Error("den_run_token_500") }, { dsn: DSN }, "0".repeat(32), 0).exception?.values[0]?.value, "den_run_token_500")
})

test("never throws: a failing or hanging fetch is dropped", async () => {
  const failing = createErrorReporter({ dsn: DSN }, { fetch: async () => { throw new TypeError("fetch failed") } })
  await assert.doesNotReject(failing.report({ code: "turn_timeout" }))
  const hanging = createErrorReporter({ dsn: DSN }, {
    timeoutMs: 20,
    fetch: (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
  })
  const started = Date.now()
  await assert.doesNotReject(hanging.report({ code: "turn_timeout" }))
  assert.ok(Date.now() - started < 1_000)
  const rejected = createErrorReporter({ dsn: DSN }, { fetch: async () => new Response("no", { status: 429 }) })
  await assert.doesNotReject(rejected.report({ code: "turn_timeout" }))
})

test("a turn that fails is reported with its code and ids, never its prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-errors-"))
  try {
    const store = new Store(nodeSqlite(join(directory, "runner.sqlite")))
    const reports: Parameters<ErrorReporter["report"]>[0][] = []
    const errors: ErrorReporter = { enabled: true, report: async (report) => { reports.push(report) } }
    const model: ModelClient = {
      async complete() {
        throw new ModelError("model_http_500", `upstream echoed: ${PROMPT}`, false)
      },
    }
    const limits = { maxConcurrentTurns: 2, maxSteps: 5, turnTimeoutMs: Number.POSITIVE_INFINITY, credentialRefreshMs: Number.POSITIVE_INFINITY, contextCharBudget: 100_000 }
    const runner = new Runner({ store, model, defaultModel: "m", defaultModelApiKey: "k", limits, errors })
    const session = store.createSession({ owner: "test" })
    runner.send({ sessionId: session.id, messageId: "msg_1", prompt: PROMPT, credentials: {} })
    await runner.idle()
    assert.equal(store.getTurn(session.id, "msg_1")?.status, "failed")
    assert.equal(reports.length, 1)
    const [report] = reports
    assert.ok(report)
    assert.equal(report.kind, "turn_failed")
    assert.equal(report.code, "model_http_500")
    assert.deepEqual(report.tags, { sessionId: session.id, messageId: "msg_1", turnKind: "message", steps: 0, toolCalls: 0 })
    const event = buildEvent(report, { dsn: DSN }, "0".repeat(32), 0)
    assert.ok(!JSON.stringify(event).includes(PROMPT))
    store.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a request that fails answers internal_error and is reported by route, never its body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "headless-errors-"))
  const realFetch = globalThis.fetch
  const { sent, fetchImpl } = capturingFetch()
  globalThis.fetch = fetchImpl
  try {
    const token = "t".repeat(32)
    const config = loadConfig({
      HEADLESS_API_TOKEN: token,
      HEADLESS_MODEL_PROTOCOL: "anthropic",
      HEADLESS_MODEL_BASE_URL: "https://gateway.test",
      HEADLESS_MODEL: "m",
      HEADLESS_DB_PATH: join(directory, "runner.sqlite"),
      HEADLESS_SENTRY_DSN: DSN,
    })
    const store = new Store(nodeSqlite(config.dbPath))
    const { app } = await createRuntime(config, store)
    // A closed database makes every read throw.
    store.close()
    const response = await app.request("/v1/sessions?owner=someone", { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { error: "internal_error" })
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2))
    assert.equal(sent.length, 1)
    const { event } = parseEnvelope(sent[0]?.body ?? "")
    assert.equal(event.tags.errorCode, "request_failed")
    assert.equal(event.tags.route, "/v1/sessions")
    assert.equal(event.tags.method, "GET")
    assert.ok(!JSON.stringify(event).includes("someone") && !JSON.stringify(event).includes(token))
  } finally {
    globalThis.fetch = realFetch
    rmSync(directory, { recursive: true, force: true })
  }
})
