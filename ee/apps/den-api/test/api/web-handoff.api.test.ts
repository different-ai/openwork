import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

/**
 * Sign-in handoffs (src/routes/auth/desktop-handoff.ts): the recipient gets a
 * session of its own, no token is kept in the grant, and a website that one
 * organization approved gets a session that works in that organization only,
 * after the person confirms where they are signing in.
 */
const den = await bootDen()
after(() => den.close())

const WEBSITE = "https://web.org-a.example"

async function grantRows(userId: string): Promise<Record<string, unknown>[]> {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("grantRows needs MySQL mode")
  const [rows] = await client.query("SELECT session_token, session_id, organization_id, consumed_at FROM desktop_handoff_grant WHERE user_id = ?", [userId])
  return list(rows)
}

async function sessionCreatedAt(userId: string): Promise<string[]> {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("sessionCreatedAt needs MySQL mode")
  const [rows] = await client.query("SELECT created_at FROM session WHERE user_id = ?", [userId])
  return list(rows).map((row) => String(row.created_at))
}

test("a website one organization approved gets a session that cannot act in the person's other organizations", async () => {
  const person = await den.signUp("Two Org Person")
  const orgA = await den.createOrg(person, "Org A")
  const orgB = await den.createOrg(person, "Org B")
  const approved = await den.request(person.token, "POST", "/v1/org/web-origins", { orgId: orgA.orgId, body: { origin: WEBSITE } })
  assert.equal(approved.status, 201, summary(approved))

  // Nothing is handed over until the person confirms the website by name.
  const unconfirmed = await den.request(person.token, "POST", "/v1/auth/desktop-handoff", { body: { returnUrl: `${WEBSITE}/` } })
  assert.equal(unconfirmed.status, 409, summary(unconfirmed))
  assert.equal(field(unconfirmed.body, "error"), "confirmation_required")
  assert.equal(field(unconfirmed.body, "returnHost"), "web.org-a.example")
  assert.equal(field(unconfirmed.body, "organizationName"), "Org A")
  assert.equal(field(unconfirmed.body, "grant"), undefined)
  assert.equal((await grantRows(person.userId)).length, 0)

  const created = await den.request(person.token, "POST", "/v1/auth/desktop-handoff", { body: { returnUrl: `${WEBSITE}/`, confirmed: true } })
  assert.equal(created.status, 200, summary(created))
  assert.equal(field(created.body, "returnUrl"), `${WEBSITE}/signin`)
  const exchanged = await den.request(null, "POST", "/v1/auth/desktop-handoff/exchange", { body: { grant: text(field(created.body, "grant"), "grant") } })
  assert.equal(exchanged.status, 200, summary(exchanged))
  const websiteToken = text(field(exchanged.body, "token"), "website session token")
  assert.notEqual(websiteToken, person.token)
  assert.equal(field(exchanged.body, "organization", "id"), orgA.orgId)

  // The website's session works in organization A, named or not.
  const inA = await den.request(websiteToken, "GET", "/v1/org", { orgId: orgA.orgId })
  assert.equal(inA.status, 200, summary(inA))
  const byDefault = await den.request(websiteToken, "GET", "/v1/org")
  assert.equal(field(byDefault.body, "organization", "id"), orgA.orgId, summary(byDefault))
  const listed = await den.request(websiteToken, "GET", "/v1/me/orgs")
  assert.deepEqual(list(field(listed.body, "orgs")).map((org) => org.id), [orgA.orgId], summary(listed))

  // It cannot act in organization B, switch to it, or reach account-wide operations.
  const inB = await den.request(websiteToken, "GET", "/v1/org", { orgId: orgB.orgId })
  assert.equal(inB.status, 403, summary(inB))
  const legacyPathB = await den.request(websiteToken, "GET", `/v1/orgs/${orgB.orgId}/org`)
  assert.equal(legacyPathB.status, 403, summary(legacyPathB))
  const switchToB = await den.request(websiteToken, "POST", "/v1/me/active-organization", { body: { organizationId: orgB.orgId } })
  assert.equal(switchToB.status, 403, summary(switchToB))
  // Naming its own organization, as clients do after signing in, is accepted.
  const stayInA = await den.request(websiteToken, "POST", "/v1/me/active-organization", { body: { organizationId: orgA.orgId } })
  assert.equal(stayInA.status, 200, summary(stayInA))
  assert.equal(field(stayInA.body, "activeOrgId"), orgA.orgId)
  // Its organization's own tokens stay available to it.
  const mcpToken = await den.request(websiteToken, "POST", "/v1/mcp/token", { body: { scopes: ["mcp:read"] } })
  assert.equal(mcpToken.status, 200, summary(mcpToken))
  assert.equal(field(mcpToken.body, "organizationId"), orgA.orgId)
  const newOrganization = await den.request(websiteToken, "POST", "/v1/org", { body: { name: "Org C" } })
  assert.equal(newOrganization.status, 403, summary(newOrganization))
  const anotherHandoff = await den.request(websiteToken, "POST", "/v1/auth/desktop-handoff", { body: {} })
  assert.equal(anotherHandoff.status, 403, summary(anotherHandoff))
  const sessions = await den.request(websiteToken, "GET", "/api/auth/list-sessions")
  assert.equal(sessions.status, 403, summary(sessions))

  // The person's own sign-in is untouched: still in both organizations.
  const ownB = await den.request(person.token, "GET", "/v1/org", { orgId: orgB.orgId })
  assert.equal(ownB.status, 200, summary(ownB))

  // The grant never held a token, and names the organization it was bound to.
  const rows = await grantRows(person.userId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.session_token, null)
  assert.equal(rows[0]?.organization_id, orgA.orgId)
  assert.ok(rows[0]?.consumed_at)

  // Signing out ends the website's session only.
  const signedOut = await den.request(websiteToken, "POST", "/api/auth/sign-out", { body: {} })
  assert.equal(signedOut.status, 200, summary(signedOut))
  const afterSignOut = await den.request(websiteToken, "GET", "/v1/org")
  assert.equal(afterSignOut.status, 401, summary(afterSignOut))
  const ownAfter = await den.request(person.token, "GET", "/v1/me")
  assert.equal(ownAfter.status, 200, summary(ownAfter))
})

