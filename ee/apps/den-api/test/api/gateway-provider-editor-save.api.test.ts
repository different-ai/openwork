import assert from "node:assert/strict"
import { after, test } from "node:test"
import { gatewayFixtureEnv } from "./gateway-fixture.js"
import { bootDen, field, list, summary, text } from "./harness.js"

const supportedModels = ["gemini-fixture-a", "gemini-fixture-b"]
const sdkOverrideModel = "claude-fixture"
const vertexNpm = "@ai-sdk/google-vertex"
const realFetch = globalThis.fetch
// Only the public catalog is stubbed; the provider, groups, credentials and grants use Den's API.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://models.openworklabs.com/api.json") return realFetch(input, init)
  return Response.json({
    "google-vertex": {
      id: "google-vertex", name: "Fixture Vertex", npm: vertexNpm, env: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"],
      models: {
        ...Object.fromEntries(supportedModels.map((id) => [id, { id, name: id, limit: { context: 100000, output: 1000 }, provider: { npm: vertexNpm } }])),
        [sdkOverrideModel]: { id: sdkOverrideModel, name: "Fixture Claude", limit: { context: 100000, output: 1000 }, provider: { npm: "@ai-sdk/google-vertex/anthropic" } },
      },
    },
  })
}
const den = await bootDen({ env: gatewayFixtureEnv })
after(async () => { globalThis.fetch = realFetch; await den.close() })

const providersPath = "/v1/inference-providers"
async function stageProvider(fixture: string) {
  const workspace = await den.createOrg(await den.signUp(`${fixture} Owner`), `${fixture} workspace`)
  const owner = den.as(workspace.owner, workspace.orgId)
  const created = await owner("POST", providersPath, {
    name: "Fixture Vertex", providerId: "google-vertex", modelIds: supportedModels.slice(0, 1),
    settings: { project: "fixture-project", location: "global" },
  })
  assert.equal(created.status, 201, summary(created))
  const provider = field(created.body, "inferenceProvider")
  assert.deepEqual(field(provider, "credentialSets"), [])
  assert.deepEqual(field(provider, "accessGrants"), [])
  const groups = list(field(provider, "modelGroups"))
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].modelIds, supportedModels.slice(0, 1))
  const groupId = text(groups[0].id, "initial model group id")
  const providerPath = `${providersPath}/${text(field(provider, "id"), "provider id")}`
  return { owner, providerPath, groupId, groupPath: `${providerPath}/model-groups/${groupId}` }
}

function assertGroupModels(body: unknown, expected: string[]) {
  const group = field(body, "modelGroup")
  const modelIds = field(group, "modelIds")
  assert.ok(Array.isArray(modelIds), "modelGroup.modelIds is an array")
  assert.deepEqual([...modelIds].sort(), [...expected].sort())
  assert.equal(field(group, "allModels"), undefined, "allModels is request-only")
}

test("allModels links configured supported Vertex models on both group create and update", async () => {
  const { owner, providerPath, groupPath } = await stageProvider("Group selection")
  const groupsPath = `${providerPath}/model-groups`

  const restricted = await owner("PATCH", groupPath, { allModels: true })
  assert.equal(restricted.status, 200, summary(restricted))
  assertGroupModels(restricted.body, supportedModels.slice(0, 1))

  const expanded = await owner("PATCH", providerPath, { modelIds: [] })
  assert.equal(expanded.status, 200, summary(expanded))
  assert.deepEqual(field(expanded.body, "inferenceProvider", "modelIds"), [])

  const updated = await owner("PATCH", groupPath, { allModels: true })
  assert.equal(updated.status, 200, summary(updated))
  assertGroupModels(updated.body, supportedModels)

  const created = await owner("POST", groupsPath, { name: "Every supported model", allModels: true })
  assert.equal(created.status, 201, summary(created))
  assertGroupModels(created.body, supportedModels)

  const both = { allModels: true, modelIds: [] }
  const invalidCreate = await owner("POST", groupsPath, { name: "Conflicting selection", ...both })
  assert.equal(invalidCreate.status, 400, summary(invalidCreate))
  const invalidPatch = await owner("PATCH", groupPath, both)
  assert.equal(invalidPatch.status, 400, summary(invalidPatch))
  const missing = await owner("POST", groupsPath, { name: "Missing selection" })
  assert.equal(missing.status, 400, summary(missing))

  const incompatible = await owner("PATCH", groupPath, { modelIds: [sdkOverrideModel] })
  assert.equal(incompatible.status, 404, summary(incompatible))
  assert.equal(field(incompatible.body, "error"), "model_not_found")

  const renamed = await owner("PATCH", groupPath, { name: "Renamed group" })
  assert.equal(renamed.status, 200, summary(renamed))
  assert.equal(field(renamed.body, "modelGroup", "name"), "Renamed group")
  assertGroupModels(renamed.body, supportedModels)

  const cleared = await owner("PATCH", groupPath, { modelIds: [] })
  assert.equal(cleared.status, 200, summary(cleared))
  assertGroupModels(cleared.body, [])
})

for (const mode of ["member", "org"]) {
  test(`an editor completes an MCP-staged provider with a ${mode} credential set`, async () => {
    const { owner, providerPath, groupId, groupPath } = await stageProvider(`${mode} credentials`)
    const saved = await owner("PATCH", providerPath, { modelIds: [], status: "active" })
    assert.equal(saved.status, 200, summary(saved))

    const group = await owner("PATCH", groupPath, { allModels: true })
    assert.equal(group.status, 200, summary(group))
    assertGroupModels(group.body, supportedModels)

    const credentials = await owner("POST", `${providerPath}/credential-sets`, {
      name: "Fixture credentials", credentialMode: mode,
      ...(mode === "member"
        ? { oauthClientId: "fixture-client", oauthClientSecret: "fixture-client-secret" }
        : { credential: { kind: "api_key", secret: "fixture-vertex-key" } }),
    })
    assert.equal(credentials.status, 201, summary(credentials))
    const credentialSetId = text(field(credentials.body, "credentialSet", "id"), "credential set id")
    const grantInput = { modelGroupId: groupId, credentialSetId, audience: { type: "organization" } }
    const granted = await owner("POST", `${providerPath}/access-grants`, grantInput)
    assert.equal(granted.status, 201, summary(granted))
    const grantId = text(field(granted.body, "accessGrant", "id"), "access grant id")

    const details = await owner("GET", providerPath)
    assert.equal(details.status, 200, summary(details))
    const provider = field(details.body, "inferenceProvider")
    assert.equal(field(provider, "status"), "active")
    assert.deepEqual(field(provider, "modelIds"), [])
    const sets = list(field(provider, "credentialSets"))
    assert.equal(sets.length, 1)
    assert.equal(sets[0].id, credentialSetId)
    assert.equal(sets[0].credentialMode, mode)
    assert.equal(sets[0].status, "active")
    assert.equal(sets[0].configured, true)
    assert.equal(sets[0].credentialStatus, mode === "member" ? "member_auth_required" : "ready")
    if (mode === "member") {
      assert.equal(sets[0].oauthClientId, "fixture-client")
      assert.equal(sets[0].hasOauthClientSecret, true)
    }
    assert.deepEqual(field(provider, "accessGrants"), [{ id: grantId, ...grantInput }])
    const groups = list(field(provider, "modelGroups"))
    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, groupId)
    assertGroupModels({ modelGroup: groups[0] }, supportedModels)
  })
}
