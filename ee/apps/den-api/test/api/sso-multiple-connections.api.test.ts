/**
 * multipleSsoConnections: an organization adds several SSO connections, each
 * with its own identity provider and one or more email domains. Each one is
 * verified, tested and enabled on its own; sign-in lists every ready provider
 * that covers the email; a sign-in through any of them opens an organization
 * that requires SSO.
 *
 * Connections are registered through the real routes against two mock OIDC
 * identity providers (loopback issuers count as verified in dev mode). Only
 * the administrator's connection test result is arranged, before enabling;
 * sign-ins are real OIDC callbacks.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { startMockIdpLab } from "../../../../../evals/packages/labs/src/idp.ts"
import { bootDen, field, summary, text, type Session } from "./harness.js"

const stamp = Date.now().toString(36)
const mainDomain = `multi-${stamp}.example`
const subsidiaryDomain = `multi-sub-${stamp}.example`
const idpA = await startMockIdpLab({ domain: mainDomain, defaultSubject: { email: `owner@${mainDomain}` } })
after(() => idpA.stop())
const idpB = await startMockIdpLab({ domain: mainDomain, defaultSubject: { email: `owner@${mainDomain}` } })
after(() => idpB.stop())
const den = await bootDen({ env: { DEN_BETTER_AUTH_TRUSTED_ORIGINS: `http://localhost:3005,http://127.0.0.1:8790,${idpA.issuer},${idpB.issuer}` } })
after(() => den.close())

const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("needs MySQL")

async function rows(statement: string, values: unknown[]): Promise<unknown[]> {
  if (!("getConnection" in client)) throw new Error("needs MySQL")
  const [result] = await client.query(statement, values)
  return Array.isArray(result) ? result : []
}

const owner = await den.signUp("Multi Owner", `owner@${mainDomain}`)
await client.execute("UPDATE user SET email_verified = 1 WHERE id = ?", [owner.userId])
const { orgId } = await den.createOrg(owner, "Multi SSO organization")
const orgSlug = text(field((await rows("SELECT slug FROM organization WHERE id = ?", [orgId]))[0], "slug"), "organization slug")
const asOwner = den.as(owner, orgId)
/** The owner's SSO session once the organization requires SSO (their password session no longer opens it). */
let asAdmin = asOwner

function registration(idp: typeof idpA, domains: string[], name: string) {
  const { kind: _kind, domain: _domain, ...config } = idp.registration({ skipDiscovery: true })
  return { ...config, domains, name }
}

/** ARRANGE ONLY: the administrator's connection test passed for the saved configuration. */
async function arrangeTestPassed(connectionId: string) {
  await client.execute("UPDATE sso_connection SET test_status = 'succeeded', last_tested_revision = config_revision, last_tested_at = NOW(3) WHERE id = ?", [connectionId])
}

async function loginOptions(email: string) {
  return den.request(null, "GET", `/v1/auth/login-options?${new URLSearchParams({ email }).toString()}`, {
    headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
  })
}

function names(value: unknown) {
  return Array.isArray(value) ? value.map((entry) => field(entry, "name")) : []
}

/** A real OIDC sign-in started the way Den Web starts it; returns the session and the identity provider that answered. */
async function oidcSignIn(body: Record<string, unknown>, person: Session = owner): Promise<{ session: Session; authorizationOrigin: string }> {
  const started = await den.request(null, "POST", "/api/auth/sign-in/sso", { body: { loginHint: person.email, callbackURL: "http://localhost:3005/", ...body } })
  assert.equal(started.status, 200, summary(started))
  const authorizationUrl = new URL(text(field(started.body, "url"), "authorization URL"))
  const authorization = await fetch(authorizationUrl, { redirect: "manual" })
  assert.equal(authorization.status, 302)
  const callbackUrl = new URL(text(authorization.headers.get("location"), "callback URL"))
  const cookies = started.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ")
  const callback = await den.request(null, "GET", `${callbackUrl.pathname}${callbackUrl.search}`, { headers: { cookie: cookies } })
  assert.equal(callback.status, 302, summary(callback))
  assert.equal(new URL(text(callback.headers.get("location"), "callback redirect")).searchParams.has("error"), false, callback.headers.get("location") ?? "")
  const cookie = callback.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
  const current = await den.request(null, "GET", "/api/auth/get-session", { headers: { cookie } })
  assert.equal(field(current.body, "user", "id"), person.userId, summary(current))
  return { session: { ...person, cookie, token: text(field(current.body, "session", "token"), "SSO token") }, authorizationOrigin: authorizationUrl.origin }
}

