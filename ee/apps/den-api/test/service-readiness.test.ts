import assert from "node:assert/strict"
import { test } from "node:test"
import { createReadinessController, emailReadiness, initialReadiness, organizationReadiness, probeDeploymentServices, readinessServiceOrigin, SERVICE_READINESS_TTL_MS, type ServiceProbeDependencies } from "../src/service-readiness.js"
import { deploymentServiceReadinessSchema, organizationServiceReadinessSchema, serviceIdSchema } from "@openwork/types/den/service-readiness"
import type { EmailTransportCheck } from "@openwork/email"
import type { HeadlessServiceHealth } from "@openwork/types/den/service-health"

const token = "test-service-token-not-for-production".repeat(2)
const env = { DEN_HEADLESS_RUNNER_URL: "https://runner.example.test", DEN_HEADLESS_RUNNER_TOKEN: token, DEN_WORKBOT_URL: "https://workbot.example.test", DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "callback-not-for-production".repeat(2), GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "https://gateway.example.test" }
const runner = { version: 1, service: "headless-runner", modelConfigured: false, resumeConfigured: true, denOriginMatches: true }
const workbot = { version: 1, service: "workbot", runnerConfigured: true, denOriginMatches: true }
function json(body: unknown, status = 200) { return Response.json(body, { status }) }
function deps(overrides: Partial<ServiceProbeDependencies> = {}): ServiceProbeDependencies {
  return {
    env: {}, denOrigin: "https://den.example.test", database: async () => undefined,
    fetch: async (url, init) => {
      assert.equal(init.method, "GET")
      assert.equal(init.redirect, "manual")
      const request = new URL(url)
      if (request.hostname.startsWith("runner")) {
        assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${token}`)
        assert.equal(new Headers(init.headers).get("X-OpenWork-Den-Origin"), "https://den.example.test")
        assert.equal(request.pathname, "/v1/health")
        return json(runner)
      }
      if (request.hostname.startsWith("workbot")) { assert.equal(request.pathname, "/internal/readiness"); return json(workbot) }
      assert.ok(["/health", "/ready"].includes(request.pathname))
      return json({ ok: true, service: "gateway", ...(request.pathname === "/ready" ? { checks: { database: "ok" } } : {}) })
    }, ...overrides,
  }
}
async function service(id: string, overrides: Partial<ServiceProbeDependencies>) {
  const result = await probeDeploymentServices(deps(overrides))
  const status = [...result.services].find(([key]) => key === id)?.[1]
  assert.ok(status)
  return status
}

test("initial configuration hints distinguish absent settings from unverified health without outbound work", () => {
  const empty = initialReadiness({})
  assert.equal(empty.version, 2)
  assert.equal(empty.server, null)
  assert.deepEqual(empty.services.map((status) => status.id), ["database", "gateway", "headlessRunner", "workbot", "email"])
  assert.equal(empty.services.find((status) => status.id === "database")?.state, "unknown")
  for (const status of empty.services) if (status.id !== "database") assert.equal(status.state, "not_configured")
  assert.deepEqual(empty.services.find((status) => status.id === "headlessRunner")?.notes, ["resume_not_configured"])
  for (const status of empty.services) assert.equal(status.durationMs, null)
  const configured = initialReadiness({ ...env, SMTP_HOST: "smtp.internal", EMAIL_FROM: "den@example.test" }, "https://den.example.test")
  deploymentServiceReadinessSchema.parse(configured)
  for (const id of ["gateway", "headlessRunner", "workbot", "email"]) {
    const status = configured.services.find((entry) => entry.id === id)
    assert.equal(status?.configured, true)
    assert.equal(status?.reason, "not_checked")
    assert.equal(status?.checkedAt, null)
    assert.equal(status?.durationMs, null)
    assert.equal(status?.stale, true)
  }
  assert.deepEqual(configured.services.find((status) => status.id === "email")?.notes, ["email_smtp"])
  assert.deepEqual(configured.services.find((status) => status.id === "headlessRunner")?.notes, [], "resume needs the runner's answer before it can be ready")
  assert.ok(configured.services.every((status) => status.state !== "ready"))
  assert.ok(!JSON.stringify(configured).includes(token))
  const noOrigin = initialReadiness(env).services.find((status) => status.id === "headlessRunner")
  assert.deepEqual(noOrigin?.notes, ["resume_misconfigured"])
  assert.deepEqual(noOrigin?.missingSettings, ["DEN_API_PUBLIC_URL"])
})

test("Slack assistant and resumable answers are not services; the contract has exactly five", async () => {
  assert.deepEqual(serviceIdSchema.options, ["database", "gateway", "headlessRunner", "workbot", "email"])
  const result = await probeDeploymentServices(deps({ env }))
  assert.deepEqual([...result.services.keys()].sort(), [...serviceIdSchema.options].sort())
  const snapshot = initialReadiness(env)
  assert.equal(deploymentServiceReadinessSchema.safeParse({ ...snapshot, services: [...snapshot.services, { ...snapshot.services[0], id: "slack" }] }).success, false)
  assert.equal(deploymentServiceReadinessSchema.safeParse({ ...snapshot, version: 1 }).success, false)
})

test("no optional services configured: only an actual database SELECT dependency succeeds, no fetches", async () => {
  let queries = 0
  const result = await probeDeploymentServices(deps({ database: async () => { queries++ }, fetch: async () => { throw new Error("must not fetch") } }))
  assert.equal(queries, 1)
  assert.equal(result.services.get("database")?.reason, "database_verified")
  for (const [id, status] of result.services) if (id !== "database") assert.equal(status.state, "not_configured", id)
})

test("partial runner, workbot and durable settings are misconfigured and disclose constant setting names only", async () => {
  const source = { DEN_HEADLESS_RUNNER_URL: "https://secret.example.test", DEN_WORKBOT_URL: "https://secret.example.test" }
  const result = await probeDeploymentServices(deps({ env: source, fetch: async () => { throw new Error("not called") } }))
  assert.deepEqual(result.services.get("headlessRunner")?.missingSettings, ["DEN_HEADLESS_RUNNER_TOKEN"])
  assert.deepEqual(result.services.get("workbot")?.missingSettings, ["DEN_HEADLESS_RUNNER_TOKEN"])
  assert.ok(!JSON.stringify([...result.services]).includes("secret.example"))
})

test("service identity and actual Gateway database readiness are required; never model calls", async () => {
  const calls: string[] = []
  const base = deps({ env })
  const result = await probeDeploymentServices({ ...base, fetch: async (url, init) => { calls.push(url); return base.fetch(url, init) } })
  for (const id of ["gateway", "headlessRunner", "workbot"]) assert.equal([...result.services].find(([key]) => key === id)?.[1].reason, "health_verified")
  assert.equal(calls.length, 4)
  assert.deepEqual(result.services.get("headlessRunner")?.notes, ["resume_ready"])
  assert.equal((await service("gateway", { env, fetch: async () => json({ ok: true, service: "den-api" }) })).reason, "incompatible_service")
  assert.equal((await service("gateway", { env, fetch: async (url) => url.endsWith("/ready") ? json({ ok: true, service: "gateway", checks: { database: "error" } }) : json({ ok: true, service: "gateway" }) })).state, "unknown")
})

for (const status of [401, 403, 404, 500, 302]) test(`HTTP ${status} is fixed-classified without reflecting an error body`, async () => {
  const result = await service("headlessRunner", { env, fetch: async () => new Response("secret-token https://sensitive.test", { status, headers: { location: "http://169.254.169.254" } }) })
  assert.equal(result.reason, status === 401 || status === 403 ? "authentication_failed" : status === 404 ? "incompatible_service" : status === 500 ? "request_failed" : "unexpected_response")
  assert.ok(!JSON.stringify(result).includes("sensitive"))
})

test("wrong service, invalid JSON and non-JSON bodies are never ready", async () => {
  for (const response of [json({ ...runner, service: "workbot" }), new Response("not-json", { headers: { "content-type": "application/json" } }), new Response(JSON.stringify(runner), { headers: { "content-type": "text/html" } })]) {
    assert.notEqual((await service("headlessRunner", { env: { DEN_HEADLESS_RUNNER_URL: env.DEN_HEADLESS_RUNNER_URL, DEN_HEADLESS_RUNNER_TOKEN: token }, fetch: async () => response })).state, "ready")
  }
})

test("runner/workbot Den origin mismatch and missing runner setup are misconfigured", async () => {
  for (const id of ["headlessRunner", "workbot"]) {
    const base = deps({ env })
    const status = await service(id, { env, fetch: async (url, init) => url.includes(id === "workbot" ? "workbot" : "runner") ? json({ ...(id === "workbot" ? workbot : runner), denOriginMatches: false }) : base.fetch(url, init) })
    assert.equal(status.state, "misconfigured")
    assert.equal(status.reason, id === "workbot" ? "invalid_configuration" : "resume_misconfigured")
  }
  assert.equal((await service("workbot", { env, fetch: async (url) => json(url.includes("runner") ? runner : { ...workbot, runnerConfigured: false }) })).state, "misconfigured")
})

test("timeouts abort, including never-resolving fetches; raw errors are discarded", async () => {
  let aborted = 0
  const result = await service("headlessRunner", { env, timeoutMs: 5, fetch: async (_url, init) => new Promise(() => { init.signal?.addEventListener("abort", () => { aborted++ }) }) })
  assert.equal(result.reason, "timeout")
  assert.ok(aborted > 0)
  const thrown = await service("headlessRunner", { env, fetch: async () => { throw new Error(`Authorization: Bearer ${token} https://secret.test`) } })
  assert.equal(thrown.reason, "request_failed")
  assert.ok(!JSON.stringify(thrown).includes(token))
})

test("large streaming body is cancelled at the byte limit, not buffered unboundedly", async () => {
  let cancelled = false
  const response = () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(20_000)) }, cancel() { cancelled = true } }), { headers: { "content-type": "application/json" } })
  const result = await service("headlessRunner", { env, fetch: async () => response() })
  assert.equal(result.reason, "unexpected_response")
  assert.equal(cancelled, true)
})

