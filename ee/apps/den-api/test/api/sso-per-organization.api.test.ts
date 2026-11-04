/**
 * ssoPerOrganization: SSO set up on a verified domain is offered, not forced,
 * and "Require SSO" is enforced when the organization is opened, never by
 * refusing the person's other organizations.
 *
 * Off (today): every email on the domain is sent to the organization's SSO,
 * invitations to other organizations included, and members cannot sign in with
 * a password. On: SSO comes first with the usual step as an alternative, an
 * invitation to another organization skips the domain's SSO, members of an
 * organization that requires SSO still sign in but cannot open it (or set it
 * active, mint MCP tokens or approve devices in it) until their session signed
 * in through its SSO. "Restrict this domain to our SSO" brings back the strict
 * behavior for the whole domain.
 *
 * These policy tests ARRANGE an enabled connection and SSO session directly.
 * sso-callback.api.test.ts separately proves provenance through real signed
 * OIDC and SAML callbacks; the arranged rows here are not callback evidence.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, summary, text, type Session } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const ssoDomain = `sso-${den.stamp}.example`
let ipCounter = 0

/** login-options as Den Web calls it, from a fresh client address so the per-IP limit never interferes. */
async function loginOptions(email: string, invite?: string) {
  ipCounter += 1
  const params = new URLSearchParams({ email })
  if (invite) params.set("invite", invite)
  return den.request(null, "GET", `/v1/auth/login-options?${params.toString()}`, {
    headers: { "x-forwarded-for": `203.0.113.${ipCounter}` },
  })
}

async function sql(statement: string, values: unknown[]) {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  await client.execute(statement, values)
}

/** ARRANGE ONLY: an enabled SSO connection on a verified domain, as after the owner set it up and tested it. */
async function arrangeVerifiedSso(orgId: string, ownerUserId: string, domain: string) {
  const providerId = `sso-${createDenTypeId("ssoProvider")}`
  await sql(
    "INSERT INTO sso_provider (id, issuer, domain, user_id, provider_id, organization_id, domain_verified) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [createDenTypeId("ssoProvider"), "https://idp.example.test", domain, ownerUserId, providerId, orgId],
  )
  await sql(
    "INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path) VALUES (?, ?, ?, 'oidc', ?, ?, 'enabled', ?)",
    [createDenTypeId("ssoConnection"), orgId, providerId, "https://idp.example.test", domain, `/sso/test-${den.stamp}`],
  )
  return providerId
}

