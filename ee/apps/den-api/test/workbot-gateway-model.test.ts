import assert from "node:assert/strict"
import { test } from "node:test"
import type { GatewayUsableModel } from "@openwork/types/den/gateway"
import { buildGatewayProviderConfig } from "../src/llm/inference-provider-config.js"
import {
  cloudAgentGatewayCatalogProjection,
  cloudAgentGatewayProtocol,
  createCloudAgentGatewayModelService,
  projectCloudAgentGatewayModels,
  type CloudAgentGatewaySnapshot,
  type CloudAgentGatewaySummary,
} from "../src/workbot/gateway-model.js"

const base = "https://gateway.example/gateway"
const actor = { organizationId: "org-one", userId: "user-one" }
const suffix = "00000000000000000000000000"
const alias = (n: number) => `gwm_${suffix}_${suffix}_${String(n).padStart(26, "0")}`
function model(n: number, upstreamModelId = "gpt-6-luna", name = "Not a Luna display name"): GatewayUsableModel {
  const id = alias(n)
  return { id, name, upstreamModelId, config: { id, apiKey: "must-not-leak" }, modelGroupId: "group", modelGroupName: "Group", credentialSetId: "set", credentialSetName: "Set" }
}
function provider(id: string, npm: string, models: GatewayUsableModel[]): CloudAgentGatewaySummary {
  return { id, providerId: npm.replace("@ai-sdk/", ""), status: "active", providerConfig: { npm, api: "https://upstream.example/v1", options: { apiKey: "upstream-secret" } }, models }
}
const openai = provider("ipr-one", "@ai-sdk/openai", [model(1)])
const anthropic = provider("ipr-two", "@ai-sdk/anthropic", [model(2, "claude", "Claude")])

test("projects multiple providers and exact aliases; catalog contains no credentials or upstream config", () => {
  const projected = projectCloudAgentGatewayModels([openai, anthropic], base)
  assert.equal(projected.length, 2)
  assert.equal(projected.find((entry) => entry.id === alias(1))?.protocol, "openai-responses")
  assert.equal(projected.find((entry) => entry.id === alias(2))?.protocol, "anthropic")
  assert.equal(projected[0]?.baseUrl, `${base}/api/v1/providers/ipr-two`)
  const catalog = cloudAgentGatewayCatalogProjection(projected)
  assert.equal(catalog.defaultModel, alias(1))
  assert.deepEqual(catalog.models.map((entry) => Object.keys(entry).sort()), [["id", "name", "provider"], ["id", "name", "provider"]])
  assert.doesNotMatch(JSON.stringify(catalog), /secret|must-not-leak|upstream\.example|apiKey|baseUrl/)
  assert.equal(catalog.verified, true) // credential-ready, not proof of a successful completion
})

test("unsupported SDKs, inactive providers and non-wire aliases are hidden", () => {
  const summaries = [
    provider("google", "@ai-sdk/google", [model(3)]),
    provider("bedrock", "@ai-sdk/amazon-bedrock", [model(4)]),
    provider("unknown", "unknown-sdk", [model(5)]),
    { ...openai, status: "disabled" },
    provider("raw", "@ai-sdk/openai", [{ ...model(6), id: "gpt-6-luna" }]),
    provider("prefixed", "@ai-sdk/openai", [{ ...model(7), id: `openai/${alias(7)}` }]),
  ] satisfies CloudAgentGatewaySummary[]
  assert.deepEqual(projectCloudAgentGatewayModels(summaries, base), [])
})

test("wire protocol support follows the rewritten SDK", () => {
  for (const npm of ["@ai-sdk/openai-compatible", "@openrouter/ai-sdk-provider", "@ai-sdk/amazon-bedrock/mantle"]) {
    assert.equal(cloudAgentGatewayProtocol({ npm }), "openai")
  }
  assert.equal(cloudAgentGatewayProtocol({ npm: "@ai-sdk/azure" }), null, "Azure requires api-version handling the runner does not support")
  assert.equal(cloudAgentGatewayProtocol({ npm: "@ai-sdk/mistral" }), null, "Mistral requires request options the generic OpenAI adapter does not support")
  assert.equal(cloudAgentGatewayProtocol({ npm: "@ai-sdk/anthropic" }), "anthropic")
  assert.equal(cloudAgentGatewayProtocol({ npm: "@ai-sdk/google-vertex" }), null)
})

