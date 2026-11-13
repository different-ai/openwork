import assert from "node:assert/strict"
import { test } from "node:test"
import { FEATURE_KEYS } from "@openwork/features"
import { clientFeatures, clientFeaturesSchema } from "../src/feature-response.js"

const retiredKeys = [
  "claudeAgentProvider",
  "webPerMember",
  "localModelsPolicy",
  "shareDeviceProvider",
  "singleOpenWorkModelsRow",
  "passwordSignInGoogle",
  "signInEmailSync",
  "ssoOidcSetupCheck",
  "denPageConsistency",
  "nativeDictation",
  "workbotScrollToBottom",
  "workbotApps",
  "workbotProactive",
  "workbotTeamSettings",
  "workbotUsageAnalytics",
  "fileSendPermissions",
  "remoteDevices",
  "remoteSessionAccess",

  "googleCalendarRecurrence",
  "googleDrivePdfText",
  "plainFreeModel",
  "settledSessions",
  "appToolRepair",
  "publicApps",
  "appSites",
  "composerBackgroundTasks",
  "agentQuestions",
  "steadyLiveTurn",
  "ssoPerOrganization",
  "superAdminPermissionSet",
  "desktopPersonalConnectors",
  "workbotDriveFiles",
  "workbotAccountMenu",
  "workbotBrowserChat",
  "workbotInstantOpen",
  "workbotQuickReply",
  "workbotWorkingStatus",
  "workbotCenteredProfile",
  "workbotBrowserPreview",
  "workbotProfileSheet",
  "workbotRemoteTasks",
  "workbotProfileNav",
  "workbotQuietCalendar",
  "workbotSlackAnswerReply",
  "browserUploadPermissions",
  "agentHarnessPermissions",
  "computerUse",
  "computerSessionHistory",
  "parallelComputerUse",
  "browserUse",
  "remoteSessionPush",
  "standardCodeMode",
  "outlookAttachments",

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
  "lastUsedSignIn", "remoteSessionHelperView",
]

test("API-first upgrades keep graduated behavior on for published clients", () => {
  const features = clientFeatures({ claudeAgentProvider: false, composerSubagentTracker: false })
  for (const key of retiredKeys) assert.equal(features[key], true, key)
  assert.equal(features.claudeAgentProvider, true)
  assert.equal(features.composerSubagentTracker, true, "the tracker is GA despite a stale opt-out")
  assert.equal("sandboxMicrosoft365" in features, false, "cloud-only sandbox setup is not a global compatibility feature")
  assert.equal("workbotBrowserRecovery" in features, false, "cloud-only recovery is advertised by the deployment-checked Workbot session")
  assert.equal("sandboxOrgs" in features, false, "cloud-only sandbox availability is not advertised as a global client feature")
  assert.deepEqual(clientFeaturesSchema.parse(features), features)
})

test("the deleted early-update window stays off for published desktops despite stale opt-ins", () => {
  for (const stale of [{}, { desktopUpdateDownloadWindow: true }, { desktopUpdateDownloadWindow: false }]) {
    const features = clientFeatures(stale)
    assert.equal(features.desktopUpdateDownloadWindow, false)
    assert.deepEqual(clientFeaturesSchema.parse(features), features)
    assert.equal(clientFeaturesSchema.safeParse({ ...features, desktopUpdateDownloadWindow: true }).success, false)
  }
  assert.equal(new Set<string>(FEATURE_KEYS).has("desktopUpdateDownloadWindow"), false)
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
