import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { orgDiagnosticsSchema, type OrgDiagnostics } from "@openwork/types/den/diagnostics"
import { bootDen, field, summary, text, type Call, type Session } from "./harness.js"

const email = "setup-diagnostics-operator@example.test"
const code = "diagnostics-one-time-setup-code-not-production"
const den = await bootDen({ env: {
  DEN_DEPLOYMENT: "self_hosted", DEN_BOOTSTRAP_ADMIN_EMAILS: "",
  DEN_SINGLE_ORG_OWNER_EMAILS: email, DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: code,
  // Email half set up (a user, no host): installation diagnostics report it misconfigured without any network.
  SMTP_USER: "synthetic-diagnostics-mail-user",
} })
after(() => den.close())

function diagnostics(call: Call, expected = 200): OrgDiagnostics {
  assert.equal(call.status, expected, summary(call))
  assert.equal(call.headers.get("cache-control"), "no-store")
  return orgDiagnosticsSchema.parse(call.body)
}

async function read(person: Session, orgId: string, path = "/v1/org/diagnostics", headers?: Record<string, string>) {
  return den.as(person, orgId)("GET", path, undefined, headers)
}

async function settled(person: Session, orgId: string): Promise<OrgDiagnostics> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const body = diagnostics(await read(person, orgId))
    if (!body.checking) return body
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail("diagnostics checks did not finish")
}

