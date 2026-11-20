import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuthAccountTable, OrganizationTable, SessionSsoProofTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, summary, text, type Member } from "./harness.js"

const den = await bootDen()
const { db } = await import("../../src/db.js")
const { createInternalMcpPrincipalHeader } = await import("../../src/session.js")
const { mintHeadlessRunMcpToken } = await import("../../src/mcp/headless-run-token-mint.js")
after(() => den.close())

let owner: Member
let orgId: string
let desktopToken: string
let apiKey: string

function internalHeaders() {
  return { "x-den-internal-mcp-principal": createInternalMcpPrincipalHeader({ userId: owner.userId, organizationId: orgId }) }
}

before(async () => {
  const created = await den.createOrg(await den.signUp("SSO owner"), "SSO workspace")
  owner = created.owner
  orgId = created.orgId
  desktopToken = await den.mintMcpToken(owner, orgId)
  const key = await den.as(owner, orgId)("POST", "/v1/api-keys", { name: "Existing key" })
  assert.equal(key.status, 201, summary(key))
  apiKey = text(field(key.body, "key"), "API key")

  const saml = await den.as(owner, orgId)("POST", "/v1/sso/saml", {
    issuer: `http://127.0.0.1/idp/${den.stamp}`,
    domain: `sso-${den.stamp}.test`,
    entryPoint: "https://login.example.test/saml2",
    cert: "idp-test-signing-certificate",
    audience: "http://127.0.0.1:8790",
  })
  assert.equal(saml.status, 201, summary(saml))
  await den.arrangeSsoConnectionEnabled(orgId)
})

test("sign-in options distinguish the current session's SSO proof from the account's password", async () => {
  const path = "/v1/me/sso-sign-in"
  assert.equal((await den.request(null, "GET", path)).status, 401)

  const user = await den.signUp("Sign-in options")
  const readOptions = () => den.request(user.token, "GET", path)
  const passwordSession = await readOptions()
  assert.equal(passwordSession.status, 200, summary(passwordSession))
  assert.equal(field(passwordSession.body, "sessionUsesSso"), false)
  assert.equal(field(passwordSession.body, "hasPasswordCredential"), true)

  const { body: profile } = await den.request(user.token, "GET", "/v1/me")
  const sessionId = normalizeDenTypeId("session", text(field(profile, "session", "id"), "session ID"))
  const userId = normalizeDenTypeId("user", user.userId)
  // A proof written for a different session does not affect this session.
  const other = await den.signIn(user.email)
  assert.equal(other.status, 200, summary(other))
  const otherProfile = await den.request(text(field(other.body, "token"), "other session token"), "GET", "/v1/me")
  const otherId = normalizeDenTypeId("session", text(field(otherProfile.body, "session", "id"), "other session ID"))
  assert.notEqual(otherId, sessionId)
  const proof = {
    userId,
    organizationId: normalizeDenTypeId("organization", orgId),
    ssoProviderId: "fixture-provider",
    authenticatedAt: new Date(),
  }
  await db.insert(SessionSsoProofTable).values({ ...proof, sessionId: otherId })
  assert.equal(field((await readOptions()).body, "sessionUsesSso"), false)

  await db.insert(SessionSsoProofTable).values({ ...proof, sessionId })
  await db.update(AuthAccountTable).set({ password: null }).where(eq(AuthAccountTable.userId, userId))
  const ssoSession = await readOptions()
  assert.equal(ssoSession.status, 200, summary(ssoSession))
  assert.equal(field(ssoSession.body, "sessionUsesSso"), true)
  assert.equal(field(ssoSession.body, "hasPasswordCredential"), false)
})

test("an agent cannot enable Require SSO without a real SSO session", async () => {
  const result = await den.request(null, "PATCH", "/v1/org", { headers: internalHeaders(), body: { requireSso: true } })
  assert.equal(result.status, 409, summary(result))
  assert.equal(field(result.body, "error"), "sso_session_required")
})

test("Require SSO blocks interactive sessions without proof, not existing agent or key credentials", async (t) => {
  // Arrange a policy enabled by an SSO-signed-in owner; this fixture has no IdP.
  await db.update(OrganizationTable).set({ metadata: JSON.stringify({ requireSso: true }) })
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", orgId)))

  await t.test("browser session cannot open the organization or mint new sign-in credentials", async () => {
    const headers = { cookie: owner.cookie }
    const results = [
      await den.request(null, "GET", "/v1/org", { orgId, headers }),
      await den.request(null, "POST", "/v1/me/active-organization", { headers, body: { organizationId: orgId } }),
      await den.request(null, "POST", "/v1/auth/desktop-handoff", { headers, body: {} }),
      await den.request(null, "POST", "/v1/mcp/token", { orgId, headers, body: { scopes: ["mcp:read"] } }),
    ]
    for (const result of results) {
      assert.equal(result.status, 403, summary(result))
      assert.equal(field(result.body, "error"), "sso_required")
    }
  })

  await t.test("first-party MCP token reaches the organization", async () => {
    const result = await den.callMcpTool(desktopToken, "execute_capability", { name: "getOrg" })
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.rpcError, null, result.raw)
    assert.equal(result.isError, false, result.raw)
    assert.equal(field(result.body, "organization", "id"), orgId, result.raw)
  })

  await t.test("headless run token used by Workbot reaches the organization", async () => {
    const { token } = await mintHeadlessRunMcpToken({ userId: owner.userId, organizationId: orgId, readOnly: true })
    const result = await den.callMcpTool(token, "execute_capability", { name: "getOrg" })
    assert.equal(result.status, 200, result.raw)
    assert.equal(result.rpcError, null, result.raw)
    assert.equal(result.isError, false, result.raw)
    assert.equal(field(result.body, "organization", "id"), orgId, result.raw)
  })

  for (const [label, headers] of Object.entries({ "Internal principal": internalHeaders(), "API key": { "x-api-key": apiKey } })) {
    await t.test(`${label} can open and list its organization`, async (t) => {
      await t.test("opens the organization", async () => {
        const org = await den.request(null, "GET", "/v1/org", { headers })
        assert.equal(org.status, 200, summary(org))
        assert.equal(field(org.body, "organization", "id"), orgId)
      })
      await t.test("keeps the organization active in the list", async () => {
        const orgs = await den.request(null, "GET", "/v1/me/orgs", { headers })
        assert.equal(orgs.status, 200, summary(orgs))
        assert.equal(field(orgs.body, "activeOrgId"), orgId)
      })
    })
  }
})
