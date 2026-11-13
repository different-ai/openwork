import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { startMockIdpLab, type StartedMockIdpLab } from "../../../../../evals/packages/labs/src/idp.ts"
import { bootDen, field, summary, text, type Session } from "./harness.js"

// ssoPerOrganization: one browser keeps the SSO sign-ins it earned for several
// organizations, and the rollout keeps today's SSO enforcement for
// organizations that have SSO.

const domain = `proofs-${Date.now()}.example`
const idpA = await startMockIdpLab({ domain, defaultSubject: { email: `owner@${domain}` } })
const idpB = await startMockIdpLab({ domain, defaultSubject: { email: `owner@${domain}` } })
after(() => idpA.stop())
after(() => idpB.stop())
const den = await bootDen({ env: { DEN_BETTER_AUTH_TRUSTED_ORIGINS: `http://localhost:3005,http://127.0.0.1:8790,${idpA.issuer},${idpB.issuer}` } })
after(() => den.close())

const { client, db } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("needs MySQL")
const { SsoProviderTable } = await import("@openwork-ee/den-db/schema")

const owner = await den.signUp("Proofs Owner", `owner@${domain}`)
await client.execute("UPDATE user SET email_verified = 1 WHERE id = ?", [owner.userId])
const orgA = (await den.createOrg(owner, "Organization A")).orgId
const orgB = (await den.createOrg(owner, "Organization B")).orgId

/** An enabled OIDC connection on a verified domain. Both providers vouch for the owner's domain, as a shared company IdP would. */
async function connectOidc(orgId: string, idp: StartedMockIdpLab, connectionDomain: string) {
  const providerId = `sso-${createDenTypeId("ssoProvider")}`
  await db.insert(SsoProviderTable).values({ id: createDenTypeId("ssoProvider"), issuer: idp.issuer, domain, userId: owner.userId, providerId, organizationId: orgId, domainVerified: true, oidcConfig: JSON.stringify({ ...idp.registration({ skipDiscovery: true }), redirectURI: `http://localhost:3005/api/auth/sso/callback/${providerId}` }) })
  await client.execute("INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path) VALUES (?, ?, ?, 'oidc', ?, ?, 'enabled', ?)", [createDenTypeId("ssoConnection"), orgId, providerId, idp.issuer, connectionDomain, `/sso/${providerId}`])
  return providerId
}

const providerA = await connectOidc(orgA, idpA, domain)
const providerB = await connectOidc(orgB, idpB, `b-${domain}`)

/** A real OIDC sign-in, optionally started from a browser that already has a session. */
async function oidcSignIn(providerId: string, from: Session | null = null, person: Session = owner): Promise<Session> {
  const started = await den.request(null, "POST", "/api/auth/sign-in/sso", { headers: from ? { cookie: from.cookie } : {}, body: { providerId, loginHint: person.email, callbackURL: "http://localhost:3005/" } })
  assert.equal(started.status, 200, summary(started))
  const authorization = await fetch(text(field(started.body, "url"), "authorization URL"), { redirect: "manual" })
  assert.equal(authorization.status, 302)
  const callbackUrl = new URL(text(authorization.headers.get("location"), "callback URL"))
  const cookies = [
    ...(from ? from.cookie.split("; ") : []),
    ...started.headers.getSetCookie().map((cookie) => cookie.split(";")[0]),
  ].join("; ")
  const callback = await den.request(null, "GET", `${callbackUrl.pathname}${callbackUrl.search}`, { headers: { cookie: cookies } })
  assert.equal(callback.status, 302, summary(callback))
  const cookie = callback.headers.getSetCookie().map((value) => value.split(";")[0]).filter((value) => value.includes("session_token=")).join("; ")
  const session = await den.request(null, "GET", "/api/auth/get-session", { headers: { cookie } })
  assert.equal(session.status, 200, summary(session))
  assert.equal(field(session.body, "user", "id"), person.userId, summary(session))
  return { ...person, cookie, token: text(field(session.body, "session", "token"), "SSO token") }
}

