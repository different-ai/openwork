import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import { externalMcpConnectionReadyForMember, listUsableExternalMcpConnections } from "../capability-sources/external-mcp-connections.js"
import { organizationFeatureEnabled } from "../features.js"
import { listTeamsForMember } from "../member-teams.js"
import { personalAgentRunId } from "../mcp/workbot-turn-limits.js"
import { approvedAgentConnectorTools } from "../tool-permissions/approvals.js"
import { readSubjectToolPolicies, readSubjectToolPolicy } from "../tool-permissions/rules.js"
import { personalAgentDispatchContext } from "./permissions-dispatch.js"

export function normalizedPersonalAgentConnectorName(name: string) {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase()
}

type ConnectorDefaults = { legacyConnectorAccess: boolean; neverConnectionIds: readonly string[] }

type ConnectorState = "on" | "off" | "blocked"

export function personalAgentConnectorState(agent: ConnectorDefaults, policy: Pick<PersonalAgentToolPolicy, "connections">, connectionId: string): ConnectorState {
  const rule = policy.connections[connectionId]
  if (agent.neverConnectionIds.includes(connectionId) || (agent.legacyConnectorAccess && rule === "block")) return "blocked"
  if (rule === "allow") return "on"
  if (rule === "block") return "off"
  return agent.legacyConnectorAccess ? "on" : "off"
}

export async function personalAgentConnectorAccess(input: { scopes?: ReadonlySet<string>; organizationId: string; memberId: string }) {
  const runId = input.scopes && personalAgentRunId(input.scopes)
  if (runId === undefined) return null
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const context = await personalAgentDispatchContext(runId, organizationId, input.memberId)
  if (!context || context.paused) return { state: (): ConnectorState => "blocked", tools: async () => new Set<string>(), toolBlocked: () => true, canRequest: false }
  const memberId = normalizeDenTypeId("member", context.memberId)
  const [agent, organization, teamAndMember, canRequest] = await Promise.all([
    readSubjectToolPolicy({ organizationId, kind: "agent", id: context.agentId }),
    readSubjectToolPolicy({ organizationId, kind: "organization", id: organizationId }),
    organizationFeatureEnabled(organizationId, "toolPermissions"),
    organizationFeatureEnabled(organizationId, "personalAgentConnectorControls", { userId: context.userId ?? undefined }),
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
    tools: async (connectionId: string) => canRequest && state(connectionId) === "off"
      ? approvedAgentConnectorTools({ organizationId, memberId, connectionId, context: { kind: "agent", id: context.agentId, label: context.agentName, runId } })
      : new Set<string>(),
  }
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
