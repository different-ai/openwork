import { after, afterEach, before, beforeEach, test } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import * as Sentry from "@sentry/node"
import { Hono } from "hono"
import { requestId } from "hono/request-id"
import { createAppLogger } from "../src/observability/logger.js"
import { sanitizeSentryEvent, sanitizeSentryLog } from "../src/observability/runtime.js"
import {
  createScimDiagnosticsMiddleware,
  currentScimDiagnosticFields,
  readScimDebugOrgIds,
  sampleScimDiagnosticTrace,
  sanitizeScimDiagnosticEvent,
  sanitizeScimDiagnosticLog,
  SCIM_DIAGNOSTIC_MESSAGE,
  SCIM_DIAGNOSTIC_OP,
  timeScimDiagnosticStage,
} from "../src/observability/scim-diagnostics.js"
import { hashScimToken, resolveStoredScimProvider } from "../src/scim-token-storage.js"

// Real Node SDK/OTel context and in-memory transport, not mocked span functions.
// Run this file in its own Node test process so SDK initialization stays isolated.
const orgId = `org_${randomUUID().replaceAll("-", "")}`
const otherOrgId = `org_${randomUUID().replaceAll("-", "")}`
const apiRequestId = `req_${"0".repeat(26)}`
const rawToken = randomUUID()
const otherRawToken = randomUUID()
const providerId = "synthetic-provider"
const bearer = (raw = rawToken, organization = orgId, provider = providerId) =>
  Buffer.from(`${raw}:${provider}:${organization}`).toString("base64url")
const providerRows = [
  { organizationId: orgId, providerId, scimToken: hashScimToken(rawToken) },
  { organizationId: otherOrgId, providerId, scimToken: hashScimToken(otherRawToken) },
]
const originalIds = process.env.SENTRY_DEBUG_ORG_IDS
const originalExpiry = process.env.SENTRY_DEBUG_ORGS_EXPIRES_AT
const events: Sentry.Event[] = []
const envelopes: string[] = []
const stdout: string[] = []
const providerLogs: string[] = []
const logger = createAppLogger({
  write: (line) => stdout.push(line),
  getTraceContext: () => undefined,
  emitProviderLog: (level, message, fields) => {
    // Match the production default sink threshold without raising info globally.
    if (level !== "warn" && level !== "error") return
    providerLogs.push(JSON.stringify({ level, message, fields }))
    Sentry.logger.warn(message, fields)
  },
})

before(() => {
  Sentry.init({
    dsn: "https://public@sentry.example.test/1",
    defaultIntegrations: false,
    registerEsmLoaderHooks: false,
    tracesSampler: (context) => sampleScimDiagnosticTrace(context, 0),
    enableLogs: true,
    sendDefaultPii: false,
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: (event, hint) => {
      const safe = sanitizeScimDiagnosticEvent(sanitizeSentryEvent(event))
      if (event.contexts?.trace?.op === SCIM_DIAGNOSTIC_OP) hint.attachments = []
      if (safe) events.push(structuredClone(safe))
      return safe
    },
    beforeSendLog: (log) => sanitizeScimDiagnosticLog(sanitizeSentryLog(log),
      [Sentry.getGlobalScope(), Sentry.getIsolationScope(), Sentry.getCurrentScope()]
        .some((scope) => Object.keys(scope.getScopeData().attributes ?? {}).length > 0)),
    transport: () => ({
      send: async (envelope) => { envelopes.push(JSON.stringify(envelope)); return { statusCode: 200 } },
      flush: async () => true,
    }),
  })
})

beforeEach(() => {
  process.env.SENTRY_DEBUG_ORG_IDS = orgId
  process.env.SENTRY_DEBUG_ORGS_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString()
  events.length = 0
  envelopes.length = 0
  stdout.length = 0
  providerLogs.length = 0
})

afterEach(async () => {
  await Sentry.flush(2_000)
  assert.equal(currentScimDiagnosticFields(), undefined)
})

after(async () => {
  await Sentry.close(2_000)
  if (originalIds === undefined) delete process.env.SENTRY_DEBUG_ORG_IDS
  else process.env.SENTRY_DEBUG_ORG_IDS = originalIds
  if (originalExpiry === undefined) delete process.env.SENTRY_DEBUG_ORGS_EXPIRES_AT
  else process.env.SENTRY_DEBUG_ORGS_EXPIRES_AT = originalExpiry
})

