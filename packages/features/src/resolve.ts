import { z } from "zod"
import {
  FEATURE_CATEGORIES,
  FEATURES,
  type FeatureCategory,
  type FeatureDefinition,
  type FeatureDeployment,
  type FeatureKey,
  type FeatureMap,
  type FeatureOverrides,
  type OutcomeFeatureKey,
} from "@openwork/features/registry"

/**
 * Retired keys. Older clients and stored overrides may still send or hold them;
 * inputs accept and ignore them, and they are never stored again.
 */
export const RETIRED_FEATURE_KEYS = [
  "gatewayDashboard", "workflows", "codemodeScripts", "remoteMcpApps", "appMcpServers", "cloud",
  "auditLogs", "auditLogsCompact", "litellm", "gatewayCloudSignIn", "opencodePlugin", "remoteSessionTargets",
  "installLinks", "mcpConnections", "simplifiedOnboarding", "connectorReadiness", "driveResumableUploads",
  "implicitCloudSkills", "platformAuditReads",
  "analyticsIntegrated", "workbotCalendar", "workbotSideChats", "workbotDefaultModel",
  "denFlatPageHeaders", "dashboardActivity", "libraryIntegrated", "libraryUsage", "modelsAnalytics",
  "headlessAutomations", "calendarPolish",
  "orgManagedDashboards", "workbotSharing",
  "automationCalendar",
  "agentPermissions", "appBuildProgress", "backgroundShellTasks", "desktopPolicyScreenRemoval",
  "gatewayProviderUsageLimits", "googleDocumentTools", "inviteLinkVerifiesEmail", "lastTurnModelFooter",
  "mcpSkillsExtension", "memberListToolbars", "modelRemovalRecovery", "nativeCloudSkills", "orgDefaultModel",
  "permissions", "rememberLastOrganization", "sharedRoles", "slackWorkbotReplies", "teamAccessRows",
  "teamMembershipCache", "teamPageTabs", "teamRoles", "workbot", "workbotLunaDefault",
  "managedDeploymentsGcp", "managedDeploymentsMcp",
  "serviceReadiness",
  "cloudAgentGateway", "secureSecretFields", "slackAssistant", "workbotFirstRun", "workbotInlineConnect",
  "headlessSessionIndex",
  "headlessDurableTurns", "headlessSessionCells",
  "workbotGuidedNavigation", "headlessStepTurns",
  "engineV2Upgrade", "engineV2ForceUpgrade",
  "workbotTeamLinks", "remoteSessionEvents", "modelsAnalyticsUi", "taskAnalyticsUi",
  "offlineRecovery",
  "connectToolShapes", "desktopConnectStandardTools",
  "localProviderMirror", "organizationAutomationSettings", "agentConnectionRemoval",
  "workbotCommandPalette", "usageLimitUpgrade", "removeOpencodeZen",
  "desktopSignInReturn", "claudeHistoryImport", "orgPrompts",
  "enterprisePlan", "organizationGrants",
  "teamPlan", "selfServeEnterprise",
  "libraryDetailBreadcrumbs", "nativeAffordanceCodeMode", "libraryConnectorNavigation", "mcpAppLibraries",
  "gatewayProviderTest", "mermaidZoom", "sandboxOrgs", "slackSendAsBot", "liveProviderSync",
  "browserFloatingView", "remoteSessionSubagents", "remoteSessionThreadView", "remoteSessionAnswers",
  "activationChecklist", "gatewayProviderAuthErrors", "providerCredentialStatus", "sessionTokenHashing",
  "customConnectorSetup", "expandedMcpPresets", "analyticsDailyTrends", "gatewayProviderRemovalLimits",
  "guidedSlackSetup", "libraryConnectorOrgSetup",
  "workbotIncludedModels", "workbotUsageRecovery",
  "liveReplyModel", "composerSubagentTracker", "textActivityRail", "artifactsListFirst",
  "automationIntervalSchedules", "automationCalendarTriggers",
  "workbotAgentHealthView", "workbotAgentLibrary", "browserLiveView", "computerUseBackground",
  "lastUsedSignIn", "remoteSessionHelperView",
  "desktopUpdateDownloadWindow",
  "featureIntros", "authSecuritySettings", "sessionSecuritySettings", "ssoSettingsOnSsoPage",
  "multipleSsoConnections", "configBlobs", "gatewayMemberApiKeys", "gatewayCustomProviders",
  "autoRouter",
  "truefoundryGateway",
  "googleCalendarRecurrence", "googleDrivePdfText", "plainFreeModel",
  "settledSessions", "appToolRepair", "publicApps",
  "appSites", "composerBackgroundTasks", "agentQuestions",
  "steadyLiveTurn", "ssoPerOrganization", "superAdminPermissionSet",
  "desktopPersonalConnectors", "workbotDriveFiles", "workbotAccountMenu",
  "workbotBrowserChat", "workbotInstantOpen", "workbotBrowserRecovery",
  "workbotQuickReply", "workbotWorkingStatus", "workbotCenteredProfile",
  "workbotBrowserPreview", "workbotProfileSheet", "workbotRemoteTasks",
  "workbotProfileNav", "workbotQuietCalendar", "workbotSlackAnswerReply",
  "browserUploadPermissions", "agentHarnessPermissions", "computerUse",
  "computerSessionHistory", "parallelComputerUse", "browserUse",
  "remoteSessionPush", "sandboxMicrosoft365", "standardCodeMode",
  "outlookAttachments",
  "claudeAgentProvider", "webPerMember", "localModelsPolicy",
  "shareDeviceProvider", "singleOpenWorkModelsRow", "passwordSignInGoogle",
  "signInEmailSync", "ssoOidcSetupCheck", "denPageConsistency",
  "nativeDictation", "workbotScrollToBottom", "workbotApps",
  "workbotProactive", "workbotTeamSettings", "workbotUsageAnalytics",
  "fileSendPermissions", "remoteDevices", "remoteSessionAccess",
  "teamSettingsSidebar",
  "workbotSettingsTabs", "sandboxSlack",
  "sandboxModelChoice",
  "settingsFind",
  "freeAutoSharedBudgets", "freeAutoSafetyPauses", "desktopOnlyFreeAuto",
  "freeAutoCrossOrgBudgets", "freeAutoSafetyCases", "fundedModelAccountSuspensions",
  "workbotAgentBrief", "workbotProfileComputers", "workbotDeviceActivity",
  "workbotEnableAllConnectors", "workbotAgentStoppedSources", "chatRunCommands",
  "chatTableExpand", "sessionMultiSelect", "followUpSuggestions",
  "sideChatPanel", "personalSkillPortability", "denGreySidebar",
  "litellmEntraMemberSignIn", "sandboxTools", "mcpThreadEvents",
  "nativeMcpEvents",
] as const

