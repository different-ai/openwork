import type { AgentSourcesPolicy } from "@openwork/types/den/workbot-proactive"

const WITHOUT_CONNECTION_SCOPE_PREFIX = "openwork:workbot-without-connection:"

export function isWorkbotTurnLimitScope(scope: string): boolean {
  return scope.startsWith(WITHOUT_CONNECTION_SCOPE_PREFIX)
}

export function headlessRunTokenScopes(input: { readOnly?: boolean; scopes?: readonly string[] }): string[] {
  return input.readOnly ? ["mcp:read", ...(input.scopes ?? [])] : ["mcp:read", "mcp:write", ...(input.scopes ?? []).filter(isWorkbotTurnLimitScope)]
}

export function workbotTurnLimitScopes(policy: Pick<AgentSourcesPolicy, "connections">): string[] {
  return Object.entries(policy.connections)
    .filter(([, value]) => value === "off")
    .map(([connectionId]) => `${WITHOUT_CONNECTION_SCOPE_PREFIX}${connectionId}`)
}

export function connectionsWithheld(scopes: ReadonlySet<string>): ReadonlySet<string> | undefined {
  const ids = new Set<string>()
  for (const scope of scopes) {
    if (!isWorkbotTurnLimitScope(scope)) continue
    const id = scope.slice(WITHOUT_CONNECTION_SCOPE_PREFIX.length)
    if (id) ids.add(id)
  }
  return ids.size ? ids : undefined
}

export const WORKBOT_CONNECTION_WITHHELD_MESSAGE = "isn't allowed for Workbot in your organization. An admin decides that in Workbot's settings."
