import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono, type Context, type Next } from "hono"
import { z } from "zod"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import type { OrganizationSsoRegistrationInput } from "../src/sso.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"
import { withSsoEmailDomainProof } from "../src/sso-email-domain-proof.js"

const organizationId = createDenTypeId("organization")
const providerId = `openwork-sso-${organizationId}`
const userId = createDenTypeId("user")
const connection: typeof SsoConnectionTable.$inferSelect = {
  id: createDenTypeId("ssoConnection"), organizationId, providerId, kind: "oidc", issuer: "https://idp.example.test", domain: "example.test",
  status: "enabled", signInPath: "/sso/proof", configRevision: "current", testStatus: "succeeded", lastTestedRevision: "current",
  lastTestedAt: new Date(), lastError: null, domainVerificationToken: "stale-display-only-token", activeTestIntentId: null,
  activeTestUserId: null, activeTestProviderId: null, activeTestConfigRevision: null, activeTestExpiresAt: null, activeTestStartedAt: null,
  createdAt: new Date(), updatedAt: new Date(),
}
const provider: typeof SsoProviderTable.$inferSelect = {
  id: createDenTypeId("ssoProvider"), organizationId, providerId, userId, issuer: connection.issuer, domain: connection.domain,
  domainVerified: true, oidcConfig: "{}", samlConfig: null, createdAt: new Date(), updatedAt: new Date(),
}
const saved: OrganizationSsoRegistrationInput[] = []
const requested: string[] = []
const verified: string[] = []
let allowed = true
let registerRoutes: typeof import("../src/routes/org/sso.js").registerOrgSsoRoutes

beforeAll(async () => {
  mock.module("../src/env.js", () => ({ env: { betterAuthUrl: "http://localhost:3000", devMode: false } }))
  mock.module("../src/auth.js", () => ({ auth: { api: {} } }))
  mock.module("../src/audit-events.js", () => ({ ORGANIZATION_AUDIT_ACTIONS: { ssoConnectionRegistered: "sso.registered" }, recordOrganizationAuditEvent: async () => {} }))
  mock.module("../src/entitlements.js", () => ({ checkEntitlement: () => ({ ok: true }) }))
  mock.module("../src/openapi.js", () => ({ enterprisePlanRequiredSchema: z.object({ error: z.string() }), xmlResponse: () => ({ description: "XML" }) }))
  mock.module("../src/middleware/index.js", () => ({ orgMemberRoute: () => async (c: Context, next: Next) => {
    c.set("organizationContext", { organization: { id: organizationId, slug: "proof", metadata: {} }, currentMember: { userId } })
    await next()
  } }))
  mock.module("../src/routes/org/shared.js", () => ({
    ensureSsoManager: () => allowed ? { ok: true } : { ok: false, response: { error: "forbidden", message: "Only owners and super-admins." } },
    ensureSsoReader: () => ({ ok: true }), orgAccessFailureStatus: () => 403,
  }))
  mock.module("../src/sso.js", () => ({
    deleteOrganizationSsoConnection: async () => false, getOrganizationSsoConnection: async () => connection,
    getOrganizationSsoSignInPath: () => "/sso/proof", getSsoAcsUrl: () => "http://localhost:3000/acs",
    getSsoMetadataUrl: () => "http://localhost:3000/metadata", getSsoOidcRedirectUrl: () => "http://localhost:3000/callback",
    getSsoProviderForConnection: async () => provider,
    registerOrganizationSsoConnection: async (input: OrganizationSsoRegistrationInput) => { saved.push(input); return connection },
  }))
  mock.module("../src/sso-test-lifecycle.js", () => ({
    beginOrganizationSsoTestIntent: async () => ({ ok: false }), buildSsoTestCompletionUrl: () => "",
    createOrganizationSsoTestIntent: async () => ({ ok: false }), disableOrganizationSsoConnection: async () => ({ ok: false }),
    enableOrganizationSsoConnection: async () => ({ ok: false }), failOrganizationSsoTestIntent: async () => false,
    getSsoTestPresentation: () => ({ testStatus: "succeeded", lastError: null, testExpiresAt: null }),
  }))
  mock.module("../src/sso-domain-proof-service.js", () => ({ ssoDomainProofService: {
    request: async (id: string) => { requested.push(id); return { domainVerificationToken: "current-expiring-service-token" } },
    verify: async (id: string) => { verified.push(id) },
  } }))
  registerRoutes = (await import("../src/routes/org/sso.js")).registerOrgSsoRoutes
})

