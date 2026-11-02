/**
 * Sandbox Microsoft 365 (sandboxMicrosoft365): a sandbox's Outlook, Calendar and Drive come as one Microsoft 365
 * connector that signs in at the sandbox's own sample work apps, so Den's ordinary Microsoft 365 routes (the ones
 * Workbot's chat, Calendar, Documents and first hello use) read each member's own sample workspace. Every other
 * organization keeps Microsoft's endpoints, and a sandbox connector that may not be used never falls back to them.
 *
 * Runs the real workshop gateway (evals/packages/open-workplace/src/workshop.mjs) in its no-password mode: each
 * "browser" below is a cookie jar, the same isolation people get from separate browser profiles.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { bootDen, field, list, summary, text, type Session } from "./harness.js"

const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud" } })
after(() => den.close())
const { client } = await import("../../src/db.js")

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === "string") throw new Error("no port")
  return address.port
}

const workplace = `http://127.0.0.1:${await freePort()}`
let child: ReturnType<typeof spawn> | null = null
after(() => { child?.kill("SIGTERM") })
before(async () => {
  child = spawn(process.execPath, [fileURLToPath(new URL("../../../../../evals/packages/open-workplace/src/workshop.mjs", import.meta.url))], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: new URL(workplace).port, PUBLIC_URL: workplace, OPEN_WORKPLACE_JOIN_MODE: "automatic", OPEN_WORKPLACE_PARTICIPANTS: "[]" },
    stdio: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const health: unknown = await fetch(`${workplace}/health`).then((response) => response.json()).catch(() => null)
    if (field(health, "microsoftSignIn") === true) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("The sample work apps did not start")
})

const admin = await den.signUp("Platform Admin", `platform-admin+${den.stamp}@example.test`)
const rollout = (body: { enabled?: boolean; killed?: boolean }) => den.request(admin.token, "PUT", "/v1/admin/features/sandboxMicrosoft365", { body })
const create = (name: string) => den.request(admin.token, "POST", "/v1/admin/sandbox-orgs", {
  body: { name, connectorBaseUrl: workplace, days: 14, memberLimit: 5, allowedEmailDomains: [], joinRole: "member" },
})
const join = async (sandbox: unknown, name: string) => {
  const person = await den.signUp(name)
  const token = text(new URL(text(field(sandbox, "joinLink"), "join link")).searchParams.get("token"), "join token")
  const joined = await den.request(person.token, "POST", "/v1/sandbox-join", { body: { token } })
  assert.equal(joined.status, 200, summary(joined))
  return person
}

/** A browser profile: its own cookie, so its own private sample workspace. */
async function browser() {
  const entered = await fetch(`${workplace}/login?next=%2F`, { redirect: "manual", headers: { accept: "text/html" } })
  const cookie = entered.headers.get("set-cookie")?.split(";")[0] ?? ""
  assert.ok(cookie, "the workshop gives the browser its own workspace")
  return {
    cookie,
    async me() { return text(field(await (await fetch(`${workplace}/v1.0/me`, { headers: { cookie } })).json(), "mail"), "mail") },
    async addEvent(subject: string, start: Date) {
      const response = await fetch(`${workplace}/v1.0/me/events`, { method: "POST", headers: { cookie, origin: workplace, "content-type": "application/json" }, body: JSON.stringify({ subject, start: { dateTime: start.toISOString(), timeZone: "UTC" }, end: { dateTime: new Date(start.getTime() + 30 * 60_000).toISOString(), timeZone: "UTC" } }) })
      assert.equal(response.status, 201, await response.text())
    },
  }
}
type Browser = Awaited<ReturnType<typeof browser>>

