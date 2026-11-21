export type CatalogAvailabilityContext = {
  generatedArtifactViewsEnabled: boolean
  managedDeploymentsEnabled: boolean
  usageSource?: string
}

export const AGENT_CONNECTION_REMOVAL_PATH = "/v1/mcp-connections/{connectionId}/removal-request"

export function catalogOperationAvailableToCapabilities(
  context: CatalogAvailabilityContext,
  operation: { method: string; path: string },
) {
  if (operation.path === "/v1/managed-deployments" || operation.path.startsWith("/v1/managed-deployments/")) {
    return context.managedDeploymentsEnabled
  }
  if (operation.path === AGENT_CONNECTION_REMOVAL_PATH) {
    return context.usageSource === "agent"
  }
  if (context.generatedArtifactViewsEnabled) return true
  return operation.path !== "/v1/workflows/{configObjectId}/views"
    && !operation.path.startsWith("/v1/artifact-views/")
}