let firstId = ""
let secondId = ""
let firstProviderId = ""
let secondProviderId = ""

test("flag off: the connection routes are off and the single connection takes one domain", async () => {
  const listed = await asOwner("GET", "/v1/sso/connections")
  assert.equal(listed.status, 404, summary(listed))
  assert.equal(field(listed.body, "error"), "feature_disabled")
  const added = await asOwner("POST", "/v1/sso/connections/oidc", registration(idpA, [mainDomain], "Okta"))
  assert.equal(added.status, 404, summary(added))
  const twoDomains = await asOwner("POST", "/v1/sso/oidc", registration(idpA, [mainDomain, subsidiaryDomain], "Okta"))
  assert.equal(twoDomains.status, 400, summary(twoDomains))
})

test("flag on: connections are added next to each other, each with its own provider, name and domains", async () => {
  const changed = await den.setFeature(orgId, "multipleSsoConnections", true)
  assert.equal(changed.status < 300, true, summary(changed))
  await den.setFeature(orgId, "ssoPerOrganization", true)

  const first = await asOwner("POST", "/v1/sso/connections/oidc", registration(idpA, [mainDomain], "Okta"))
  assert.equal(first.status, 201, summary(first))
  firstId = text(field(first.body, "connection", "id"), "first id")
  firstProviderId = text(field(first.body, "connection", "providerId"), "first provider")
  assert.equal(firstProviderId, `openwork-sso-${orgId}`, "the first connection keeps the organization's provider id")
  assert.equal(field(first.body, "connection", "displayName"), "Okta")

  const second = await asOwner("POST", "/v1/sso/connections/oidc", registration(idpB, [mainDomain, `${subsidiaryDomain.toUpperCase()}`], "Entra"))
  assert.equal(second.status, 201, summary(second))
  secondId = text(field(second.body, "connection", "id"), "second id")
  secondProviderId = text(field(second.body, "connection", "providerId"), "second provider")
  assert.equal(secondProviderId, secondId, "an added connection is its own provider")
  assert.deepEqual(field(second.body, "connection", "domains"), [mainDomain, subsidiaryDomain])
  assert.equal(field(second.body, "connection", "domain"), `${mainDomain},${subsidiaryDomain}`)
  const dnsNames = field(second.body, "connection", "domainVerificationDnsNames")
  assert.equal(Array.isArray(dnsNames) && dnsNames.length, 2, summary(second))

  const listed = await asOwner("GET", "/v1/sso/connections")
  assert.equal(listed.status, 200, summary(listed))
  const connections = field(listed.body, "connections")
  assert.ok(Array.isArray(connections))
  assert.deepEqual(connections.map((connection) => field(connection, "id")), [firstId, secondId])
  assert.deepEqual(connections.map((connection) => field(connection, "status")), ["disabled", "disabled"])

  const legacy = await asOwner("GET", "/v1/sso")
  assert.equal(field(legacy.body, "connection", "id"), firstId, "the single-connection route keeps managing the oldest")
})

