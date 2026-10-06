import { granted, usable, type LegacyOracle } from "@openwork-ee/den-modules"
import { cloudAutomationRuntimeForOrganization } from "../automations/headless-runtime.js"
import { memberFacingMcpConnectionsEnabled } from "../capability-sources/external-mcp-rollout.js"
import { organizationInstallLinksEnabled } from "../capability-sources/install-links-rollout.js"
import { checkEntitlement, getAuditEntitlement } from "../entitlements.js"
import { env } from "../env.js"
import { remoteSessionCapabilitiesEnabled } from "../mcp/remote-session-capabilities.js"
import { appMcpServersEnabled } from "../mcp-app-rollout.js"
import { isOpenWorkWebAvailableForOrganization } from "../openwork-web-availability.js"
import { organizationHasCapability, organizationManagedDashboardsEnabled } from "../organization-capabilities.js"
import { slackRuntimeForOrganization } from "../slack-assistant/headless.js"
import { workbotOrigin } from "../workbot/config.js"

type MetadataInput = Record<string, unknown> | string | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The legacy helpers' metadata parameter type; anything else reads as "no metadata", as they would. */
function metadataOf(value: unknown): MetadataInput {
  if (typeof value === "string" || isRecord(value)) return value
  return null
}

/**
 * Today's helpers, unchanged, as shadow-compare oracles (plan W0-03 step 12,
 * 00-legacy-mapping §H.1). Each compares at the level the helper answers:
 * effective state (`usable`), entitlement plus availability (`granted`), or
 * an operation-level plan gate (`planAllows`).
 */
export function createDenApiLegacyOracles(): LegacyOracle[] {
  return [
    { id: "org.capabilities.mcpConnections", moduleId: "connect", legacy: (row) => memberFacingMcpConnectionsEnabled(metadataOf(row.metadata)) },
    { id: "org.capabilities.installLinks", moduleId: "installLinks", legacy: (row) => organizationInstallLinksEnabled(metadataOf(row.metadata)) },
    { id: "org.capabilities.appMcpServers", moduleId: "mcpApps", legacy: (row) => appMcpServersEnabled(metadataOf(row.metadata)) },
    { id: "org.capabilities.orgManagedDashboards", moduleId: "dashboards", legacy: (row) => organizationManagedDashboardsEnabled(metadataOf(row.metadata)) },
    { id: "org.capabilities.openworkWeb", moduleId: "openworkWeb", legacy: (row) => isOpenWorkWebAvailableForOrganization(metadataOf(row.metadata)) },
    {
      id: "org.capabilities.workbot",
      moduleId: "workbot",
      legacy: (row) => organizationHasCapability(metadataOf(row.metadata), "workbot") && workbotOrigin() !== null,
    },
    {
      id: "org.capabilities.auditLogs",
      moduleId: "auditLogs",
      legacy: (row) => organizationHasCapability(metadataOf(row.metadata), "auditLogs") && env.auditVisibilityEnabled,
      resolved: (view) => usable(view.state("auditLogs")) && view.planAllows("audit.read"),
    },
    {
      id: "org.capabilities.modelsAnalytics",
      moduleId: "openworkModels.analytics",
      legacy: (row) => organizationHasCapability(metadataOf(row.metadata), "modelsAnalytics"),
      resolved: (view) => granted(view.state("openworkModels.analytics")),
    },
    {
      id: "org.capabilities.slackAssistant",
      moduleId: "slackAssistant",
      legacy: (row) => organizationHasCapability(metadataOf(row.metadata), "slackAssistant"),
      resolved: (view) => granted(view.state("slackAssistant")),
    },
    {
      id: "org.capabilities.slackAssistantHeadless",
      moduleId: "slackAssistant.headless",
      legacy: (row) => slackRuntimeForOrganization(metadataOf(row.metadata)) === "headless",
      resolved: (view) => granted(view.state("slackAssistant.headless")),
    },
    {
      id: "automations.headlessRuntime",
      moduleId: "automations.headless",
      legacy: (row) => cloudAutomationRuntimeForOrganization(metadataOf(row.metadata)) === "headless",
    },
    { id: "automations.remoteSessions", moduleId: "automations.remoteSessions", legacy: () => remoteSessionCapabilitiesEnabled() },
    {
      id: "org.entitlements.sso",
      moduleId: "enterpriseAuth.sso",
      legacy: (row) => checkEntitlement(metadataOf(row.metadata), "sso").ok,
      resolved: (view) => view.planAllows("sso.configure"),
    },
    {
      id: "org.entitlements.desktopPolicies",
      moduleId: "desktopPolicies",
      legacy: (row) => checkEntitlement(metadataOf(row.metadata), "desktopPolicies").ok,
      resolved: (view) => view.planAllows("desktopPolicies.write"),
    },
    {
      id: "org.entitlements.desktopPolicies.branding",
      moduleId: "branding",
      legacy: (row) => checkEntitlement(metadataOf(row.metadata), "desktopPolicies").ok,
      resolved: (view) => view.planAllows("branding.write"),
    },
    {
      id: "org.entitlements.orgControls",
      moduleId: "versionPinning",
      legacy: (row) => checkEntitlement(metadataOf(row.metadata), "orgControls").ok,
      resolved: (view) => view.planAllows("versionPinning.write"),
    },
    {
      id: "org.entitlements.auditLogs",
      moduleId: "auditLogs",
      legacy: (row) => getAuditEntitlement(metadataOf(row.metadata)).enabled,
      resolved: (view) => view.planAllows("audit.entitlement"),
    },
    { id: "env.gateway", moduleId: "aiGateway", legacy: () => env.gatewayEnabled },
    { id: "env.automationsRuntime", moduleId: "automations", legacy: () => env.automations.runtimeEnabled },
    { id: "env.freeInference", moduleId: "freeInference", legacy: () => env.inferenceFree.enabled },
  ]
}