for (const raw of ["https://user:password@example.test", "https://example.test?secret=x", "https://example.test#x", "https://example.test/path", "https://169.254.169.254", "https://[fe80::1]", "https://[fd00:ec2::254]", "https://[::ffff:169.254.169.254]", "http://public.example.test", "https://metadata.google.internal", "file:///health"]) test(`unsafe origin is rejected: ${raw.replace(/password|secret/g, "fixture")}`, () => assert.throws(() => readinessServiceOrigin(raw)))
for (const raw of ["https://service.example.test", "http://headless-runner:8795", "http://runner.svc.cluster.local:8795", "http://localhost:8795", "http://127.0.0.1:8795", "http://[::1]:8795"]) test(`operator origin accepted: ${raw}`, () => assert.equal(readinessServiceOrigin(raw), new URL(raw).origin))

const callback = env.DEN_HEADLESS_RUNNER_CALLBACK_TOKEN
const runnerOnly = { DEN_HEADLESS_RUNNER_URL: env.DEN_HEADLESS_RUNNER_URL, DEN_HEADLESS_RUNNER_TOKEN: token }
const resumeCases: Array<{ name: string; env: Record<string, string>; health?: Partial<HeadlessServiceHealth>; denOrigin?: string | null; state: string; reason: string; notes: string[]; missing?: string[] }> = [
  { name: "nothing set up on either side", env: runnerOnly, health: { resumeConfigured: false, denOriginMatches: null }, state: "ready", reason: "health_verified", notes: ["resume_not_configured"] },
  { name: "runner resumes but Den has no callback token", env: runnerOnly, state: "misconfigured", reason: "resume_misconfigured", notes: ["resume_misconfigured"], missing: ["DEN_HEADLESS_RUNNER_CALLBACK_TOKEN"] },
  { name: "callback token too short", env: { ...runnerOnly, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "short" }, state: "misconfigured", reason: "resume_misconfigured", notes: ["resume_misconfigured"] },
  { name: "callback token equals runner token", env: { ...runnerOnly, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: token }, state: "misconfigured", reason: "resume_misconfigured", notes: ["resume_misconfigured"] },
  { name: "no public Den origin", env: { ...runnerOnly, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: callback }, denOrigin: null, state: "misconfigured", reason: "resume_misconfigured", notes: ["resume_misconfigured"], missing: ["DEN_API_PUBLIC_URL"] },
  { name: "Den has the token but the runner does not resume", env: { ...runnerOnly, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: callback }, health: { resumeConfigured: false, denOriginMatches: null }, state: "misconfigured", reason: "resume_misconfigured", notes: ["resume_misconfigured"] },
  { name: "runner expects another Den origin", env: { ...runnerOnly, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: callback }, health: { denOriginMatches: false }, state: "misconfigured", reason: "resume_misconfigured", notes: ["resume_misconfigured"] },
  { name: "both sides match", env: { ...runnerOnly, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: callback }, state: "ready", reason: "health_verified", notes: ["resume_ready"] },
]
for (const entry of resumeCases) test(`resumable answers are a runner note, never a service: ${entry.name}`, async () => {
  const status = await service("headlessRunner", { env: entry.env, ...(entry.denOrigin === null ? { denOrigin: undefined } : {}), fetch: async () => json({ ...runner, ...entry.health }) })
  assert.equal(status.state, entry.state)
  assert.equal(status.reason, entry.reason)
  assert.deepEqual(status.notes, entry.notes)
  assert.deepEqual(status.missingSettings, entry.missing ?? [])
  assert.equal(typeof status.durationMs, "number")
})