beforeEach(() => {
  saved.length = 0; requested.length = 0; verified.length = 0
  provider.oidcConfig = "{}"
  allowed = true
})
afterAll(() => mock.restore())

function app() {
  const result = new Hono<{ Variables: OrgRouteVariables }>()
  registerRoutes(result)
  return result
}

test("legacy-enabled JSON exposes missing email proof without disabling sign-in", async () => {
  const response = await app().request("/v1/sso")
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ connection: { status: "enabled", domainVerified: true, emailDomainVerified: false } })
  provider.oidcConfig = withSsoEmailDomainProof({}, { version: 1, organizationId, providerId, domain: "example.test", method: "dns-txt", verifiedAt: new Date().toISOString() })
  expect(await (await app().request("/v1/sso")).json()).toMatchObject({ connection: { domainVerified: true, emailDomainVerified: true } })
})

test("legacy-enabled request and verify use the service, never the stale display token or SDK verification", async () => {
  const request = await app().request("/v1/sso/request-domain-verification", { method: "POST" })
  expect(request.status).toBe(201)
  expect(await request.json()).toEqual({ domainVerificationToken: "current-expiring-service-token" })
  expect((await app().request("/v1/sso/verify-domain", { method: "POST" })).status).toBe(204)
  expect(requested).toEqual([organizationId])
  expect(verified).toEqual([organizationId])
})

for (const kind of ["oidc", "saml"]) {
  test(`${kind}: public registration cannot inject server-owned proof/configuration fields`, async () => {
    const malicious = { version: 1, organizationId, providerId, domain: "example.test", method: "dns-txt", verifiedAt: new Date().toISOString() }
    const response = await app().request(`/v1/sso/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      issuer: "https://idp.example.test", domain: "example.test", clientId: "client", clientSecret: "secret", entryPoint: "https://idp.example.test/sso", cert: "synthetic-cert",
      openworkEmailDomainProof: malicious, domainVerified: true, emailDomainVerified: true,
      oidcConfig: { openworkEmailDomainProof: malicious }, samlConfig: { openworkEmailDomainProof: malicious },
    }) })
    expect(response.status).toBe(201)
    expect(saved).toHaveLength(1)
    expect(saved[0]).not.toHaveProperty("openworkEmailDomainProof")
    expect(saved[0]).not.toHaveProperty("oidcConfig")
    expect(saved[0]).not.toHaveProperty("samlConfig")
    expect(saved[0]).not.toHaveProperty("domainVerified")
    expect(await response.json()).toMatchObject({ connection: { emailDomainVerified: false } })
  })
}

test("public registration rejects wildcard, URL, and domain-list authority", async () => {
  for (const domain of ["*.example.test", "https://example.test", "example.test,other.test"]) {
    const response = await app().request("/v1/sso/oidc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      issuer: "https://idp.example.test", domain, clientId: "client", clientSecret: "secret",
    }) })
    expect(response.status).toBe(400)
  }
  expect(saved).toHaveLength(0)
})

test("DNS provenance operations retain the owner/super-admin gate", async () => {
  allowed = false
  for (const path of ["request-domain-verification", "verify-domain"]) expect((await app().request(`/v1/sso/${path}`, { method: "POST" })).status).toBe(403)
  expect(requested).toEqual([])
  expect(verified).toEqual([])
})