async function sessionId(session: Session) {
  const current = await den.request(null, "GET", "/api/auth/get-session", { headers: { cookie: session.cookie } })
  return text(field(current.body, "session", "id"), "session id")
}

async function opens(session: Session, orgId: string) {
  return (await den.as(session, orgId)("GET", "/v1/org")).status
}

// Both organizations require SSO, each turned on by an admin signed in through it.
assert.equal((await den.as(await oidcSignIn(providerA), orgA)("PATCH", "/v1/org", { requireSso: true })).status, 200)
assert.equal((await den.as(await oidcSignIn(providerB), orgB)("PATCH", "/v1/org", { requireSso: true })).status, 200)

test("a browser that signs in through a second organization's SSO keeps the first", async () => {
  const viaA = await oidcSignIn(providerA)
  assert.equal(await opens(viaA, orgA), 200)
  assert.equal(await opens(viaA, orgB), 403)

  const viaBThenA = await oidcSignIn(providerB, viaA)
  assert.equal(await opens(viaBThenA, orgB), 200)
  assert.equal(await opens(viaBThenA, orgA), 200, "the proof for A carried into the new session")

  const viaBAlone = await oidcSignIn(providerB)
  assert.equal(await opens(viaBAlone, orgA), 403, "nothing is carried without the earlier browser session")
})

test("a password session carries nothing, and another person's session is never carried", async () => {
  const password = await den.signIn(owner.email)
  assert.equal(password.status, 200, summary(password))
  const passwordToken = text(field(password.body, "token"), "password token")
  const passwordCookie = password.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  const fromPassword = await oidcSignIn(providerB, { ...owner, token: passwordToken, cookie: passwordCookie })
  assert.equal(await opens(fromPassword, orgA), 403)

  const other = await den.signUp("Other Person", `other@${domain}`)
  await client.execute("UPDATE user SET email_verified = 1 WHERE id = ?", [other.userId])
  await den.join(await oidcSignIn(providerA), orgA, other)
  const otherViaA = await oidcSignIn(providerA, null, other)
  assert.equal(await opens(otherViaA, orgA), 200)
  // The owner completes an SSO sign-in that the other person's browser started.
  const crossed = await oidcSignIn(providerB, otherViaA, owner)
  assert.equal(await opens(crossed, orgA), 403, "proofs only move between sessions of the same person")
})

test("\"Ask for SSO again\" is gone: an SSO sign-in opens the organization for as long as the session lasts", async () => {
  // An organization that saved a limit before it was removed: the stored value no longer applies.
  await client.execute("UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.ssoSessionMaxAgeHours', 8) WHERE id = ?", [orgA])
  const signedIn = await oidcSignIn(providerA)
  await client.execute("UPDATE session_sso_proof SET authenticated_at = DATE_SUB(NOW(3), INTERVAL 9 HOUR) WHERE session_id = ? AND organization_id = ?", [await sessionId(signedIn), orgA])
  assert.equal(await opens(signedIn, orgA), 200)

  const refused = await den.as(signedIn, orgA)("PATCH", "/v1/org", { ssoSessionMaxAgeHours: 24 })
  assert.equal(refused.status, 400, summary(refused))
})