test("an unreachable runner keeps its own failure and only configuration-derived resume notes", async () => {
  const down = await service("headlessRunner", { env: { ...runnerOnly, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: callback }, fetch: async () => { throw new Error("connection refused") } })
  assert.equal(down.state, "unreachable")
  assert.deepEqual(down.notes, [], "Den alone cannot claim resume works")
  const unset = await service("headlessRunner", { env: runnerOnly, fetch: async () => { throw new Error("connection refused") } })
  assert.deepEqual(unset.notes, ["resume_not_configured"])
  const weak = await service("headlessRunner", { env: { ...runnerOnly, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "short" }, fetch: async () => new Response(null, { status: 503 }) })
  assert.equal(weak.state, "unreachable", "a resume problem never hides the runner's own state")
  assert.deepEqual(weak.notes, ["resume_misconfigured"])
  const callbackOnly = await service("headlessRunner", { env: { DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: callback }, fetch: async () => { throw new Error("not called") } })
  assert.equal(callbackOnly.state, "misconfigured")
  assert.deepEqual(callbackOnly.missingSettings, ["DEN_HEADLESS_RUNNER_URL", "DEN_HEADLESS_RUNNER_TOKEN"])
  assert.equal(callbackOnly.durationMs, null)
})

test("a Workbot depends on a reachable runner, not on resumable answers", async () => {
  const status = await service("workbot", { env: { ...env, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "short" } })
  assert.equal(status.state, "ready")
  const runnerDown = deps({ env })
  assert.equal((await service("workbot", { env, fetch: async (url, init) => url.includes("runner") ? new Response(null, { status: 503 }) : runnerDown.fetch(url, init) })).reason, "dependency_unavailable")
})

