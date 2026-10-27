import assert from "node:assert/strict"
import type { ServerResponse } from "node:http"
import { createServer, type AddressInfo, type Socket } from "node:net"
import { after, test } from "node:test"
import { deploymentServiceReadinessSchema, organizationServiceReadinessSchema, type DeploymentServiceReadiness } from "@openwork/types/den/service-readiness"
import { bootDen, field, startFakeHttpServer, summary, text } from "./harness.js"

const requests: string[] = []
const pending: ServerResponse[] = []
const token = "readiness-test-service-token-not-production".repeat(2)
let hold = true
const runnerHealth = { version: 1, service: "headless-runner", modelConfigured: false, resumeConfigured: true, denOriginMatches: true }
const fake = await startFakeHttpServer((request, _body, response) => {
  const path = request.url ?? ""
  requests.push(path)
  response.setHeader("content-type", "application/json")
  if (path === "/health") return void response.end(JSON.stringify({ ok: true, service: "gateway" }))
  if (path === "/ready") return void response.end(JSON.stringify({ ok: true, service: "gateway", checks: { database: "ok" } }))
  assert.equal(request.headers.authorization, `Bearer ${token}`)
  assert.equal(request.headers["x-openwork-den-origin"], "http://127.0.0.1:8790")
  if (path === "/v1/health") {
    if (hold) pending.push(response)
    else response.end(JSON.stringify(runnerHealth))
    return
  }
  assert.equal(path, "/internal/readiness")
  response.end(JSON.stringify({ version: 1, service: "workbot", runnerConfigured: true, denOriginMatches: true }))
})

// A real SMTP conversation for the live email check. It also completes any
// transactional mail Den sends, so each connection's commands are recorded.
const smtpSessions: string[][] = []
const smtpSockets = new Set<Socket>()
const smtp = createServer((socket) => {
  smtpSockets.add(socket)
  socket.on("close", () => smtpSockets.delete(socket))
  const commands: string[] = []
  smtpSessions.push(commands)
  let buffer = ""
  let data = false
  socket.write("220 fake.smtp.test ESMTP\r\n")
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    for (let index = buffer.indexOf("\r\n"); index >= 0; index = buffer.indexOf("\r\n")) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      if (data) {
        if (line === ".") { data = false; socket.write("250 2.0.0 Queued\r\n") }
        continue
      }
      const verb = line.split(" ")[0].toUpperCase()
      commands.push(verb)
      if (verb === "EHLO") socket.write("250-fake.smtp.test\r\n250 AUTH PLAIN LOGIN\r\n")
      else if (verb === "AUTH") socket.write("235 2.7.0 Authentication successful\r\n")
      else if (verb === "DATA") { data = true; socket.write("354 Go ahead\r\n") }
      else if (verb === "QUIT") { socket.write("221 Bye\r\n"); socket.end() }
      else socket.write("250 OK\r\n")
    }
  })
})
await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve))
const smtpPort = (smtp.address() as AddressInfo).port

const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted",
  DEN_HEADLESS_RUNNER_URL: fake.url, DEN_HEADLESS_RUNNER_TOKEN: token,
  DEN_WORKBOT_URL: fake.url, DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "readiness-test-callback-token".repeat(2),
  // Test the legacy configured proxy without changing Gateway deployment intent.
  GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: fake.url,
  EMAIL_FROM: "OpenWork <den@example.test>", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_USER: "synthetic-mail-user", SMTP_PASS: "synthetic-mail-pass-not-production",
} })
after(async () => {
  for (const response of pending) response.end(JSON.stringify(runnerHealth))
  await fake.close()
  for (const socket of smtpSockets) socket.destroy()
  await new Promise((resolve) => smtp.close(resolve))
  await den.close()
})

async function waitForRunner() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pending.length) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("background runner probe was not started")
}
let platformAdmin: ReturnType<typeof den.signUp> | null = null
/** The deployment's allowlisted administrator (DEN_BOOTSTRAP_ADMIN_EMAILS), signed up once. */
function admin() {
  platformAdmin ??= den.signUp("Readiness Platform Admin", process.env.DEN_BOOTSTRAP_ADMIN_EMAILS)
  return platformAdmin
}
function status(snapshot: DeploymentServiceReadiness, id: string) {
  const found = snapshot.services.find((entry) => entry.id === id)
  assert.ok(found, id)
  return found
}