/** The person's newest session: the one the last sign-in created. */
async function newestSessionId(session: Session) {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  const [rows] = await client.query("SELECT id FROM session WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [session.userId])
  const first: unknown = Array.isArray(rows) ? rows[0] : null
  return text(field(first, "id"), "session id")
}

/** ARRANGE ONLY: this session came back from the organization's SSO (what the SSO callback records). */
async function arrangeSsoSession(session: Session, orgId: string, providerId: string) {
  await sql(
    "INSERT INTO session_sso_authentication (session_id, user_id, organization_id, sso_provider_id) VALUES (?, ?, ?, ?)",
    [await newestSessionId(session), session.userId, orgId, providerId],
  )
}

/** A fresh sign-in with the person's password: its bearer token and the session cookie Den Web holds. */
async function passwordSession(person: Session): Promise<Session> {
  const signedIn = await den.signIn(person.email)
  assert.equal(signedIn.status, 200, summary(signedIn))
  const cookie = signedIn.headers.get("set-cookie")?.split(";")[0]?.trim() ?? ""
  return { ...person, token: text(field(signedIn.body, "token"), "token"), cookie }
}

async function setFlag(orgId: string, enabled: boolean) {
  const changed = await den.setFeature(orgId, "ssoPerOrganization", enabled)
  assert.equal(changed.status < 300, true, summary(changed))
}

async function setSsoSettings(owner: Session, orgId: string, body: Record<string, boolean>) {
  const updated = await den.as(owner, orgId)("PATCH", "/v1/org", body)
  assert.equal(updated.status, 200, summary(updated))
}

// One SSO organization owns the domain; another organization has no SSO.
const ssoOwner = await den.signUp("Sso Owner")
const { orgId: ssoOrgId } = await den.createOrg(ssoOwner, "Domain SSO org")
// The admin who manages the SSO settings signs in (through the organization's SSO, arranged below).
const ownerSsoSignIn = await den.signIn(ssoOwner.email)
const ssoAdmin: Session = { ...ssoOwner, token: text(field(ownerSsoSignIn.body, "token"), "owner token"), cookie: "" }
const providerId = await arrangeVerifiedSso(ssoOrgId, ssoOwner.userId, ssoDomain)
await arrangeSsoSession(ssoAdmin, ssoOrgId, providerId)
const otherOwner = await den.signUp("Other Owner")
const { orgId: otherOrgId } = await den.createOrg(otherOwner, "No SSO org")

// A person on the domain who belongs to both organizations.
const both = await den.signUp("Both Member", `both-${den.stamp}@${ssoDomain}`)
await den.join(ssoOwner, ssoOrgId, both)
await den.join(otherOwner, otherOrgId, both)

test("flag off: an email on the SSO domain is sent to SSO only, even with an invitation to another organization", async () => {
  await setFlag(ssoOrgId, false)
  const invited = await den.as(otherOwner, otherOrgId)("POST", "/v1/invitations", { email: `invitee-off-${den.stamp}@${ssoDomain}`, role: "member" })
  const inviteToken = text(field(invited.body, "inviteToken"), `invite token (${summary(invited)})`)

  const options = await loginOptions(`invitee-off-${den.stamp}@${ssoDomain}`, inviteToken)
  assert.equal(options.status, 200, summary(options))
  assert.equal(field(options.body, "nextStep"), "sso")
  assert.equal(field(options.body, "allowInvitationSignup"), false)
  assert.equal(field(options.body, "alternativeStep"), undefined)
  assert.equal(field(options.body, "ssoRequired"), undefined)

  const signIn = await den.signIn(both.email)
  assert.equal(signIn.status, 403, `members of an SSO organization cannot use a password while the flag is off: ${summary(signIn)}`)
})

test("flag on, SSO not required: SSO is offered first and the usual step stays available", async () => {
  await setFlag(ssoOrgId, true)
  await setSsoSettings(ssoAdmin, ssoOrgId, { requireSso: false })

  const existing = await loginOptions(both.email)
  assert.equal(existing.status, 200, summary(existing))
  assert.equal(field(existing.body, "nextStep"), "sso")
  assert.equal(field(existing.body, "alternativeStep"), "password")
  assert.equal(field(existing.body, "ssoRequired"), false)
  assert.equal(field(existing.body, "organizationName"), "Domain SSO org")

  const fresh = await loginOptions(`fresh-${den.stamp}@${ssoDomain}`)
  assert.equal(field(fresh.body, "nextStep"), "sso")
  assert.equal(field(fresh.body, "alternativeStep"), "new_account")

  const signIn = await den.signIn(both.email)
  assert.equal(signIn.status, 200, `a password still signs in: ${summary(signIn)}`)
  const viaPassword: Session = { ...both, token: text(field(signIn.body, "token"), "token"), cookie: "" }
  const ssoOrg = await den.as(viaPassword, ssoOrgId)("GET", "/v1/org")
  assert.equal(ssoOrg.status, 200, `SSO is optional, so the organization opens: ${summary(ssoOrg)}`)
})

test("flag on: an invitation to another organization skips the domain's SSO", async () => {
  await setFlag(ssoOrgId, true)
  const email = `invitee-on-${den.stamp}@${ssoDomain}`
  const invited = await den.as(otherOwner, otherOrgId)("POST", "/v1/invitations", { email, role: "member" })
  const inviteToken = text(field(invited.body, "inviteToken"), `invite token (${summary(invited)})`)

  const options = await loginOptions(email, inviteToken)
  assert.equal(options.status, 200, summary(options))
  assert.equal(field(options.body, "nextStep"), "new_account")
  assert.equal(field(options.body, "allowInvitationSignup"), true)
  assert.equal(field(options.body, "organizationSlug"), undefined)

  // An invitation to the SSO organization itself does not skip its SSO.
  const ownInvite = await den.as(ssoOwner, ssoOrgId)("POST", "/v1/invitations", { email: `own-${den.stamp}@${ssoDomain}`, role: "member" })
  const own = await loginOptions(`own-${den.stamp}@${ssoDomain}`, text(field(ownInvite.body, "inviteToken"), "own invite token"))
  assert.equal(field(own.body, "nextStep"), "sso")
})

test("flag on, Require SSO: the person still signs in and uses other organizations, but the SSO organization opens only from an SSO session", async () => {
  await setFlag(ssoOrgId, true)
  await setSsoSettings(ssoAdmin, ssoOrgId, { requireSso: true })

  const options = await loginOptions(both.email)
  assert.equal(field(options.body, "nextStep"), "sso")
  assert.equal(field(options.body, "ssoRequired"), true)
  assert.equal(field(options.body, "alternativeStep"), "password")

  // Den Web repeats this older preflight when the person submits the chosen
  // password. It must not undo login-options and send them back to SSO.
  const preflight = await den.request(null, "GET", `/v1/orgs/sso/resolve?email=${encodeURIComponent(both.email)}`)
  assert.equal(preflight.status, 200, summary(preflight))
  assert.equal(field(preflight.body, "requireSso"), false)
  assert.equal(field(preflight.body, "method"), "password")

  const signIn = await den.signIn(both.email)
  assert.equal(signIn.status, 200, summary(signIn))
  const viaPassword: Session = { ...both, token: text(field(signIn.body, "token"), "token"), cookie: "" }

  const other = await den.as(viaPassword, otherOrgId)("GET", "/v1/org")
  assert.equal(other.status, 200, `other organizations stay usable: ${summary(other)}`)

  const blocked = await den.as(viaPassword, ssoOrgId)("GET", "/v1/org")
  assert.equal(blocked.status, 403, summary(blocked))
  assert.equal(field(blocked.body, "error"), "sso_required")
  assert.match(String(field(blocked.body, "signInUrl")), /\/sso\//)

  const switched = await den.request(viaPassword.token, "POST", "/v1/me/active-organization", { body: { organizationId: ssoOrgId } })
  assert.equal(switched.status, 403, summary(switched))
  assert.equal(field(switched.body, "error"), "sso_required")

  const withCookie = await passwordSession(both)
  const betterAuthSwitch = await den.request(null, "POST", "/api/auth/organization/set-active", { headers: { cookie: withCookie.cookie }, body: { organizationId: ssoOrgId } })
  assert.equal(betterAuthSwitch.status, 403, summary(betterAuthSwitch))
  assert.equal(field(betterAuthSwitch.body, "code"), "SSO_REQUIRED")
  assert.match(String(field(betterAuthSwitch.body, "signInPath")), /^\/sso\//)

  const mcpToken = await den.request(viaPassword.token, "POST", "/v1/mcp/token", { orgId: ssoOrgId, body: { scopes: ["mcp:read"] } })
  assert.equal(mcpToken.status, 403, `no MCP token for the SSO organization: ${summary(mcpToken)}`)

  const orgs = await den.request(viaPassword.token, "GET", "/v1/me/orgs")
  assert.notEqual(field(orgs.body, "activeOrgId"), ssoOrgId, `the session is never active in the SSO organization: ${summary(orgs)}`)

  // The same person after signing in through the organization's SSO.
  const ssoSignIn = await den.signIn(both.email)
  const viaSso: Session = { ...both, token: text(field(ssoSignIn.body, "token"), "token"), cookie: "" }
  await arrangeSsoSession(viaSso, ssoOrgId, providerId)
  const opened = await den.as(viaSso, ssoOrgId)("GET", "/v1/org")
  assert.equal(opened.status, 200, summary(opened))
  const active = await den.request(viaSso.token, "POST", "/v1/me/active-organization", { body: { organizationId: ssoOrgId } })
  assert.equal(active.status, 200, summary(active))

  // Turning the flag off restores today's behavior: no per-organization check, password refused at sign-in.
  await setFlag(ssoOrgId, false)
  const reopened = await den.as(viaPassword, ssoOrgId)("GET", "/v1/org")
  assert.equal(reopened.status, 200, `flag off never adds the per-organization check: ${summary(reopened)}`)
  const refused = await den.signIn(both.email)
  assert.equal(refused.status, 403, summary(refused))
  await setSsoSettings(ssoAdmin, ssoOrgId, { requireSso: false })
})

test("restricting the domain needs the flag, and brings back sign-in-wide SSO for every email on it", async () => {
  await setFlag(ssoOrgId, false)
  const unavailable = await den.as(ssoAdmin, ssoOrgId)("PATCH", "/v1/org", { restrictDomainToSso: true })
  assert.equal(unavailable.status, 404, summary(unavailable))

  await setFlag(ssoOrgId, true)
  await setSsoSettings(ssoAdmin, ssoOrgId, { restrictDomainToSso: true })
  const invited = await den.as(otherOwner, otherOrgId)("POST", "/v1/invitations", { email: `restricted-${den.stamp}@${ssoDomain}`, role: "member" })
  const inviteToken = text(field(invited.body, "inviteToken"), "invite token")

  const options = await loginOptions(`restricted-${den.stamp}@${ssoDomain}`, inviteToken)
  assert.equal(field(options.body, "nextStep"), "sso")
  assert.equal(field(options.body, "alternativeStep"), undefined, "SSO is the only way in")
  assert.equal(field(options.body, "allowInvitationSignup"), false)

  const preflight = await den.request(null, "GET", `/v1/orgs/sso/resolve?email=${encodeURIComponent(both.email)}`)
  assert.equal(preflight.status, 200, summary(preflight))
  assert.equal(field(preflight.body, "method"), "sso")
  assert.equal(field(preflight.body, "requireSso"), true)

  const signIn = await den.signIn(both.email)
  assert.equal(signIn.status, 403, summary(signIn))
  const signUp = await den.request(null, "POST", "/api/auth/sign-up/email", {
    body: { email: `restricted-new-${den.stamp}@${ssoDomain}`, name: "Restricted New", password: den.password },
  })
  assert.equal(signUp.status, 403, `a new account on the restricted domain is refused: ${summary(signUp)}`)

  await setSsoSettings(ssoAdmin, ssoOrgId, { restrictDomainToSso: false })
  await setFlag(ssoOrgId, false)
})

test("flag on: only an admin signed in through the organization's SSO can require it, so nobody locks themselves out", async () => {
  await setFlag(ssoOrgId, true)
  const viaPassword = await den.as(ssoOwner, ssoOrgId)("PATCH", "/v1/org", { requireSso: true })
  assert.equal(viaPassword.status, 409, summary(viaPassword))
  assert.equal(field(viaPassword.body, "error"), "sso_session_required")
  await setSsoSettings(ssoAdmin, ssoOrgId, { requireSso: true })
  await setSsoSettings(ssoAdmin, ssoOrgId, { requireSso: false })
  await setFlag(ssoOrgId, false)
})