/** The member presses Connect, approves on the workshop's consent page in their browser, and Den finishes the sign-in. */
async function connect(person: Session, orgId: string, connectionId: string, profile: Browser) {
  const started = await den.as(person, orgId)("GET", `/v1/oauth-providers/${connectionId}/connect/start`)
  assert.equal(started.status, 200, summary(started))
  const authorizeUrl = new URL(text(field(started.body, "authorizeUrl"), "authorize url"))
  assert.equal(authorizeUrl.origin, workplace, "the sample connector signs in at the sandbox's work apps, not Microsoft")
  const consent = await fetch(authorizeUrl, { redirect: "manual", headers: { cookie: profile.cookie, accept: "text/html" } })
  assert.equal(consent.status, 200)
  const request = (await consent.text()).match(/name="request" value="([^"]+)"/)?.[1] ?? ""
  const allowed = await fetch(`${authorizeUrl.origin}${authorizeUrl.pathname}`, { method: "POST", redirect: "manual", headers: { cookie: profile.cookie, origin: workplace, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, decision: "allow" }) })
  assert.equal(allowed.status, 303)
  const callback = new URL(allowed.headers.get("location") ?? "")
  assert.equal(callback.pathname, "/v1/oauth-providers/microsoft-365/connect/callback")
  const finished = await den.request(null, "GET", `${callback.pathname}${callback.search}`)
  assert.equal(finished.status, 200, finished.text.slice(0, 300))
}

const thisWeek = () => { const start = new Date(); start.setUTCHours(start.getUTCHours() + 2, 0, 0, 0); return start }
async function calendar(person: Session, orgId: string) {
  const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 7 * 86_400_000).toISOString()
  return den.as(person, orgId)("GET", `/v1/capabilities/microsoft-365/calendar-events?timeMin=${from}&timeMax=${to}&maxResults=100`)
}
const subjects = (call: Awaited<ReturnType<typeof calendar>>) => list(field(call.body, "events")).map((event) => String(event.subject))

test("off by default: a sandbox keeps its five separate sample connectors", async () => {
  const created = await create("Before the rollout")
  assert.equal(created.status, 200, summary(created))
  assert.equal(field(created.body, "sandbox", "connectorCount"), 5)
  assert.equal(field(created.body, "sandbox", "sampleMicrosoft365"), false)
})

test("on: each member's Microsoft 365 reads their own sample workspace through Den's ordinary routes", async () => {
  assert.equal((await rollout({ enabled: true })).status, 200)
  const created = await create("Demo sandbox")
  assert.equal(created.status, 200, summary(created))
  const sandbox = field(created.body, "sandbox")
  const orgId = text(field(sandbox, "organizationId"), "organization id")
  assert.equal(field(sandbox, "sampleMicrosoft365"), true)
  const connections = list(field((await den.as(admin, orgId)("GET", "/v1/mcp-connections")).body, "connections"))
  assert.deepEqual(connections.map((entry) => entry.name).sort(), ["Confluence", "Jira", "Microsoft 365"], "one Microsoft 365 replaces Outlook, Calendar and Drive")
  const microsoft = connections.find((entry) => entry.name === "Microsoft 365")
  assert.equal(microsoft?.nativeProviderKey, "microsoft-365")
  const connectionId = text(microsoft?.id, "connection id")

  const avery = await join(sandbox, "Avery Demo"), riley = await join(sandbox, "Riley Demo")
  const averyBrowser = await browser(), rileyBrowser = await browser()
  assert.equal(field((await calendar(avery, orgId)).body, "error"), "needs_connection", "nothing is read before the member approves")

  await connect(avery, orgId, connectionId, averyBrowser)
  const status = await den.as(avery, orgId)("GET", `/v1/oauth-providers/${connectionId}/status`)
  assert.equal(field(status.body, "connected"), true, summary(status))
  assert.equal(field(status.body, "externalAccountId"), await averyBrowser.me(), "the connected account is Avery's own sample mailbox")

  await averyBrowser.addEvent("Avery's pilot review", thisWeek())
  const averyCalendar = await calendar(avery, orgId)
  assert.equal(averyCalendar.status, 200, summary(averyCalendar))
  assert.ok(subjects(averyCalendar).includes("Avery's pilot review"), "an event Avery added in Open Calendar is what Den (and Workbot) reads")

  await connect(riley, orgId, connectionId, rileyBrowser)
  const rileyCalendar = await calendar(riley, orgId)
  assert.equal(rileyCalendar.status, 200, summary(rileyCalendar))
  assert.ok(!subjects(rileyCalendar).includes("Avery's pilot review"), "Riley never sees Avery's workspace")
  const mail = await den.as(riley, orgId)("GET", "/v1/capabilities/microsoft-365/mail-messages?maxResults=5")
  assert.equal(mail.status, 200, summary(mail))

  // The kill switch stops the sample connector; nothing is sent to Microsoft instead.
  assert.equal((await rollout({ killed: true })).status, 200)
  const killed = await calendar(avery, orgId)
  assert.equal(killed.status, 409, summary(killed))
  assert.match(text(field(killed.body, "message"), "message"), /turned off/)
  const refusedStart = await den.as(avery, orgId)("GET", `/v1/oauth-providers/${connectionId}/connect/start`)
  assert.ok(!JSON.stringify(refusedStart.body).includes("login.microsoftonline.com"), summary(refusedStart))
  assert.notEqual(refusedStart.status, 200, summary(refusedStart))
  assert.equal((await rollout({ killed: false, enabled: true })).status, 200)
  assert.equal((await calendar(avery, orgId)).status, 200, "restoring the rollout brings it back without reconnecting")

  // When the sandbox ends, so does its sample Microsoft 365.
  await client.execute("UPDATE sandbox_organization SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE organization_id = ?", [orgId])
  const ended = await calendar(avery, orgId)
  assert.equal(ended.status, 409, summary(ended))
  assert.match(text(field(ended.body, "message"), "message"), /sandbox has ended/)
})

