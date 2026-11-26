export type CatalogAvailabilityContext = {
  generatedArtifactViewsEnabled: boolean
  managedDeploymentsEnabled: boolean
  limitedAgentRun?: boolean
  usageSource?: string
}

const GMAIL_THREAD_READ_PATH = "/v1/capabilities/google-workspace/gmail-thread/{threadId}"

export function filterGmailThreadRead<T extends { path: string }>(catalog: readonly T[], enabled?: boolean): readonly T[] {
  return enabled ? catalog : catalog.filter((operation) => operation.path !== GMAIL_THREAD_READ_PATH)
}

const PERSONAL_AGENTS_PATH = "/v1/personal-agents"

export function filterPersonalAgents<T extends { path: string }>(catalog: readonly T[], enabled?: boolean): readonly T[] {
  return enabled ? catalog : catalog.filter((operation) => (
    operation.path !== PERSONAL_AGENTS_PATH && !operation.path.startsWith(`${PERSONAL_AGENTS_PATH}/`)
  ))
}

export function limitedAgentRunMayCall(operation: { method: string }): boolean {
  return operation.method.toUpperCase() === "GET"
}

export const AGENT_CONNECTION_REMOVAL_PATH = "/v1/mcp-connections/{connectionId}/removal-request"

export function catalogOperationAvailableToCapabilities(
  context: CatalogAvailabilityContext,
  operation: { method: string; path: string },
) {
  if (context.limitedAgentRun && !limitedAgentRunMayCall(operation)) return false
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