function createApp(handler: (request: Request) => Response | Promise<Response>, lookupFails = false) {
  const app = new Hono<{ Variables: { requestId: string } }>()
  let probes = 0
  let calls = 0
  app.use("*", requestId({ headerName: "", generator: () => apiRequestId }))
  app.use("/api/auth/scim/v2/*", createScimDiagnosticsMiddleware({
    logger,
    resolveProvider: async (token) => {
      probes++
      if (lookupFails) throw new Error("private database error")
      return resolveStoredScimProvider(token, async (provider, organization) =>
        providerRows.find((row) => row.providerId === provider && row.organizationId === organization) ?? null)
    },
  }))
  // Same dispatch shape as production: mutations registered before the generic
  // Better Auth fallback, which owns Users GET. Middleware must call each once.
  app.post("/api/auth/scim/v2/Users", async (c) => { calls++; return handler(c.req.raw) })
  app.all("/api/auth/*", async (c) => { calls++; return handler(c.req.raw) })
  return { app, probes: () => probes, calls: () => calls }
}

function request(path = "Users", method = "GET", token = bearer(), headers: Record<string, string> = {}) {
  return new Request(`https://api.example.test/api/auth/scim/v2/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(method === "POST" ? { body: JSON.stringify({ userName: "private@example.test" }) } : {}),
  })
}

test("allowlist and expiry fail closed, including malformed calendar/time and one bad entry", () => {
  const now = Date.parse("2030-01-01T00:00:00Z")
  const env = { SENTRY_DEBUG_ORG_IDS: ` ${orgId}, ${otherOrgId} `, SENTRY_DEBUG_ORGS_EXPIRES_AT: "2030-01-01T00:00:01Z" }
  assert.deepEqual(readScimDebugOrgIds(env, now), [orgId, otherOrgId])
  assert.deepEqual(readScimDebugOrgIds({ ...env, SENTRY_DEBUG_ORGS_EXPIRES_AT: "2030-01-01T01:00:01+01:00" }, now), [orgId, otherOrgId])
  for (const expiry of [undefined, "", "tomorrow", "2030-01-01", "2030-01-01T00:01Z", "2030-01-01T00:00:01", "2030-02-30T00:00:00Z", "2030-01-01T25:00:00Z", "2030-01-01T00:00:00Z", "2029-12-31T23:59:59Z", " 2030-01-01T00:00:01Z", "2030-01-01T00:00:01+99:99"]) {
    assert.deepEqual(readScimDebugOrgIds({ ...env, SENTRY_DEBUG_ORGS_EXPIRES_AT: expiry }, now), [])
  }
  for (const ids of [undefined, "", "*", `${orgId},`, `${orgId},person@example.test`, `${orgId},two words`, "a".repeat(129), Array(101).fill(orgId).join(",")]) {
    assert.deepEqual(readScimDebugOrgIds({ ...env, SENTRY_DEBUG_ORG_IDS: ids }, now), [])
  }
  assert.deepEqual(readScimDebugOrgIds(env, now + 1_000), [])
})

test("ordinary sampler preserves parent decisions before the configured baseline", () => {
  assert.equal(sampleScimDiagnosticTrace({}, 0.01), 0.01)
  assert.equal(sampleScimDiagnosticTrace({}, 0.42), 0.42)
  assert.equal(sampleScimDiagnosticTrace({ parentSampled: false }, 1), 0)
  assert.equal(sampleScimDiagnosticTrace({ parentSampled: true }, 0), 1)
  assert.equal(sampleScimDiagnosticTrace({
    attributes: { "sentry.op": SCIM_DIAGNOSTIC_OP, "organization.id": orgId },
    parentSampled: true,
  }, 0.01), 0)
})

test("installed SDK preserves old non-target sampling with inconsistent upstream DSC", async () => {
  const client = Sentry.getClient()
  assert.ok(client)
  const options = client.getOptions()
  const originalSampler = options.tracesSampler
  const originalRate = options.tracesSampleRate
  const originalBeforeSendTransaction = options.beforeSendTransaction
  const originalDebugIds = process.env.SENTRY_DEBUG_ORG_IDS
  process.env.SENTRY_DEBUG_ORG_IDS = ""
  assert.deepEqual(readScimDebugOrgIds(), [])
  try {
    // This comparison observes SDK sampling, not export. Keep ordinary events
    // out of the surrounding diagnostic-only envelope capture fixture.
    options.beforeSendTransaction = () => null
    // Exercise the installed Node SDK/OTel sampler via public APIs. Both policies
    // must honor the parent decision regardless of SDK random-value propagation.
    for (const upstream of [
      { sampled: false, rate: 1 },
      { sampled: true, rate: 0.1 },
    ]) {
      const decisions: boolean[] = []
      for (const mode of ["original", "diagnostic"]) {
        options.tracesSampleRate = 0.01
        let samplerCalls = 0
        options.tracesSampler = mode === "original" ? undefined : (context) => {
          samplerCalls++
          assert.equal(context.parentSampled, upstream.sampled)
          assert.equal(context.parentSampleRate, upstream.rate)
          return sampleScimDiagnosticTrace(context, 0.01)
        }
        const traceId = randomUUID().replaceAll("-", "")
        const decision = Sentry.withIsolationScope(() => Sentry.withScope(() => Sentry.continueTrace({
          sentryTrace: `${traceId}-${"b".repeat(16)}-${Number(upstream.sampled)}`,
          baggage: `sentry-trace_id=${traceId},sentry-public_key=public,sentry-sample_rate=${upstream.rate},sentry-sample_rand=0.5`,
        }, () => {
          return Sentry.startSpan({ name: "ordinary sampling comparison", op: "test" }, (span) => {
            assert.equal(span.spanContext().traceId, traceId)
            return span.isRecording()
          })
        })))
        decisions.push(decision)
        assert.equal(samplerCalls, mode === "original" ? 0 : 1)
        await Sentry.flush(2_000)
      }
      assert.deepEqual(decisions, [upstream.sampled, upstream.sampled])
    }
  } finally {
    try {
      await Sentry.flush(2_000)
    } finally {
      options.tracesSampler = originalSampler
      options.tracesSampleRate = originalRate
      options.beforeSendTransaction = originalBeforeSendTransaction
      if (originalDebugIds === undefined) delete process.env.SENTRY_DEBUG_ORG_IDS
      else process.env.SENTRY_DEBUG_ORG_IDS = originalDebugIds
    }
  }
})

test("final diagnostic sanitizer discards unknown SDK fields and dynamic sampling baggage", () => {
  const secret = "private@example.test"
  const event: Sentry.Event = {
    type: "transaction",
    event_id: "1".repeat(32),
    start_timestamp: 1,
    timestamp: 2,
    transaction: secret,
    message: secret,
    logentry: { message: secret, params: [secret] },
    request: { url: `https://example.test/${secret}`, headers: { authorization: secret }, data: secret, query_string: secret, cookies: { session: secret } },
    contexts: { trace: { trace_id: "2".repeat(32), span_id: "3".repeat(16), op: SCIM_DIAGNOSTIC_OP, data: { "organization.id": orgId, arbitrary: secret, better_auth_ms: 3, den_mirror_ms: secret, duration_ms: NaN } }, arbitrary: { value: secret } },
    user: { email: secret },
    tags: { arbitrary: secret },
    extra: { arbitrary: secret },
    breadcrumbs: [{ message: secret }],
    sdkProcessingMetadata: { dynamicSamplingContext: { transaction: secret } },
  }
  Object.assign(event, { future_sdk_payload: secret })
  const safe = sanitizeScimDiagnosticEvent(sanitizeSentryEvent(event))
  assert.ok(safe)
  assert.equal(JSON.stringify(safe).includes(secret), false)
  assert.deepEqual(Object.keys(safe).sort(), ["contexts", "event_id", "spans", "start_timestamp", "timestamp", "transaction", "type"])
  assert.deepEqual(safe.contexts?.trace?.data, { "organization.id": orgId, better_auth_ms: 3 })
  const ordinary: Sentry.Event = { transaction: "unchanged", extra: { value: "unchanged" } }
  assert.equal(sanitizeScimDiagnosticEvent(ordinary), ordinary)
})

