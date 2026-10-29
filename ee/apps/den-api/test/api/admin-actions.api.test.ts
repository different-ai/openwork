/**
 * Permission-gated admin actions: only the owner registers SAML (sso.manage),
 * a SCIM bearer stops working once SCIM provisioning is removed, and a member
 * without Manage OpenWork Models cannot change the organization default model.
 * Ported from evals/core/scim-okta-lifecycle.e2e.test.ts and
 * evals/core/den-org-default-model.e2e.test.ts.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
const API_ORIGIN = "http://127.0.0.1:8790"

function saml(label: string, domain: string) {
  return {
    issuer: `http://127.0.0.1/okta/${label}-${den.stamp}`,
    domain,
    entryPoint: `https://okta.example.test/app/openwork/${label}-${den.stamp}/sso/saml`,
    cert: "okta-test-signing-certificate",
    audience: API_ORIGIN,
  }
}

function scim(bearer: string, method: "GET" | "POST", path: string, body?: unknown) {
  return den.request(null, method, `/api/auth/scim/v2${path}`, {
    headers: { authorization: `Bearer ${bearer}`, accept: "application/scim+json, application/json", "content-type": "application/scim+json" },
    rawBody: body === undefined ? undefined : JSON.stringify(body),
  })
}

test("only the owner registers a SAML connection: an admin is refused, naming sso.manage", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Sam Owner"), "SSO org")
  const admin = await den.newMember(owner, orgId, "Ada Admin")
  const promoted = await den.as(owner, orgId)("POST", `/v1/members/${admin.memberId}/role`, { role: "admin" })
  assert.equal(promoted.status, 200, summary(promoted))

  const refused = await den.as(admin, orgId)("POST", "/v1/sso/saml", saml("admin-attempt", `admin-attempt-${den.stamp}.test`))
  assert.equal(refused.status, 403, summary(refused))
  assert.equal(field(refused.body, "error"), "forbidden")
  assert.equal(field(refused.body, "requiredPermission"), "sso.manage")
  const none = await den.as(owner, orgId)("GET", "/v1/sso")
  assert.equal(field(none.body, "connection"), null, `no connection was saved: ${summary(none)}`)

  const saved = await den.as(owner, orgId)("POST", "/v1/sso/saml", saml("owner", `owner-${den.stamp}.test`))
  assert.equal(saved.status, 201, summary(saved))
  const read = await den.as(owner, orgId)("GET", "/v1/sso")
  assert.equal(typeof field(read.body, "connection", "acsUrl"), "string", summary(read))
})

test("removing SCIM provisioning revokes the identity provider's bearer: it can neither read nor create users", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Sky Owner"), "SCIM org")
  const domain = `scim-${den.stamp}.test`
  const saved = await den.as(owner, orgId)("POST", "/v1/sso/saml", saml("scim", domain))
  assert.equal(saved.status, 201, summary(saved))
  await den.arrangeSsoConnectionEnabled(orgId)

  assert.equal((await scim("nonsense", "GET", "/Users")).status, 401)
  const issued = await den.as(owner, orgId)("POST", "/v1/scim/token")
  assert.equal(issued.status, 201, summary(issued))
  const bearer = text(field(issued.body, "scimToken"), "SCIM token")
  const listed = await scim(bearer, "GET", "/Users")
  assert.equal(listed.status, 200, summary(listed))
  assert.equal(field(listed.body, "totalResults"), 0)

  const removed = await den.as(owner, orgId)("DELETE", "/v1/scim")
  assert.equal(removed.status, 204, summary(removed))
  assert.equal((await scim(bearer, "GET", "/Users")).status, 401)
  const stale = await scim(bearer, "POST", "/Users", {
    schemas: [SCIM_USER_SCHEMA], userName: `stale@${domain}`, name: { givenName: "Stale", familyName: "Provider" },
    emails: [{ primary: true, value: `stale@${domain}`, type: "work" }], externalId: "00u-stale", active: true,
  })
  assert.equal(stale.status, 401, summary(stale))
})

test("a member without Manage OpenWork Models cannot change the organization default model", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Mo Owner"), "Default model org")
  const maya = await den.newMember(owner, orgId, "Maya Modeler")
  const provider = await den.as(owner, orgId)("POST", "/v1/llm-providers", {
    name: "Anthropic",
    source: "custom",
    customConfig: {
      id: "anthropic", name: "Anthropic", npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:9/v1" }, env: ["ANTHROPIC_API_KEY"],
      models: [{ id: "claude-sonnet-example", name: "Claude Sonnet" }, { id: "claude-opus-example", name: "Claude Opus" }],
    },
    apiKey: "sk-openwork-default-model-test-only",
    allMembers: true, memberIds: [], teamIds: [],
  })
  assert.equal(provider.status, 201, summary(provider))
  const providerId = text(field(provider.body, "llmProvider", "id"), "provider id")
  const chosen = { providerId, modelId: "claude-opus-example" }
  const set = await den.as(owner, orgId)("PUT", "/v1/org/default-model/everyone", { model: chosen })
  assert.equal(set.status, 200, summary(set))

  for (const model of [null, { providerId, modelId: "claude-sonnet-example" }]) {
    const denied = await den.as(maya, orgId)("PUT", "/v1/org/default-model/everyone", { model })
    assert.equal(denied.status, 403, summary(denied))
    assert.equal(field(denied.body, "requiredPermission"), "inference.manage")
  }
  const saved = await den.as(owner, orgId)("GET", "/v1/org/default-model")
  assert.deepEqual(field(saved.body, "everyone"), chosen)
})
