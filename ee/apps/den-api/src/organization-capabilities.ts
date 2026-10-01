import { z } from "zod"

/**
 * Per-organization capability flags ("org capabilities").
 *
 * Capabilities let platform admins manage feature switches org-by-org from the
 * /admin backoffice. The helpers here expose the raw stored booleans;
 * feature-specific rollout helpers can layer effective default-on kill-switch
 * semantics for member-facing surfaces.
 *
 * Storage rides the existing organization metadata JSON column — the same
 * home as `limits`, `plan`, and `requireSso` — so no schema change is needed.
 */
export const ORGANIZATION_CAPABILITY_KEYS = ["installLinks", "mcpConnections", "modelsAnalytics", "auditLogs", "orgManagedDashboards", "appMcpServers", "slackAssistant", "slackAssistantHeadless", "headlessAutomations", "cloudBrowser", "workbot"] as const

export const organizationCapabilityKeySchema = z.enum(ORGANIZATION_CAPABILITY_KEYS)

export type OrganizationCapabilityKey = z.infer<typeof organizationCapabilityKeySchema>

export type OrganizationCapabilities = Record<OrganizationCapabilityKey, boolean>

type MetadataInput = Record<string, unknown> | string | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseMetadata(input: MetadataInput): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

/** Every capability key resolved to a boolean, defaulting to false. */
export function normalizeOrganizationCapabilities(metadata: MetadataInput): OrganizationCapabilities {
  const parsed = parseMetadata(metadata)
  const raw = isRecord(parsed.capabilities) ? parsed.capabilities : {}

  return {
    installLinks: raw.installLinks === true,
    mcpConnections: raw.mcpConnections === true,
    modelsAnalytics: raw.modelsAnalytics === true,
    auditLogs: raw.auditLogs === true,
    orgManagedDashboards: raw.orgManagedDashboards === true,
    appMcpServers: raw.appMcpServers === true,
    slackAssistant: raw.slackAssistant === true,
    slackAssistantHeadless: raw.slackAssistantHeadless === true,
    headlessAutomations: raw.headlessAutomations === true,
    cloudBrowser: raw.cloudBrowser === true,
    workbot: raw.workbot === true,
  }
}

/** Only raw, literal org capability overrides that are explicitly stored. */
export function readOrganizationCapabilityOverrides(metadata: MetadataInput): Partial<OrganizationCapabilities> {
  const parsed = parseMetadata(metadata)
  const raw = isRecord(parsed.capabilities) ? parsed.capabilities : {}
  const capabilities: Partial<OrganizationCapabilities> = {}

  if (typeof raw.installLinks === "boolean") {
    capabilities.installLinks = raw.installLinks
  }
  if (typeof raw.mcpConnections === "boolean") {
    capabilities.mcpConnections = raw.mcpConnections
  }

  if (typeof raw.modelsAnalytics === "boolean") capabilities.modelsAnalytics = raw.modelsAnalytics
  if (typeof raw.auditLogs === "boolean") capabilities.auditLogs = raw.auditLogs
  if (typeof raw.orgManagedDashboards === "boolean") capabilities.orgManagedDashboards = raw.orgManagedDashboards
  if (typeof raw.appMcpServers === "boolean") capabilities.appMcpServers = raw.appMcpServers

  if (typeof raw.slackAssistant === "boolean") capabilities.slackAssistant = raw.slackAssistant
  if (typeof raw.slackAssistantHeadless === "boolean") capabilities.slackAssistantHeadless = raw.slackAssistantHeadless
  if (typeof raw.headlessAutomations === "boolean") capabilities.headlessAutomations = raw.headlessAutomations
  if (typeof raw.cloudBrowser === "boolean") capabilities.cloudBrowser = raw.cloudBrowser
  if (typeof raw.workbot === "boolean") capabilities.workbot = raw.workbot

  return capabilities
}

/**
 * Org-managed Dashboards are default-off per organization. Only an explicit
 * `metadata.capabilities.orgManagedDashboards: true` enables the Den admin
 * surface, the /v1/dashboards routes, and granted dashboards in Desktop.
 * Workflows, saved apps, and every other capability are unaffected.
 */
export function organizationManagedDashboardsEnabled(metadata: MetadataInput): boolean {
  return normalizeOrganizationCapabilities(metadata).orgManagedDashboards
}

/**
 * Building your own Apps, each served as its own MCP server, is default-off per
 * organization. Only an explicit `metadata.capabilities.appMcpServers: true`
 * enables it. MCP Apps from connected MCP servers are unaffected.
 */
export function organizationAppMcpServersEnabled(metadata: MetadataInput): boolean {
  return normalizeOrganizationCapabilities(metadata).appMcpServers
}

/** Whether the organization stores an explicit literal true for the capability. */
export function organizationHasCapability(metadata: MetadataInput, key: OrganizationCapabilityKey): boolean {
  return normalizeOrganizationCapabilities(metadata)[key]
}