test("invalid/forged bearer, non-target org, and spoofed org header never admit diagnostics", async () => {
  const upstream = Response.json({ detail: "unchanged authentication response" }, { status: 401 })
  for (const token of ["malformed", bearer("forged"), bearer(rawToken, otherOrgId), bearer(rawToken, orgId, "forged-provider"), bearer(otherRawToken, otherOrgId)]) {
    const fixture = createApp(() => {
      assert.equal(currentScimDiagnosticFields(), undefined)
      assert.equal(Sentry.getActiveSpan()?.isRecording() ?? false, false)
      return upstream
    })
    const response = await fixture.app.fetch(request("Users", "GET", token, { "x-openwork-org-id": orgId }))
    assert.equal(response, upstream)
    assert.equal(fixture.calls(), 1)
  }
  assert.equal(stdout.length, 0)
  await Sentry.flush(2_000)
  assert.equal(events.length, 0)
})

test("disabled config, missing bearer, management/noncanonical paths and probe failures fall through once", async () => {
  const response = new Response(null, { status: 204 })
  const fixture = createApp(() => response)
  delete process.env.SENTRY_DEBUG_ORGS_EXPIRES_AT
  assert.equal(await fixture.app.fetch(request()), response)
  assert.equal(fixture.probes(), 0)
  process.env.SENTRY_DEBUG_ORGS_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString()
  const noToken = request()
  noToken.headers.delete("authorization")
  await fixture.app.fetch(noToken)
  for (const path of ["Users/one/extra", "users", "Schemas", "Users/"]) await fixture.app.fetch(request(path))
  assert.equal(fixture.probes(), 0)
  const failure = createApp(() => response, true)
  assert.equal(await failure.app.fetch(request()), response)
  assert.equal(failure.calls(), 1)
  assert.equal(stdout.length, 0)
})