test("an existing sandbox gets it from /admin, and ordinary organizations keep Microsoft's sign-in", async () => {
  assert.equal((await rollout({ enabled: false })).status, 200)
  const older = field((await create("Older sandbox")).body, "sandbox")
  const id = text(field(older, "id"), "sandbox id"), orgId = text(field(older, "organizationId"), "organization id")
  const refused = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/microsoft-365`)
  assert.equal(refused.status, 400, "needs the feature on for the organization first")
  const override = await den.request(admin.token, "PUT", `/v1/admin/organizations/${encodeURIComponent(orgId)}/capabilities`, { body: { capabilities: { sandboxMicrosoft365: true } } })
  assert.ok(override.status < 300, summary(override))
  const added = await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/microsoft-365`)
  assert.equal(added.status, 200, summary(added))
  assert.equal(field(added.body, "sandbox", "sampleMicrosoft365"), true)
  assert.equal(field(added.body, "sandbox", "connectorCount"), 6, "the separate connectors stay until an admin removes them")
  assert.equal(field((await den.request(admin.token, "POST", `/v1/admin/sandbox-orgs/${id}/microsoft-365`)).body, "sandbox", "connectorCount"), 6, "adding twice is harmless")

  // An ordinary organization with the feature on everywhere still signs in at Microsoft.
  assert.equal((await rollout({ enabled: true })).status, 200)
  const owner = await den.signUp("Ordinary Owner")
  const ordinary = await den.createOrg(owner, "Ordinary company")
  const connection = await den.as(owner, ordinary.orgId)("POST", "/v1/mcp-connections", { kind: "native_provider", nativeProviderKey: "microsoft-365", name: "Microsoft 365", oauthClient: { clientId: "real-entra-app", clientSecret: "real-entra-secret-value", features: ["calendarRead"] } })
  assert.equal(connection.status, 200, summary(connection))
  const connectionId = text(field(connection.body, "id") ?? field(connection.body, "connection", "id"), "connection id")
  const tenant = await den.as(owner, ordinary.orgId)("POST", `/v1/oauth-providers/${connectionId}/client`, { tenantId: "11111111-2222-4333-8444-555555555555" })
  assert.equal(tenant.status, 200, summary(tenant))
  const started = await den.as(owner, ordinary.orgId)("GET", `/v1/oauth-providers/${connectionId}/connect/start`)
  assert.equal(new URL(text(field(started.body, "authorizeUrl"), "authorize url")).origin, "https://login.microsoftonline.com", summary(started))
})
