import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary } from "./harness.js"

// Exact second GA batch. These names remain response compatibility only, never editable controls.
const retired = [
  "claudeAgentProvider", "webPerMember", "localModelsPolicy", "shareDeviceProvider",
  "singleOpenWorkModelsRow", "passwordSignInGoogle", "signInEmailSync", "ssoOidcSetupCheck",
  "denPageConsistency", "nativeDictation", "workbotScrollToBottom", "workbotApps",
  "workbotProactive", "workbotTeamSettings", "workbotUsageAnalytics", "fileSendPermissions",
  "remoteDevices", "remoteSessionAccess",
]
const den = await bootDen()
after(() => den.close())
const workspace = await den.createOrg(await den.signUp("GA Owner"), "GA regression workspace")
const member = await den.newMember(workspace.owner, workspace.orgId, "GA Member")

async function editableFeatures() {
  const response = await den.asPlatformAdmin("GET", "/v1/admin/features")
  assert.equal(response.status, 200, summary(response))
  return list(field(response.body, "features"))
}

async function assertCompatibility() {
  const responses = [
    await den.request(null, "GET", "/v1/features"),
    await den.as(workspace.owner, workspace.orgId)("GET", "/v1/org"),
    await den.as(member, workspace.orgId)("GET", "/v1/org"),
  ]
  for (const response of responses) {
    assert.equal(response.status, 200, summary(response))
    for (const key of retired) assert.equal(field(response.body, "features", key), true, key)
  }
}

test("the admin feature page's real API omits all 18 retired controls, but clients retain fixed compatibility", async () => {
  const features = await editableFeatures()
  assert.ok(features.length > 0, "the route must return the live editable registry, not an empty fixture")
  for (const key of retired) assert.equal(features.some((feature) => feature.key === key), false, key)
  for (const key of ["remoteTasksOptIn", "remoteComputers"]) assert.equal(features.some((feature) => feature.key === key), true, `${key} must remain adjustable`)
  await assertCompatibility()
})

test("retired deployment and organization inputs cannot recreate admin controls or disable compatibility", async () => {
  for (const key of retired) {
    const rollout = await den.asPlatformAdmin("PUT", `/v1/admin/features/${key}`, { enabled: false, killed: true })
    assert.equal(rollout.status, 400, `${key}: ${summary(rollout)}`)
    assert.equal(field(rollout.body, "error"), "invalid_request", key)
  }
  // Older organization editors may still submit obsolete fields. They are ignored, not persisted as controls.
  const capabilities = Object.fromEntries(retired.map((key) => [key, false]))
  const organization = await den.asPlatformAdmin("PUT", `/v1/admin/organizations/${workspace.orgId}/capabilities`, { capabilities })
  assert.equal(organization.status, 200, summary(organization))
  for (const key of retired) {
    assert.equal(field(organization.body, "capabilities", key), undefined, key)
    assert.equal(field(organization.body, "featureStates", key), undefined, key)
  }
  const features = await editableFeatures()
  for (const key of retired) assert.equal(features.some((feature) => feature.key === key), false, key)
  await assertCompatibility()
})