test("real MySQL: always on, no flag; cheap member projection; bounded asynchronous admin checks with server facts, live SMTP sign-in and durable admission", async () => {
  const { token: adminToken } = await admin()
  const first = await den.createOrg(await den.signUp("Readiness Member"), "Readiness org one")
  const before = await den.as(first.owner, first.orgId)("GET", "/v1/org")
  assert.equal(before.status, 200, summary(before))
  const gatewayIntent = field(before.body, "deploymentCapabilities", "aiGateway")
  const initial = organizationServiceReadinessSchema.parse(field(before.body, "deploymentCapabilities", "serviceReadiness"))
  assert.equal(initial.checkedAt, null)
  assert.deepEqual(initial.services.map((entry) => entry.id), ["database", "gateway", "headlessRunner", "workbot", "email"])
  assert.equal(field(before.body, "canManageDeploymentServices"), false, "an organization owner is not an installation administrator")
  assert.equal(field(before.body, "features", "serviceReadiness"), undefined, "the retired flag is not reported")

  for (const path of ["/v1/admin/services", "/v1/admin/services/check"]) {
    const method = path.endsWith("check") ? "POST" : "GET"
    assert.equal((await den.request(null, method, path)).status, 401)
    assert.equal((await den.request(first.owner.token, method, path)).status, 403)
  }
  const minimal = await den.as(first.owner, first.orgId)("GET", "/v1/org/service-readiness")
  assert.equal(minimal.status, 200, summary(minimal))
  assert.equal(minimal.headers.get("cache-control"), "no-store")
  assert.equal(organizationServiceReadinessSchema.parse(minimal.body).checkedAt, null)
  assert.equal(requests.length, 0, "neither unauthorized nor member routes may initiate checks")
  assert.equal(smtpSessions.length, 0)
  const retired = await den.request(adminToken, "PUT", "/v1/admin/features/serviceReadiness", { body: { enabled: false } })
  assert.notEqual(retired.status, 200, "the retired flag cannot be switched")

  const queued = await den.request(adminToken, "POST", "/v1/admin/services/check")
  assert.equal(queued.status, 202, summary(queued))
  assert.equal(queued.headers.get("cache-control"), "no-store")
  const queuedBody = deploymentServiceReadinessSchema.parse(queued.body)
  assert.equal(queuedBody.checking, true, "POST returns before the held upstream response")
  assert.ok(queuedBody.server, "the answering replica reports its version and start")
  assert.ok(queuedBody.server.version.length > 0)
  assert.ok(Date.parse(queuedBody.server.startedAt) <= Date.now())
  assert.equal(queuedBody.server.startupMs, null, "this in-process Den never called listen()")
  await waitForRunner()
  const duplicate = await den.request(adminToken, "POST", "/v1/admin/services/check")
  assert.equal(duplicate.status, 202, summary(duplicate))
  const cheapGet = await den.request(adminToken, "GET", "/v1/admin/services")
  assert.equal(cheapGet.status, 200, summary(cheapGet))
  assert.equal(deploymentServiceReadinessSchema.parse(cheapGet.body).checkedAt, null)
  assert.equal(requests.filter((path) => path === "/v1/health").length, 1)

  // A second controller is a different replica's admission path, using the same real durable limiter.
  const { createReadinessController, SERVICE_READINESS_RATE_KEY, SERVICE_READINESS_RATE_WINDOW_MS } = await import("../../src/service-readiness.js")
  const { checkRateLimit } = await import("../../src/utils/rate-limit.js")
  const replica = createReadinessController({
    admit: () => checkRateLimit(SERVICE_READINESS_RATE_KEY, 1, SERVICE_READINESS_RATE_WINDOW_MS, Date.now()),
    probe: async () => { assert.fail("another replica must not start a probe inside the durable window") },
  })
  assert.ok((await replica.refresh()) !== null)

  hold = false
  for (const response of pending.splice(0)) response.end(JSON.stringify(runnerHealth))
  const { serviceReadiness } = await import("../../src/service-readiness-runtime.js")
  await serviceReadiness.idle()
  const settled = serviceReadiness.snapshot()
  assert.equal(settled.server, null, "server facts are never part of the shared snapshot")
  assert.equal(status(settled, "database").state, "ready", "real SELECT succeeded")
  assert.equal(typeof status(settled, "database").durationMs, "number")
  assert.equal(status(settled, "gateway").state, "not_configured")
  assert.equal(status(settled, "gateway").durationMs, null, "no live check, no duration")
  const runner = status(settled, "headlessRunner")
  assert.equal(runner.state, "ready")
  assert.deepEqual(runner.notes, ["resume_ready"])
  assert.equal(typeof runner.durationMs, "number")
  assert.equal(status(settled, "workbot").state, "ready")
  const email = status(settled, "email")
  assert.equal(email.state, "ready", JSON.stringify(email))
  assert.equal(email.reason, "email_verified")
  assert.deepEqual(email.notes, ["email_smtp"])
  assert.equal(typeof email.durationMs, "number")
  const verification = smtpSessions.find((commands) => commands.includes("AUTH") && !commands.includes("MAIL"))
  assert.ok(verification, `a verification signed in without sending: ${JSON.stringify(smtpSessions)}`)
  assert.deepEqual(verification, ["EHLO", "AUTH", "QUIT"])

  const freshGet = await den.request(adminToken, "GET", "/v1/admin/services")
  assert.equal(freshGet.status, 200, summary(freshGet))
  const fresh = deploymentServiceReadinessSchema.parse(freshGet.body)
  assert.deepEqual({ ...fresh, server: null }, settled)
  const completedRequestCount = requests.length
  const completedSmtpCount = smtpSessions.length
  const coalesced = await den.request(adminToken, "POST", "/v1/admin/services/check")
  assert.equal(coalesced.status, 202, summary(coalesced))
  assert.equal(coalesced.headers.get("retry-after"), null)
  assert.deepEqual(deploymentServiceReadinessSchema.parse(coalesced.body), fresh, "Check now reuses the completed result without changing success/check timestamps")
  assert.equal(requests.length, completedRequestCount, "fresh GET then Check now must not launch duplicate probes")
  assert.equal(smtpSessions.length, completedSmtpCount)
  assert.ok((await replica.refresh()) !== null, "a replica without Redis or a fresh local result still obeys the global quota")

  const memberRead = await den.as(first.owner, first.orgId)("GET", "/v1/org/service-readiness")
  const memberSnapshot = organizationServiceReadinessSchema.parse(memberRead.body)
  assert.ok(memberSnapshot.checkedAt)
  assert.equal(memberSnapshot.services.find((entry) => entry.id === "email")?.state, "ready")
  for (const entry of memberSnapshot.services) for (const key of ["missingSettings", "required", "notes", "durationMs"]) assert.equal(key in entry, false, key)
  assert.equal("server" in memberSnapshot, false)
  const freshContext = await den.as(first.owner, first.orgId)("GET", "/v1/org")
  assert.equal(freshContext.status, 200, summary(freshContext))
  assert.deepEqual(organizationServiceReadinessSchema.parse(field(freshContext.body, "deploymentCapabilities", "serviceReadiness")), memberSnapshot)
  assert.deepEqual(field(freshContext.body, "deploymentCapabilities", "aiGateway"), gatewayIntent)
  for (const secret of [token, fake.url, String(smtpPort), "synthetic-mail", "Authorization", "missingSettings", '"required"', '"notes"', "durationMs"]) {
    assert.ok(!memberRead.text.includes(secret), secret)
    assert.ok(!freshContext.text.includes(secret), `GET /v1/org must retain the safe member projection: ${secret}`)
  }
  for (const secret of [token, fake.url, "synthetic-mail-pass"]) assert.ok(!freshGet.text.includes(secret), secret)
  assert.ok(!requests.some((path) => /resume-token|catalog|models|turns|events/.test(path)))
})