test("email configuration matches SMTP > Resend > development sink, no transport side effects", () => {
  assert.equal(emailReadiness({}).state, "not_configured")
  assert.equal(emailReadiness({ OPENWORK_DEV_MODE: "1" }).state, "not_configured", "the development sink is not a mail transport")
  assert.equal(emailReadiness({ RESEND_API_KEY: "test", EMAIL_FROM: "test@example.test", SMTP_HOST: "smtp.internal", SMTP_PORT: "bad" }).state, "misconfigured")
  assert.equal(emailReadiness({ RESEND_API_KEY: "test" }).reason, "missing_configuration")
  assert.deepEqual(emailReadiness({ RESEND_API_KEY: "test" }).notes, ["email_resend"])
  assert.equal(emailReadiness({ SMTP_HOST: "smtp.internal", SMTP_USER: "user", EMAIL_FROM: "test@example.test" }).reason, "missing_configuration")
  assert.equal(emailReadiness({ SMTP_USER: "user" }).state, "misconfigured")
  assert.equal(emailReadiness({ RESEND_API_KEY: "test", EMAIL_FROM: "test@example.test" }).reason, "not_checked")
  assert.deepEqual(emailReadiness({ RESEND_API_KEY: "test", EMAIL_FROM: "test@example.test" }).notes, ["email_resend"])
  assert.equal(emailReadiness({ SMTP_HOST: "smtp.internal", EMAIL_FROM: "test@example.test" }).reason, "not_checked")
  assert.deepEqual(emailReadiness({ SMTP_HOST: "smtp.internal", RESEND_API_KEY: "test", EMAIL_FROM: "test@example.test" }).notes, ["email_smtp"])
})

