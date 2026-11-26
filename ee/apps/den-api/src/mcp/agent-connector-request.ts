import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { createExternalMcpLifecycleDeadline } from "../capability-sources/external-mcp-client.js"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import { personalAgentPeople, personOrUnknown } from "../personal-agents/access.js"
import { listRequestablePersonalAgentConnections, normalizedPersonalAgentConnectorName, personalAgentConnectorAccess } from "../personal-agents/connector-access.js"
import { personalAgentRequestEventDetail, recordPersonalAgentEvent } from "../personal-agents/events.js"
import { personalAgentExecutionContext } from "../personal-agents/permissions-dispatch.js"
import { personalAgentToolTitle } from "../personal-agents/permissions-policy.js"
import type { PersonalAgentExecution } from "./workbot-turn-limits.js"
import { agentApprovalContext, CONNECTOR_ONLY_TOOL_NAME, requestAgentConnectorApproval } from "../tool-permissions/approvals.js"
import { cachedSearchTools, listExternalMcpToolsThroughSearchCache, type McpMemberIdentity } from "./external-capabilities.js"

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

export function registerAgentConnectorRequestTool(server: McpServer, input: {
  organizationId: string
  member: McpMemberIdentity
  execution: PersonalAgentExecution
  scopes: ReadonlySet<string>
  redirectUriBase: string
}) {
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
    const organizationId = input.organizationId
    const memberId = input.member.orgMembershipId
    const scope = { organizationId, memberId, scopes: input.scopes }
    const context = await personalAgentExecutionContext(input.execution, organizationId, memberId)
    if (!context || context.paused) return respond({ ...unavailable, status: "unavailable" })
    const requested = normalizedPersonalAgentConnectorName(connectionName)
    const candidates = (await listRequestablePersonalAgentConnections(scope))
      .filter((connection) => normalizedPersonalAgentConnectorName(connection.name) === requested)
    const [connection] = candidates
    if (!connection || candidates.length !== 1) return respond({ ...unavailable, status: "unavailable" })

    let toolName = CONNECTOR_ONLY_TOOL_NAME
    let toolTitle = ""
    if (action && !connection.toolPolicy?.allDisabled) {
      const tools = cachedSearchTools(connection, input.member) ?? await listExternalMcpToolsThroughSearchCache({
        connection, member: input.member, redirectUriBase: input.redirectUriBase,
        deadline: createExternalMcpLifecycleDeadline(3000),
      }).catch(() => [])
      const exact = tools.filter((tool) => tool.name === action)
      const matches = exact.length ? exact : tools.filter((tool) => normalizedPersonalAgentConnectorName(personalAgentToolTitle(tool)) === normalizedPersonalAgentConnectorName(action))
      const [match] = matches
      if (matches.length === 1 && match && match.name !== CONNECTOR_ONLY_TOOL_NAME && match.name.length <= 128) {
        const access = await personalAgentConnectorAccess(scope)
        if (!access || access.state(connection.id) !== "off" || access.toolBlocked(connection.id, match.name) || isToolDisabled(connection.toolPolicy, match.name)) {
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
