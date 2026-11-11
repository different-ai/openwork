/**
 * ssoOidcSetupCheck: the OIDC setup accepts an issuer or a discovery URL,
 * checks it against the identity provider and refuses a wrong one on the
 * issuer field.
 *
 * Runs through the real routes against a mock OIDC identity provider
 * (loopback issuers are reachable in dev mode).
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { startMockIdpLab } from "../../../../../evals/packages/labs/src/idp.ts"
import { bootDen, field, summary, text } from "./harness.js"

const stamp = Date.now().toString(36)
const domain = `oidc-check-${stamp}.example`
const idp = await startMockIdpLab({ domain, defaultSubject: { email: `owner@${domain}` } })
after(() => idp.stop())
const den = await bootDen({ env: { DEN_BETTER_AUTH_TRUSTED_ORIGINS: `http://localhost:3005,http://127.0.0.1:8790,${idp.issuer}` } })
after(() => den.close())

const owner = await den.signUp("Check Owner", `owner@${domain}`)
const { orgId } = await den.createOrg(owner, "OIDC setup check organization")
const asOwner = den.as(owner, orgId)

const discoveryUrl = `${idp.issuer}/.well-known/openid-configuration`

function registration(overrides: Record<string, unknown>) {
  const { kind: _kind, ...config } = idp.registration({ skipDiscovery: false })
  const { authorizationEndpoint: _a, tokenEndpoint: _t, jwksEndpoint: _j, userInfoEndpoint: _u, ...withoutEndpoints } = config
  return { ...withoutEndpoints, ...overrides }
}

function issuerProblem(body: unknown) {
  const details = field(body, "details")
  const first = Array.isArray(details) ? details[0] : null
  return { message: field(first, "message"), path: field(first, "path") }
}

test("flag off: a discovery URL saved as the issuer is refused with 400, and the check route is off", async () => {
  const check = await asOwner("POST", "/v1/sso/oidc/check", { issuer: idp.issuer })
  assert.equal(check.status, 404, summary(check))
  assert.equal(field(check.body, "error"), "feature_disabled")

  const saved = await asOwner("POST", "/v1/sso/oidc", registration({ issuer: discoveryUrl }))
  assert.equal(saved.status, 400, summary(saved))
  assert.deepEqual(issuerProblem(saved.body), {
    message: "OIDC discovery failed with 404. Enter manual OIDC endpoints or enable skip discovery.",
    path: ["issuer"],
  })
})

test("flag on: the check reports the issuer and endpoints behind an issuer or a discovery URL", async () => {
  const changed = await den.setFeature(orgId, "ssoOidcSetupCheck", true)
  assert.equal(changed.status < 300, true, summary(changed))

  const fromIssuer = await asOwner("POST", "/v1/sso/oidc/check", { issuer: idp.issuer })
  assert.equal(fromIssuer.status, 200, summary(fromIssuer))
  assert.equal(field(fromIssuer.body, "ok"), true)
  assert.equal(field(fromIssuer.body, "issuer"), idp.issuer)
  assert.equal(field(fromIssuer.body, "fromDiscoveryUrl"), false)
  assert.equal(field(fromIssuer.body, "tokenEndpoint"), `${idp.issuer}/token`)

  const fromDiscovery = await asOwner("POST", "/v1/sso/oidc/check", { issuer: discoveryUrl })
  assert.equal(field(fromDiscovery.body, "ok"), true, summary(fromDiscovery))
  assert.equal(field(fromDiscovery.body, "issuer"), idp.issuer)
  assert.equal(field(fromDiscovery.body, "fromDiscoveryUrl"), true)

  const wrong = await asOwner("POST", "/v1/sso/oidc/check", { issuer: `${idp.issuer}/oauth2` })
  assert.equal(wrong.status, 200, summary(wrong))
  assert.equal(field(wrong.body, "ok"), false)
  assert.equal(field(wrong.body, "code"), "not_found")
  assert.equal(field(wrong.body, "discoveryUrl"), `${idp.issuer}/oauth2/.well-known/openid-configuration`)
})

test("flag on: a wrong issuer is refused on the issuer field with the URL that was tried", async () => {
  const saved = await asOwner("POST", "/v1/sso/oidc", registration({ issuer: `${idp.issuer}/oauth2` }))
  assert.equal(saved.status, 400, summary(saved))
  const problem = issuerProblem(saved.body)
  assert.deepEqual(problem.path, ["issuer"])
  assert.equal(problem.message, `No sign-in settings at ${idp.issuer}/oauth2/.well-known/openid-configuration (404). Check the address, or enter the endpoints yourself.`)
})

test("flag on: manual endpoints refuse a discovery URL as the issuer", async () => {
  const { kind: _kind, ...manual } = idp.registration({ skipDiscovery: true })
  const saved = await asOwner("POST", "/v1/sso/oidc", { ...manual, issuer: discoveryUrl })
  assert.equal(saved.status, 400, summary(saved))
  assert.deepEqual(issuerProblem(saved.body), {
    message: "The issuer is the provider's base address, not its discovery URL.",
    path: ["issuer"],
  })
})

test("flag on: a discovery URL saves the connection under the provider's issuer and endpoints", async () => {
  const saved = await asOwner("POST", "/v1/sso/oidc", registration({ issuer: discoveryUrl }))
  assert.equal(saved.status, 201, summary(saved))
  assert.equal(field(saved.body, "connection", "issuer"), idp.issuer)
  assert.equal(field(saved.body, "connection", "oidc", "tokenEndpoint"), `${idp.issuer}/token`)
  assert.equal(field(saved.body, "connection", "oidc", "jwksEndpoint"), `${idp.issuer}/jwks`)
  text(field(saved.body, "connection", "id"), "connection id")
})

test("domain check: saving again keeps the same TXT value, and with the flag on a failed check says which record failed", async () => {
  // A public issuer, so dev mode does not mark the domain verified on save.
  const { kind: _kind, ...manual } = idp.registration({ skipDiscovery: true })
  const publicIssuer = { ...manual, issuer: `https://idp.${domain}` }

  assert.equal((await den.setFeature(orgId, "ssoOidcSetupCheck", false)).status < 300, true)
  const first = await asOwner("POST", "/v1/sso/oidc", publicIssuer)
  assert.equal(first.status, 201, summary(first))
  assert.equal(field(first.body, "connection", "domainVerified"), false)
  const value = text(field(first.body, "domainVerificationToken"), "TXT value")

  const again = await asOwner("POST", "/v1/sso/oidc", publicIssuer)
  assert.equal(again.status, 201, summary(again))
  assert.equal(field(again.body, "domainVerificationToken"), value, "a save must not replace a value an administrator may already have published")

  const off = await asOwner("POST", "/v1/sso/verify-domain", {})
  assert.equal(off.status, 400, summary(off))
  assert.equal(field(off.body, "domainVerification"), undefined)

  assert.equal((await den.setFeature(orgId, "ssoOidcSetupCheck", true)).status < 300, true)
  const on = await asOwner("POST", "/v1/sso/verify-domain", {})
  assert.equal(on.status, 400, summary(on))
  const dnsName = text(field(again.body, "connection", "domainVerificationDnsName"), "record name")
  assert.equal(field(on.body, "domainVerification", "dnsName"), dnsName)
  assert.equal(field(on.body, "domainVerification", "domain"), domain)
  // No resolver has a record under the reserved .example name; offline runs cannot reach one at all.
  assert.ok(["record_missing", "lookup_failed"].includes(String(field(on.body, "domainVerification", "reason"))), summary(on))
})