const smtpEnv = { SMTP_HOST: "smtp.internal", SMTP_USER: "user", SMTP_PASS: "synthetic-pass", EMAIL_FROM: "Den <den@example.test>" }
const resendEnv = { RESEND_API_KEY: "re_synthetic_not_production", EMAIL_FROM: "den@example.test" }
const emailCases: Array<[Record<string, string>, EmailTransportCheck, string, string, string]> = [
  [smtpEnv, { provider: "smtp", outcome: "verified" }, "ready", "email_verified", "email_smtp"],
  [smtpEnv, { provider: "smtp", outcome: "auth_failed" }, "misconfigured", "authentication_failed", "email_smtp"],
  [smtpEnv, { provider: "smtp", outcome: "timeout" }, "unreachable", "timeout", "email_smtp"],
  [smtpEnv, { provider: "smtp", outcome: "unreachable" }, "unreachable", "request_failed", "email_smtp"],
  [resendEnv, { provider: "resend", outcome: "verified" }, "ready", "email_verified", "email_resend"],
  [resendEnv, { provider: "resend", outcome: "key_accepted" }, "ready", "email_key_verified", "email_resend"],
  [resendEnv, { provider: "resend", outcome: "sender_unverified" }, "misconfigured", "email_sender_unverified", "email_resend"],
  [resendEnv, { provider: "resend", outcome: "unexpected_response" }, "unknown", "unexpected_response", "email_resend"],
]
for (const [source, check, state, reason, note] of emailCases) test(`email live check ${check.provider}/${"outcome" in check ? check.outcome : "-"} → ${state}/${reason}`, async () => {
  let calls = 0
  const status = await service("email", { env: source, verifyEmail: async (signal) => { calls++; assert.equal(signal.aborted, false); return check } })
  assert.equal(calls, 1)
  assert.equal(status.state, state)
  assert.equal(status.reason, reason)
  assert.equal(status.configured, true)
  assert.deepEqual(status.notes, [note])
  assert.equal(typeof status.durationMs, "number")
})

