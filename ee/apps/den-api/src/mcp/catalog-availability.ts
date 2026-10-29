/** Feature- and caller-dependent visibility of Den API catalog operations. Pure, so it is testable without a database. */
export type CatalogAvailabilityContext = {
  generatedArtifactViewsEnabled: boolean
  /** Managed deployment planning, launch preparation and status: managed deployments enabled. */
  managedDeploymentsEnabled: boolean
  /**
   * What started these capability calls. Removal is offered only to a person's
   * own agent, never to saved Workflows, Automations or Apps that run unattended.
   */
  usageSource?: string
}

/** Outlook attachment reads (mail-attachments and mail-attachment), rolled out with Outlook attachments. */
export const OUTLOOK_ATTACHMENT_PATH_PREFIX = "/v1/capabilities/microsoft-365/mail-attachment"

/**
 * Provider operations a rollout hides. Native provider search, enumeration and
 * execution read the registry's catalog, so these are filtered out of it; the
 * routes themselves also refuse while the feature is off.
 */
export function nativeOperationAvailableToCapabilities(
  context: { outlookAttachmentsEnabled: boolean },
  operation: { path: string },
) {
  return context.outlookAttachmentsEnabled || !operation.path.startsWith(OUTLOOK_ATTACHMENT_PATH_PREFIX)
}

/** The agent-facing connection removal operation (POST /v1/mcp-connections/{connectionId}/removal-request). */
export const AGENT_CONNECTION_REMOVAL_PATH = "/v1/mcp-connections/{connectionId}/removal-request"

export function catalogOperationAvailableToCapabilities(
  context: CatalogAvailabilityContext,
  operation: { method: string; path: string },
) {
  // Hidden from search, enumeration and execution until the organization has
  // the managed deployments rollout; the routes themselves still enforce permissions and features.
  if (operation.path === "/v1/managed-deployments" || operation.path.startsWith("/v1/managed-deployments/")) {
    return context.managedDeploymentsEnabled
  }
  // Removal preparation is available only to a person's agent, never unattended callers.
  // The route still checks ownership/permissions and leaves deletion to the person's confirmation in Den.
  if (operation.path === AGENT_CONNECTION_REMOVAL_PATH) {
    return context.usageSource === "agent"
  }
  if (context.generatedArtifactViewsEnabled) return true
  return operation.path !== "/v1/workflows/{configObjectId}/views"
    && !operation.path.startsWith("/v1/artifact-views/")
}
