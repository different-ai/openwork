import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { createExternalMcpLifecycleDeadline } from "../capability-sources/external-mcp-client.js"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import { personalAgentPeople, personOrUnknown } from "../personal-agents/access.js"
import { listNativeProviderUsableEntries } from "../capability-sources/native-provider-connections.js"
import { OPENWORK_CONNECTION_ID, OPENWORK_CONNECTION_NAME, operationTool } from "../personal-agents/builtin-connection.js"
import { listRequestablePersonalAgentConnections, normalizedPersonalAgentConnectorName, personalAgentConnectorAccess } from "../personal-agents/connector-access.js"
import { personalAgentRequestEventDetail, recordPersonalAgentEvent } from "../personal-agents/events.js"
import { personalAgentExecutionContext } from "../personal-agents/permissions-dispatch.js"
import { personalAgentToolTitle } from "../personal-agents/permissions-policy.js"
import type { PersonalAgentExecution } from "./workbot-turn-limits.js"
import { agentApprovalContext, CONNECTOR_ONLY_TOOL_NAME, requestAgentConnectorApproval } from "../tool-permissions/approvals.js"
import { openWorkOperations, type CapabilityRegistryContext } from "./capability-registry.js"
import type { McpToolOperation } from "./catalog.js"
import { cachedSearchTools, listExternalMcpToolsThroughSearchCache, type McpMemberIdentity } from "./external-capabilities.js"
import { nativeOperations } from "./native-capabilities.js"

function textContent(text: string): { type: "text"; text: string }[] {
  return [{ type: "text", text }]
}

export const AGENT_CONNECTOR_REQUEST_TOOL_NAME = "request_agent_connector_access"

const outputSchema = z.object({
  status: z.enum(["pending", "unavailable"]),
  requestId: z.string().optional(),
  connectionName: z.string().optional(),
  message: z.string(),
})

type ExternalConnection = Awaited<ReturnType<typeof listRequestablePersonalAgentConnections>>[number]
type RequestableConnection = { id: string; name: string } & ({ external: ExternalConnection } | { operations: readonly McpToolOperation[] })