test("email live check runs only for complete settings, is bounded, and keeps its provider note on failure", async () => {
  let calls = 0
  const verifyEmail = async () => { calls++; return { provider: "smtp", outcome: "verified" } satisfies EmailTransportCheck }
  for (const source of [{}, { OPENWORK_DEV_MODE: "1" }, { SMTP_HOST: "smtp.internal" }, { RESEND_API_KEY: "test" }]) {
    const status = await service("email", { env: source, verifyEmail })
    assert.notEqual(status.state, "ready")
    assert.equal(status.durationMs, null)
  }
  assert.equal(calls, 0)
  const unchecked = await service("email", { env: resendEnv })
  assert.equal(unchecked.reason, "configuration_only", "no live check wired: settings present, not verified")
  let aborted = false
  const slow = await service("email", { env: smtpEnv, emailTimeoutMs: 5, verifyEmail: (signal) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true }) }) })
  assert.equal(slow.state, "unreachable")
  assert.equal(slow.reason, "timeout")
  assert.deepEqual(slow.notes, ["email_smtp"])
  assert.equal(aborted, true)
  const thrown = await service("email", { env: smtpEnv, verifyEmail: async () => { throw new Error("535 auth failed for user synthetic-pass") } })
  assert.equal(thrown.reason, "request_failed")
  assert.ok(!JSON.stringify(thrown).includes("synthetic-pass"))
})

