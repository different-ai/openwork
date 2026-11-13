/**
 * Microsoft Foundry providers can hold member credential sets, where each member signs in with their own Entra ID
 * account. A Foundry provider's saved address must therefore stay on its own resource, or on an origin the operator
 * allowlisted, so nobody who manages providers can choose where colleagues' credentials are sent.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary, text } from "./harness.js"

const realFetch = globalThis.fetch
// Only the public model catalog Den reads is synthetic: one Foundry Claude model and one OpenAI model.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  return Response.json({
    azure: { id: "azure", name: "Fixture Azure", npm: "@ai-sdk/azure", env: ["AZURE_API_KEY"], models: {
      "claude-fixture": { id: "claude-fixture", name: "Fixture Claude", limit: { context: 200000, output: 8000 },
        provider: { npm: "@ai-sdk/anthropic", api: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1" } },
    } },
    openai: { id: "openai", name: "Fixture OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: {
      "gpt-fixture": { id: "gpt-fixture", name: "Fixture GPT", limit: { context: 100000, output: 1000 } },
    } },
  })
}
const den = await bootDen({ env: {
  GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:8791", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:8791",
  GATEWAY_EGRESS_ALLOWED_ORIGINS: "https://foundry-proxy.operator.example",
} })
after(async () => { globalThis.fetch = realFetch; await den.close() })

const foundry = (settings: Record<string, string>) => ({ name: "Foundry", providerId: "microsoft-foundry", modelIds: ["claude-fixture"], settings })

test("a Foundry provider's address stays on its own resource unless the operator allowlisted the origin", async () => {
  const workspace = await den.createOrg(await den.signUp("Foundry Owner"), "Foundry workspace")
  const owner = den.as(workspace.owner, workspace.orgId)

  // Another host, a look-alike host and another Foundry resource are all refused, whichever credentials would follow.
  for (const upstreamBaseUrl of [
    "https://foundry-proxy.example/anthropic/v1",
    "https://acme-foundry.services.ai.azure.com.example/anthropic/v1",
    "https://other-resource.services.ai.azure.com/anthropic/v1",
  ]) {
    const refused = await owner("POST", "/v1/inference-providers", foundry({ resourceName: "acme-foundry", upstreamBaseUrl }))
    assert.equal(refused.status, 400, `${upstreamBaseUrl}: ${summary(refused)}`)
    assert.equal(field(refused.body, "error"), "invalid_settings", summary(refused))
    const withMemberSignIn = await owner("POST", "/v1/inference-providers", {
      ...foundry({ resourceName: "acme-foundry", upstreamBaseUrl }),
      credentialMode: "member", oauthTenantId: "11111111-2222-4333-8444-555555555555", oauthClientId: "fixture-client", oauthClientSecret: "fixture-client-secret",
    })
    assert.equal(withMemberSignIn.status, 400, `${upstreamBaseUrl}: ${summary(withMemberSignIn)}`)
    assert.equal(field(withMemberSignIn.body, "error"), "invalid_settings", summary(withMemberSignIn))
  }

  // The resource's own address, with or without the override, and an operator-allowlisted origin are accepted.
  const derived = await owner("POST", "/v1/inference-providers", foundry({ resourceName: "acme-foundry" }))
  assert.equal(derived.status, 201, summary(derived))
  const sameOrigin = await owner("POST", "/v1/inference-providers", foundry({ resourceName: "acme-foundry", upstreamBaseUrl: "https://acme-foundry.services.ai.azure.com/anthropic/v1" }))
  assert.equal(sameOrigin.status, 201, summary(sameOrigin))
  const allowlisted = await owner("POST", "/v1/inference-providers", foundry({ resourceName: "acme-foundry", upstreamBaseUrl: "https://foundry-proxy.operator.example/anthropic/v1" }))
  assert.equal(allowlisted.status, 201, summary(allowlisted))

  // Members can still be given their own Entra ID sign-in on a provider that reaches its own resource.
  const providerId = text(field(derived.body, "inferenceProvider", "id"), "provider id")
  const memberSet = await owner("POST", `/v1/inference-providers/${providerId}/credential-sets`, {
    name: "Member sign-in", credentialMode: "member", oauthTenantId: "11111111-2222-4333-8444-555555555555", oauthClientId: "fixture-client", oauthClientSecret: "fixture-client-secret",
  })
  assert.equal(memberSet.status, 201, summary(memberSet))
})

test("a provider that only ever uses an organization key keeps its public address override", async () => {
  const workspace = await den.createOrg(await den.signUp("Override Owner"), "Override workspace")
  const created = await den.as(workspace.owner, workspace.orgId)("POST", "/v1/inference-providers", {
    name: "OpenAI through a proxy", providerId: "openai", modelIds: ["gpt-fixture"], settings: { upstreamBaseUrl: "https://openai-proxy.example/v1" },
  })
  assert.equal(created.status, 201, summary(created))
  assert.equal(field(created.body, "inferenceProvider", "settings", "upstreamBaseUrl"), "https://openai-proxy.example/v1")
})
