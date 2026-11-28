import { NATIVE_OAUTH_PROVIDERS } from "../capability-sources/provider-registry.js"
import { personalAgentExecution } from "../mcp/workbot-turn-limits.js"
import { toolPermissionRefusal, type ToolPermissionRefusal } from "../tool-permissions/dispatch.js"
import { OPENWORK_CONNECTION_ID, OPENWORK_CONNECTION_NAME } from "./connector-access.js"
import { personalAgentExecutionContext, personalAgentPolicyRefusal } from "./permissions-dispatch.js"

export { OPENWORK_CONNECTION_ID, OPENWORK_CONNECTION_NAME }

export function isBuiltInAgentConnection(connectionId: string): boolean {
  return connectionId === OPENWORK_CONNECTION_ID || Object.hasOwn(NATIVE_OAUTH_PROVIDERS, connectionId)
}

type Operation = { name: string; method: string; path: string; operation: { summary?: string } }

export function operationTool(operation: Operation) {
  const method = operation.method.toUpperCase()
  return {
    name: operation.name,
    title: (operation.operation.summary ?? operation.name).slice(0, 240),
    annotations: { readOnlyHint: method === "GET" || method === "HEAD", destructiveHint: method === "DELETE" },
  }
}

const ORGANIZATION_AGENT_PATHS = ["/v1/org/personal-agent-policy", "/v1/org/personal-agents"]
const AUTOMATION_PATHS = ["/v1/automations"]
const AGENTS_PATH = "/v1/personal-agents"
const AGENT_PATH = "/v1/personal-agents/{id}"
const AGENT_SHARES_PATH = "/v1/personal-agents/{id}/shares"
const OWNER_ONLY_FIELDS = ["toolPolicy", "monthlyBudgetMicros"]

function underPath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function widensAgentAccess(operation: Operation, input: { path?: Record<string, unknown>; body?: unknown }, agentId: string): string | null {
  const method = operation.method.toUpperCase()
  if (method === "GET" || method === "HEAD") return null
  if (underPath(operation.path, ORGANIZATION_AGENT_PATHS)) return "An agent cannot change what your organization allows agents to do."
  if (underPath(operation.path, AUTOMATION_PATHS)) return "An agent cannot change Automations, because they run without this agent's limits. It can add a routine to itself instead."
  if (!underPath(operation.path, [AGENTS_PATH])) return null
  if (!underPath(operation.path, [AGENT_PATH])) return "An agent cannot make another agent."
  if (String(input.path?.id ?? "") !== agentId) return "An agent can only change itself, not another agent."
  if (underPath(operation.path, [AGENT_SHARES_PATH])) return "An agent cannot change who it is shared with."
  const body = input.body
  if (isRecord(body) && OWNER_ONLY_FIELDS.some((field) => Object.hasOwn(body, field))) {
    return "An agent cannot change what it is allowed to use or spend. It can ask its owner with a change request."
  }
  return null
}

export async function personalAgentOperationRefusal(input: {
  scopes: ReadonlySet<string>
  organizationId: string
  userId: string
  operation: Operation
  toolInput: { path?: Record<string, unknown>; body?: unknown }
  connection?: { id: string; name: string }
}): Promise<ToolPermissionRefusal | null> {
  const execution = personalAgentExecution(input.scopes)
  if (!execution) return null
  const context = await personalAgentExecutionContext(execution, input.organizationId, undefined, execution.kind === "chat" ? input.userId : undefined)
  if (!context) return personalAgentPolicyRefusal("This run is no longer active or no longer has access to this agent.")
  if (context.paused) return personalAgentPolicyRefusal("An admin paused this agent.")
  const widening = widensAgentAccess(input.operation, input.toolInput, context.agentId)
  if (widening) return personalAgentPolicyRefusal(widening)
  return toolPermissionRefusal({
    scopes: input.scopes,
    connection: { ...(input.connection ?? { id: OPENWORK_CONNECTION_ID, name: OPENWORK_CONNECTION_NAME }), organizationId: input.organizationId },
    tool: operationTool(input.operation),
    actingMemberId: context.memberId,
  })
}
