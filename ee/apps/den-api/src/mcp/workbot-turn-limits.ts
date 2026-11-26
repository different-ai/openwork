import type { AgentSourcesPolicy } from "@openwork/types/den/workbot-proactive"

const WITHOUT_CONNECTION_SCOPE_PREFIX = "openwork:workbot-without-connection:"
const WITHOUT_TOOL_SCOPE_PREFIX = "openwork:agent-without-tool:"
const LIMITED_AGENT_RUN_SCOPE = "openwork:agent-run-limited"
const AGENT_RUN_SCOPE_PREFIX = "openwork:agent-run:"
const AGENT_TOOL_CHOICE_PREFIX = "openwork:agent-tool:"

export function personalAgentRunScope(runId: string): string {
  return `${AGENT_RUN_SCOPE_PREFIX}${runId}`
}

export function personalAgentRunId(scopes: ReadonlySet<string>): string | undefined {
  for (const scope of scopes) {
    if (scope.startsWith(AGENT_RUN_SCOPE_PREFIX)) return scope.slice(AGENT_RUN_SCOPE_PREFIX.length)
  }
}

export function personalAgentToolChoiceScope(choice: "allow" | "ask" | "allow_once", connectionId: string, toolName: string): string {
  return `${AGENT_TOOL_CHOICE_PREFIX}${choice}:${encodeURIComponent(connectionId)}/${encodeURIComponent(toolName)}`
}

export function isWorkbotTurnLimitScope(scope: string): boolean {
  return scope.startsWith(WITHOUT_CONNECTION_SCOPE_PREFIX)
    || scope.startsWith(WITHOUT_TOOL_SCOPE_PREFIX)
    || scope.startsWith(AGENT_RUN_SCOPE_PREFIX)
    || scope.startsWith(AGENT_TOOL_CHOICE_PREFIX)
    || scope === LIMITED_AGENT_RUN_SCOPE
}

export function isLimitedAgentRun(scopes: ReadonlySet<string>): boolean {
  return scopes.has(LIMITED_AGENT_RUN_SCOPE) || personalAgentRunId(scopes) !== undefined
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
    if (!scope.startsWith(WITHOUT_CONNECTION_SCOPE_PREFIX)) continue
    const id = scope.slice(WITHOUT_CONNECTION_SCOPE_PREFIX.length)
    if (id) ids.add(id)
  }
  return ids.size ? ids : undefined
}

export function agentToolLimitScopes(blocks: {
  connections: readonly string[]
  tools: readonly { connectionId: string; toolName: string }[]
}): string[] {
  if (blocks.connections.length === 0 && blocks.tools.length === 0) return []
  return [
    LIMITED_AGENT_RUN_SCOPE,
    ...blocks.connections.map((connectionId) => `${WITHOUT_CONNECTION_SCOPE_PREFIX}${connectionId}`),
    ...blocks.tools.map((tool) => `${WITHOUT_TOOL_SCOPE_PREFIX}${encodeURIComponent(tool.connectionId)}/${encodeURIComponent(tool.toolName)}`),
  ]
}

export const LIMITED_AGENT_RUN_MESSAGE = "This run belongs to an agent whose owner limited its tools, so it cannot start other work or change Automations and agents."

export function toolsWithheld(scopes: ReadonlySet<string>): ReadonlyMap<string, ReadonlySet<string>> | undefined {
  const byConnection = new Map<string, Set<string>>()
  for (const scope of scopes) {
    if (!scope.startsWith(WITHOUT_TOOL_SCOPE_PREFIX)) continue
    const [connectionPart, toolPart, ...rest] = scope.slice(WITHOUT_TOOL_SCOPE_PREFIX.length).split("/")
    if (!connectionPart || !toolPart || rest.length) continue
    let connectionId: string
    let toolName: string
    try {
      connectionId = decodeURIComponent(connectionPart)
      toolName = decodeURIComponent(toolPart)
    } catch {
      continue
    }
    const tools = byConnection.get(connectionId) ?? new Set<string>()
    tools.add(toolName)
    byConnection.set(connectionId, tools)
  }
  return byConnection.size ? byConnection : undefined
}

export const AGENT_TOOL_WITHHELD_MESSAGE = "is turned off for this agent. Its owner decides that in the agent's settings."

export const WORKBOT_CONNECTION_WITHHELD_MESSAGE = "isn't allowed for Workbot in your organization. An admin decides that in Workbot's settings."
