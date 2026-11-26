import assert from "node:assert/strict"
import { after, test } from "node:test"
import { gatewayFixtureEnv } from "./gateway-fixture.js"
import { bootDen, field, summary, text } from "./harness.js"

const realFetch = globalThis.fetch
let forwarded: unknown = null
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.endsWith("/api/v1/provider-tests")) {
    forwarded = JSON.parse(String(init?.body))
    return Response.json({ ok: true, model: "anthropic.claude-fixture", status: 200, code: null, message: null })
  }
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  return Response.json(Object.fromEntries([
    ["amazon-bedrock", "@ai-sdk/amazon-bedrock"], ["amazon-bedrock-mantle", "@ai-sdk/amazon-bedrock/mantle"], ["openai", "@ai-sdk/openai"],
  ].map(([id, npm]) => [id, { id, name: id, npm, env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], models: { "anthropic.claude-fixture": { id: "anthropic.claude-fixture", name: "Fixture model", limit: { context: 100000, output: 1000 } } } }])))
}
const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => { globalThis.fetch = realFetch; await den.close() })
const path = "/v1/inference-providers"
const policy = { guardrailIdentifier: "fixture123", guardrailVersion: "DRAFT" }
const create = { name: "Bedrock fixture", providerId: "amazon-bedrock", modelIds: [], settings: { region: "us-east-1", ...policy } }

test("an organization owner saves, loads, updates and clears a paired Bedrock guardrail", async () => {
  const org = await den.createOrg(await den.signUp("Guardrail owner"), "Guardrail workspace")
  const owner = den.as(org.owner, org.orgId)
  const blocked = await owner("POST", path, create)
  assert.equal(blocked.status, 403, summary(blocked))
  assert.equal(field(blocked.body, "error"), "feature_disabled")
  const memberFeaturePath = `/v1/admin/organizations/${org.orgId}/members/${org.owner.memberId}/capabilities`
  const memberEnabled = await den.asPlatformAdmin("PUT", memberFeaturePath, { capabilities: { bedrockGuardrails: true } })
  assert.equal(memberEnabled.status, 200, summary(memberEnabled))
  assert.equal(field((await owner("GET", "/v1/org")).body, "features", "bedrockGuardrails"), false)
  assert.equal((await owner("POST", path, create)).status, 403)
  assert.equal((await den.setFeature(org.orgId, "bedrockGuardrails", true)).status, 200)
  const memberDisabled = await den.asPlatformAdmin("PUT", memberFeaturePath, { capabilities: { bedrockGuardrails: false } })
  assert.equal(memberDisabled.status, 200, summary(memberDisabled))
  assert.equal(field((await owner("GET", "/v1/org")).body, "features", "bedrockGuardrails"), true)
  const created = await owner("POST", path, create)
  assert.equal(created.status, 201, summary(created))
  const providerPath = `${path}/${text(field(created.body, "inferenceProvider", "id"), "provider id")}`
  assert.deepEqual(field(created.body, "inferenceProvider", "settings"), create.settings)
  const loaded = await owner("GET", providerPath)
  assert.deepEqual(field(loaded.body, "inferenceProvider", "settings"), create.settings)
  for (const settings of [{ guardrailIdentifier: "" }, { guardrailVersion: "" }]) {
    const partialClear = await owner("PATCH", providerPath, { settings })
    assert.equal(partialClear.status, 400, summary(partialClear))
    assert.deepEqual(field((await owner("GET", providerPath)).body, "inferenceProvider", "settings"), create.settings)
  }
  const updated = await owner("PATCH", providerPath, { settings: { ...policy, guardrailVersion: "2" } })
  assert.equal(updated.status, 200, summary(updated))
  assert.equal(field(updated.body, "inferenceProvider", "settings", "guardrailVersion"), "2")
  const relocated = await owner("PATCH", providerPath, { settings: { region: "us-west-2" } })
  assert.equal(relocated.status, 409, summary(relocated))
  assert.equal((await den.setFeature(org.orgId, "bedrockGuardrails", false)).status, 200)
  const renamed = await owner("PATCH", providerPath, { name: "Renamed provider", settings: { region: "us-east-1" } })
  assert.equal(renamed.status, 200, summary(renamed))
  assert.equal(field(renamed.body, "inferenceProvider", "settings", "guardrailVersion"), "2")
  const blockedClear = await owner("PATCH", providerPath, { settings: { guardrailIdentifier: "", guardrailVersion: "" } })
  assert.equal(blockedClear.status, 403, summary(blockedClear))
  assert.equal((await den.setFeature(org.orgId, "bedrockGuardrails", true)).status, 200)
  const cleared = await owner("PATCH", providerPath, { settings: { guardrailIdentifier: "", guardrailVersion: "" } })
  assert.equal(cleared.status, 200, summary(cleared))
  assert.equal(field(cleared.body, "inferenceProvider", "settings", "guardrailIdentifier"), undefined)
  assert.equal(field(cleared.body, "inferenceProvider", "settings", "guardrailVersion"), undefined)
  const outsider = await den.createOrg(await den.signUp("Other owner"), "Other workspace")
  assert.equal((await den.as(outsider.owner, outsider.orgId)("GET", providerPath)).status, 404)
})

test("guardrails reject partial policies and non-Bedrock providers", async () => {
  const org = await den.createOrg(await den.signUp("Policy owner"), "Policy workspace")
  const owner = den.as(org.owner, org.orgId)
  await den.setFeature(org.orgId, "bedrockGuardrails", true)
  const member = await den.newMember(org.owner, org.orgId, "Policy member")
  const denied = await den.as(member, org.orgId)("POST", path, create)
  assert.equal(denied.status, 403, summary(denied))
  for (const settings of [{ region: "us-east-1", guardrailIdentifier: "fixture123" }, { region: "us-east-1", guardrailIdentifier: "" }, { region: "us-east-1", guardrailVersion: "" }, { region: "us-east-1", ...policy, guardrailVersion: "0" }]) {
    const result = await owner("POST", path, { ...create, settings })
    assert.equal(result.status, 400, summary(result))
  }
  for (const providerId of ["openai", "amazon-bedrock-mantle"]) {
    const result = await owner("POST", path, { ...create, providerId })
    assert.equal(result.status, 400, summary(result))
  }
})

test("provider tests reject disabled policy before forwarding and preserve enabled settings", async () => {
  const org = await den.createOrg(await den.signUp("Test owner"), "Test workspace")
  const owner = den.as(org.owner, org.orgId)
  const input = { providerId: "amazon-bedrock", model: "anthropic.claude-fixture", settings: create.settings, credential: { kind: "aws_keys", secret: JSON.stringify({ accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" }) } }
  forwarded = null
  const blocked = await owner("POST", `${path}/test-connection`, input)
  assert.equal(blocked.status, 403, summary(blocked))
  assert.equal(forwarded, null)
  await den.setFeature(org.orgId, "bedrockGuardrails", true)
  const result = await owner("POST", `${path}/test-connection`, input)
  assert.equal(result.status, 200, summary(result))
  assert.deepEqual(field(forwarded, "settings"), input.settings)
})