test("a token shaped like an organization-bound one but never issued signs nobody in", async () => {
  const person = await den.signUp("Forged Token Person")
  const org = await den.createOrg(person, "Forged Org")
  const forged = await den.request(`ow_org_session_${org.orgId}_${"a".repeat(32)}`, "GET", "/v1/me")
  assert.equal(forged.status, 401, summary(forged))
  const malformed = await den.request(`ow_org_session_${person.token}`, "GET", "/v1/me")
  assert.equal(malformed.status, 401, summary(malformed))
})

test("a desktop handoff gives the desktop its own session and keeps no token", async () => {
  const person = await den.signUp("Desktop Person")
  const org = await den.createOrg(person, "Desktop Org")
  // ARRANGE ONLY: a grant that expired two days ago, as an old release left it, token included.
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("expired grant fixture needs MySQL mode")
  await client.execute("INSERT INTO desktop_handoff_grant (id, user_id, session_token, expires_at) VALUES (?, ?, ?, DATE_SUB(NOW(3), INTERVAL 2 DAY))", [`expired-grant-${den.stamp}`, person.userId, person.token])

  const created = await den.request(person.token, "POST", "/v1/auth/desktop-handoff", { body: { desktopScheme: "openwork" } })
  assert.equal(created.status, 200, summary(created))
  assert.match(text(field(created.body, "openworkUrl"), "deep link"), /^openwork:\/\/den-auth\?grant=/)
  // Creating a grant deletes long-expired ones, so their tokens do not linger.
  assert.equal((await grantRows(person.userId)).length, 1)
  const grant = text(field(created.body, "grant"), "grant")

  const rows = await grantRows(person.userId)
  assert.equal(rows[0]?.session_token, null)
  assert.ok(rows[0]?.session_id)
  assert.equal(rows[0]?.organization_id, null)

  const exchanged = await den.request(null, "POST", "/v1/auth/desktop-handoff/exchange", { body: { grant } })
  assert.equal(exchanged.status, 200, summary(exchanged))
  const desktopToken = text(field(exchanged.body, "token"), "desktop session token")
  assert.notEqual(desktopToken, person.token)
  assert.match(desktopToken, /^[0-9A-Za-z]{32}$/)

  // An ordinary session: every organization, account-wide operations included.
  const other = await den.createOrg({ ...person, token: desktopToken }, "Second Desktop Org")
  const inFirst = await den.request(desktopToken, "GET", "/v1/org", { orgId: org.orgId })
  assert.equal(inFirst.status, 200, summary(inFirst))
  const inSecond = await den.request(desktopToken, "GET", "/v1/org", { orgId: other.orgId })
  assert.equal(inSecond.status, 200, summary(inSecond))

  // It keeps the sign-in time of the session it came from, so it is no fresher for step-up checks.
  const times = await sessionCreatedAt(person.userId)
  assert.ok(new Set(times).size < times.length, `the desktop session shares a sign-in time: ${times.join(", ")}`)

  // One use only, and signing out the desktop leaves the browser signed in.
  const again = await den.request(null, "POST", "/v1/auth/desktop-handoff/exchange", { body: { grant } })
  assert.equal(again.status, 404, summary(again))
  const signedOut = await den.request(desktopToken, "POST", "/api/auth/sign-out", { body: {} })
  assert.equal(signedOut.status, 200, summary(signedOut))
  const browser = await den.request(person.token, "GET", "/v1/me")
  assert.equal(browser.status, 200, summary(browser))
})

test("a platform administrator cannot sign in to an organization's website", async () => {
  const createdOrg = await den.asPlatformAdmin("POST", "/v1/org", { name: "Admin Visited Org" })
  assert.ok(createdOrg.status < 300, summary(createdOrg))
  const approved = await den.asPlatformAdmin("POST", "/v1/org/web-origins", { origin: "https://web.admin-visited.example" })
  assert.equal(approved.status, 201, summary(approved))
  const refused = await den.asPlatformAdmin("POST", "/v1/auth/desktop-handoff", { returnUrl: "https://web.admin-visited.example/", confirmed: true })
  assert.equal(refused.status, 403, summary(refused))
  assert.equal(field(refused.body, "error"), "forbidden")
})

test("a grant written before grants stopped holding tokens still exchanges once, and its token is cleared", async () => {
  const person = await den.signUp("Earlier Grant Person")
  // ARRANGE ONLY: a row as the previous release wrote it, holding the session token.
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("legacy grant fixture needs MySQL mode")
  const grant = `legacy-grant-${den.stamp}`
  await client.execute("INSERT INTO desktop_handoff_grant (id, user_id, session_token, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(3), INTERVAL 5 MINUTE))", [grant, person.userId, person.token])

  const exchanged = await den.request(null, "POST", "/v1/auth/desktop-handoff/exchange", { body: { grant } })
  assert.equal(exchanged.status, 200, summary(exchanged))
  const handedOver = text(field(exchanged.body, "token"), "handed-over token")
  assert.notEqual(handedOver, person.token)
  assert.equal((await den.request(handedOver, "GET", "/v1/me")).status, 200)
  assert.equal((await grantRows(person.userId))[0]?.session_token, null)
})
