/**
 * ARRANGE ONLY: AI Gateway model access for API tests whose subject is not the Gateway itself.
 *
 * Every cloud-agent turn (Workbot, Slack, Automations) gets its model through the member's own AI Gateway
 * assignment, so tests of resume grants, session index, step turns or Workbot settings need a member with one.
 * Providers, model groups, credentials and grants are created through Den's real API; only the public model
 * catalog Den reads (models.openworklabs.com) is synthetic. Authorization itself is covered by
 * workbot-gateway.api.test.ts.
 */
import assert from "node:assert/strict"
import { field, list, summary, text, type bootDen, type Member } from "./harness.js"

export const GATEWAY_FIXTURE_BASE_URL = "http://127.0.0.1:8791"

/** Pass to bootDen: turns the deployment's AI Gateway on. */
export const gatewayFixtureEnv = {
  GATEWAY_ENABLED: "true",
  GATEWAY_PROXY_BASE_URL: GATEWAY_FIXTURE_BASE_URL,
  GATEWAY_PUBLIC_BASE_URL: GATEWAY_FIXTURE_BASE_URL,
}

/** Serve a fixed public model catalog; returns a restore function for `after`. */
export function stubPublicModelCatalog(): () => void {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
    return Response.json({
      openai: { id: "openai", name: "Fixture OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], api: "https://api.openai.com/v1", models: {
        "gpt-6-luna": { id: "gpt-6-luna", name: "Fixture Luna", limit: { context: 100000, output: 1000 } },
        "gpt-fixture-other": { id: "gpt-fixture-other", name: "Fixture Other", limit: { context: 100000, output: 1000 } },
      } },
    })
  }
  return () => { globalThis.fetch = realFetch }
}

type Den = Awaited<ReturnType<typeof bootDen>>
let providers = 0

/**
 * The owner configures an OpenAI provider with the given upstream models and an org credential, and grants it to
 * each member of `audience`. Returns the Gateway alias (gwm_…) for each upstream model, as `audience[0]` sees it.
 */
export async function grantGatewayModels(
  den: Den,
  owner: Member,
  orgId: string,
  audience: Member[],
  upstreamModelIds: string[] = ["gpt-6-luna"],
): Promise<Record<string, string>> {
  const call = den.as(owner, orgId)
  const created = await call("POST", "/v1/inference-providers", { name: `Fixture OpenAI ${++providers}`, providerId: "openai", modelIds: upstreamModelIds })
  assert.equal(created.status, 201, summary(created))
  const providerId = text(field(created.body, "inferenceProvider", "id"), "provider id")
  const group = await call("POST", `/v1/inference-providers/${providerId}/model-groups`, { name: "Assigned models", modelIds: upstreamModelIds })
  assert.equal(group.status, 201, summary(group))
  const modelGroupId = text(field(group.body, "modelGroup", "id"), "model group id")
  const credential = await call("POST", `/v1/inference-providers/${providerId}/credential-sets`, {
    name: "Fixture credential", credentialMode: "org", credential: { kind: "api_key", secret: "fixture-openai-private-key" },
  })
  assert.equal(credential.status, 201, summary(credential))
  const credentialSetId = text(field(credential.body, "credentialSet", "id"), "credential set id")
  for (const person of audience) {
    const grant = await call("POST", `/v1/inference-providers/${providerId}/access-grants`, {
      modelGroupId, credentialSetId, audience: { type: "member", memberId: person.memberId },
    })
    assert.equal(grant.status, 201, summary(grant))
  }
  const viewer = audience[0]
  assert.ok(viewer, "grant to at least one member")
  const usable = await den.as(viewer, orgId)("GET", "/v1/inference-providers?scope=usable")
  assert.equal(usable.status, 200, summary(usable))
  const provider = list(field(usable.body, "inferenceProviders")).find((entry) => entry.id === providerId)
  const aliases: Record<string, string> = {}
  for (const upstream of upstreamModelIds) {
    const model = list(provider?.models).find((entry) => entry.upstreamModelId === upstream)
    aliases[upstream] = text(model?.id, `Gateway alias for ${upstream}`)
  }
  return aliases
}

/**
 * ARRANGE ONLY: the member's own Gateway bearer key, as Den mints it for their turns (the same stable key), so a
 * synthetic upstream can accept exactly that key. Never use this to observe an outcome.
 */
export async function memberGatewayKey(orgId: string, member: Member): Promise<string> {
  const [{ ensureMemberGatewayKey }, { normalizeDenTypeId }] = await Promise.all([
    import("../../src/gateway-keys.js"), import("@openwork-ee/utils/typeid"),
  ])
  return ensureMemberGatewayKey({ organizationId: normalizeDenTypeId("organization", orgId), memberId: normalizeDenTypeId("member", member.memberId) })
}
