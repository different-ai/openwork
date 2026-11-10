import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { startMockIdpLab } from "../../../../../evals/packages/labs/src/idp.ts"
import { bootDen, field, summary, text, type Session } from "./harness.js"

const domain = `callback-${Date.now()}.example`
const idp = await startMockIdpLab({ domain, defaultSubject: { email: `owner@${domain}` } })
after(() => idp.stop())
const den = await bootDen({ env: { DEN_BETTER_AUTH_TRUSTED_ORIGINS: `http://localhost:3005,http://127.0.0.1:8790,${idp.issuer}` } })
after(() => den.close())
const owner = await den.signUp("Callback Owner", `owner@${domain}`)
const { orgId } = await den.createOrg(owner, "Callback organization")
const providerId = `sso-${createDenTypeId("ssoProvider")}`
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("needs MySQL")
// A verified existing owner keeps their password credential when linking SSO.
await client.execute("UPDATE user SET email_verified = 1 WHERE id = ?", [owner.userId])
// Only configuration is arranged. Sessions and provenance must come from the callback.
const { db } = await import("../../src/db.js")
const { SsoProviderTable } = await import("@openwork-ee/den-db/schema")
await db.insert(SsoProviderTable).values({ id: createDenTypeId("ssoProvider"), issuer: idp.issuer, domain, userId: owner.userId, providerId, organizationId: orgId, domainVerified: true, oidcConfig: JSON.stringify({ ...idp.registration({ skipDiscovery: true }), redirectURI: `http://localhost:3005/api/auth/sso/callback/${providerId}` }) })
await client.execute("INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path) VALUES (?, ?, ?, 'oidc', ?, ?, 'enabled', ?)", [createDenTypeId("ssoConnection"), orgId, providerId, idp.issuer, domain, "/sso/callback-test"])
await den.setFeature(orgId, "ssoPerOrganization", true)

async function oidcSignIn(person = owner): Promise<Session> {
  const started = await den.request(null, "POST", "/api/auth/sign-in/sso", { body: { providerId, loginHint: person.email, callbackURL: "http://localhost:3005/" } })
  assert.equal(started.status, 200, summary(started))
  const authorization = await fetch(text(field(started.body, "url"), "authorization URL"), { redirect: "manual" })
  assert.equal(authorization.status, 302)
  const callbackUrl = new URL(text(authorization.headers.get("location"), "callback URL"))
  const cookies = started.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ")
  const callback = await den.request(null, "GET", `${callbackUrl.pathname}${callbackUrl.search}`, { headers: { cookie: cookies } })
  assert.equal(callback.status, 302, summary(callback))
  assert.equal(new URL(text(callback.headers.get("location"), "callback redirect")).searchParams.has("error"), false, callback.headers.get("location") ?? "")
  const cookie = callback.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  const session = await den.request(null, "GET", "/api/auth/get-session", { headers: { cookie } })
  assert.equal(session.status, 200, summary(session))
  assert.equal(field(session.body, "user", "id"), person.userId, summary(session))
  return { ...person, cookie, token: text(field(session.body, "session", "token"), "SSO token") }
}