test("each connection is enabled on its own, and sign-in lists the ready providers that cover the email", async () => {
  const untested = await asOwner("POST", `/v1/sso/connections/${secondId}/enable`)
  assert.equal(untested.status, 409, summary(untested))

  await arrangeTestPassed(firstId)
  const enabledFirst = await asOwner("POST", `/v1/sso/connections/${firstId}/enable`)
  assert.equal(enabledFirst.status, 204, summary(enabledFirst))
  let options = await loginOptions(`someone@${mainDomain}`)
  assert.equal(field(options.body, "nextStep"), "sso", summary(options))
  assert.deepEqual(names(field(options.body, "ssoProviders")), ["Okta"])

  await arrangeTestPassed(secondId)
  const enabledSecond = await asOwner("POST", `/v1/sso/connections/${secondId}/enable`)
  assert.equal(enabledSecond.status, 204, summary(enabledSecond))
  options = await loginOptions(`someone@${mainDomain}`)
  assert.deepEqual(names(field(options.body, "ssoProviders")), ["Okta", "Entra"])
  options = await loginOptions(`someone@${subsidiaryDomain}`)
  assert.equal(field(options.body, "nextStep"), "sso", summary(options))
  assert.deepEqual(names(field(options.body, "ssoProviders")), ["Entra"], "a provider only signs in its own domains")

  const page = await den.request(null, "GET", `/v1/auth/sso-options?organizationSlug=${encodeURIComponent(orgSlug)}`)
  assert.equal(page.status, 200, summary(page))
  assert.deepEqual(names(field(page.body, "providers")), ["Okta", "Entra"])
  const unknown = await den.request(null, "GET", "/v1/auth/sso-options?organizationSlug=no-such-org-anywhere")
  assert.equal(unknown.status, 404, summary(unknown))
})

test("a sign-in through either provider opens an organization that requires SSO", async () => {
  const viaA = await oidcSignIn({ providerId: firstProviderId })
  assert.equal(viaA.authorizationOrigin, new URL(idpA.issuer).origin)
  const required = await den.as(viaA.session, orgId)("PATCH", "/v1/org", { requireSso: true })
  assert.equal(required.status, 200, summary(required))

  const password = await den.signIn(owner.email)
  assert.equal(password.status, 200, summary(password))
  const blocked = await den.request(text(field(password.body, "token"), "password token"), "GET", "/v1/org", { orgId })
  assert.equal(blocked.status, 403, summary(blocked))

  const viaB = await oidcSignIn({ providerId: secondProviderId })
  assert.equal(viaB.authorizationOrigin, new URL(idpB.issuer).origin)
  const opened = await den.as(viaB.session, orgId)("GET", "/v1/org")
  assert.equal(opened.status, 200, summary(opened))
  asAdmin = den.as(viaB.session, orgId)
})

test("a sign-in that names only the organization goes to a ready connection, never a disabled one", async () => {
  const disabled = await asAdmin("POST", `/v1/sso/connections/${firstId}/disable`)
  assert.equal(disabled.status, 204, summary(disabled))
  const bySlug = await oidcSignIn({ organizationSlug: orgSlug })
  assert.equal(bySlug.authorizationOrigin, new URL(idpB.issuer).origin)
  const byEmail = await oidcSignIn({ email: owner.email })
  assert.equal(byEmail.authorizationOrigin, new URL(idpB.issuer).origin)
  const options = await loginOptions(`someone@${mainDomain}`)
  assert.deepEqual(names(field(options.body, "ssoProviders")), ["Entra"])
  const direct = await den.request(null, "POST", "/api/auth/sign-in/sso", { body: { providerId: firstProviderId, callbackURL: "http://localhost:3005/" } })
  assert.equal(direct.status, 403, summary(direct))
})