test("durations cover live checks only and use the injected clock", async () => {
  let time = 1_000
  const clock = () => time
  const result = await probeDeploymentServices(deps({ env: { ...env, ...resendEnv }, clock,
    database: async () => { time += 3 },
    fetch: async (url, init) => { time += 7; return deps().fetch(url, init) },
    verifyEmail: async () => { time += 11; return { provider: "resend", outcome: "verified" } },
  }))
  for (const id of serviceIdSchema.options) assert.equal(typeof result.services.get(id)?.durationMs, "number", id)
  const idle = await probeDeploymentServices(deps({ clock, fetch: async () => { throw new Error("must not fetch") } }))
  assert.equal(typeof idle.services.get("database")?.durationMs, "number")
  for (const id of ["gateway", "headlessRunner", "workbot", "email"] as const) assert.equal(idle.services.get(id)?.durationMs, null, id)
  const invalid = await service("gateway", { env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://public.example.test" }, fetch: async () => { throw new Error("must not fetch") } })
  assert.equal(invalid.reason, "invalid_configuration")
  assert.equal(invalid.durationMs, null, "configuration validation is not a live check")
})

test("a live check duration is measured from the first network call to completion", async () => {
  let time = 0
  const status = await service("gateway", { env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: env.GATEWAY_PROXY_BASE_URL }, clock: () => time, fetch: async (url) => { time += url.endsWith("/ready") ? 20 : 5; return json({ ok: true, service: "gateway", ...(url.endsWith("/ready") ? { checks: { database: "ok" } } : {}) }) } })
  assert.equal(status.durationMs, 25, "both Gateway calls count")
  const timedOut = await service("headlessRunner", { env, timeoutMs: 15, fetch: async () => new Promise(() => undefined) })
  assert.equal(timedOut.reason, "timeout")
  assert.ok((timedOut.durationMs ?? 0) >= 10)
})

test("singleflight admission, fresh failed status, stale TTL and retained lastSuccessAt; cheap projection cannot probe", async () => {
  let time = Date.parse("2026-10-19T00:00:00Z")
  let admissions = 0
  let probes = 0
  let fail = false
  let finish: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const controller = createReadinessController({ now: () => time, admit: async () => { admissions++; return null }, probe: async () => { probes++; await gate; return probeDeploymentServices(deps({ database: async () => { if (fail) throw new Error("sensitive") } })) } })
  deploymentServiceReadinessSchema.parse(controller.snapshot())
  assert.equal(controller.snapshot().checkedAt, null)
  const requests = Array.from({ length: 8 }, () => controller.refresh())
  await Promise.all(requests)
  assert.equal(controller.snapshot().checking, true)
  assert.equal(admissions, 1)
  assert.equal(probes, 1)
  finish?.()
  await controller.idle()
  const success = controller.snapshot().services[0].lastSuccessAt
  assert.ok(success)
  assert.equal(controller.snapshot().services[0].stale, false)
  time += SERVICE_READINESS_TTL_MS
  assert.equal(controller.snapshot().services[0].stale, true)
  fail = true
  await controller.refresh()
  await controller.idle()
  const failed = controller.snapshot().services[0]
  assert.equal(failed.state, "unreachable")
  assert.equal(failed.stale, false)
  assert.equal(failed.lastSuccessAt, success)
  const minimal = organizationServiceReadinessSchema.parse(organizationReadiness(controller.snapshot()))
  for (const entry of minimal.services) for (const field of ["required", "missingSettings", "notes", "durationMs"]) assert.equal(field in entry, false, field)
  assert.equal("server" in minimal, false)
  for (let i = 0; i < 100; i++) organizationReadiness(controller.snapshot())
  assert.equal(probes, 2)
})

test("global rate denial stops new probes; there is no feature switch to consult", async () => {
  let admitted = 0
  let probes = 0
  const controller = createReadinessController({ admit: async () => { admitted++; return 30 }, probe: async () => { probes++; return probeDeploymentServices(deps()) } })
  assert.equal(await controller.refresh(), 30)
  assert.equal(admitted, 1)
  assert.equal(probes, 0)
  const admittedController = createReadinessController({ admit: async () => null, probe: async () => { probes++; return probeDeploymentServices(deps()) } })
  await admittedController.refresh()
  await admittedController.idle()
  assert.equal(probes, 1)
  const snapshot = admittedController.snapshot()
  assert.equal(snapshot.services[0].state, "ready")
  assert.equal(snapshot.version, 2)
  assert.equal(snapshot.server, null, "the controller never holds per-replica server facts")
  deploymentServiceReadinessSchema.parse(snapshot)
})

test("Check now coalesces a recently completed GET refresh without admission, probes or timestamp changes", async () => {
  let time = Date.parse("2026-10-19T00:00:00Z")
  let admissions = 0
  let probes = 0
  const controller = createReadinessController({ now: () => time, admit: async () => { admissions++; return admissions === 1 ? null : 30 }, probe: async () => { probes++; return probeDeploymentServices(deps()) } })
  // The admin GET's fire-and-forget refresh finishes before the person presses Check now.
  void controller.refresh()
  await controller.idle()
  const completed = controller.snapshot()
  assert.ok(completed.checkedAt)
  time += 29_999
  assert.equal(await controller.refresh(), null)
  assert.deepEqual(controller.snapshot(), completed)
  assert.equal(admissions, 1)
  assert.equal(probes, 1)
  time++
  assert.equal(await controller.refresh(), 30, "once the coalescing window expires, the durable quota still applies")
  assert.equal(probes, 1)
  assert.deepEqual(controller.snapshot(), completed)
})

test("quota denial rechecks the shared snapshot to coalesce a different replica that just finished", async () => {
  const time = Date.parse("2026-10-19T00:00:00Z")
  const publisher = createReadinessController({ now: () => time, admit: async () => null, probe: () => probeDeploymentServices(deps()) })
  await publisher.refresh()
  await publisher.idle()
  let shared: ReturnType<typeof publisher.snapshot> | null = null
  let reads = 0
  const replica = createReadinessController({ now: () => time,
    load: async () => { reads++; return shared },
    admit: async () => { shared = publisher.snapshot(); return 30 },
    probe: async () => { assert.fail("a shared recent result must not launch another probe") },
  })
  assert.equal(await replica.refresh(), null)
  assert.equal(reads, 2)
  assert.deepEqual(replica.snapshot(), publisher.snapshot())
})

test("cached snapshot can be synchronized without ever initiating a probe", async () => {
  const saved = { ...initialReadiness(), checkedAt: "2026-10-19T00:00:00.000Z" }
  const controller = createReadinessController({ admit: async () => { throw new Error("no admission") }, load: async () => saved, probe: async () => { throw new Error("no probe") } })
  controller.syncCache()
  await controller.idle()
  assert.equal(controller.snapshot().checkedAt, saved.checkedAt)
})
