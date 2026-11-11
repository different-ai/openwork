import assert from "node:assert/strict"
import { test } from "node:test"
import { PrivateUrlError } from "../src/capability-sources/url-guard.js"
import { checkOidcDiscovery, isOidcDiscoveryUrl } from "../src/sso-oidc-discovery.js"

const ISSUER = "https://login.example.test"
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`

const document = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
}

/** A provider that serves its discovery document at one address and 404s elsewhere. */
function provider(calls: string[] = [], body: unknown = document) {
  return async (url: string | URL) => {
    calls.push(String(url))
    return String(url) === DISCOVERY ? Response.json(body) : new Response("not found", { status: 404 })
  }
}

test("an issuer gets the well-known path appended and its endpoints read", async () => {
  const calls: string[] = []
  const result = await checkOidcDiscovery(`${ISSUER}/`, provider(calls))
  assert.deepEqual(calls, [DISCOVERY])
  assert.deepEqual(result, {
    ok: true,
    issuer: ISSUER,
    discoveryUrl: DISCOVERY,
    fromDiscoveryUrl: false,
    authorizationEndpoint: `${ISSUER}/authorize`,
    tokenEndpoint: `${ISSUER}/token`,
    jwksEndpoint: `${ISSUER}/jwks`,
    userInfoEndpoint: null,
  })
})

test("a discovery URL is fetched as it is and the issuer comes from the document", async () => {
  const calls: string[] = []
  const result = await checkOidcDiscovery(DISCOVERY, provider(calls))
  assert.deepEqual(calls, [DISCOVERY], "the well-known path is not appended twice")
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.issuer, ISSUER)
  assert.equal(result.ok && result.fromDiscoveryUrl, true)
  assert.equal(isOidcDiscoveryUrl(DISCOVERY), true)
  assert.equal(isOidcDiscoveryUrl(ISSUER), false)
})

test("a wrong address is reported with the exact URL tried and its status", async () => {
  const result = await checkOidcDiscovery(`${ISSUER}/oauth2`, provider())
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, "not_found")
  assert.equal(!result.ok && result.status, 404)
  assert.equal(!result.ok && result.discoveryUrl, `${ISSUER}/oauth2/.well-known/openid-configuration`)
  assert.match(!result.ok ? result.message : "", /No sign-in settings at https:\/\/login\.example\.test\/oauth2\/\.well-known\/openid-configuration \(404\)/)
})

test("an issuer the document does not name is a mismatch that offers the reported issuer", async () => {
  const result = await checkOidcDiscovery(ISSUER, provider([], { ...document, issuer: "https://other.example.test" }))
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.code, "issuer_mismatch")
  assert.equal(!result.ok && result.reportedIssuer, "https://other.example.test")
})

test("unusable input, documents and unreachable or private providers each get their own answer", async () => {
  const notUrl = await checkOidcDiscovery("login.example.test", provider())
  assert.equal(!notUrl.ok && notUrl.code, "invalid_url")
  const scheme = await checkOidcDiscovery("ftp://login.example.test", provider())
  assert.equal(!scheme.ok && scheme.code, "invalid_url")

  const incomplete = await checkOidcDiscovery(ISSUER, provider([], { issuer: ISSUER }))
  assert.equal(!incomplete.ok && incomplete.code, "invalid_document")
  const html = await checkOidcDiscovery(ISSUER, async () => new Response("<html>", { status: 200 }))
  assert.equal(!html.ok && html.code, "invalid_document")

  const down = await checkOidcDiscovery(ISSUER, async () => { throw new TypeError("fetch failed") })
  assert.equal(!down.ok && down.code, "unreachable")
  const blocked = await checkOidcDiscovery(ISSUER, async () => { throw new PrivateUrlError("private") })
  assert.equal(!blocked.ok && blocked.code, "blocked")
  const error = await checkOidcDiscovery(ISSUER, async () => new Response("", { status: 503 }))
  assert.equal(!error.ok && error.code, "http_error")
})