export async function listRequestableAgentConnections(ctx: CapabilityRegistryContext): Promise<RequestableConnection[]> {
  const member = ctx.member
  if (!member) return []
  const scope = { organizationId: ctx.organizationId, memberId: member.orgMembershipId, scopes: ctx.principal.scopes }
  const access = await personalAgentConnectorAccess(scope)
  if (!access?.canRequest) return []
  const [external, native] = await Promise.all([
    listRequestablePersonalAgentConnections(scope),
    listNativeProviderUsableEntries({ organizationId: ctx.organizationId, orgMembershipId: member.orgMembershipId, teamIds: member.teamIds }),
  ])
  const all: RequestableConnection[] = [
    ...(access.state(OPENWORK_CONNECTION_ID) === "off" ? [{ id: OPENWORK_CONNECTION_ID, name: OPENWORK_CONNECTION_NAME, operations: openWorkOperations(ctx) }] : []),
    ...native.filter((entry) => entry.connectedForMe && access.state(entry.id) === "off")
      .map((entry) => ({ id: entry.id, name: entry.name, operations: nativeOperations(ctx.catalog, entry.nativeProviderKey) })),
    ...external.map((connection) => ({ id: connection.id, name: connection.name, external: connection })),
  ]
  const counts = new Map<string, number>()
  for (const { name } of all) {
    const normalized = normalizedPersonalAgentConnectorName(name)
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  return all.filter(({ name }) => counts.get(normalizedPersonalAgentConnectorName(name)) === 1)
}

export function registerAgentConnectorRequestTool(server: McpServer, input: {
  member: McpMemberIdentity
  execution: PersonalAgentExecution
  capabilityContext: CapabilityRegistryContext
}) {
  const { organizationId, redirectUriBase } = input.capabilityContext
  const scopes = input.capabilityContext.principal.scopes
  server.registerTool(AGENT_CONNECTOR_REQUEST_TOOL_NAME, {
    title: "Ask to use a connector",
    description: "Ask a person to let this agent use a named connector that is off. Only ask when the current task needs that connector. If you already know the exact tool name or title, supply it as action; otherwise omit it. This never uses the connector. If a request is pending, finish what you can and say what is waiting. A person can approve in OpenWork for a later run.",
    inputSchema: z.object({
      connectionName: z.string().trim().min(1).max(255).describe("Exact name of a connector that is off."),
      action: z.string().trim().min(1).max(240).optional().describe("Exact tool name or title, if known."),
    }).strict(),
    outputSchema,
  }, async ({ connectionName, action }) => {
    const unavailable = { status: "unavailable", message: "This connector is not available to request. Use the exact name of an off connector shown in search." }
    const respond = (result: z.infer<typeof outputSchema>) => ({ structuredContent: result, content: textContent(JSON.stringify(result)) })
    const memberId = input.member.orgMembershipId
    const scope = { organizationId, memberId, scopes }
    const context = await personalAgentExecutionContext(input.execution, organizationId, memberId)
    if (!context || context.paused) return respond({ ...unavailable, status: "unavailable" })
    const requested = normalizedPersonalAgentConnectorName(connectionName)
    const candidates = (await listRequestableAgentConnections(input.capabilityContext))
      .filter((connection) => normalizedPersonalAgentConnectorName(connection.name) === requested)
    const [connection] = candidates
    if (!connection || candidates.length !== 1) return respond({ ...unavailable, status: "unavailable" })

    let toolName = CONNECTOR_ONLY_TOOL_NAME
    let toolTitle = ""
    const external = "external" in connection ? connection.external : null
    if (action && !external?.toolPolicy?.allDisabled) {
      const tools = "operations" in connection ? connection.operations.map(operationTool).map(({ name, title }) => ({ name, title }))
        : (cachedSearchTools(connection.external, input.member) ?? await listExternalMcpToolsThroughSearchCache({
          connection: connection.external, member: input.member, redirectUriBase,
          deadline: createExternalMcpLifecycleDeadline(3000),
        }).catch(() => [])).map((tool) => ({ name: tool.name, title: personalAgentToolTitle(tool) }))
      const exact = tools.filter((tool) => tool.name === action)
      const matches = exact.length ? exact : tools.filter((tool) => normalizedPersonalAgentConnectorName(personalAgentToolTitle(tool)) === normalizedPersonalAgentConnectorName(action))
      const [match] = matches
      if (matches.length === 1 && match && match.name !== CONNECTOR_ONLY_TOOL_NAME && match.name.length <= 128) {
        const access = await personalAgentConnectorAccess(scope)
        if (!access || access.state(connection.id) !== "off" || access.toolBlocked(connection.id, match.name) || (external && isToolDisabled(external.toolPolicy, match.name))) {
          return respond({ ...unavailable, status: "unavailable" })
        }
        toolName = match.name
        toolTitle = personalAgentToolTitle(match)
      }
    }
    const request = await requestAgentConnectorApproval({ organizationId, memberId,
      context: agentApprovalContext(context, input.execution),
      connectionId: connection.id, connectionName: connection.name, toolName, toolTitle,
    })
    if (!request) return respond({ ...unavailable, status: "unavailable" })
    if (request.created) {
      const people = await personalAgentPeople(organizationId, [memberId])
      await recordPersonalAgentEvent({ organizationId, agentId: context.agentId, actorMemberId: memberId, action: "request.asked",
        detail: personalAgentRequestEventDetail({ requester: personOrUnknown(people, memberId).name, kind: "tool", tool: toolTitle || null, connection: connection.name }),
      })
    }
    return respond({ status: "pending", requestId: request.id, connectionName: connection.name,
      message: "I asked in this agent’s chat. Finish what you can and say what is waiting. Do not retry in this turn.",
    })
  })
}