export function isFeatureKey(value: string): value is FeatureKey {
  return Object.hasOwn(FEATURES, value)
}

export const FEATURE_KEYS: readonly FeatureKey[] = Object.keys(FEATURES).filter(isFeatureKey)

function isFeatureCategory(value: string): value is FeatureCategory {
  return Object.hasOwn(FEATURE_CATEGORIES, value)
}

/** Category keys in the order /admin shows them. */
export const FEATURE_CATEGORY_KEYS: readonly FeatureCategory[] = Object.keys(FEATURE_CATEGORIES).filter(isFeatureCategory)

export function featureDefinition(key: FeatureKey): FeatureDefinition {
  return FEATURES[key]
}

/** The given keys (every feature by default) grouped in FEATURE_CATEGORIES order; empty groups are left out. */
export function featuresByCategory(keys: readonly FeatureKey[] = FEATURE_KEYS): Array<{ category: FeatureCategory; keys: FeatureKey[] }> {
  const groups: Array<{ category: FeatureCategory; keys: FeatureKey[] }> = []
  for (const category of FEATURE_CATEGORY_KEYS) {
    const inCategory = keys.filter((key) => featureDefinition(key).category === category)
    if (inCategory.length > 0) groups.push({ category, keys: inCategory })
  }
  return groups
}

/** The feature declares `outcomes`: /admin › Features reads whether it ran and worked. */
export function featureHasOutcomes(key: FeatureKey): key is OutcomeFeatureKey {
  return featureDefinition(key).outcomes === true
}

/** Every feature that declares `outcomes`, in registry order. */
export const OUTCOME_FEATURE_KEYS: readonly OutcomeFeatureKey[] = FEATURE_KEYS.filter(featureHasOutcomes)

/** Internal docs are read in the open-source repo, on the default branch. */
export const FEATURE_DOCS_BASE_URL = "https://github.com/different-ai/openwork/blob/dev/"

/** Link to the feature's internal doc, or null when it has none yet. */
export function featureDocsUrl(key: FeatureKey): string | null {
  const docs = featureDefinition(key).docs
  return docs ? `${FEATURE_DOCS_BASE_URL}${docs}` : null
}

export function featureAvailableOn(key: FeatureKey, deployment: FeatureDeployment): boolean {
  return featureDefinition(key).deployments.includes(deployment)
}

/** Features that exist on this deployment; the only ones with a Helm key there. */
export function availableFeatureKeys(deployment: FeatureDeployment): FeatureKey[] {
  return FEATURE_KEYS.filter((key) => featureAvailableOn(key, deployment))
}

/**
 * `newThing` → `DEN_FEATURE_NEW_THING`. Must match the Helm chart's
 * `snakecase | upper`; `pnpm features:check` renders the chart to prove it.
 */