test("Users GET and mutations, and Groups, capture separate roots below an unsampled parent", async () => {
  const upstreamTrace = "a".repeat(32)
  const fixture = createApp(() => {
    assert.equal(Sentry.getActiveSpan()?.isRecording(), true)
    assert.notEqual(Sentry.getActiveSpan()?.spanContext().traceId, upstreamTrace)
    return new Response(null, { status: 204 })
  })
  const operations = [
    ["Users", "GET"], ["Users/id", "GET"], ["Users", "POST"],
    ["Users/id", "PUT"], ["Users/id", "PATCH"], ["Users/id", "DELETE"],
    ["Groups", "GET"], ["Groups", "POST"], ["Groups/id", "PATCH"],
  ]
  for (const [path, method] of operations) {
    await Sentry.continueTrace({ sentryTrace: `${upstreamTrace}-${"b".repeat(16)}-0` }, () =>
      Sentry.startSpan({ name: "unsampled incoming request", op: "http.server" }, async (parent) => {
        assert.equal(parent.isRecording(), false)
        await fixture.app.fetch(request(path, method))
        assert.equal(Sentry.getActiveSpan(), parent)
      }))
  }
  await Sentry.flush(2_000)
  assert.equal(fixture.calls(), operations.length)
  assert.equal(events.length, operations.length)
  assert.equal(new Set(events.map((event) => event.contexts?.trace?.trace_id)).size, operations.length)
  for (const event of events) {
    assert.equal(event.contexts?.trace?.data?.["organization.id"], orgId)
    assert.equal(event.contexts?.trace?.parent_span_id, undefined)
  }
})

test("stage timing is a pass-through outside diagnostics and preserves synchronous errors", async () => {
  const response = new Response("unchanged")
  const pending = Promise.resolve(response)
  assert.equal(timeScimDiagnosticStage("better_auth_ms", () => pending), pending)
  assert.equal(await pending, response)
  const error = new Error("unchanged exception")
  assert.throws(() => timeScimDiagnosticStage("den_mirror_ms", () => { throw error }), (thrown) => thrown === error)
  assert.equal(currentScimDiagnosticFields(), undefined)
})

test("Users stage timings survive root sanitization and reach org-filterable completion logs", async () => {
  for (const method of ["GET", "POST", "PUT", "PATCH"]) {
    const response = new Response("unchanged")
    const fixture = createApp(async () => {
      const result = await timeScimDiagnosticStage("better_auth_ms", () => Promise.resolve(response))
      if (method !== "GET") await timeScimDiagnosticStage("den_mirror_ms", async () => true)
      return result
    })
    const returned = await fixture.app.fetch(request(method === "PUT" || method === "PATCH" ? "Users/id" : "Users", method))
    assert.equal(returned, response)
    assert.equal(returned.bodyUsed, false)
    await Sentry.flush(2_000)
    const fields = events.at(-1)?.contexts?.trace?.data
    assert.equal(fields?.["organization.id"], orgId)
    assert.ok(typeof fields?.better_auth_ms === "number" && fields.better_auth_ms >= 0)
    if (method === "GET") assert.equal(fields?.den_mirror_ms, undefined)
    else assert.ok(typeof fields?.den_mirror_ms === "number" && fields.den_mirror_ms >= 0)
    assert.ok(stdout.at(-1)?.includes('"better_auth_ms":'))
    assert.ok(stdout.at(-1)?.includes(`"organization.id":${JSON.stringify(orgId)}`))
  }
})

