/**
 * ENG-815: an identity provider renames a member's email. Den must keep one
 * user (matched by the provider's stable subject) and follow the rename, not
 * JIT-create a second user that locks the person out of their org role.
 *
 * Drives a real OIDC sign-in end to end against a tiny fake IdP: Den's
 * /api/auth/sign-in/sso -> IdP authorize -> /api/auth/sso/callback.
 */
import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { bootDen, field, startFakeHttpServer, summary, text, type Den } from "./harness.js"

type Identity = { sub: string; email: string }

let den: Den
let idp: Awaited<ReturnType<typeof startFakeHttpServer>>
/** What the fake IdP says about the person on the next sign-in. */
let nextIdentity: Identity = { sub: "", email: "" }
const codes = new Map<string, Identity>()

before(async () => {
  idp = await startFakeHttpServer((request, body, response) => {
    const url = new URL(request.url ?? "/", "http://idp.local")
    const json = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(value))
    }
    if (url.pathname === "/authorize") {
      const code = `code-${codes.size + 1}`
      codes.set(code, { ...nextIdentity })
      const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
      callback.searchParams.set("code", code)
      callback.searchParams.set("state", url.searchParams.get("state") ?? "")
      response.writeHead(302, { location: callback.toString() })
      response.end()
      return
    }
    if (url.pathname === "/token") {
      const code = new URLSearchParams(body).get("code") ?? ""
      json({ access_token: `token:${code}`, token_type: "Bearer", expires_in: 3600 })
      return
    }
    if (url.pathname === "/userinfo") {
      const code = (request.headers.authorization ?? "").replace(/^Bearer token:/, "")
      const identity = codes.get(code)
      if (!identity) {
        response.writeHead(401)
        response.end()
        return
      }
      json({ sub: identity.sub, email: identity.email, email_verified: true, name: "Renamed Person" })
      return
    }
    if (url.pathname === "/jwks") {
      json({ keys: [] })
      return
    }
    response.writeHead(404)
    response.end()
  })
  den = await bootDen({ env: { DEN_BETTER_AUTH_TRUSTED_ORIGINS: `http://localhost:3005,http://127.0.0.1:8790,${idp.url}` } })
})

after(async () => {
  await den?.close()
  await idp?.close()
})

function cookiesFrom(headers: Headers): string {
  return headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ")
}

/** One full SSO sign-in as `identity`; returns the Den user the session belongs to. */
async function signInWithSso(providerId: string, identity: Identity) {
  nextIdentity = identity
  const started = await den.request(null, "POST", "/api/auth/sign-in/sso", {
    body: { providerId, callbackURL: "http://localhost:3005/dashboard" },
  })
  assert.equal(started.status, 200, summary(started))
  const authorizeUrl = text(field(started.body, "url"), "authorize url")
  const cookie = cookiesFrom(started.headers)

  const authorized = await fetch(authorizeUrl, { redirect: "manual" })
  const callback = new URL(text(authorized.headers.get("location"), "callback location"))
  const finished = await den.request(null, "GET", `${callback.pathname}${callback.search}`, { headers: { cookie } })
  assert.equal(finished.status, 302, summary(finished))
  assert.doesNotMatch(finished.headers.get("location") ?? "", /error=/, `callback failed: ${finished.headers.get("location")}`)

  const session = await den.request(null, "GET", "/api/auth/get-session", { headers: { cookie: cookiesFrom(finished.headers) } })
  return { id: text(field(session.body, "user", "id"), "session user id"), email: text(field(session.body, "user", "email"), "session email") }
}

async function usersWithEmails(emails: string[]): Promise<string[]> {
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  const [rows] = await client.query("SELECT email FROM user WHERE email IN (?) ORDER BY email", [emails])
  return Array.isArray(rows) ? rows.map((row) => String(field(row, "email"))) : []
}

async function registerOidcOrg(label: string) {
  const domain = `${label}-${den.stamp}.test`
  const { orgId, owner } = await den.createOrg(await den.signUp(`Owner ${label}`), `Org ${label}`)
  const saved = await den.as(owner, orgId)("POST", "/v1/sso/oidc", {
    issuer: idp.url,
    domain,
    clientId: "den-test-client",
    clientSecret: "den-test-secret",
    skipDiscovery: true,
    authorizationEndpoint: `${idp.url}/authorize`,
    tokenEndpoint: `${idp.url}/token`,
    jwksEndpoint: `${idp.url}/jwks`,
    userInfoEndpoint: `${idp.url}/userinfo`,
  })
  assert.ok(saved.status < 300, summary(saved))
  const providerId = text(field(saved.body, "connection", "providerId"), "provider id")
  // ARRANGE ONLY: domain ownership is proven over DNS and the owner's IdP test
  // is interactive; neither is what this test observes.
  await den.arrangeSsoConnectionEnabled(orgId)
  const { client } = await import("../../src/db.js")
  if (!("getConnection" in client)) throw new Error("needs MySQL mode")
  await client.execute("UPDATE sso_provider SET domain_verified = 1 WHERE organization_id = ?", [orgId])
  return { domain, providerId }
}

test("an IdP email rename keeps the same Den user and follows the new email", async () => {
  const { domain, providerId } = await registerOidcOrg("rename")
  const oldEmail = `person@${domain}`
  const newEmail = `person.renamed@${domain}`

  const first = await signInWithSso(providerId, { sub: "stable-subject-1", email: oldEmail })
  assert.equal(first.email, oldEmail)

  const second = await signInWithSso(providerId, { sub: "stable-subject-1", email: newEmail })
  assert.equal(second.id, first.id, "the rename must not create a second user")
  assert.equal(second.email, newEmail, "the session reflects the IdP's new email")
  assert.deepEqual(await usersWithEmails([oldEmail, newEmail]), [newEmail])
})

test("an IdP cannot move a member to an email outside its verified domain", async () => {
  const { domain, providerId } = await registerOidcOrg("outside")
  const oldEmail = `person@${domain}`

  const first = await signInWithSso(providerId, { sub: "stable-subject-2", email: oldEmail })
  const second = await signInWithSso(providerId, { sub: "stable-subject-2", email: `person@elsewhere-${den.stamp}.test` })
  assert.equal(second.id, first.id)
  assert.equal(second.email, oldEmail, "email outside the provider's domain is ignored")
})