export function featureLockEnvName(key: FeatureKey): string {
  return `DEN_FEATURE_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`
}

/** Builds a value for every registry key, so adding an entry never means editing a literal. */
export function mapFeatures<V>(fn: (key: FeatureKey) => V): Record<FeatureKey, V> {
  const result: Partial<Record<FeatureKey, V>> = {}
  for (const key of FEATURE_KEYS) result[key] = fn(key)
  return result as Record<FeatureKey, V>
}

/** Accepts exactly the registry keys. */
export const featureKeySchema = z.enum(mapFeatures((key) => key))

/** Deployment-wide state of one feature, stored per deployment and changed in /admin. */
export type FeatureRollout = { enabled: boolean; killed: boolean }

export type FeatureRollouts = Partial<Record<FeatureKey, FeatureRollout>>

/** The stored state, or the registry default when nothing is stored. */
export function featureRollout(key: FeatureKey, rollouts: FeatureRollouts): FeatureRollout {
  return rollouts[key] ?? { enabled: featureDefinition(key).default, killed: false }
}

export type FeatureEnvironment = {
  deployment: FeatureDeployment
  locks: FeatureOverrides
}

export type FeatureContext = FeatureEnvironment & {
  rollouts: FeatureRollouts
  overrides: FeatureOverrides
  memberOverrides?: FeatureOverrides
}

export type FeatureSource = "unavailable" | "killed" | "lock" | "override" | "member" | "everyone"

export type ResolvedFeature = {
  key: FeatureKey
  enabled: boolean
  source: FeatureSource
  everyone: boolean
  killed: boolean
  lock: boolean | null
  override: boolean | null
  overrideApplies: boolean
}

export function resolveFeature(key: FeatureKey, context: FeatureContext): ResolvedFeature {
  const { enabled: everyone, killed } = featureRollout(key, context.rollouts)
  const lock = context.locks[key] ?? null
  const override = context.overrides[key] ?? null
  const base = { key, everyone, killed, lock, override }
  if (!featureAvailableOn(key, context.deployment)) {
    return { ...base, enabled: false, source: "unavailable", overrideApplies: false }
  }
  if (killed) return { ...base, enabled: false, source: "killed", overrideApplies: false }
  if (lock !== null) return { ...base, enabled: lock, source: "lock", overrideApplies: false }
  const memberOverride = context.memberOverrides?.[key]
  if (memberOverride !== undefined) return { ...base, enabled: memberOverride, source: "member", overrideApplies: true }
  if (override !== null) return { ...base, enabled: override, source: "override", overrideApplies: true }
  return { ...base, enabled: everyone, source: "everyone", overrideApplies: true }
}

export function resolveFeatures(context: FeatureContext): FeatureMap {
  return mapFeatures((key) => resolveFeature(key, context).enabled)
}

export type FeatureEnvironmentProblem = { variable: string; message: string; fatal: boolean }

/**
 * Reads DEN_DEPLOYMENT and DEN_FEATURE_* from an environment record. Fatal
 * problems (unknown deployment, a value other than "true"/"false") should stop
 * the server at boot; the others are warnings about ignored variables.
 */
export function parseFeatureEnvironment(env: Record<string, string | undefined>): FeatureEnvironment & { problems: FeatureEnvironmentProblem[] } {
  const problems: FeatureEnvironmentProblem[] = []
  const rawDeployment = env.DEN_DEPLOYMENT?.trim() ?? ""
  let deployment: FeatureDeployment = "self_hosted"
  if (rawDeployment === "cloud" || rawDeployment === "self_hosted") {
    deployment = rawDeployment
  } else if (rawDeployment !== "") {
    problems.push({ variable: "DEN_DEPLOYMENT", message: `must be "cloud" or "self_hosted", got "${rawDeployment}".`, fatal: true })
  }

  const locks: FeatureOverrides = {}
  const known = new Map<string, FeatureKey>(FEATURE_KEYS.map((key) => [featureLockEnvName(key), key]))
  for (const [variable, rawValue] of Object.entries(env)) {
    if (!variable.startsWith("DEN_FEATURE_")) continue
    const value = rawValue?.trim() ?? ""
    if (value === "") continue
    const key = known.get(variable)
    if (!key) {
      problems.push({ variable, message: "is not a known feature and is ignored.", fatal: false })
      continue
    }
    if (value !== "true" && value !== "false") {
      problems.push({ variable, message: `must be "true", "false" or empty, got "${value}".`, fatal: true })
      continue
    }
    if (!featureAvailableOn(key, deployment)) {
      problems.push({ variable, message: `is ignored: ${key} is not part of this deployment.`, fatal: false })
      continue
    }
    locks[key] = value === "true"
  }

  return { deployment, locks, problems }
}