test("rejected requests omit unexecuted mirror timing and Groups 409 remains a generic conflict", async () => {
  const response = Response.json({ scimType: "invalidValue", detail: "private conflict" }, { status: 409 })
  const fixture = createApp(() => timeScimDiagnosticStage("better_auth_ms", () => Promise.resolve(response)))
  await fixture.app.fetch(request("Users", "POST"))
  await Sentry.flush(2_000)
  assert.equal(events.at(-1)?.contexts?.trace?.data?.den_mirror_ms, undefined)
  const groups = createApp(() => response)
  assert.equal(await groups.app.fetch(request("Groups", "POST")), response)
  await Sentry.flush(2_000)
  assert.equal(events.at(-1)?.contexts?.trace?.data?.scim_outcome, "conflict")
  assert.equal(events.at(-1)?.contexts?.trace?.data?.better_auth_ms, undefined)
  assert.equal(response.bodyUsed, false)
})

test("failed mirror stage records its timing without changing the thrown error", async () => {
  const error = new Error("private mirror exception")
  const fixture = createApp(async () => {
    await assert.rejects(timeScimDiagnosticStage("den_mirror_ms", async () => { throw error }), (thrown) => thrown === error)
    assert.ok(typeof currentScimDiagnosticFields()?.den_mirror_ms === "number")
    return new Response(null, { status: 503 })
  })
  await fixture.app.fetch(request("Users/id", "PATCH"))
  await Sentry.flush(2_000)
  assert.ok(typeof events[0]?.contexts?.trace?.data?.den_mirror_ms === "number")
  assert.equal(envelopes.join("").includes(error.message), false)
})

test("concurrent target and non-target requests keep their scopes and outcomes isolated", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fixture = createApp(async (req) => {
    if (req.method === "POST") {
      await gate
      assert.equal(currentScimDiagnosticFields()?.scim_operation, "Users.create")
      return new Response(null, { status: 409 })
    }
    assert.equal(currentScimDiagnosticFields(), undefined)
    release()
    return new Response(null, { status: 200 })
  })
  const [target, other] = await Promise.all([
    fixture.app.fetch(request("Users", "POST")),
    fixture.app.fetch(request("Users", "GET", bearer(otherRawToken, otherOrgId))),
  ])
  assert.equal(target.status, 409)
  assert.equal(other.status, 200)
  await Sentry.flush(2_000)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.contexts?.trace?.data?.scim_outcome, "conflict")
  assert.equal(stdout.length, 1)
})

test("concurrent targeted organizations receive distinct diagnostic roots", async () => {
  process.env.SENTRY_DEBUG_ORG_IDS = `${orgId},${otherOrgId}`
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const fixture = createApp(async (req) => {
    if (req.method === "POST") await gate
    else release()
    return new Response(null, { status: req.method === "POST" ? 409 : 200 })
  })
  await Promise.all([
    fixture.app.fetch(request("Users", "POST")),
    fixture.app.fetch(request("Groups", "GET", bearer(otherRawToken, otherOrgId))),
  ])
  await Sentry.flush(2_000)
  assert.equal(events.length, 2)
  assert.equal(new Set(events.map((event) => event.contexts?.trace?.trace_id)).size, 2)
  assert.equal(events.find((event) => event.contexts?.trace?.data?.["organization.id"] === orgId)?.contexts?.trace?.data?.http_status_code, 409)
  assert.equal(events.find((event) => event.contexts?.trace?.data?.["organization.id"] === otherOrgId)?.contexts?.trace?.data?.http_status_code, 200)
})

