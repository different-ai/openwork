import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, isRecord, list, startFakeMcpServer, summary, text, type Member } from "./harness.js"

/**
 * Workbot's Apps list (`apps` on GET /v1/workbot/connections, behind `workbotProfileSheet`): every connector the
 * member can use, connected or not, with a plain status and who can fix it, and never a secret.
 */
const den = await bootDen({ env: { DEN_WORKBOT_URL: "http://127.0.0.1:3017" } })
let unavailable = false
const service = await startFakeMcpServer({
  tools: [{ name: "read_notes", description: "Read team notes", text: "Notes." }],
  decide: ({ path }) => unavailable && path.startsWith("/broken") ? { reply: false, status: 503, body: "Service unavailable" } : { reply: true },
})
after(async () => { await service.close(); await den.close() })

const SHARED_KEY = "synthetic-shared-api-key-do-not-leak"
const HEADER_VALUE = "synthetic-header-value-do-not-leak"
const PERSONAL_KEY = "synthetic-personal-api-key-do-not-leak"
const APP_FIELDS = ["action", "authType", "connectMode", "connectUrl", "iconCandidates", "id", "managedBy", "name", "nativeProviderKey", "ready", "status"]

const { orgId, owner } = await den.createOrg(await den.signUp("Apps Owner"), "Apps workspace")
const member = await den.newMember(owner, orgId, "Apps Member")

async function connection(body: Record<string, unknown>) {
  const created = await den.as(owner, orgId)("POST", "/v1/mcp-connections", body)
  assert.equal(created.status, 200, summary(created))
  return text(field(created.body, "id"), "connection id")
}

async function apps(person: Member) {
  const response = await den.request(await den.mintMcpToken(person, orgId), "GET", "/v1/workbot/connections")
  assert.equal(response.status, 200, summary(response))
  return { response, apps: field(response.body, "apps") }
}

test("every usable connector is listed, connected or not, Connected first; secrets never leave Den; member and admin differ only in who fixes it", async () => {
  const notes = await connection({
    name: "Team Notes", url: `${service.url}/shared/mcp`, authType: "apikey", credentialMode: "shared", apiKey: SHARED_KEY,
    requestHeaders: [{ name: "X-Workspace-Secret", value: HEADER_VALUE }], access: { orgWide: true },
  })
  const personal = await connection({ name: "Personal Notes", url: `${service.url}/personal/mcp`, authType: "apikey", credentialMode: "per_member", access: { orgWide: true } })
  const broken = await connection({ name: "Broken Tracker", url: `${service.url}/broken/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true } })
  const ownerOnly = await connection({ name: "Owner Only", url: `${service.url}/owner/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: false } })

  // With the profile turned off for the organization there is no `apps`.
  assert.equal((await den.setFeature(orgId, "workbotProfileSheet", false)).status, 200)
  assert.equal((await apps(member)).apps, undefined)
  assert.equal((await den.setFeature(orgId, "workbotProfileSheet", true)).status, 200)

  // A failed stored health check (recorded by an admin's check, never on open) makes it need attention.
  unavailable = true
  try {
    const checked = await den.as(owner, orgId)("POST", `/v1/mcp-connections/${broken}/check`)
    assert.equal(checked.status, 200, summary(checked))
  } finally { unavailable = false }

  const before = await apps(member)
  const listed = list(before.apps)
  assert.deepEqual(listed.map((app) => [app.name, app.status]), [
    ["Team Notes", "connected"],
    ["Personal Notes", "needs_sign_in"],
    ["Broken Tracker", "needs_attention"],
  ])
  // Not shared with this member: not theirs to see.
  assert.equal(listed.some((app) => app.id === ownerOnly), false)
  const byId = new Map(listed.map((app) => [app.id, app]))
  assert.deepEqual(byId.get(notes), { ...byId.get(notes), status: "connected", action: null, managedBy: "organization", ready: true, connectUrl: null })
  assert.deepEqual(byId.get(personal), { ...byId.get(personal), status: "needs_sign_in", action: "connect", managedBy: "you", authType: "apikey", connectMode: "external" })
  assert.ok(String(byId.get(personal)?.connectUrl).includes("/dashboard/your-connections"))
  assert.deepEqual(byId.get(broken), { ...byId.get(broken), status: "needs_attention", action: "ask_admin", managedBy: "organization", connectMode: "admin", connectUrl: null })

  for (const app of listed) assert.deepEqual(Object.keys(app).sort(), APP_FIELDS)
  for (const secret of [SHARED_KEY, HEADER_VALUE, "X-Workspace-Secret", service.url, "/shared/mcp", "requestHeader", "apiKey", "accessToken", "oauthClient"]) {
    assert.equal(before.response.text.includes(secret), false, `response leaks ${secret}`)
  }

  // The member signs in with their own key: Connected, and still nothing secret comes back.
  const saved = await den.as(member, orgId)("PUT", `/v1/mcp-connections/${personal}/my-credential`, { apiKey: PERSONAL_KEY })
  assert.equal(saved.status, 200, summary(saved))
  const after = await apps(member)
  assert.deepEqual(list(after.apps).map((app) => [app.name, app.status]), [
    ["Personal Notes", "connected"],
    ["Team Notes", "connected"],
    ["Broken Tracker", "needs_attention"],
  ])
  assert.equal(after.response.text.includes(PERSONAL_KEY), false)

  // An admin sees the connectors available to them, with fixes they can make themselves in settings.
  const admin = list((await apps(owner)).apps)
  const adminBroken = admin.find((app) => app.id === broken)
  assert.ok(isRecord(adminBroken))
  assert.equal(adminBroken.action, "admin_settings")
  assert.equal(admin.find((app) => app.id === personal)?.status, "needs_sign_in")
  assert.equal(admin.some((app) => app.id === ownerOnly), false)

  // The everyday welcome list is unchanged by any of this.
  assert.deepEqual(field(after.response.body, "connections"), [])
})