test("renaming keeps a connection enabled; deleting one leaves the others", async () => {
  const renamed = await asAdmin("PATCH", `/v1/sso/connections/${secondId}`, { name: "Microsoft" })
  assert.equal(renamed.status, 200, summary(renamed))
  assert.equal(field(renamed.body, "connection", "displayName"), "Microsoft")
  assert.equal(field(renamed.body, "connection", "status"), "enabled")
  const cleared = await asAdmin("PATCH", `/v1/sso/connections/${secondId}`, { name: "" })
  assert.equal(field(cleared.body, "connection", "name"), null)
  assert.equal(typeof field(cleared.body, "connection", "displayName"), "string")

  const foreign = await den.signUp("Foreign Owner")
  const { orgId: foreignOrg } = await den.createOrg(foreign, "Foreign organization")
  await den.setFeature(foreignOrg, "multipleSsoConnections", true)
  const notTheirs = await den.as(foreign, foreignOrg)("DELETE", `/v1/sso/connections/${secondId}`)
  assert.equal(notTheirs.status, 404, summary(notTheirs))

  const deleted = await asAdmin("DELETE", `/v1/sso/connections/${firstId}`)
  assert.equal(deleted.status, 204, summary(deleted))
  const listed = await asAdmin("GET", "/v1/sso/connections")
  const connections = field(listed.body, "connections")
  assert.ok(Array.isArray(connections))
  assert.deepEqual(connections.map((connection) => field(connection, "id")), [secondId])
  const legacy = await asAdmin("GET", "/v1/sso")
  assert.equal(field(legacy.body, "connection", "id"), secondId)
})

test("a connection for domains another connection verified needs no new DNS record; a new domain does", async () => {
  const issuer = "https://idp-c.example.test"
  const manual = {
    issuer,
    clientId: "client-c",
    clientSecret: "secret-c",
    skipDiscovery: true,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksEndpoint: `${issuer}/jwks`,
  }
  const reused = await asAdmin("POST", "/v1/sso/connections/oidc", { ...manual, domains: [subsidiaryDomain] })
  assert.equal(reused.status, 201, summary(reused))
  assert.equal(field(reused.body, "connection", "domainVerified"), true, summary(reused))
  const fresh = await asAdmin("POST", "/v1/sso/connections/oidc", { ...manual, domains: [subsidiaryDomain, `new-${stamp}.example`] })
  assert.equal(fresh.status, 201, summary(fresh))
  assert.equal(field(fresh.body, "connection", "domainVerified"), false, summary(fresh))
})

test("an administrator tests one connection while another stays enabled", async () => {
  const added = await asAdmin("POST", "/v1/sso/connections/oidc", registration(idpA, [mainDomain], "Okta again"))
  assert.equal(added.status, 201, summary(added))
  const connectionId = text(field(added.body, "connection", "id"), "added id")
  const created = await asAdmin("POST", `/v1/sso/connections/${connectionId}/test`)
  assert.equal(created.status, 201, summary(created))
  const intentId = text(field(created.body, "intentId"), "intent id")
  const started = await asAdmin("POST", `/v1/sso/test/${intentId}/start`)
  assert.equal(started.status, 200, summary(started))
  const authorizationUrl = new URL(text(field(started.body, "url"), "test authorization URL"))
  assert.equal(authorizationUrl.origin, new URL(idpA.issuer).origin, "the test runs against the connection it tests")
  const authorization = await fetch(authorizationUrl, { redirect: "manual" })
  const callbackUrl = new URL(text(authorization.headers.get("location"), "callback URL"))
  const cookies = started.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ")
  const callback = await den.request(null, "GET", `${callbackUrl.pathname}${callbackUrl.search}`, { headers: { cookie: cookies } })
  assert.equal(callback.status, 302, summary(callback))

  const tested = await asAdmin("GET", `/v1/sso/connections/${connectionId}`)
  assert.equal(field(tested.body, "connection", "testStatus"), "succeeded", summary(tested))
  const enabled = await asAdmin("POST", `/v1/sso/connections/${connectionId}/enable`)
  assert.equal(enabled.status, 204, summary(enabled))
  const listed = await asAdmin("GET", "/v1/sso/connections")
  const connections = field(listed.body, "connections")
  assert.ok(Array.isArray(connections))
  assert.deepEqual(connections.filter((connection) => field(connection, "status") === "enabled").map((connection) => field(connection, "id")), [secondId, connectionId])
})