test("diagnostic envelope redacts inherited payloads, SQL child spans, errors and attachments; 409 bytes are unchanged", async () => {
  const sensitive = "private@example.test raw-SQL-parameter raw-error-detail"
  const body = JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], detail: sensitive, scimType: "uniqueness", status: "409" })
  const originalResponse = new Response(body, { status: 409, headers: { "content-type": "application/scim+json", "x-preserved": "yes" } })
  const reference = randomUUID()
  const fixture = createApp(async () => {
    Sentry.setUser({ email: sensitive })
    Sentry.setContext("request", { body: sensitive, headers: sensitive, query: sensitive })
    Sentry.setExtra("arbitrary", sensitive)
    Sentry.addBreadcrumb({ message: sensitive, data: { sql: sensitive } })
    Sentry.getCurrentScope().addAttachment({ filename: sensitive, data: sensitive })
    Sentry.getActiveSpan()?.setAttribute("db.statement", sensitive)
    await Sentry.startSpan({ op: "db", name: `SELECT ${sensitive}`, attributes: { "db.query.parameters": sensitive } }, async () => {})
    Sentry.captureException(new Error(sensitive))
    logger.error(sensitive, { error: new Error(sensitive), arbitrary: sensitive })
    return originalResponse
  })
  const response = await Sentry.withIsolationScope(async (scope) => {
    scope.setUser({ email: sensitive })
    scope.setContext("request", { headers: sensitive, body: sensitive })
    scope.addBreadcrumb({ message: sensitive })
    return fixture.app.fetch(request(`Users?filter=${encodeURIComponent(sensitive)}`, "POST", bearer(), {
      "x-request-id": reference,
    }))
  })
  assert.equal(response, originalResponse)
  assert.equal(response.status, 409)
  assert.equal(response.headers.get("x-preserved"), "yes")
  assert.equal(response.bodyUsed, false)
  assert.equal(await response.text(), body)
  await Sentry.flush(2_000)
  assert.equal(events.length, 1)
  const event = events[0]
  assert.deepEqual(event?.spans, [])
  assert.equal(event?.contexts?.trace?.data?.scim_outcome, "conflict")
  assert.equal(event?.contexts?.trace?.data?.api_request_id, apiRequestId)
  assert.equal(event?.contexts?.trace?.data?.proxy_request_id, `sha256:${createHash("sha256").update(reference).digest("hex")}`)
  assert.ok(envelopes.some((envelope) => envelope.includes('"transaction"')))
  for (const output of [...envelopes, ...stdout, ...providerLogs]) {
    for (const forbidden of [sensitive, "private@example.test", "raw-SQL-parameter", rawToken, bearer(), reference, "db.statement", "db.query.parameters"]) {
      assert.equal(output.includes(forbidden), false, `unexpected diagnostic payload: ${forbidden}`)
    }
  }
  assert.ok(stdout.some((line) => line.includes(`"organization.id":${JSON.stringify(orgId)}`)))
})

test("sampling and export recheck live expiry; completion warnings do not depend on sampling", async () => {
  const fixture = createApp(() => {
    process.env.SENTRY_DEBUG_ORG_IDS = otherOrgId
    assert.equal(sampleScimDiagnosticTrace({ attributes: { "sentry.op": SCIM_DIAGNOSTIC_OP, "organization.id": orgId } }, 0.01), 0)
    process.env.SENTRY_DEBUG_ORG_IDS = orgId
    process.env.SENTRY_DEBUG_ORGS_EXPIRES_AT = "2000-01-01T00:00:00Z"
    assert.equal(sampleScimDiagnosticTrace({ attributes: { "sentry.op": SCIM_DIAGNOSTIC_OP, "organization.id": orgId } }, 0.01), 0)
    return new Response(null, { status: 204 })
  })
  await fixture.app.fetch(request())
  await Sentry.flush(2_000)
  assert.equal(events.length, 0)
  assert.equal(stdout.length, 0)

  process.env.SENTRY_DEBUG_ORGS_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString()
  const client = Sentry.getClient()
  assert.ok(client)
  const sampler = client.getOptions().tracesSampler
  client.getOptions().tracesSampler = () => 0
  try {
    const unsampled = createApp(() => new Response(null, { status: 200 }))
    await unsampled.app.fetch(request())
    assert.ok(stdout.some((line) => line.includes(SCIM_DIAGNOSTIC_MESSAGE)))
    assert.ok(providerLogs.some((line) => line.includes(SCIM_DIAGNOSTIC_MESSAGE)))
    await Sentry.flush(2_000)
    assert.equal(events.length, 0)
  } finally {
    client.getOptions().tracesSampler = sampler
  }
})

test("scope-attribute log inheritance fails closed, and unsafe proxy references are omitted", async () => {
  const fixture = createApp(() => {
    assert.equal(currentScimDiagnosticFields()?.proxy_request_id, undefined)
    Sentry.setAttribute("private@example.test", "private value")
    assert.equal(sanitizeScimDiagnosticLog({ message: "unsafe", attributes: { unexpected: "unsafe" } }, true), null)
    return new Response(null, { status: 200 })
  })
  await fixture.app.fetch(request("Users", "GET", bearer(), { "x-request-id": "person@example.test" }))
  await Sentry.flush(2_000)
  assert.equal(envelopes.join("").includes("private@example.test"), false)
  assert.equal(stdout.join("").includes("person@example.test"), false)
  assert.ok(stdout.some((line) => line.includes(SCIM_DIAGNOSTIC_MESSAGE)))
})
