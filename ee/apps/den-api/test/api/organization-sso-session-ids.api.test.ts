/** Session-backed agents retain SSO proof and can never fall back into a different organization. */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { Hono } from "hono"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, OrganizationTable, SessionSsoProofTable, SsoConnectionTable, SsoProviderTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { McpCredentialProofSource } from "../../src/mcp/credential-proof.js"
import type { OrganizationContextVariables } from "../../src/middleware/organization-context.js"
import type { UserOrganizationsContext } from "../../src/middleware/user-organizations.js"
import type { AuthContextVariables } from "../../src/session.js"
import { sessionTokenMatches } from "../../src/session-token.js"
import { bootDen, field, list, summary, type Call } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { createInternalMcpPrincipalHeader, getRequestSession, revokeBearerSession, verifyInternalMcpPrincipalHeader } = await import("../../src/session.js")
const { DEN_MCP_GRANT_ID_CLAIM, DEN_MCP_RESOURCE } = await import("../../src/auth.js")
const { mcpPrincipalProofSource, verifyMcpRequest } = await import("../../src/mcp/auth.js")
const { mintHeadlessRunMcpToken, revokeHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
const { resolveOrganizationContextMiddleware } = await import("../../src/middleware/organization-context.js")
const { findSsoAccessBlock, findSsoAccessBlockForCredential, findSsoBlockedOrganizations, readSessionSsoProof, recordSessionSsoAuthentication, sessionCanRequireOrganizationSso } = await import("../../src/organization-sso-access.js")

function assertAgentRefused(call: Call) {
  assert.equal(call.status, 403, summary(call))
  assert.equal(field(call.body, "error"), "sso_required", summary(call))
  assert.equal(field(call.body, "reason"), "agent_credential_without_sso_proof", summary(call))
}

for (const policy of ["requireSso", "restrictDomainToSso"]) {
  test(`${policy}: SSO agent authorization`, async (t) => {
    const { orgId, owner } = await den.createOrg(await den.signUp(`${policy} Owner`), `${policy} workspace`)
    const plain = await den.createOrg(owner, `${policy} plain workspace`)
    const organizationId = normalizeDenTypeId("organization", orgId)
    const plainOrganizationId = normalizeDenTypeId("organization", plain.orgId)
    const userId = normalizeDenTypeId("user", owner.userId)
    const providerId = `test-sso-${organizationId}`
    const foreignWorkerId = createDenTypeId("worker")
    const ownWorkerId = createDenTypeId("worker")
    const [session] = await db.select({ id: AuthSessionTable.id }).from(AuthSessionTable).where(sessionTokenMatches(owner.token)).limit(1)
    assert.ok(session)
    // Arrange an enabled, verified IdP, two memberships and one worker in each organization.
    await db.insert(SsoProviderTable).values({
      id: createDenTypeId("ssoProvider"), providerId, organizationId, userId,
      issuer: "https://idp.example.test", domain: "example.test", domainVerified: true,
    })
    await db.insert(SsoConnectionTable).values({
      id: createDenTypeId("ssoConnection"), providerId, organizationId, kind: "oidc", status: "enabled",
      issuer: "https://idp.example.test", domain: "example.test", signInPath: "/sso/test-workspace",
    })
    await db.insert(WorkerTable).values([
      { id: foreignWorkerId, org_id: plainOrganizationId, created_by_user_id: userId, name: "Plain workspace worker", destination: "local", status: "healthy" },
      { id: ownWorkerId, org_id: organizationId, created_by_user_id: userId, name: "SSO workspace worker", destination: "local", status: "healthy" },
    ])
    const headersFor = (proofSource?: McpCredentialProofSource) => ({
      "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({ userId, organizationId, proofSource }),
    })
    const sessionSource: McpCredentialProofSource = { kind: "session", sessionId: session.id }
    // This credential predates Require SSO; a current proof is still needed when it re-enters the API.
    const tokenWithoutProof = await den.mintMcpToken(owner, orgId)
    const fresh = await den.signIn(owner.email)
    assert.equal(fresh.status, 200, summary(fresh))
    const freshToken = field(fresh.body, "token")
    if (typeof freshToken !== "string") throw new Error("fresh session token missing")
    const [freshSession] = await db.$primary.select({ id: AuthSessionTable.id }).from(AuthSessionTable).where(sessionTokenMatches(freshToken)).limit(1)
    assert.ok(freshSession)
    const unrestricted = await den.request(null, "GET", "/v1/org", { headers: headersFor() })
    assert.equal(unrestricted.status, 200, summary(unrestricted))
    await db.update(OrganizationTable).set({ metadata: JSON.stringify({ [policy]: true }) }).where(eq(OrganizationTable.id, organizationId))

    await t.test("browser without proof is refused, with the unchanged browser error", async () => {
      const browser = await den.as(owner, orgId)("GET", "/v1/org")
      assert.equal(browser.status, 403, summary(browser))
      assert.equal(field(browser.body, "error"), "sso_required")
      assert.equal(field(browser.body, "reason"), undefined)
      assert.equal(typeof field(browser.body, "signInUrl"), "string")
      const mint = await den.as(owner, orgId)("POST", "/v1/mcp/token", {})
      assert.equal(mint.status, 403, summary(mint))
    })

    await t.test("session-backed MCP credential without proof is refused with an actionable agent reason", async () => {
      assertAgentRefused(await den.request(null, "GET", "/v1/org", { headers: headersFor(sessionSource) }))
      const result = await den.callMcpTool(tokenWithoutProof, "execute_capability", { name: "getOrg" })
      assert.equal(result.isError, true, result.raw)
      assert.equal(field(result.body, "error"), "sso_required", result.raw)
      assert.equal(field(result.body, "reason"), "agent_credential_without_sso_proof", result.raw)
      const proxied = await den.request(tokenWithoutProof, "GET", "/v1/workbot/calendar/v1/llm-providers")
      assertAgentRefused(proxied)
      assert.equal(typeof field(proxied.body, "signInUrl"), "string")
    })

    await t.test("credential-bound requests never fall back to the plain organization, including worker deletion", async () => {
      for (const proof of [undefined, sessionSource]) {
        const headers = headersFor(proof)
        assertAgentRefused(await den.request(null, "GET", "/v1/me/orgs", { headers }))
        assertAgentRefused(await den.request(null, "GET", "/v1/workers", { headers }))
        assertAgentRefused(await den.request(null, "DELETE", `/v1/workers/${foreignWorkerId}`, { headers }))
        for (const route of ["/v1/me/orgs", "/v1/org", "/v1/workers"]) {
          const overridden = await den.request(null, "GET", route, { orgId: plain.orgId, headers })
          assert.equal(overridden.status, 403, summary(overridden))
        }
      }
      const listed = await den.as(plain.owner, plain.orgId)("GET", "/v1/workers")
      assert.equal(listed.status, 200, summary(listed))
      assert.deepEqual(list(field(listed.body, "workers")).map((worker) => worker.id), [foreignWorkerId])
    })

    await t.test("grant, run and absent proof sources fail closed, without a misleading sign-in link", async () => {
      const run = await mintHeadlessRunMcpToken({ userId, organizationId })
      try {
        const principal = await verifyMcpRequest(new Headers({ authorization: `Bearer ${run.token}` }), DEN_MCP_RESOURCE)
        assert.ok(!(principal instanceof Response))
        const runSource = mcpPrincipalProofSource(principal)
        assert.deepEqual(runSource, { kind: "run", tokenId: run.tokenId })
        const grantSource: McpCredentialProofSource = { kind: "grant", grantId: createDenTypeId("oauthConsent") }
        // A grant carrying an sid must not be downgraded into the more permissive session kind.
        assert.deepEqual(mcpPrincipalProofSource({ ...principal, payload: { ...principal.payload, sid: session.id, [DEN_MCP_GRANT_ID_CLAIM]: grantSource.grantId } }), grantSource)
        for (const proof of [undefined, grantSource, runSource ?? undefined]) {
          const call = await den.request(null, "GET", "/v1/org", { headers: headersFor(proof) })
          assertAgentRefused(call)
          assert.equal(field(call.body, "signInUrl"), undefined)
          assertAgentRefused(await den.request(null, "GET", "/v1/workers", { headers: headersFor(proof) }))
        }
        const result = await den.callMcpTool(run.token, "execute_capability", { name: "getOrg", body: { proofSource: sessionSource } })
        assert.equal(result.isError, true, result.raw)
        assert.equal(field(result.body, "reason"), "agent_credential_without_sso_proof", result.raw)
      } finally {
        await revokeHeadlessRunMcpToken(run.tokenId)
      }
    })

    await t.test("malformed IDs consistently mean no proof, including HTTP organization-context", async () => {
      for (const sessionId of [null, "mcp_internal", "malformed", "", "ses_invalid", createDenTypeId("user"), session.id]) {
        assert.equal((await findSsoAccessBlock({ sessionId, organizationId }))?.organizationId, organizationId)
        assert.equal((await findSsoBlockedOrganizations({ sessionId, organizationIds: [organizationId] })).has(organizationId), true)
        assert.equal(await sessionCanRequireOrganizationSso({ sessionId, organizationId }), false)
        assert.equal(await readSessionSsoProof({ sessionId: sessionId ?? "", userId, organizationId }), null)
        assert.ok(await findSsoAccessBlockForCredential({ kind: "session", sessionId: sessionId ?? "" }, organizationId))
      }
      const browser = await getRequestSession(new Headers({ authorization: `Bearer ${owner.token}` }))
      assert.ok(browser)
      const malformed = new Hono<{ Variables: AuthContextVariables & Partial<OrganizationContextVariables> & Partial<UserOrganizationsContext> }>()
      malformed.use("*", async (c, next) => {
        c.set("user", browser.user)
        c.set("session", { ...browser.session, id: "malformed", activeOrganizationId: organizationId })
        c.set("apiKey", null)
        await next()
      })
      malformed.get("/v1/org", resolveOrganizationContextMiddleware, (c) => c.json({ allowed: true }))
      const response = await malformed.request("/v1/org")
      assert.equal(response.status, 403)
      assert.equal(field(await response.json(), "error"), "sso_required")
    })

    // Arrange the proof the SSO callback writes for this exact live session, not for the user generally.
    await recordSessionSsoAuthentication({ sessionId: session.id, userId, providerId })
    const tokenWithProof = await den.mintMcpToken(owner, orgId)

    await t.test("desktop first-party token uses sid and retains its SSO proof through actual MCP invocation", async () => {
      const principal = await verifyMcpRequest(new Headers({ authorization: `Bearer ${tokenWithProof}` }), DEN_MCP_RESOURCE)
      assert.ok(!(principal instanceof Response))
      assert.deepEqual(mcpPrincipalProofSource(principal), sessionSource)
      assert.equal(await findSsoAccessBlockForCredential(sessionSource, organizationId), null)
      assert.equal((await readSessionSsoProof({ sessionId: session.id, userId, organizationId }))?.providerId, providerId)
      const browser = await den.as(owner, orgId)("GET", "/v1/org")
      assert.equal(browser.status, 200, summary(browser))
      const agent = await den.callMcpTool(tokenWithProof, "execute_capability", { name: "getOrg" })
      assert.equal(agent.isError, false, agent.raw)
      assert.equal(field(agent.body, "organization", "id"), organizationId, agent.raw)
      const proxied = await den.request(tokenWithProof, "GET", "/v1/workbot/calendar/v1/llm-providers")
      assert.equal(proxied.status, 200, summary(proxied))
      const workers = await den.callMcpTool(tokenWithProof, "execute_capability", { name: "getWorkers" })
      assert.equal(workers.isError, false, workers.raw)
      assert.deepEqual(list(field(workers.body, "workers")).map((worker) => worker.id), [ownWorkerId])
      const headers = headersFor(sessionSource)
      const organizations = await den.request(null, "GET", "/v1/me/orgs", { headers })
      assert.equal(organizations.status, 200, summary(organizations))
      assert.equal(field(organizations.body, "activeOrgId"), organizationId)
      assert.deepEqual(list(field(organizations.body, "orgs")).map((org) => org.id), [organizationId])
      const foreignDelete = await den.request(null, "DELETE", `/v1/workers/${foreignWorkerId}`, { headers })
      assert.equal(foreignDelete.status, 404, summary(foreignDelete))
    })

    await t.test("forged or omitted signed-header proof cannot borrow a user's existing SSO proof", async () => {
      for (const proof of [undefined, { kind: "grant", grantId: createDenTypeId("oauthConsent") }, { kind: "run", tokenId: createDenTypeId("oauthAccessToken") }] satisfies (McpCredentialProofSource | undefined)[]) {
        assertAgentRefused(await den.request(null, "GET", "/v1/org", { headers: headersFor(proof) }))
      }
      const unsigned = headersFor()["x-den-internal-mcp-principal"]
      const [payload, signature] = unsigned.split(".")
      const parsed: Record<string, unknown> = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
      const forged = `${Buffer.from(JSON.stringify({ ...parsed, proofSource: sessionSource })).toString("base64url")}.${signature}`
      assert.equal(verifyInternalMcpPrincipalHeader(forged), null)
      const denied = await den.request(null, "GET", "/v1/org", { headers: { "x-den-internal-mcp-principal": forged } })
      assert.equal(denied.status, 401, summary(denied))
      assertAgentRefused(await den.request(null, "GET", "/v1/org", { headers: headersFor({ kind: "session", sessionId: "malformed" }) }))
      // A different browser session for the same user has not earned this session's proof.
      assertAgentRefused(await den.request(null, "GET", "/v1/org", { headers: headersFor({ kind: "session", sessionId: freshSession.id }) }))
    })

    await t.test("even an SSO-backed agent cannot enable Require SSO: PATCH returns 409, not 500", async () => {
      await db.update(OrganizationTable).set({ metadata: "{}" }).where(eq(OrganizationTable.id, organizationId))
      try {
        const patch = await den.request(null, "PATCH", "/v1/org", { headers: headersFor(sessionSource), body: { [policy]: true } })
        assert.equal(patch.status, 409, summary(patch))
        assert.equal(field(patch.body, "error"), "sso_session_required")
      } finally {
        await db.update(OrganizationTable).set({ metadata: JSON.stringify({ [policy]: true }) }).where(eq(OrganizationTable.id, organizationId))
      }
    })

    await t.test("revoking the backing session refuses its MCP credential before internal re-entry", async () => {
      assert.equal(await revokeBearerSession(new Headers({ authorization: `Bearer ${owner.token}` })), true)
      const result = await den.callMcpTool(tokenWithProof, "execute_capability", { name: "getOrg" })
      assert.equal(result.status, 401, result.raw)
      const refusal: unknown = JSON.parse(result.raw)
      assert.equal(field(refusal, "error"), "mcp_session_revoked", result.raw)
    })
    await db.delete(SessionSsoProofTable).where(eq(SessionSsoProofTable.sessionId, session.id))
  })
}
