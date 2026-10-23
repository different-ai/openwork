/** Rollout-dependent visibility of Den API catalog operations to agents. Pure, so it is testable without a database. */
export type CatalogAvailabilityContext = {
  generatedArtifactViewsEnabled: boolean
  /** Managed deployment planning, launch preparation and status: managed deployments enabled. */
  managedDeploymentsEnabled: boolean
  /** Removing an organization connection on the user's explicit request: agent connection removal enabled. */
  agentConnectionRemovalEnabled: boolean
  /** Organization environment variables: environment variables enabled. Hidden when left out. */
  environmentVariablesEnabled?: boolean
  /**
   * What started these capability calls. Removal is offered only to a person's
   * own agent, never to saved Workflows, Automations or Apps that run unattended.
   */
  usageSource?: string
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
  // Hidden until the organization has the rollout; the routes also refuse while it is off.
  if (operation.path === "/v1/environment-variables" || operation.path.startsWith("/v1/environment-variables/")) {
    return context.environmentVariablesEnabled === true
  }
  // Hidden until the organization has the rollout; the route also refuses while it is off.
  if (operation.path === AGENT_CONNECTION_REMOVAL_PATH) {
    return context.agentConnectionRemovalEnabled && context.usageSource === "agent"
  }
  if (context.generatedArtifactViewsEnabled) return true
  return operation.path !== "/v1/workflows/{configObjectId}/views"
    && !operation.path.startsWith("/v1/artifact-views/")
}
