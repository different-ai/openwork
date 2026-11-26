import { and, eq, inArray, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, MemberTable, PersonalAgentRequestTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { AGENT_TOOL_WITHHELD_MESSAGE, connectionsWithheld, personalAgentRunId, personalAgentToolChoiceScope, toolsWithheld, WORKBOT_CONNECTION_WITHHELD_MESSAGE } from "../mcp/workbot-turn-limits.js"
import { activePersonalAgentMember, personalAgentAccess, personalAgentPeople, personOrUnknown } from "./access.js"
import { personalAgentRequestEventDetail, recordPersonalAgentEvent } from "./events.js"
import { evaluatePersonalAgentTool, organizationToolRule, personalAgentOrganizationRules } from "./org-rules.js"
import { personalAgentToolIsReadOnly, personalAgentToolTitle } from "./permissions-policy.js"

export function personalAgentPolicyRefusal(message: string) {
  return { error: "policy_blocked", message, retryable: false, sameArgumentsRetryable: false } as const
}

export const PERSONAL_AGENT_UNAPPROVABLE_WRITE = "This tool cannot ask first yet, so an agent cannot use it to make changes."

export async function personalAgentDispatchContext(runId: string, organizationId: string, actingMemberId?: string) {
  if (!isDenTypeId("automationRun", runId)) return null
  const member = sql`coalesce(${AutomationRunTable.acting_member_id}, ${AutomationTable.owner_member_id})`
  const [context] = await db.$primary.select({ agentId: PersonalAgentTable.id, memberId: MemberTable.id, paused: PersonalAgentTable.paused_at })
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

export async function personalAgentToolRefusal(input: {
  scopes: ReadonlySet<string>
  connection: { id: string; name: string; organizationId: string }
  tool: { name: string; title?: string; annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean } }
  actingMemberId: string
}) {
  const runId = personalAgentRunId(input.scopes)
  if (runId === undefined) return null
  const { connection, tool, scopes } = input
  const orgMembershipId = normalizeDenTypeId("member", input.actingMemberId)
  const organizationId = normalizeDenTypeId("organization", connection.organizationId)
  const context = await personalAgentDispatchContext(runId, organizationId, orgMembershipId)
  if (!context) return { error: "forbidden", message: "This run is no longer active or no longer has access to this agent." } as const
  if (context.paused) return personalAgentPolicyRefusal("An admin paused this agent.")
  const organization = await personalAgentOrganizationRules(organizationId, { fresh: true })
  const organizationRule = organizationToolRule(organization, connection.id, tool.name)
  const connectionBlocked = connectionsWithheld(scopes)?.has(connection.id)
  const toolBlocked = toolsWithheld(scopes)?.get(connection.id)?.has(tool.name)
  const choice = (value: "allow" | "ask" | "allow_once") => scopes.has(personalAgentToolChoiceScope(value, connection.id, tool.name))
  const access = evaluatePersonalAgentTool({
    agent: connectionBlocked || toolBlocked ? "block" : choice("ask") ? "ask" : choice("allow") ? "allow" : null,
    organization: organizationRule,
    readOnly: personalAgentToolIsReadOnly(tool.annotations),
    allowedOnce: choice("allow_once"),
  })
  if (access === "block") {
    if (organizationRule !== "block" && connectionBlocked) {
      return { error: "forbidden", message: `"${connection.name}" ${WORKBOT_CONNECTION_WITHHELD_MESSAGE}` } as const
    }
    return personalAgentPolicyRefusal(`${tool.name} ${AGENT_TOOL_WITHHELD_MESSAGE}`)
  }
  if (access === "allow") return null

  const run = normalizeDenTypeId("automationRun", runId)
  const agentId = context.agentId
  const title = personalAgentToolTitle(tool)
  const created = await db.transaction(async (tx) => {
    await tx.select({ id: PersonalAgentTable.id }).from(PersonalAgentTable).where(eq(PersonalAgentTable.id, agentId)).for("update")
    const [existing] = await tx.select({ id: PersonalAgentRequestTable.id }).from(PersonalAgentRequestTable).where(and(
      eq(PersonalAgentRequestTable.agent_id, agentId), eq(PersonalAgentRequestTable.kind, "tool"), eq(PersonalAgentRequestTable.status, "pending"),
      eq(PersonalAgentRequestTable.requested_by_member_id, orgMembershipId), eq(PersonalAgentRequestTable.connection_id, connection.id),
      sql`binary ${PersonalAgentRequestTable.tool_name} = ${tool.name}`,
    )).limit(1)
    if (existing) return false
    await tx.insert(PersonalAgentRequestTable).values({
      id: createDenTypeId("personalAgentRequest"), organization_id: organizationId, agent_id: agentId, kind: "tool",
      run_id: run, requested_by_member_id: orgMembershipId, connection_id: connection.id, connection_name: connection.name.slice(0, 160),
      tool_name: tool.name, tool_title: title,
    })
    return true
  })
  if (created) {
    const people = await personalAgentPeople(organizationId, [orgMembershipId])
    await recordPersonalAgentEvent({ organizationId, agentId, actorMemberId: orgMembershipId, action: "request.asked",
      detail: personalAgentRequestEventDetail({ requester: personOrUnknown(people, orgMembershipId).name, kind: "tool", tool: title, connection: connection.name.slice(0, 160) }),
    })
  }
  return {
    error: "needs_approval",
    message: `${title} needs a yes from a person first. I asked in this agent's chat. Do not try it again in this run: finish what you can and say what is waiting.`,
    retryable: false, sameArgumentsRetryable: false,
  } as const
}