test("shared Vertex Anthropic rewriting stays supported and authorization-required aliases stay hidden", () => {
  const rewritten = buildGatewayProviderConfig({ id: "vertex", provider_config: { npm: "@ai-sdk/google-vertex/anthropic", api: "https://vertex.example" } }, base)
  const summary = { ...provider("vertex", "unused", [model(3, "claude")]), providerConfig: rewritten }
  assert.equal(projectCloudAgentGatewayModels([summary], base)[0]?.protocol, "anthropic")
  const pending = { ...openai, models: [], authorizationRequests: [{ models: [model(1)] }] }
  assert.deepEqual(projectCloudAgentGatewayModels([pending], base), [])
})

test("Luna resolves by unique upstream ID, never by display name, case folding or arbitrary fallback", () => {
  const catalog = (summaries: CloudAgentGatewaySummary[]) => cloudAgentGatewayCatalogProjection(projectCloudAgentGatewayModels(summaries, base))
  assert.equal(catalog([openai]).defaultModel, alias(1))
  assert.equal(catalog([provider("imposter", "@ai-sdk/openai", [model(2, "another-model", "GPT-6 Luna")])]).defaultModel, "openai/gpt-6-luna")
  assert.equal(catalog([provider("case", "@ai-sdk/openai", [model(2, "GPT-6-LUNA")])]).defaultModel, "openai/gpt-6-luna")
  assert.equal(catalog([openai, provider("duplicate", "@ai-sdk/openai-compatible", [model(3)])]).defaultModel, "openai/gpt-6-luna")
  assert.equal(catalog([]).defaultModel, "openai/gpt-6-luna")
})

test("access re-reads actor-scoped readiness and issues only the current member's Gateway bearer", async () => {
  let summaries = [openai, anthropic]
  let snapshots = 0
  let keys = 0
  const service = createCloudAgentGatewayModelService({
    async snapshot(input) {
      assert.deepEqual(input, actor)
      snapshots++
      return { memberId: "member-one", gatewayBaseUrl: base, summaries }
    },
    async memberKey(input, memberId) {
      assert.deepEqual(input, actor)
      assert.equal(memberId, "member-one")
      keys++
      return "gwk-member-bearer"
    },
  })
  await service.catalog(actor)
  assert.equal(keys, 0)
  assert.deepEqual(await service.access(actor, alias(1)), { baseUrl: `${base}/api/v1/providers/ipr-one`, apiKey: "gwk-member-bearer", protocol: "openai-responses" })
  for (const id of ["gpt-6-luna", "openai/gpt-6-luna", `openai/${alias(1)}`, alias(8)]) {
    await assert.rejects(service.access(actor, id), /cloud_agent_gateway_model_unavailable/)
  }
  summaries = [] // Credential removal, offboarding/grant revocation or provider removal on the next live read.
  await assert.rejects(service.access(actor, alias(1)), /cloud_agent_gateway_model_unavailable/)
  assert.deepEqual((await service.catalog(actor)).models, [])
  assert.equal(keys, 1)
  assert.equal(snapshots, 8)
})

test("no organization/user cache: another actor and membership failures cannot reuse prior access", async () => {
  const service = createCloudAgentGatewayModelService({
    async snapshot(input): Promise<CloudAgentGatewaySnapshot> {
      if (input.organizationId !== actor.organizationId || input.userId !== actor.userId) throw new Error("cloud_agent_gateway_member_not_found")
      return { memberId: "member-one", gatewayBaseUrl: base, summaries: [openai] }
    },
    async memberKey() { return "gwk-bearer" },
  })
  assert.equal((await service.catalog(actor)).models.length, 1)
  await assert.rejects(service.access({ ...actor, organizationId: "other-org" }, alias(1)), /member_not_found/)
  await assert.rejects(service.catalog({ ...actor, userId: "removed-user" }), /member_not_found/)
})

test("unconfigured gateway fails closed without issuing a key", async () => {
  const service = createCloudAgentGatewayModelService({
    async snapshot() { throw new Error("cloud_agent_gateway_not_configured") },
    async memberKey() { assert.fail("must not issue a bearer") },
  })
  await assert.rejects(service.catalog(actor), /not_configured/)
  await assert.rejects(service.access(actor, alias(1)), /not_configured/)
})