async function setupOperator(): Promise<Session> {
  assert.equal(field((await den.request(null, "GET", "/v1/auth/bootstrap/status")).body, "status"), "available")
  const verified = await den.request(null, "POST", "/v1/auth/bootstrap/verify", { body: { email, code } })
  assert.equal(verified.status, 200, summary(verified))
  const signedUp = await den.request(null, "POST", "/api/auth/sign-up/email", { body: {
    email, name: "Setup Diagnostics Operator", password: den.password, bootstrapGrant: text(field(verified.body, "grant"), "bootstrap grant"),
  } })
  assert.equal(signedUp.status, 200, summary(signedUp))
  const signedIn = await den.signIn(email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  return { email, name: "Setup Diagnostics Operator", token: text(field(signedIn.body, "token"), "session token"), cookie: signedIn.headers.get("set-cookie")?.split(";")[0] ?? "", userId: text(field(signedIn.body, "user", "id"), "user id") }
}

async function refreshSession(person: Session) {
  const refreshed = await den.signIn(person.email)
  assert.equal(refreshed.status, 200, summary(refreshed))
  person.token = text(field(refreshed.body, "token"), "refreshed token")
  person.cookie = refreshed.headers.get("set-cookie")?.split(";")[0] ?? ""
}

const operator = await setupOperator()
const { orgId, owner } = await den.createOrg(operator, "Local diagnostics org")
const member = await den.newMember(owner, orgId, "Diagnostics Member")
const admin = await den.newMember(owner, orgId, "Diagnostics Org Admin", "admin")
const successor = await den.newMember(owner, orgId, "Diagnostics Future Owner", "admin")

test("real MySQL: access matrix — sections by permission, installation only for the setup-created local operator", async () => {
  assert.equal((await den.request(null, "GET", "/v1/org/diagnostics", { orgId })).status, 401)
  assert.equal((await den.request(null, "POST", "/v1/org/diagnostics/check", { orgId })).status, 401)

  const mine = diagnostics(await read(owner, orgId))
  assert.equal(mine.deployment, "self_hosted")
  assert.equal(mine.installation.access, "operator", "setup persisted operator authority without environment allowlist seeding")
  assert.equal(mine.desktop.access, "granted")
  assert.equal(mine.providers.access, "granted")
  assert.equal(mine.connectors.access, "granted")
  assert.deepEqual(mine.network, { access: "granted", canRun: true })
  if (mine.installation.access === "operator") {
    assert.ok(mine.installation.server.version)
    assert.equal(mine.installation.services.services.find((service) => service.id === "email")?.state, "misconfigured")
    assert.ok(!JSON.stringify(mine.installation).includes("synthetic-diagnostics-mail-user"), "setting values never leave Den")
  }
  assert.ok(mine.attention.some((item) => item.code === "service_misconfigured" && item.subject === "Email" && item.severity === "error"))

  const plain = diagnostics(await read(member, orgId))
  assert.deepEqual(plain.desktop, { access: "locked", permission: "desktop_policies.view" })
  // This deployment has no AI Gateway, so providers fall back to the legacy provider permission.
  assert.deepEqual(plain.providers, { access: "locked", permission: "llm_providers.view" })
  assert.deepEqual(plain.connectors, { access: "locked", permission: "connections.view" })
  assert.deepEqual(plain.network, { access: "locked", permission: "egress_diagnostics.view" })
  assert.deepEqual(plain.installation, { access: "locked", reason: "installation_admin_required" })
  assert.deepEqual(plain.attention, [], "nothing from locked sections leaks into the summary")

  for (const person of [admin, successor]) {
    const theirs = diagnostics(await read(person, orgId))
    assert.equal(theirs.desktop.access, "granted", "organization admins see organization sections")
    assert.equal(theirs.providers.access, "granted")
    assert.deepEqual(theirs.network, { access: "granted", canRun: false }, "running network diagnostics is owner-only")
    assert.deepEqual(theirs.installation, { access: "locked", reason: "installation_admin_required" }, `${person.name}: an org admin is not an installation administrator`)
    assert.ok(!theirs.attention.some((item) => item.section === "installation"))
    const spoofed = diagnostics(await read(person, orgId, "/v1/org/diagnostics", { "x-den-deployment": "self_hosted", "x-openwork-deployment": "self_hosted", "x-openwork-platform-admin": "true", "x-can-manage-deployment-services": "true" }))
    assert.equal(spoofed.installation.access, "locked", "headers never grant installation authority")
    assert.equal((await den.request(person.token, "GET", "/v1/admin/services")).status, 403, "adminRoute was not widened")
  }

  // ?strict=1 is for post-deploy smoke tests: 503 only when the caller can see an error.
  diagnostics(await read(owner, orgId, "/v1/org/diagnostics?strict=1"), 503)
  diagnostics(await read(member, orgId, "/v1/org/diagnostics?strict=1"), 200)
  diagnostics(await read(owner, orgId, "/v1/org/diagnostics?strict=0"), 200)
  assert.equal((await read(owner, orgId, "/v1/org/diagnostics?strict=maybe")).status, 400)

  // The operator's own API key acts for the operator; another owner's key does not.
  const issued = await den.as(owner, orgId)("POST", "/v1/api-keys", { name: "Operator smoke test" })
  assert.equal(issued.status, 201, summary(issued))
  const key = text(field(issued.body, "key"), "API key")
  const viaKey = diagnostics(await den.request(null, "GET", "/v1/org/diagnostics", { orgId, headers: { "x-api-key": key } }))
  assert.equal(viaKey.installation.access, "operator", "an operator's API key opens installation diagnostics for smoke tests")
  diagnostics(await den.request(null, "GET", "/v1/org/diagnostics?strict=1", { orgId, headers: { "x-api-key": key } }), 503)

  const foreign = await den.createOrg(await den.signUp("Foreign Diagnostics Owner"), "Foreign diagnostics org")
  const foreignKey = await den.as(foreign.owner, foreign.orgId)("POST", "/v1/api-keys", { name: "Foreign smoke test" })
  assert.equal(foreignKey.status, 201, summary(foreignKey))
  const foreignView = diagnostics(await den.request(null, "GET", "/v1/org/diagnostics", { orgId: foreign.orgId, headers: { "x-api-key": text(field(foreignKey.body, "key"), "API key") } }))
  assert.deepEqual(foreignView.installation, { access: "locked", reason: "installation_admin_required" }, "an organization owner's key is not installation authority")
  assert.equal(foreignView.desktop.access, "granted")
  assert.equal((await read(operator, foreign.orgId)).status, 404, "never another organization's diagnostics")
})

test("real MySQL: POST check starts what the caller may run and answers 429 only when everything was rate limited", async () => {
  const started = await den.as(owner, orgId)("POST", "/v1/org/diagnostics/check")
  assert.equal(started.status, 202, summary(started))
  orgDiagnosticsSchema.parse(started.body)
  await settled(owner, orgId)
  const limited = await den.as(admin, orgId)("POST", "/v1/org/diagnostics/check")
  assert.equal(limited.status, 429, `the organization's provider check ran moments ago: ${summary(limited)}`)
  assert.ok(Number(limited.headers.get("retry-after")) > 0)
  assert.equal(orgDiagnosticsSchema.parse(limited.body).installation.access, "locked")
  const nothing = await den.as(member, orgId)("POST", "/v1/org/diagnostics/check", { sections: ["installation"], canManageDeploymentServices: true })
  assert.equal(nothing.status, 202, "a member with no sections has nothing to check")
  assert.equal(orgDiagnosticsSchema.parse(nothing.body).installation.access, "locked", "a forged body never authorizes a check")
})

function report(input: Partial<Record<string, unknown>> = {}) {
  return {
    attemptId: randomUUID(), appVersion: "0.20.1", platform: "darwin", observedAt: new Date().toISOString(), success: true,
    steps: { window: 300, engine: 1_300, signed_in: 1_800, org_tools: 2_400 }, failedStep: null, reason: null, ...input,
  }
}

test("real MySQL: desktop startup reports are stored once per launch and aggregated for desktop policy viewers", async () => {
  const send = (person: Session, body: unknown) => den.as(person, orgId)("POST", "/v1/diagnostics/desktop-startup", body)
  const repeated = report({ success: false, failedStep: "signed_in", reason: "certificate", steps: { window: 300, engine: 1_300, signed_in: null, org_tools: null } })
  for (const body of [report(), repeated, repeated, report({ attemptId: repeated.attemptId, success: true, failedStep: null, reason: null })]) {
    const sent = await send(member, body)
    assert.equal(sent.status, 204, summary(sent))
  }
  assert.equal((await send(admin, report({ appVersion: "0.21.0", steps: { window: 200, engine: 900, signed_in: 1_000, org_tools: 1_200 } }))).status, 204)
  // Too old, too far ahead: accepted and ignored so the app never retries.
  assert.equal((await send(member, report({ observedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }))).status, 204)
  assert.equal((await send(member, report({ observedAt: new Date(Date.now() + 3_600_000).toISOString() }))).status, 204)
  for (const invalid of [
    report({ reason: "ECONNREFUSED 10.0.0.5:443", success: false, failedStep: "engine" }),
    report({ hostname: "laptop.example" }),
    report({ success: false }),
    { attemptId: "not-a-uuid" },
  ]) {
    const rejected = await send(member, invalid)
    assert.equal(rejected.status, 400, summary(rejected))
  }
  assert.equal((await den.request(null, "POST", "/v1/diagnostics/desktop-startup", { orgId, body: report() })).status, 401)

  const view = diagnostics(await read(admin, orgId))
  assert.equal(view.desktop.access, "granted")
  if (view.desktop.access !== "granted") return
  assert.equal(view.desktop.startups, 3, "one row per launch; ignored reports are not counted")
  assert.equal(view.desktop.connected, 2)
  assert.equal(view.desktop.failed, 1)
  assert.equal(view.desktop.people, 2)
  assert.equal(view.desktop.typicalMs, 1_200)
  assert.equal(view.desktop.slowestMs, 2_400)
  assert.deepEqual(view.desktop.failures.map((failure) => [failure.step, failure.reason, failure.count, failure.people]), [["signed_in", "certificate", 1, 1]])
  assert.deepEqual(view.desktop.versions, [{ version: "0.20.1", startups: 2 }, { version: "0.21.0", startups: 1 }])
  const warning = view.attention.find((item) => item.code === "desktop_startup_failures")
  assert.deepEqual([warning?.severity, warning?.count, warning?.detail, warning?.targetId], ["warning", 1, "certificate", "signed_in"])
  assert.ok(!JSON.stringify(view.desktop).includes(member.email), "no member identity in the desktop section")
  assert.equal(diagnostics(await read(member, orgId)).desktop.access, "locked", "a member can report but not read")
})

test("real MySQL: ownership changes and removal never move installation authority", async () => {
  const transferred = await den.as(owner, orgId)("POST", `/v1/members/${successor.memberId}/transfer-ownership`)
  assert.equal(transferred.status, 200, summary(transferred))
  // Ownership changes revoke affected sessions; prove access with fresh genuine sessions.
  for (const person of [owner, operator, successor]) await refreshSession(person)
  assert.equal(diagnostics(await read(successor, orgId)).installation.access, "locked", "transferred ownership is not installation authority")
  assert.equal(diagnostics(await read(owner, orgId)).installation.access, "operator", "operator authority is independent of former ownership")
  const removed = await den.as(successor, orgId)("DELETE", `/v1/members/${owner.memberId}`)
  assert.equal(removed.status, 204, summary(removed))
  await refreshSession(operator)
  assert.equal((await read(operator, orgId)).status, 404, "a removed member has no organization diagnostics")
  assert.equal((await den.as(operator, orgId)("POST", "/v1/org/diagnostics/check")).status, 404)
})