test("a real signed OIDC callback lets the owner safely require SSO", async () => {
  const recovery = await den.as(owner, orgId)("PATCH", "/v1/org", { requireSso: true })
  assert.equal(recovery.status, 409, summary(recovery))
  assert.match(text(field(recovery.body, "signInPath"), "SSO recovery path"), /^\/sso\//)
  const session = await oidcSignIn()
  const enabled = await den.as(session, orgId)("PATCH", "/v1/org", { requireSso: true })
  assert.equal(enabled.status, 200, summary(enabled))
  const opened = await den.as(session, orgId)("GET", "/v1/org")
  assert.equal(opened.status, 200, summary(opened))
  // Linking the account via real SSO must not upgrade older password sessions.
  for (const [method, path, body] of [
    ["GET", "/v1/org", undefined],
    ["POST", "/v1/api-keys", { name: "Password key" }],
    ["POST", "/v1/mcp/token", { scopes: ["mcp:read"] }],
  ] satisfies ["GET" | "POST", string, unknown][]) {
    const blocked = await den.request(owner.token, method, path, { orgId, body })
    assert.equal(blocked.status, 403, summary(blocked))
    assert.equal(field(blocked.body, "error"), "sso_required")
  }
  const rawKey = await den.request(null, "POST", "/api/auth/api-key/create", { headers: { cookie: owner.cookie }, body: { name: "Raw key" } })
  assert.equal(rawKey.status, 403, summary(rawKey))
})

test("a real callback while the flag is off remains valid when it is enabled", async () => {
  await den.setFeature(orgId, "ssoPerOrganization", false)
  const legacyPassword = await den.signIn(owner.email)
  assert.equal(legacyPassword.status, 403, summary(legacyPassword))
  const session = await oidcSignIn()
  await den.setFeature(orgId, "ssoPerOrganization", true)
  const opened = await den.as(session, orgId)("GET", "/v1/org")
  assert.equal(opened.status, 200, summary(opened))
  const password = await den.signIn(owner.email)
  assert.equal(password.status, 200, summary(password))
  const blocked = await den.request(text(field(password.body, "token"), "password token"), "GET", "/v1/org", { orgId })
  assert.equal(blocked.status, 403, summary(blocked))
})

test("a password-approved device cannot gain SSO by redeeming after enforcement changes", async () => {
  const ssoSession = await oidcSignIn()
  for (const approvalSession of [owner, ssoSession]) {
    assert.equal((await den.as(ssoSession, orgId)("PATCH", "/v1/org", { requireSso: false })).status, 200)
    const code = await den.request(null, "POST", "/api/auth/device/code", { body: { client_id: "openwork-cli" } })
    assert.equal(code.status, 200, summary(code))
    const approved = await den.request(approvalSession.token, "POST", "/v1/auth/device/decision", { body: { userCode: field(code.body, "user_code"), decision: "approve", organizationId: orgId } })
    assert.equal(approved.status, 200, summary(approved))
    assert.equal((await den.as(ssoSession, orgId)("PATCH", "/v1/org", { requireSso: true })).status, 200)
    const redeemed = await den.request(null, "POST", "/api/auth/device/token", { body: { client_id: "openwork-cli", device_code: field(code.body, "device_code"), grant_type: "urn:ietf:params:oauth:grant-type:device_code" } })
    assert.equal(redeemed.status, 200, summary(redeemed))
    const deviceToken = text(field(redeemed.body, "access_token"), "device token")
    const blocked = await den.request(deviceToken, "GET", "/v1/org", { orgId })
    assert.equal(blocked.status, approvalSession === owner ? 403 : 200, summary(blocked))
    if (approvalSession === owner) assert.equal(field(blocked.body, "error"), "sso_required")
  }
})

test("desktop device approval requires real SSO proof and carries it to the new session", async () => {
  const ssoSession = await oidcSignIn()
  assert.equal((await den.setFeature(orgId, "ssoPerOrganization", true)).status, 200)
  assert.equal((await den.as(ssoSession, orgId)("PATCH", "/v1/org", { requireSso: true })).status, 200)
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/remoteDesktopDeviceLogin", { enabled: true })).status, 200)
  const code = await den.request(null, "POST", "/api/auth/device/code", { body: { client_id: "openwork-desktop-device" } })
  assert.equal(code.status, 200)
  const decision = { userCode: field(code.body, "user_code"), decision: "approve", organizationId: orgId }
  const password = await den.request(owner.token, "POST", "/v1/auth/device/decision", { body: decision })
  assert.equal(password.status, 403)
  assert.equal(field(password.body, "error"), "sso_required")
  const approved = await den.request(ssoSession.token, "POST", "/v1/auth/device/decision", { body: decision })
  assert.equal(approved.status, 200)
  const redeemed = await den.request(null, "POST", "/api/auth/device/token", { body: { client_id: "openwork-desktop-device", device_code: field(code.body, "device_code"), grant_type: "urn:ietf:params:oauth:grant-type:device_code" } })
  assert.equal(redeemed.status, 200)
  const deviceToken = text(field(redeemed.body, "access_token"), "device session")
  assert.notEqual(deviceToken, ssoSession.token)
  const opened = await den.request(deviceToken, "GET", "/v1/org", { orgId })
  assert.equal(opened.status, 200)
  assert.equal((await den.asPlatformAdmin("PUT", "/v1/admin/features/remoteDesktopDeviceLogin", { enabled: false })).status, 200)
})

test("SSO authentication does not grant organization settings permission", async () => {
  const admin = await oidcSignIn()
  const member = await den.signUp("Callback Member", `member@${domain}`)
  await client.execute("UPDATE user SET email_verified = 1 WHERE id = ?", [member.userId])
  await den.join(admin, orgId, member)
  const session = await oidcSignIn(member)
  assert.equal((await den.as(session, orgId)("GET", "/v1/org")).status, 200)
  const changed = await den.as(session, orgId)("PATCH", "/v1/org", { requireSso: false })
  assert.equal(changed.status, 403, summary(changed))
  assert.equal(field(changed.body, "requiredPermission"), "organization.update")
})

test("a real signed SAML response records provenance; a tampered response cannot", async () => {
  const { samlIdentityProvider } = await import("./saml-idp.js")
  const saml = samlIdentityProvider()
  const samlDomain = `saml-${den.stamp}.example`
  const samlOwner = await den.signUp("SAML Owner", `owner@${samlDomain}`)
  const { orgId: samlOrg } = await den.createOrg(samlOwner, "SAML organization")
  const samlProvider = `sso-${createDenTypeId("ssoProvider")}`
  const issuer = "https://synthetic-idp.example"
  const audience = "http://localhost:3005"
  const acs = `http://localhost:3005/api/auth/sso/saml2/sp/acs/${samlProvider}`
  await db.insert(SsoProviderTable).values({ id: createDenTypeId("ssoProvider"), issuer: audience, domain: samlDomain, userId: samlOwner.userId, providerId: samlProvider, organizationId: samlOrg, domainVerified: true, samlConfig: JSON.stringify({ issuer: audience, entryPoint: `${issuer}/sso`, cert: saml.cert, audience, callbackUrl: acs, idpMetadata: { entityID: issuer }, spMetadata: { entityID: audience }, wantAssertionsSigned: true, mapping: { email: "email", name: "displayName" } }) })
  await client.execute("INSERT INTO sso_connection (id, organization_id, provider_id, kind, issuer, domain, status, sign_in_path) VALUES (?, ?, ?, 'saml', ?, ?, 'enabled', ?)", [createDenTypeId("ssoConnection"), samlOrg, samlProvider, issuer, samlDomain, "/sso/saml-test"])
  await den.setFeature(samlOrg, "ssoPerOrganization", true)
  await den.join(samlOwner, samlOrg, owner)
  for (const tamper of [true, false]) {
    const started = await den.request(null, "POST", "/api/auth/sign-in/sso", { body: { providerId: samlProvider, callbackURL: "http://localhost:3005/" } })
    assert.equal(started.status, 200, summary(started))
    const assertion = saml.respond({ authorizationUrl: text(field(started.body, "url"), "SAML request URL"), issuer, audience, acs, email: samlOwner.email, tamper })
    const callback = await den.request(null, "POST", new URL(acs).pathname, { headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: new URLSearchParams(assertion).toString() })
    assert.equal(callback.status, 302, summary(callback))
    const redirect = new URL(text(callback.headers.get("location"), "SAML redirect"))
    assert.equal(redirect.searchParams.has("error"), tamper, redirect.toString())
    if (tamper) {
      assert.equal(callback.headers.getSetCookie().some((cookie) => cookie.includes("session_token=")), false)
      continue
    }
    const cookie = callback.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
    const current = await den.request(null, "GET", "/api/auth/get-session", { headers: { cookie } })
    const session: Session = { ...samlOwner, cookie, token: text(field(current.body, "session", "token"), "SAML token") }
    const enabled = await den.as(session, samlOrg)("PATCH", "/v1/org", { requireSso: true })
    assert.equal(enabled.status, 200, summary(enabled))
    const otherOrganizationSso = await oidcSignIn()
    const blocked = await den.as(otherOrganizationSso, samlOrg)("GET", "/v1/org")
    assert.equal(blocked.status, 403, summary(blocked))
    assert.equal(field(blocked.body, "error"), "sso_required")
  }
})
