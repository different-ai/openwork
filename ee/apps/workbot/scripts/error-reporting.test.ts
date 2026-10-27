import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import type { ErrorEvent } from "@sentry/node"
import { loadConfig } from "../src/server/config.js"
import { closeErrorReporting, initErrorReporting, observedRunnerFetch, reportError, runnerRoute, scrubEvent, type ErrorTags, type WorkbotErrorCode } from "../src/server/error-reporting.js"

const env = {
  WORKBOT_PUBLIC_URL: "https://workbot.test",
  WORKBOT_DEN_API_URL: "https://den.test",
  WORKBOT_RUNNER_URL: "https://runner.test",
  WORKBOT_RUNNER_TOKEN: "runner-token-runner-token-runner-token-01",
  WORKBOT_SESSION_SECRET: "test-secret-test-secret-test-secret-0001",
}

test("no DSN, or an empty one, sends nothing", () => {
  assert.equal(loadConfig(env).errorReporting, null)
  assert.equal(loadConfig({ ...env, WORKBOT_SENTRY_DSN: "" }).errorReporting, null)
  // Reporting before (or without) setup is a quiet no-op.
  assert.doesNotThrow(() => reportError("route_error", new Error("boom")))
})

test("a DSN turns reporting on, with the image version as the release", () => {
  const config = loadConfig({ ...env, WORKBOT_SENTRY_DSN: "https://key@o1.ingest.sentry.io/42", WORKBOT_SENTRY_ENVIRONMENT: "staging", WORKBOT_VERSION: "1.2.3" })
  assert.deepEqual(config.errorReporting, { dsn: "https://key@o1.ingest.sentry.io/42", environment: "staging", release: "workbot@1.2.3" })
  assert.equal(loadConfig({ ...env, WORKBOT_SENTRY_DSN: "https://key@o1.ingest.sentry.io/42", WORKBOT_VERSION: "dev" }).errorReporting?.release, undefined)
  assert.throws(() => loadConfig({ ...env, WORKBOT_SENTRY_DSN: "not a url" }), /WORKBOT_SENTRY_DSN/)
})

test("events lose bodies, cookies, headers, query strings, people and any message that isn't a code", () => {
  const event: ErrorEvent = {
    type: undefined,
    message: "Summarise my inbox for me please",
    request: {
      method: "POST",
      url: "https://workbot.test/auth/callback?code=secret-code&state=s",
      data: { text: "my private message" },
      cookies: { "__Host-workbot": "sealed" },
      headers: { authorization: "Bearer token-123", cookie: "__Host-workbot=sealed" },
      query_string: "code=secret-code",
    },
    user: { id: "user_1", email: "person@example.test" },
    breadcrumbs: [{ message: "fetch https://den.test/token" }],
    extra: { prompt: "hello" },
    tags: { errorCode: "den_unavailable", route: "/v1/workbot/messages" },
    exception: {
      values: [
        { type: "SyntaxError", value: `Unexpected token 'h', "hello world" is not valid JSON`, stacktrace: { frames: [{ filename: "routes.ts", context_line: "const text = body.text", vars: { text: "secret" } }] } },
        { type: "Error", value: "den_token_500" },
      ],
    },
  }
  const scrubbed = scrubEvent(event)
  const json = JSON.stringify(scrubbed)
  for (const leaked of ["secret-code", "my private message", "sealed", "token-123", "person@example.test", "hello", "Summarise", "den.test/token", "body.text"]) {
    assert.ok(!json.includes(leaked), `leaked ${leaked}`)
  }
  assert.deepEqual(scrubbed.request, { method: "POST", url: "/auth/callback" })
  assert.equal(scrubbed.exception?.values?.[0]?.value, "[redacted]")
  assert.equal(scrubbed.exception?.values?.[1]?.value, "den_token_500")
  assert.equal(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename, "routes.ts")
  assert.deepEqual(scrubbed.tags, { errorCode: "den_unavailable", route: "/v1/workbot/messages" })
  assert.equal(scrubEvent({ type: undefined }).tags?.errorCode, "unhandled")
})

test("runner calls report unreachable and 5xx, never cancellations, and keep their ids out", async () => {
  const reports: { code: WorkbotErrorCode; tags: ErrorTags }[] = []
  const report = (code: WorkbotErrorCode, _error?: unknown, tags: ErrorTags = {}) => {
    reports.push({ code, tags })
  }
  const answering = (status: number): typeof fetch => async () => new Response(null, { status })
  const failing: typeof fetch = async () => {
    throw new TypeError("fetch failed")
  }
  const url = "https://runner.test/v1/sessions/hs_abcdef123456/saved-files/fl_0123/preview/3?owner=x"
  assert.equal(runnerRoute(url), "/v1/sessions/:id/saved-files/:id/preview/:id")

  assert.equal((await observedRunnerFetch(report, answering(200))(url)).status, 200)
  assert.equal((await observedRunnerFetch(report, answering(404))(url)).status, 404)
  assert.equal((await observedRunnerFetch(report, answering(503))(url, { method: "POST" })).status, 503)
  await assert.rejects(observedRunnerFetch(report, failing)(url), /fetch failed/)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(observedRunnerFetch(report, failing)(url, { signal: cancelled.signal }))
  const timedOut = AbortSignal.timeout(0)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await assert.rejects(observedRunnerFetch(report, failing)(url, { signal: timedOut }))

  assert.deepEqual(reports, [
    { code: "runner_http_5xx", tags: { status: 503, method: "POST", route: "/v1/sessions/:id/saved-files/:id/preview/:id" } },
    { code: "runner_unreachable", tags: { method: "GET", route: "/v1/sessions/:id/saved-files/:id/preview/:id", reason: "network" } },
    { code: "runner_unreachable", tags: { method: "GET", route: "/v1/sessions/:id/saved-files/:id/preview/:id", reason: "timeout" } },
  ])
})

test("with a DSN, Sentry receives the code and tags, scrubbed", async () => {
  const received: string[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8")
    })
    request.on("end", () => {
      received.push(`${request.url ?? ""}\n${body}`)
      response.writeHead(200, { "content-type": "application/json" }).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  try {
    await initErrorReporting({ dsn: `http://publickey@127.0.0.1:${address.port}/7`, environment: "test", release: "workbot@test" })
    reportError("den_unavailable", new Error("Bearer secret-token for person@example.test"), { response: "den_unavailable" })
    await closeErrorReporting()
    const envelope = received.find((entry) => entry.startsWith("/api/7/envelope/") && entry.includes(`{"type":"event"`))
    assert.ok(!received.some((entry) => entry.includes(`{"type":"session"`)), "sent a release-health session")
    assert.ok(envelope, "no envelope arrived")
    assert.match(envelope, /"errorCode":"den_unavailable"/)
    assert.match(envelope, /"response":"den_unavailable"/)
    assert.match(envelope, /"environment":"test"/)
    assert.ok(!envelope.includes("secret-token") && !envelope.includes("person@example.test"))
  } finally {
    server.close()
  }
})
