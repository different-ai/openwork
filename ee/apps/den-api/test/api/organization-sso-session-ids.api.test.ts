/** Synthetic MCP sessions have no browser SSO proof: refuse them, never crash or bypass SSO. */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, OrganizationTable, SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { sessionTokenMatches } from "../../src/session-token.js"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { createInternalMcpPrincipalHeader } = await import("../../src/session.js")
const { findSsoAccessBlock, findSsoBlockedOrganizations, readSessionSsoProof, recordSessionSsoAuthentication, sessionCanRequireOrganizationSso } = await import("../../src/organization-sso-access.js")

for (const policy of ["requireSso", "restrictDomainToSso"]) {
  test(`${policy}: synthetic and malformed sessions fail closed; browser proof still grants access`, async () => {
    const { orgId, owner } = await den.createOrg(await den.signUp(`${policy} Owner`), `${policy} workspace`)
    const organizationId = normalizeDenTypeId("organization", orgId)
    const userId = normalizeDenTypeId("user", owner.userId)
    const providerId = `test-sso-${organizationId}`
    // Arrange an enabled, verified IdP and a required-SSO policy. The callback's proof is arranged below.
    await db.insert(SsoProviderTable).values({
      id: createDenTypeId("ssoProvider"), providerId, organizationId, userId,
      issuer: "https://idp.example.test", domain: "example.test", domainVerified: true,
    })
    await db.insert(SsoConnectionTable).values({
      id: createDenTypeId("ssoConnection"), providerId, organizationId, kind: "oidc", status: "enabled",
      issuer: "https://idp.example.test", domain: "example.test", signInPath: "/sso/test-workspace",
    })
    const internalHeaders = { "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({ userId, organizationId }) }
    const unrestricted = await den.request(null, "GET", "/v1/org", { headers: internalHeaders })
    assert.equal(unrestricted.status, 200, summary(unrestricted))
    await db.update(OrganizationTable).set({ metadata: JSON.stringify({ [policy]: true }) }).where(eq(OrganizationTable.id, organizationId))

    const browser = await den.as(owner, orgId)("GET", "/v1/org")
    assert.equal(browser.status, 403, summary(browser))
    assert.equal(field(browser.body, "error"), "sso_required")
    const mint = await den.as(owner, orgId)("POST", "/v1/mcp/token", {})
    assert.equal(mint.status, 403, summary(mint))
    assert.equal(field(mint.body, "error"), "sso_required")

    // Unlike the browser exchange, trusted headless issuance does not require a browser SSO session.
    const { mintHeadlessRunMcpToken, revokeHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
    const minted = await mintHeadlessRunMcpToken({ userId, organizationId })
    const { verifyMcpRequest } = await import("../../src/mcp/auth.js")
    const { DEN_MCP_RESOURCE } = await import("../../src/auth.js")
    try {
      const principal = await verifyMcpRequest(new Headers({ authorization: `Bearer ${minted.token}` }), DEN_MCP_RESOURCE)
      assert.ok(!(principal instanceof Response), "headless credentials authenticate without a browser SSO proof")
      assert.equal(principal.userId, userId)
      assert.equal(principal.organizationId, organizationId)
    } finally {
      await revokeHeadlessRunMcpToken(minted.tokenId)
    }

    // No browser token or org header: exercise actual signed-principal authentication and org resolution.
    const internal = await den.request(null, "GET", "/v1/org", { headers: internalHeaders })
    assert.equal(internal.status, 403, summary(internal))
    assert.equal(field(internal.body, "error"), "sso_required")
    const internalOrganizations = await den.request(null, "GET", "/v1/me/orgs", { headers: internalHeaders })
    assert.equal(internalOrganizations.status, 200, summary(internalOrganizations))
    assert.equal(field(internalOrganizations.body, "activeOrgId"), null)

    const [session] = await db.select({ id: AuthSessionTable.id }).from(AuthSessionTable).where(sessionTokenMatches(owner.token)).limit(1)
    assert.ok(session)
    for (const sessionId of ["mcp_internal", "malformed", "", "ses_invalid", createDenTypeId("user"), session.id]) {
      assert.equal((await findSsoAccessBlock({ sessionId, organizationId }))?.organizationId, organizationId)
      assert.equal((await findSsoBlockedOrganizations({ sessionId, organizationIds: [organizationId] })).has(organizationId), true)
      assert.equal(await sessionCanRequireOrganizationSso({ sessionId, organizationId }), false)
      assert.equal(await readSessionSsoProof({ sessionId, userId, organizationId }), null)
    }

    await recordSessionSsoAuthentication({ sessionId: session.id, userId, providerId })
    assert.equal(await findSsoAccessBlock({ sessionId: session.id, organizationId }), null)
    assert.equal(await sessionCanRequireOrganizationSso({ sessionId: session.id, organizationId }), true)
    assert.equal((await readSessionSsoProof({ sessionId: session.id, userId, organizationId }))?.providerId, providerId)
    const allowed = await den.as(owner, orgId)("GET", "/v1/org")
    assert.equal(allowed.status, 200, summary(allowed))
    const allowedMint = await den.as(owner, orgId)("POST", "/v1/mcp/token", {})
    assert.equal(allowedMint.status, 200, summary(allowedMint))
    const organizations = await den.as(owner, orgId)("GET", "/v1/me/orgs")
    assert.equal(organizations.status, 200, summary(organizations))
    assert.equal(field(organizations.body, "activeOrgId"), organizationId)
  })
}
