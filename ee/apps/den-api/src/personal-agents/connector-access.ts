import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import { externalMcpConnectionReadyForMember, listUsableExternalMcpConnections } from "../capability-sources/external-mcp-connections.js"
import { organizationFeatureEnabled } from "../features.js"
import { listTeamsForMember } from "../member-teams.js"
import { personalAgentExecution } from "../mcp/workbot-turn-limits.js"
import { agentApprovalContext, approvedAgentConnectorTools } from "../tool-permissions/approvals.js"
import { readSubjectToolPolicies, readSubjectToolPolicy } from "../tool-permissions/rules.js"
import { personalAgentExecutionContext } from "./permissions-dispatch.js"

export function normalizedPersonalAgentConnectorName(name: string) {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
}

export const OPENWORK_CONNECTION_ID = "openwork"
export const OPENWORK_CONNECTION_NAME = "OpenWork"
export const COMPUTER_CONNECTION_ID = "computer"
export const COMPUTER_CONNECTION_NAME = "Computer"
export const COMPUTER_CONNECTION_TOOLS = [
  { name: "bash", title: "Run commands on its own computer", annotations: { readOnlyHint: true } },
  { name: "look", title: "Look at files on its own computer", annotations: { readOnlyHint: true } },
] as const

export function personalAgentComputerOffered(organizationId: string): Promise<boolean> {
  return organizationFeatureEnabled(normalizeDenTypeId("organization", organizationId), "remoteComputers")
}

export async function personalAgentComputerOn(input: { scopes: ReadonlySet<string>; organizationId: string; memberId: string }): Promise<boolean> {
  if (!await personalAgentComputerOffered(input.organizationId)) return false
  const access = await personalAgentConnectorAccess(input)
  const reachable = access && await personalAgentConnectionToolFilter(access, COMPUTER_CONNECTION_ID)
  return Boolean(reachable && COMPUTER_CONNECTION_TOOLS.every(({ name }) => reachable(name)))
}

type ConnectorDefaults = { defaultConnectorsOff?: boolean; legacyConnectorAccess: boolean; neverConnectionIds: readonly string[] }

type ConnectorState = "on" | "off" | "blocked"

export function personalAgentConnectorState(agent: ConnectorDefaults, policy: Pick<PersonalAgentToolPolicy, "connections">, connectionId: string): ConnectorState {
  const rule = policy.connections[connectionId]
  if (agent.neverConnectionIds.includes(connectionId) || (agent.legacyConnectorAccess && rule === "block")) return "blocked"
  if (rule === "allow") return "on"
  if (rule === "block" || rule === "ask") return "off"
  return agent.legacyConnectorAccess && !agent.defaultConnectorsOff ? "on" : "off"
}

export function personalAgentChosenTools(policy: PersonalAgentToolPolicy, connectionId: string): Set<string> {
  if (policy.connections[connectionId] !== "ask" || !Object.hasOwn(policy.tools, connectionId)) return new Set()
  return new Set(Object.entries(policy.tools[connectionId]).filter(([, access]) => access !== "block").map(([name]) => name))
}

export async function personalAgentConnectorAccess(input: { scopes?: ReadonlySet<string>; organizationId: string; memberId: string }) {
  const execution = input.scopes && personalAgentExecution(input.scopes)
  if (!execution) return null
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const context = await personalAgentExecutionContext(execution, organizationId, input.memberId)
  if (!context || context.paused) return { state: (): ConnectorState => "blocked", tools: async () => new Set<string>(), toolBlocked: () => true, canRequest: false }
  const memberId = normalizeDenTypeId("member", context.memberId)
  const [agent, organization, teamAndMember, canRequest] = await Promise.all([
    readSubjectToolPolicy({ organizationId, kind: "agent", id: context.agentId }),
    readSubjectToolPolicy({ organizationId, kind: "organization", id: organizationId }),
    organizationFeatureEnabled(organizationId, "toolPermissions"),
    organizationFeatureEnabled(organizationId, "personalAgents", { userId: context.userId ?? undefined }),
  ])
  const teamIds = teamAndMember ? (await listTeamsForMember({ organizationId, memberId })).map(({ id }) => id) : []
  const [teams, member] = await Promise.all([
    readSubjectToolPolicies(organizationId, "team", teamIds),
    teamAndMember ? readSubjectToolPolicy({ organizationId, kind: "member", id: memberId }) : undefined,
  ])
  const tenant = [organization, ...teams.values(), ...(member ? [member] : [])]
  const state = (connectionId: string): ConnectorState => tenant.some((entry) => entry.connections[connectionId] === "block")
    ? "blocked" : personalAgentConnectorState(context, agent, connectionId)
  return {
    state, canRequest,
    toolBlocked: (connectionId: string, toolName: string) => Object.hasOwn(agent.tools[connectionId] ?? {}, toolName) && agent.tools[connectionId][toolName] === "block"
      || tenant.some((entry) => Object.hasOwn(entry.tools[connectionId] ?? {}, toolName) && entry.tools[connectionId][toolName] === "block"),
    tools: async (connectionId: string) => {
      if (state(connectionId) !== "off") return new Set<string>()
      const chosen = personalAgentChosenTools(agent, connectionId)
      if (!canRequest) return chosen
      const approved = await approvedAgentConnectorTools({ organizationId, memberId, connectionId, context: agentApprovalContext(context, execution) })
      return new Set([...chosen, ...approved])
    },
  }
}

export type PersonalAgentConnectorAccess = NonNullable<Awaited<ReturnType<typeof personalAgentConnectorAccess>>>

export async function personalAgentConnectionToolFilter(access: PersonalAgentConnectorAccess, connectionId: string): Promise<((toolName: string) => boolean) | null> {
  const state = access.state(connectionId)
  if (state === "blocked") return null
  const approved = state === "off" ? await access.tools(connectionId) : null
  if (approved && approved.size === 0) return null
  return (toolName) => !access.toolBlocked(connectionId, toolName) && (!approved || approved.has(toolName))
}

export async function listRequestablePersonalAgentConnections(input: { scopes: ReadonlySet<string>; organizationId: string; memberId: string }) {
  const access = await personalAgentConnectorAccess(input)
  if (!access?.canRequest) return []
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const orgMembershipId = normalizeDenTypeId("member", input.memberId)
  const teams = await listTeamsForMember({ organizationId, memberId: orgMembershipId })
  const usable = await listUsableExternalMcpConnections({ organizationId, orgMembershipId, teamIds: teams.map(({ id }) => id) })
  const counts = new Map<string, number>()
  for (const { name } of usable) {
    const normalized = normalizedPersonalAgentConnectorName(name)
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
  }
  const result = []
  for (const connection of usable) {
    if (counts.get(normalizedPersonalAgentConnectorName(connection.name)) !== 1) continue
    if (!connection.toolPolicy?.allDisabled && access.state(connection.id) === "off" && await externalMcpConnectionReadyForMember(connection, orgMembershipId)) result.push(connection)
  }
  return result
}
