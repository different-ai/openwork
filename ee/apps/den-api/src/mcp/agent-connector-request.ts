import type { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import { createExternalMcpLifecycleDeadline } from "../capability-sources/external-mcp-client.js"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import { personalAgentPeople, personOrUnknown } from "../personal-agents/access.js"
import { listNativeProviderUsableEntries } from "../capability-sources/native-provider-connections.js"
import { OPENWORK_CONNECTION_ID, OPENWORK_CONNECTION_NAME, openWorkConnectionTools, operationTool } from "../personal-agents/builtin-connection.js"
import { COMPUTER_CONNECTION_ID, COMPUTER_CONNECTION_NAME, COMPUTER_CONNECTION_TOOLS, listRequestablePersonalAgentConnections, normalizedPersonalAgentConnectorName, personalAgentComputerOffered, personalAgentConnectorAccess } from "../personal-agents/connector-access.js"
import { personalAgentRequestEventDetail, recordPersonalAgentEvent } from "../personal-agents/events.js"
import { personalAgentExecutionContext } from "../personal-agents/permissions-dispatch.js"
import { personalAgentToolTitle } from "../personal-agents/permissions-policy.js"
import type { PersonalAgentExecution } from "./workbot-turn-limits.js"
import { agentApprovalContext, CONNECTOR_ONLY_TOOL_NAME, requestAgentConnectorApproval } from "../tool-permissions/approvals.js"
import { openWorkOperations, type CapabilityRegistryContext } from "./capability-registry.js"
import type { McpToolOperation } from "./catalog.js"
import { cachedSearchTools, listExternalMcpToolsThroughSearchCache, type McpMemberIdentity } from "./external-capabilities.js"
import { nativeOperations } from "./native-capabilities.js"
import { tokenize } from "./search.js"

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
type NamedTool = { name: string; title: string }
type RequestableConnection = { id: string; name: string } & ({ external: ExternalConnection } | { operations: readonly McpToolOperation[] } | { tools: readonly NamedTool[] })

async function requestableAgentConnections(ctx: CapabilityRegistryContext) {
  const member = ctx.member
  if (!member) return null
  const scope = { organizationId: ctx.organizationId, memberId: member.orgMembershipId, scopes: ctx.principal.scopes }
  const access = await personalAgentConnectorAccess(scope)
  if (!access?.canRequest) return null
  const [computerOffered, external, native] = await Promise.all([
    personalAgentComputerOffered(ctx.organizationId),
    listRequestablePersonalAgentConnections(scope),
    listNativeProviderUsableEntries({ organizationId: ctx.organizationId, orgMembershipId: member.orgMembershipId, teamIds: member.teamIds }),
  ])
  const all: RequestableConnection[] = [
    ...(access.state(OPENWORK_CONNECTION_ID) === "off" ? [{ id: OPENWORK_CONNECTION_ID, name: OPENWORK_CONNECTION_NAME, tools: openWorkConnectionTools(openWorkOperations(ctx)) }] : []),
    ...(computerOffered && access.state(COMPUTER_CONNECTION_ID) === "off" ? [{ id: COMPUTER_CONNECTION_ID, name: COMPUTER_CONNECTION_NAME, tools: COMPUTER_CONNECTION_TOOLS }] : []),
    ...native.filter((entry) => entry.connectedForMe && access.state(entry.id) === "off")
      .map((entry) => ({ id: entry.id, name: entry.name, operations: nativeOperations(ctx.catalog, entry.nativeProviderKey) })),
    ...external.map((connection) => ({ id: connection.id, name: connection.name, external: connection })),
  ]
  const counts = new Map<string, number>()
  for (const { name } of all) {
    const normalized = normalizedPersonalAgentConnectorName(name)
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  return { access, member, connections: all.filter(({ name }) => counts.get(normalizedPersonalAgentConnectorName(name)) === 1) }
}

export async function listRequestableAgentConnections(ctx: CapabilityRegistryContext): Promise<RequestableConnection[]> {
  return (await requestableAgentConnections(ctx))?.connections ?? []
}

async function requestableConnectionTools(connection: RequestableConnection, input: { member: McpMemberIdentity; redirectUriBase: string; waitMs: number }): Promise<NamedTool[]> {
  if ("tools" in connection) return connection.tools.map(({ name, title }) => ({ name, title }))
  if ("operations" in connection) return connection.operations.map(operationTool).map(({ name, title }) => ({ name, title }))
  if (connection.external.toolPolicy?.allDisabled) return []
  const tools = cachedSearchTools(connection.external, input.member) ?? await listExternalMcpToolsThroughSearchCache({
    connection: connection.external, member: input.member, redirectUriBase: input.redirectUriBase,
    deadline: createExternalMcpLifecycleDeadline(input.waitMs),
  }).catch(() => [])
  return tools.filter((tool) => !isToolDisabled(connection.external.toolPolicy, tool.name)).map((tool) => ({ name: tool.name, title: personalAgentToolTitle(tool) }))
}

export type OffAgentTool = { connector: string; tool: string; title: string }

const SEARCH_FILLER = new Set(["a", "an", "and", "any", "at", "can", "do", "for", "get", "have", "i", "in", "me", "my", "of", "on", "or", "our", "please", "some", "that", "the", "this", "to", "use", "with", "you", "your"])

function wordStems(value: string): string[] {
  return tokenize(value).map((token) => token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token)
}

export function searchWords(query: string): string[] {
  return [...new Set(wordStems(query).filter((token) => !SEARCH_FILLER.has(token)))]
}

export function wordScore(words: readonly string[], ...texts: string[]): number {
  const have = new Set(texts.flatMap(wordStems))
  return words.filter((word) => have.has(word)).length
}

export async function searchOffAgentTools(ctx: CapabilityRegistryContext, input: {
  query: string
  limit: number
  alsoMatch?: (connectionId: string, toolName: string) => boolean
}): Promise<{ offConnectors: string[]; offTools: OffAgentTool[] }> {
  const requestable = await requestableAgentConnections(ctx)
  if (!requestable) return { offConnectors: [], offTools: [] }
  const { access, member, connections } = requestable
  const words = searchWords(input.query)
  const scored = (await Promise.all(connections.map(async (connection) => {
    const [tools, reachable] = await Promise.all([
      requestableConnectionTools(connection, { member, redirectUriBase: ctx.redirectUriBase, waitMs: 2000 }),
      ctx.agentToolFilter(connection.id),
    ])
    const named = wordScore(words, connection.name)
    return tools
      .filter((tool) => tool.name.length <= 128 && tool.name !== CONNECTOR_ONLY_TOOL_NAME && !reachable?.(tool.name) && !access.toolBlocked(connection.id, tool.name))
      .map((tool) => ({
        connector: connection.name, tool: tool.name, title: personalAgentToolTitle(tool),
        score: wordScore(words, tool.name, tool.title) * 2 + named + (input.alsoMatch?.(connection.id, tool.name) ? 2 : 0),
      }))
  }))).flat()
  return {
    offConnectors: connections.map(({ name }) => name).slice(0, 100),
    offTools: scored.filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, input.limit)
      .map(({ connector, tool, title }) => ({ connector, tool, title })),
  }
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
    description: "Ask a person to let this agent use one tool of a connector that is off. Only ask when the current task needs it. Search first: offTools lists the off tools that match, each with its connector. Pass that connector as connectionName and that tool as action, so the person can allow, allow once or block exactly that tool. Omit action only when search shows no matching tool and the task needs the whole connector. This never uses the connector. If a request is pending, finish what you can and say what is waiting. A person can approve in OpenWork for a later run.",
    inputSchema: z.object({
      connectionName: z.string().trim().min(1).max(255).describe("Exact name of a connector that is off."),
      action: z.string().trim().min(1).max(240).optional().describe("Exact name or title of the tool you need. Leave out only to ask for the whole connector."),
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
      const tools = await requestableConnectionTools(connection, { member: input.member, redirectUriBase, waitMs: 3000 })
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
