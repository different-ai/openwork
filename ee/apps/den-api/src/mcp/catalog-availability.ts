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

const TEAMS_MEETING_PATHS = ["/v1/capabilities/microsoft-365/teams-meetings"]

export function filterTeamsMeetingTranscripts<T extends { path: string }>(catalog: readonly T[], enabled?: boolean): readonly T[] {
  return enabled ? catalog : catalog.filter(({ path }) => !underPath(path, TEAMS_MEETING_PATHS))
}

const PERSONAL_AGENT_PATHS = ["/v1/personal-agents", "/v1/org/personal-agents", "/v1/org/personal-agent-policy", "/v1/org/personal-agent-events"]
const TOOL_PERMISSION_PATHS = ["/v1/org/tool-permissions", "/v1/tool-approvals"]

function underPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

export function filterPersonalAgents<T extends { path: string }>(catalog: readonly T[], enabled?: boolean): readonly T[] {
  return catalog.filter(({ path }) => !underPath(path, TOOL_PERMISSION_PATHS) && (enabled || !underPath(path, PERSONAL_AGENT_PATHS)))
}

export function limitedAgentRunMayCall(operation: { method: string }): boolean {
  return operation.method.toUpperCase() === "GET"
}

export const AGENT_CONNECTION_REMOVAL_PATH = "/v1/mcp-connections/{connectionId}/removal-request"

export function catalogOperationAvailableToCapabilities(
  context: CatalogAvailabilityContext,
  operation: { method: string; path: string },
) {
  if (underPath(operation.path, TOOL_PERMISSION_PATHS)) return false
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
