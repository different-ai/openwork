import assert from "node:assert/strict"
import { test } from "node:test"
import { FEATURE_KEYS } from "@openwork/features"
import { clientFeatures, clientFeaturesSchema } from "../src/feature-response.js"

const retiredKeys = [
  "engineV2ForceUpgrade", "libraryDetailBreadcrumbs", "nativeAffordanceCodeMode",
  "libraryConnectorNavigation", "mcpAppLibraries", "gatewayProviderTest", "mermaidZoom",
  "slackSendAsBot", "liveProviderSync", "browserFloatingView", "remoteSessionSubagents",
  "remoteSessionThreadView", "remoteSessionAnswers", "activationChecklist",
  "gatewayProviderAuthErrors", "providerCredentialStatus", "sessionTokenHashing",
  "customConnectorSetup", "expandedMcpPresets", "analyticsDailyTrends",
  "gatewayProviderRemovalLimits", "guidedSlackSetup", "libraryConnectorOrgSetup",
  "workbotIncludedModels", "workbotUsageRecovery",
  "liveReplyModel", "composerSubagentTracker", "textActivityRail", "artifactsListFirst",
  "automationIntervalSchedules", "automationCalendarTriggers",
]

test("API-first upgrades keep graduated behavior on for published clients", () => {
  const features = clientFeatures({ autoRouter: false, composerSubagentTracker: false })
  for (const key of retiredKeys) assert.equal(features[key], true, key)
  assert.equal(features.autoRouter, false)
  assert.equal(features.composerSubagentTracker, true, "the tracker is GA despite a stale opt-out")
  assert.equal("sandboxOrgs" in features, false, "cloud-only sandbox availability is not advertised as a global client feature")
  assert.deepEqual(clientFeaturesSchema.parse(features), features)
})

test("stale retired rollout values cannot disable compatibility and never enter registry/admin state", () => {
  const stale = Object.fromEntries(retiredKeys.map((key) => [key, false]))
  const features = clientFeatures(stale)
  for (const key of retiredKeys) {
    assert.equal(features[key], true, key)
    assert.equal(FEATURE_KEYS.some((registered) => registered === key), false, key)
    assert.equal(clientFeaturesSchema.safeParse({ ...features, [key]: false }).success, false, key)
  }
})