test("the rollout migration keeps SSO required for organizations that have it today", async () => {
  const sqlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/den-db/drizzle/0180_keep_sso_required_on_rollout.sql")
  const statement = (await readFile(sqlPath, "utf8")).split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n")

  async function organization(name: string, input: { sso: boolean; metadata: string | null; flag?: boolean }) {
    const { orgId } = await den.createOrg(owner, name)
    await client.execute("UPDATE organization SET metadata = ? WHERE id = ?", [input.metadata, orgId])
    if (input.sso) {
      const providerId = `sso-${createDenTypeId("ssoProvider")}`
      await db.insert(SsoProviderTable).values({ id: createDenTypeId("ssoProvider"), issuer: idpA.issuer, domain: `${providerId}.example`, userId: owner.userId, providerId, organizationId: orgId, domainVerified: true })
      await client.execute("INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path) VALUES (?, ?, ?, 'oidc', ?, ?, 'enabled', ?)", [createDenTypeId("ssoConnection"), orgId, providerId, idpA.issuer, `${providerId}.example`, `/sso/${providerId}`])
    }
    if (input.flag !== undefined) await client.execute("INSERT INTO organization_feature (organization_id, feature_key, enabled, source) VALUES (?, 'ssoPerOrganization', ?, 'platform')", [orgId, input.flag])
    return orgId
  }
  async function requireSso(orgId: string) {
    const [rows] = await client.query("SELECT JSON_EXTRACT(metadata, '$.requireSso') = TRUE AS required, metadata FROM organization WHERE id = ?", [orgId])
    const row = Array.isArray(rows) ? rows[0] : undefined
    const metadata: unknown = row && "metadata" in row ? row.metadata : null
    return { required: Boolean(row && "required" in row && row.required), metadata: typeof metadata === "string" ? metadata : JSON.stringify(metadata) }
  }

  const savedFalse = await organization("SSO, saved false", { sso: true, metadata: JSON.stringify({ requireSso: false, brandAppName: "Kept" }) })
  const empty = await organization("SSO, no metadata", { sso: true, metadata: null })
  const flagOn = await organization("SSO, flag on, chose optional", { sso: true, metadata: JSON.stringify({ requireSso: false }), flag: true })
  const flagOffOverride = await organization("SSO, flag off override", { sso: true, metadata: JSON.stringify({ requireSso: false }), flag: false })
  const noSso = await organization("No SSO", { sso: false, metadata: JSON.stringify({ requireSso: false }) })

  await client.query(statement)

  assert.equal((await requireSso(savedFalse)).required, true)
  assert.match((await requireSso(savedFalse)).metadata, /"brandAppName": ?"Kept"/, "other settings are kept")
  assert.equal((await requireSso(empty)).required, true)
  assert.equal((await requireSso(flagOn)).required, false, "an organization already on the flag keeps its admin's choice")
  assert.equal((await requireSso(flagOffOverride)).required, true)
  assert.equal((await requireSso(noSso)).required, false)

  // Rolled out to everyone: organizations without an override off are on the flag already.
  const rolledOut = await organization("SSO, rolled out", { sso: true, metadata: JSON.stringify({ requireSso: false }) })
  const rolledOutOff = await organization("SSO, rolled out, override off", { sso: true, metadata: JSON.stringify({ requireSso: false }), flag: false })
  await client.execute("INSERT INTO feature_rollout (feature_key, enabled, killed) VALUES ('ssoPerOrganization', 1, 0)")
  try {
    await client.query(statement)
  } finally {
    await client.execute("DELETE FROM feature_rollout WHERE feature_key = 'ssoPerOrganization'")
  }
  assert.equal((await requireSso(rolledOut)).required, false)
  assert.equal((await requireSso(rolledOutOff)).required, true)
})

test("turning SSO on leaves it optional until an admin requires it", async () => {
  const { orgId } = await den.createOrg(owner, "Enable optional SSO")
  await client.execute("UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.plan', JSON_OBJECT('tier', 'enterprise', 'source', 'manual')) WHERE id = ?", [orgId])
  const providerId = `sso-${createDenTypeId("ssoProvider")}`
  const enableDomain = `${providerId}.example`
  await db.insert(SsoProviderTable).values({ id: createDenTypeId("ssoProvider"), issuer: idpA.issuer, domain: enableDomain, userId: owner.userId, providerId, organizationId: orgId, domainVerified: true })
  await client.execute("INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path, config_revision, test_status, last_tested_revision) VALUES (?, ?, ?, 'oidc', ?, ?, 'disabled', ?, 'r1', 'succeeded', 'r1')", [createDenTypeId("ssoConnection"), orgId, providerId, idpA.issuer, enableDomain, `/sso/${providerId}`])
  const enabled = await den.as(owner, orgId)("POST", "/v1/sso/enable")
  assert.equal(enabled.status, 204, summary(enabled))
  const org = await den.as(owner, orgId)("GET", "/v1/org")
  assert.doesNotMatch(String(field(org.body, "organization", "metadata")), /"requireSso":true/)
  assert.equal(org.status, 200, "a password session still opens it")
})