test("real MySQL: installation authority follows the local allowlist for sessions and API keys their owner created", async () => {
  const adminOrg = await den.createOrg(await admin(), "Readiness operator org")
  const member = await den.createOrg(await den.signUp("Readiness Key Member"), "Readiness member org")
  const hint = async (call: Promise<{ status: number; body: unknown }>) => {
    const result = await call
    assert.equal(result.status, 200)
    return field(result.body, "canManageDeploymentServices")
  }
  const mint = async (owner: typeof member.owner, orgId: string) => {
    const issued = await den.as(owner, orgId)("POST", "/v1/api-keys", { name: "Diagnostics automation" })
    assert.equal(issued.status, 201, summary(issued))
    return text(field(issued.body, "key"), "API key")
  }
  assert.equal(await hint(den.as(adminOrg.owner, adminOrg.orgId)("GET", "/v1/org")), true, "allowlisted administrator session")
  assert.equal(await hint(den.as(member.owner, member.orgId)("GET", "/v1/org")), false, "organization owner session")
  const adminKey = await mint(adminOrg.owner, adminOrg.orgId)
  assert.equal(await hint(den.request(null, "GET", "/v1/org", { orgId: adminOrg.orgId, headers: { "x-api-key": adminKey } })), true, "an API key acts for its allowlisted owner")
  const memberKey = await mint(member.owner, member.orgId)
  assert.equal(await hint(den.request(null, "GET", "/v1/org", { orgId: member.orgId, headers: { "x-api-key": memberKey } })), false, "an owner's API key gains nothing from organization ownership")
})
