import assert from "node:assert/strict"
import { after, test } from "node:test"
import { OrganizationFeatureTable, FeatureRolloutTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { WORKBOT_DEFAULT_MODEL_ID } from "@openwork/types/den/workbot-settings"
import { bootDen, field, summary } from "./harness.js"
import { gatewayFixtureEnv, grantGatewayModels, stubPublicModelCatalog } from "./gateway-fixture.js"

// Workbot's models are each caller's own AI Gateway assignments; only the public model catalog is synthetic.
const restoreFetch = stubPublicModelCatalog()
const den = await bootDen({ env: { ...gatewayFixtureEnv, DEN_DEPLOYMENT: "self_hosted", DEN_FEATURE_WORKBOT: "false", DEN_FEATURE_WORKBOT_LUNA_DEFAULT: "false" } })
after(async () => { restoreFetch(); await den.close() })

test("guided navigation follows the workspace assistant rollout after Workbot becomes generally available", async () => {
  const workspace = await den.createOrg(await den.signUp("Navigation Owner"), "Navigation workspace")
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const session = async () => {
    const result = await den.request(token, "GET", "/v1/workbot/session")
    assert.equal(result.status, 200, summary(result))
    assert.equal(field(result.body, "enabled"), true)
    return result.body
  }
  for (const assistant of [false, true]) {
    const assistantChanged = await den.setFeature(workspace.orgId, "workbotWorkspaceAssistant", assistant)
    assert.equal(assistantChanged.status, 200, summary(assistantChanged))
    const body = await session()
    assert.equal(field(body, "workspaceAssistant"), assistant)
    assert.equal(field(body, "guidedNavigation"), assistant)
  }
})

test("an owner always sees explicit Luna readiness and keeps an isolated organization model choice", async () => {
  const workspace = await den.createOrg(await den.signUp("Workspace Owner"), "Model workspace")
  const other = await den.createOrg(await den.signUp("Another Owner"), "Another workspace")
  const call = den.as(workspace.owner, workspace.orgId)
  const path = "/v1/org/workbot-settings"
  // Old database rows, operator locks and kill switches must not hide GA behavior on self-hosted installs.
  const { db } = await import("../../src/db.js")
  for (const feature_key of ["workbot", "workbotLunaDefault", "permissions"]) {
    await db.insert(FeatureRolloutTable).values({ feature_key, enabled: false, killed: true })
    await db.insert(OrganizationFeatureTable).values({ organization_id: normalizeDenTypeId("organization", workspace.orgId), feature_key, enabled: false, source: "platform" })
  }
  const { "gpt-6-luna": luna, "gpt-fixture-other": otherModel } = await grantGatewayModels(den, workspace.owner, workspace.orgId, [workspace.owner], ["gpt-6-luna", "gpt-fixture-other"])
  const { "gpt-6-luna": otherLuna } = await grantGatewayModels(den, other.owner, other.orgId, [other.owner])
  assert.notEqual(luna, otherLuna, "each organization has its own Gateway aliases")

  const ready = await call("GET", path)
  assert.equal(ready.status, 200, summary(ready))
  assert.equal(field(ready.body, "defaultModel"), luna, "Luna is the caller's Gateway alias for the upstream GPT-6 Luna")
  assert.equal(field(ready.body, "defaultReadiness"), "available")
  assert.equal(field(ready.body, "model"), null)
  const token = await den.mintMcpToken(workspace.owner, workspace.orgId)
  const session = () => den.request(token, "GET", "/v1/workbot/session")
  const initialSession = await session()
  assert.equal(initialSession.status, 200, summary(initialSession))
  assert.equal(field(initialSession.body, "model"), luna)
  assert.equal(field(initialSession.body, "gatewayModels"), true, "Den authorizes the member's Gateway model for every turn")

  const saved = await call("PUT", path, { model: otherModel })
  assert.equal(saved.status, 200, summary(saved))
  assert.equal(field(saved.body, "model"), otherModel)
  assert.equal(field((await session()).body, "model"), otherModel)
  assert.equal((await den.as(other.owner, workspace.orgId)("GET", path)).status, 404)
  assert.equal((await den.as(other.owner, workspace.orgId)("PUT", path, { model: otherLuna })).status, 404)
  assert.equal((await call("PUT", path, { model: otherLuna })).status, 400, "another organization's alias is not a choice here")
  assert.equal(field((await call("GET", path)).body, "model"), otherModel)
  const otherSettings = await den.as(other.owner, other.orgId)("GET", path)
  assert.equal(field(otherSettings.body, "model"), null)
  assert.equal(field(otherSettings.body, "defaultModel"), otherLuna)
  const otherToken = await den.mintMcpToken(other.owner, other.orgId)
  assert.equal(field((await den.request(otherToken, "GET", "/v1/workbot/session")).body, "model"), otherLuna)

  // Without a Luna assignment the default is reported unavailable, never silently swapped for another model.
  const lunaless = await den.createOrg(await den.signUp("Lunaless Owner"), "Lunaless workspace")
  const { "gpt-fixture-other": lunalessOther } = await grantGatewayModels(den, lunaless.owner, lunaless.orgId, [lunaless.owner], ["gpt-fixture-other"])
  const lunalessCall = den.as(lunaless.owner, lunaless.orgId)
  const missing = await lunalessCall("GET", path)
  assert.equal(field(missing.body, "defaultReadiness"), "unavailable")
  assert.equal(field(missing.body, "defaultModel"), WORKBOT_DEFAULT_MODEL_ID)
  assert.equal((await lunalessCall("PUT", path, { model: lunalessOther })).status, 200)
  const chosen = await lunalessCall("GET", path)
  assert.equal(field(chosen.body, "model"), lunalessOther)
  assert.equal(field(chosen.body, "modelAvailable"), true)
  assert.equal((await lunalessCall("PUT", path, { model: null })).status, 200)
  const lunalessToken = await den.mintMcpToken(lunaless.owner, lunaless.orgId)
  assert.equal(field((await den.request(lunalessToken, "GET", "/v1/workbot/session")).body, "model"), WORKBOT_DEFAULT_MODEL_ID)

  // When the Gateway cannot be read, readiness is unverified, saved choices stay, and no new choice is accepted.
  const { env } = await import("../../src/env.js")
  env.gatewayEnabled = false
  try {
    const offline = await call("GET", path)
    assert.equal(offline.status, 200, summary(offline))
    assert.equal(field(offline.body, "defaultReadiness"), "unverified")
    assert.equal(field(offline.body, "model"), otherModel)
    assert.equal((await call("PUT", path, { model: otherModel })).status, 503)
    assert.equal(field((await session()).body, "model"), otherModel)
  } finally {
    env.gatewayEnabled = true
  }
})
