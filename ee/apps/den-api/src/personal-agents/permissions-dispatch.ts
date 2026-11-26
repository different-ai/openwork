import { and, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, MemberTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { personalAgentRunId } from "../mcp/workbot-turn-limits.js"
import { activePersonalAgentMember, personalAgentAccess } from "./access.js"

export function personalAgentPolicyRefusal(message: string) {
  return { error: "policy_blocked", message, retryable: false, sameArgumentsRetryable: false } as const
}

export const PERSONAL_AGENT_UNAPPROVABLE_WRITE = "This tool cannot ask first yet, so an agent cannot use it to make changes."

export async function personalAgentDispatchContext(runId: string, organizationId: string, actingMemberId?: string) {
  if (!isDenTypeId("automationRun", runId)) return null
  const member = sql`coalesce(${AutomationRunTable.acting_member_id}, ${AutomationTable.owner_member_id})`
  const [context] = await db.$primary.select({ agentId: PersonalAgentTable.id, agentName: PersonalAgentTable.name, memberId: MemberTable.id, paused: PersonalAgentTable.paused_at })
    .from(AutomationRunTable)
    .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
    .innerJoin(PersonalAgentTable, eq(PersonalAgentTable.id, AutomationTable.agent_id))
    .innerJoin(MemberTable, and(eq(MemberTable.id, member), eq(MemberTable.organizationId, AutomationTable.organization_id), activePersonalAgentMember()))
    .where(and(eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", runId)),
      eq(AutomationTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(PersonalAgentTable.state, "active"), inArray(AutomationRunTable.status, ["claimed", "running"]),
      isNull(AutomationRunTable.cancel_requested_at),
      actingMemberId ? eq(MemberTable.id, normalizeDenTypeId("member", actingMemberId)) : undefined)).limit(1)
  if (!context) return null
  const access = await personalAgentAccess({ organizationId, memberId: context.memberId }, context.agentId, true)
  return access?.state === "active" ? { ...context, paused: context.paused || access.pausedAt !== null } : null
}

export async function personalAgentRunDispatchRefusal(scopes: ReadonlySet<string>, organizationId: string) {
  const runId = personalAgentRunId(scopes)
  if (runId === undefined) return null
  const context = await personalAgentDispatchContext(runId, organizationId)
  if (!context) return personalAgentPolicyRefusal("This run is no longer active or no longer has access to this agent.")
  return context.paused ? personalAgentPolicyRefusal("An admin paused this agent.") : null
}
