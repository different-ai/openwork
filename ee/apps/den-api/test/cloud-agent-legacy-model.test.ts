import assert from "node:assert/strict"
import { test } from "node:test"
import { createCloudAgentLegacyModelService, legacyCloudModelId, type CloudAgentLegacyProvider } from "../src/workbot/legacy-model.js"
import { createCloudAgentModelService, headlessExplicitModelId, type CloudAgentModelService } from "../src/workbot/cloud-agent-model.js"
import { CloudAgentGatewayAccessError } from "../src/workbot/gateway-model.js"

const actor = { organizationId: "org-one", userId: "user-one" }
const upstream = "deployment/team/model"
const id = "lpr_00000000000000000000000000"
const selected = legacyCloudModelId(id, upstream)
function provider(overrides: Partial<CloudAgentLegacyProvider> = {}): CloudAgentLegacyProvider {
  return { id, source: "custom", providerId: "compatible", providerConfig: { npm: "@ai-sdk/openai-compatible", api: "https://inference.example/v1", env: ["SERVICE_API_KEY"] }, credential: "actor-secret", models: [{ modelId: upstream, name: "Model", modelConfig: {} }], ...overrides }
}
function service(providers: CloudAgentLegacyProvider[]) {
  return createCloudAgentLegacyModelService({ providers: async () => providers })
}

test("catalog carries exact record identity and full upstream slash ID, never keys/config/endpoint", async () => {
  const models = service([provider(), provider({ id: "lpr_00000000000000000000000001" })])
  const catalog = await models.catalog(actor)
  assert.equal(catalog.models.length, 2)
  assert.equal(new Set(catalog.models.map(model => model.id)).size, 2)
  assert.doesNotMatch(JSON.stringify(catalog), /actor-secret|apiKey|inference\.example|providerConfig/)
  assert.deepEqual(await models.access(actor, selected), { protocol: "openai", baseUrl: "https://inference.example/v1", apiKey: "actor-secret", model: upstream })
  for (const model of [upstream, `compatible/${upstream}`, `lpr_other/${upstream}`, `${id}/model`]) await assert.rejects(models.access(actor, model), /unavailable/)
})

test("usage is recorded only when a legacy credential is resolved, never for a catalog or denied choice", async () => {
  let uses = 0
  const models = createCloudAgentLegacyModelService({ providers: async () => [provider()], used: async () => { uses++ } })
  await models.catalog(actor)
  assert.equal(uses, 0)
  await assert.rejects(models.access(actor, "unavailable"))
  assert.equal(uses, 0)
  await models.access(actor, selected)
  assert.equal(uses, 1)
})

test("single-env maps use the existing scoped runtime credential mapping", async () => {
  const models = service([provider({ source: "models_dev", credential: JSON.stringify({ SERVICE_API_KEY: "member-key" }) })])
  assert.equal((await models.access(actor, selected)).apiKey, "member-key")
  assert.equal((await models.catalog(actor)).models.length, 1)
})

test("missing, unsupported and unrepresentable routes are hidden and denied, never downgraded", async () => {
  const base = provider()
  const configs = [
    { ...base.providerConfig, npm: "@ai-sdk/amazon-bedrock" },
    { ...base.providerConfig, npm: "@ai-sdk/google-vertex/anthropic" },
    { ...base.providerConfig, npm: "@ai-sdk/azure" },
    { ...base.providerConfig, npm: "@openrouter/ai-sdk-provider" },
    { ...base.providerConfig, headers: { "x-custom": "value" } },
    { ...base.providerConfig, options: { headers: { "x-custom": "value" } } },
    { ...base.providerConfig, options: { apiKey: "other-secret" } },
    { ...base.providerConfig, options: { region: "region" } },
    { ...base.providerConfig, options: "invalid" },
    { ...base.providerConfig, env: ["ACCESS_KEY", "SECRET_KEY"] },
    { ...base.providerConfig, api: "https://inference.example/{env:PATH}" },
    { ...base.providerConfig, api: "https://user:secret@inference.example/v1" },
    { ...base.providerConfig, api: "https://inference.example/v1?api_key=secret" },
    { npm: "@ai-sdk/openai-compatible" },
  ]
  const providers = [
    ...configs.map(providerConfig => provider({ providerConfig })),
    provider({ credential: null }), provider({ credential: " " }),
    provider({ credential: JSON.stringify({ WRONG_KEY: "key" }) }),
    provider({ credential: JSON.stringify({ SERVICE_API_KEY: "key", OTHER_KEY: "other" }) }),
    ...["options", "headers", "provider"].map(key => provider({ models: [{ modelId: upstream, name: "Model", modelConfig: { [key]: { value: true } } }] })),
  ]
  for (const entry of providers) {
    assert.equal((await service([entry]).catalog(actor)).models.length, 0, JSON.stringify(entry.providerConfig))
    await assert.rejects(service([entry]).access(actor, selected), /unavailable/)
  }
})

