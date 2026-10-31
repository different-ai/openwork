import { z } from "zod"

/**
 * Published desktop clients interpret a missing rollout key as a rollback.
 * These response-only values preserve the graduated behavior during API-first
 * upgrades. They are not registry entries, rollout state or admin controls.
 *
 * Remove a value only when no supported published desktop version still reads
 * that key (and the minimum supported client version enforces that boundary).
 * sandboxOrgs is deliberately absent: sandbox availability is cloud-only and
 * is advertised by its deployment-checked admin API, not a client rollout key.
 */
const retired = z.literal(true).default(true).meta({
  deprecated: true,
  description: "Fixed compatibility value for supported published desktop clients; not a configurable feature.",
})
const retiredClientFeaturesSchema = z.object({
  engineV2ForceUpgrade: retired,
  libraryDetailBreadcrumbs: retired,
  nativeAffordanceCodeMode: retired,
  libraryConnectorNavigation: retired,
  mcpAppLibraries: retired,
  gatewayProviderTest: retired,
  mermaidZoom: retired,
  slackSendAsBot: retired,
  liveProviderSync: retired,
  browserFloatingView: retired,
  remoteSessionSubagents: retired,
  remoteSessionThreadView: retired,
  remoteSessionAnswers: retired,
  activationChecklist: retired,
  gatewayProviderAuthErrors: retired,
  providerCredentialStatus: retired,
  sessionTokenHashing: retired,
  customConnectorSetup: retired,
  expandedMcpPresets: retired,
  analyticsDailyTrends: retired,
  gatewayProviderRemovalLimits: retired,
  guidedSlackSetup: retired,
  libraryConnectorOrgSetup: retired,
  workbotIncludedModels: retired,
  workbotUsageRecovery: retired,
  liveReplyModel: retired,
  composerSubagentTracker: retired,
  textActivityRail: retired,
  artifactsListFirst: retired,
  automationIntervalSchedules: retired,
  automationCalendarTriggers: retired,
})

export const clientFeaturesSchema = retiredClientFeaturesSchema.meta({
  description: "Effective feature state plus deprecated fixed true compatibility values for graduated behavior. Compatibility values are not configurable features.",
}).catchall(z.boolean())

/** Response-only compatibility: never persist these keys as registry/admin state. */
export function clientFeatures(features: Record<string, boolean>): Record<string, boolean> & z.infer<typeof retiredClientFeaturesSchema> {
  return { ...features, ...retiredClientFeaturesSchema.parse({}) }
}
