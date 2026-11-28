import { and, eq, gt, inArray, isNull, ne, sql } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, MemberTable, PersonalAgentChatTurnTable, PersonalAgentConversationTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { cachedOrganizationFeatureEnabled, organizationFeatureEnabled } from "../features.js"
import { personalAgentExecution, type PersonalAgentExecution } from "../mcp/workbot-turn-limits.js"
import { activePersonalAgentMember, personalAgentAccess } from "./access.js"

export function personalAgentPolicyRefusal(message: string) {
  return { error: "policy_blocked", message, retryable: false, sameArgumentsRetryable: false } as const
}

export const PERSONAL_AGENT_UNAPPROVABLE_WRITE = "This tool cannot ask first yet, so an agent cannot use it to make changes."

export async function personalAgentDispatchContext(runId: string, organizationId: string, actingMemberId?: string) {
  if (!isDenTypeId("automationRun", runId) || !await cachedOrganizationFeatureEnabled(organizationId, "personalAgents")) return null
  const member = sql`coalesce(${AutomationRunTable.acting_member_id}, ${AutomationTable.owner_member_id})`
  const [context] = await db.$primary.select({ agentId: PersonalAgentTable.id, agentName: PersonalAgentTable.name, memberId: MemberTable.id, userId: MemberTable.userId, paused: PersonalAgentTable.paused_at })
    .from(AutomationRunTable)
    .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
    .innerJoin(PersonalAgentTable, eq(PersonalAgentTable.id, AutomationTable.agent_id))
    .innerJoin(MemberTable, and(eq(MemberTable.id, member), eq(MemberTable.organizationId, AutomationTable.organization_id), activePersonalAgentMember()))
    .where(and(eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", runId)),
      eq(AutomationTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(PersonalAgentTable.state, "active"), inArray(AutomationRunTable.status, ["claimed", "running"]),
      ne(AutomationTable.state, "archived"), isNull(AutomationRunTable.cancel_requested_at),
      actingMemberId ? eq(MemberTable.id, normalizeDenTypeId("member", actingMemberId)) : undefined)).limit(1)
  if (!context) return null
  const access = await personalAgentAccess({ organizationId, memberId: context.memberId }, context.agentId, true)
  return access?.state === "active" ? { ...context, paused: context.paused || access.pausedAt !== null, legacyConnectorAccess: access.legacyConnectorAccess, neverConnectionIds: access.neverConnectionIds } : null
}

export const PERSONAL_AGENT_CHAT_TIMEOUT_MS = 10 * 60_000

export async function personalAgentChatDispatchContext(turnId: string, organizationId: string, actingMemberId?: string, userId?: string) {
  if (!isDenTypeId("personalAgentChatTurn", turnId)) return null
  const conversation = PersonalAgentConversationTable
  const turn = PersonalAgentChatTurnTable
  const [context] = await db.$primary.select({ agentId: PersonalAgentTable.id, agentName: PersonalAgentTable.name, memberId: MemberTable.id, userId: MemberTable.userId })
    .from(turn).innerJoin(conversation, eq(conversation.id, turn.conversation_id))
    .innerJoin(PersonalAgentTable, and(eq(PersonalAgentTable.id, conversation.agent_id), eq(PersonalAgentTable.organization_id, conversation.organization_id)))
    .innerJoin(MemberTable, and(eq(MemberTable.id, conversation.member_id), eq(MemberTable.organizationId, conversation.organization_id), activePersonalAgentMember()))
    .where(and(eq(turn.id, normalizeDenTypeId("personalAgentChatTurn", turnId)), eq(turn.status, "running"),
      gt(turn.created_at, new Date(Date.now() - PERSONAL_AGENT_CHAT_TIMEOUT_MS)), eq(PersonalAgentTable.state, "active"),
      eq(conversation.organization_id, normalizeDenTypeId("organization", organizationId)),
      actingMemberId ? eq(MemberTable.id, normalizeDenTypeId("member", actingMemberId)) : undefined,
      userId ? eq(MemberTable.userId, normalizeDenTypeId("user", userId)) : undefined)).limit(1)
  if (!context?.userId) return null
  const featureOptions = { userId: context.userId }
  const [agents, access] = await Promise.all([
    organizationFeatureEnabled(organizationId, "personalAgents", featureOptions),
    personalAgentAccess({ organizationId, memberId: context.memberId }, context.agentId, true),
  ])
  if (!agents || access?.state !== "active") return null
  return { ...context, paused: access.pausedAt !== null, defaultConnectorsOff: true, legacyConnectorAccess: access.legacyConnectorAccess, neverConnectionIds: access.neverConnectionIds }
}

export async function personalAgentExecutionContext(execution: PersonalAgentExecution, organizationId: string, actingMemberId?: string, userId?: string) {
  return execution.kind === "chat"
    ? personalAgentChatDispatchContext(execution.id, organizationId, actingMemberId, userId)
    : personalAgentDispatchContext(execution.id, organizationId, actingMemberId)
}

export async function personalAgentRunDispatchRefusal(scopes: ReadonlySet<string>, organizationId: string, userId?: string) {
  const execution = personalAgentExecution(scopes)
  if (!execution) return null
  const context = await personalAgentExecutionContext(execution, organizationId, undefined, userId)
  if (!context) return personalAgentPolicyRefusal("This run is no longer active or no longer has access to this agent.")
  return context.paused ? personalAgentPolicyRefusal("An admin paused this agent.") : null
}

