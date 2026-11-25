import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FEATURE_KEYS,
  RETIRED_FEATURE_KEYS,
  featureKeySchema,
  parseFeatureEnvironment,
  resolveFeatures,
} from "@openwork/features"

const graduated = [
  "googleCalendarRecurrence", "googleDrivePdfText", "plainFreeModel", "settledSessions",
  "appToolRepair", "publicApps", "appSites", "composerBackgroundTasks", "agentQuestions",
  "steadyLiveTurn", "ssoPerOrganization", "superAdminPermissionSet", "desktopPersonalConnectors",
  "workbotDriveFiles", "workbotAccountMenu", "workbotBrowserChat", "workbotInstantOpen",
  "workbotBrowserRecovery", "workbotQuickReply", "workbotWorkingStatus", "workbotCenteredProfile",
  "workbotBrowserPreview", "workbotProfileSheet", "workbotRemoteTasks", "workbotProfileNav",
  "workbotQuietCalendar", "workbotSlackAnswerReply", "browserUploadPermissions",
  "agentHarnessPermissions", "computerUse", "computerSessionHistory", "parallelComputerUse",
  "browserUse", "remoteSessionPush", "sandboxMicrosoft365", "standardCodeMode", "outlookAttachments",
  "claudeAgentProvider", "webPerMember", "localModelsPolicy",
  "shareDeviceProvider", "singleOpenWorkModelsRow", "passwordSignInGoogle",
  "signInEmailSync", "ssoOidcSetupCheck", "denPageConsistency",
  "nativeDictation", "workbotScrollToBottom", "workbotApps",
  "workbotProactive", "workbotTeamSettings", "workbotUsageAnalytics",
  "fileSendPermissions", "remoteDevices", "remoteSessionAccess",
  "workbotSettingsTabs", "sandboxSlack", "sandboxModelChoice", "settingsFind",
  "freeAutoSharedBudgets", "freeAutoSafetyPauses", "desktopOnlyFreeAuto",
  "freeAutoCrossOrgBudgets", "freeAutoSafetyCases", "fundedModelAccountSuspensions",
  "workbotAgentBrief", "workbotProfileComputers", "workbotDeviceActivity",
  "workbotEnableAllConnectors", "workbotAgentStoppedSources", "chatRunCommands",
  "chatTableExpand", "sessionMultiSelect", "followUpSuggestions",
  "sideChatPanel", "personalSkillPortability", "denGreySidebar",
  "litellmEntraMemberSignIn", "sandboxTools", "mcpThreadEvents",
  "nativeMcpEvents",
  "gatewayOpenCodeSetup", "importOpencodeConnections", "lowStorageWarning",
  "providerFilterSyncFix", "questionMinimize",
  "remoteComputers",
]

test("completed rollouts are retired rather than permanently enabled flags", () => {
  const active = new Set<string>(FEATURE_KEYS)
  const retired = new Set<string>(RETIRED_FEATURE_KEYS)
  for (const key of graduated) {
    assert.equal(active.has(key), false, key)
    assert.equal(retired.has(key), true, key)
    assert.equal(featureKeySchema.safeParse(key).success, false, key)
  }
})

test("the abandoned team settings sidebar is retired", () => {
  assert.equal(featureKeySchema.safeParse("teamSettingsSidebar").success, false)
  assert.ok(RETIRED_FEATURE_KEYS.includes("teamSettingsSidebar"))
})

test("old operator locks cannot turn graduated features off or enter the active feature map", () => {
  const env = Object.fromEntries(graduated.map((key) => [
    `DEN_FEATURE_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`,
    "false",
  ]))
  for (const deployment of ["cloud", "self_hosted"]) {
    const parsed = parseFeatureEnvironment({ ...env, DEN_DEPLOYMENT: deployment })
    assert.deepEqual(parsed.locks, {})
    assert.equal(parsed.problems.length, graduated.length)
    assert.ok(parsed.problems.every((problem) => !problem.fatal))
    const features = resolveFeatures({ ...parsed, rollouts: {}, overrides: {} })
    for (const key of graduated) assert.equal(Object.hasOwn(features, key), false, key)
  }
})

const removed = [
  "connectEngineTools", "connectStandardTools", "connectionMcpServers",
  "sandboxGateway", "workbotDocumentEditing",
]

test("removed experiments cannot be enabled with old operator locks", () => {
  const env = Object.fromEntries(removed.map((key) => [
    `DEN_FEATURE_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`,
    "true",
  ]))
  for (const key of removed) {
    assert.ok(RETIRED_FEATURE_KEYS.some((retired) => retired === key), key)
    assert.equal(featureKeySchema.safeParse(key).success, false, key)
  }
  const parsed = parseFeatureEnvironment(env)
  assert.deepEqual(parsed.locks, {})
  assert.equal(parsed.problems.length, removed.length)
  assert.ok(parsed.problems.every((problem) => !problem.fatal))
  const features = resolveFeatures({ ...parsed, rollouts: {}, overrides: {} })
  for (const key of removed) assert.equal(Object.hasOwn(features, key), false, key)
})