test("OpenAI responses and Anthropic use explicit protocols and normal SDK base URLs", async () => {
  for (const [npm, protocol, baseUrl] of [["@ai-sdk/openai", "openai-responses", "https://api.openai.com/v1"], ["@ai-sdk/anthropic", "anthropic", "https://api.anthropic.com/v1"]]) {
    const models = service([provider({ providerConfig: { npm, env: ["API_KEY"] } })])
    const access = await models.access(actor, selected)
    assert.equal(access.protocol, protocol)
    assert.equal(access.baseUrl, baseUrl)
  }
})

test("configured models and whitelist/blacklist are authoritative; no upstream discovery", async () => {
  for (const providerConfig of [
    { ...provider().providerConfig, whitelist: [] },
    { ...provider().providerConfig, whitelist: ["different"] },
    { ...provider().providerConfig, blacklist: [upstream], whitelist: [upstream] },
  ]) {
    const models = service([provider({ providerConfig })])
    assert.deepEqual((await models.catalog(actor)).models, [])
    await assert.rejects(models.access(actor, selected), /unavailable/)
  }
  await assert.rejects(service([provider({ models: [] })]).access(actor, selected), /unavailable/)
})

test("Luna-only default policy remains exact and never chooses an arbitrary legacy model", async () => {
  assert.equal((await service([provider()]).catalog(actor)).defaultModel, "openai/gpt-6-luna")
  const luna = provider({ models: [{ modelId: "gpt-6-luna", name: "Luna", modelConfig: {} }] })
  assert.equal((await service([luna]).catalog(actor)).defaultModel, `${id}/gpt-6-luna`)
  assert.equal((await service([luna, { ...luna, id: "lpr_other" }]).catalog(actor)).defaultModel, "openai/gpt-6-luna")
})

test("each catalog, mint and resume reads current actor access; revoked/blocked credentials cannot reuse an earlier key", async () => {
  let current = [provider()]
  let calls = 0
  const models = createCloudAgentLegacyModelService({ providers: async input => {
    calls++
    if (input.organizationId !== actor.organizationId || input.userId !== actor.userId) throw new CloudAgentGatewayAccessError("model_access_unavailable")
    return current
  } })
  await models.catalog(actor)
  assert.equal((await models.access(actor, selected)).apiKey, "actor-secret")
  for (const denied of [{ ...actor, userId: "other-member" }, { ...actor, organizationId: "other-org" }]) await assert.rejects(models.access(denied, selected), /unavailable/)
  current = [provider({ credential: null })] // Missing, blocked or revoked member binding.
  await assert.rejects(models.access(actor, selected), /unavailable/)
  current = [] // Grant revoked, provider deleted or membership invalidated.
  await assert.rejects(models.access(actor, selected), /unavailable/)
  assert.equal(calls, 6)
})

test("unified facade preserves Gateway identity/access and works with Gateway disabled", async () => {
  let gatewayAccess = 0
  const gateway: CloudAgentModelService = {
    catalog: async () => ({ models: [{ id: "gwm_exact", name: "Gateway", provider: "openai" }], defaultModel: "gwm_exact", verified: true }),
    access: async (_actor, model) => { gatewayAccess++; assert.equal(model, "gwm_exact"); return { protocol: "openai-responses", baseUrl: "https://gateway.example/v1", apiKey: "gateway-member-key" } },
  }
  const facade = createCloudAgentModelService(gateway, service([provider()]))
  assert.equal((await facade.catalog(actor)).defaultModel, "gwm_exact")
  assert.equal((await facade.access(actor, selected)).model, upstream)
  assert.equal(gatewayAccess, 0)
  assert.equal((await facade.access(actor, "gwm_exact")).apiKey, "gateway-member-key")
  const disabled = createCloudAgentModelService({ ...gateway, catalog: async () => { throw new CloudAgentGatewayAccessError("gateway_not_configured") } }, service([provider()]))
  assert.deepEqual((await disabled.catalog(actor)).models.map(model => model.id), [selected])
  const failed = createCloudAgentModelService({ ...gateway, catalog: async () => { throw new Error("database_unavailable") } }, service([provider()]))
  await assert.rejects(failed.catalog(actor), /database_unavailable/)
  assert.equal(headlessExplicitModelId({ providerId: id, modelId: upstream }), selected)
  assert.equal(headlessExplicitModelId({ providerId: "ipr_record", modelId: "gwm_exact" }), "gwm_exact")
})
