import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, MemberTable, PersonalAgentRevisionTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { personalAgentToolPolicyBlocks } from "@openwork/automations"
import { db } from "../db.js"
import { agentToolLimitScopes, headlessRunTokenScopes, personalAgentRunScope } from "../mcp/workbot-turn-limits.js"
import { personalAgentAccess } from "./access.js"
import { organizationFeatureEnabled } from "../features.js"
import { readOrganizationWrittenToolRules, readSubjectToolPolicy } from "../tool-permissions/rules.js"
import { personalAgentRepository } from "./repository.js"
import { personalAgentSpend } from "./spend.js"

export type PersonalAgentRunAdmission =
  | { ok: true; agentName: string; brief: string; organizationRules: string; mcpScopes: string[] }
  | { ok: false; code: "execution_failed" | "execution_runtime_unavailable"; message: string }

export async function admitPersonalAgentRun(input: {
  agentRevisionId: string | undefined
  runId: string
  organizationId: string
  actingMemberId: string
  headless: boolean
}): Promise<PersonalAgentRunAdmission> {
  if (!await organizationFeatureEnabled(input.organizationId, "personalAgents")) {
    return { ok: false, code: "execution_failed", message: "Agents are turned off for this organization, so this routine did not run." }
  }
  const pinned = input.agentRevisionId && await personalAgentRepository.runDefinition(input.agentRevisionId)
  if (!pinned || pinned.archived) {
    return { ok: false, code: "execution_failed", message: "This routine's agent no longer exists, so it did not run." }
  }
  const agentId = normalizeDenTypeId("personalAgent", pinned.agentId)
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const [routine] = await db.$primary.select({ state: AutomationTable.state, trigger: AutomationRunTable.trigger }).from(AutomationRunTable)
    .innerJoin(AutomationTable, eq(AutomationTable.id, AutomationRunTable.automation_id))
    .where(and(eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", input.runId)), eq(AutomationTable.agent_id, agentId),
      eq(AutomationTable.organization_id, organizationId))).limit(1)
  if (!routine || routine.state === "archived") return { ok: false, code: "execution_failed", message: "This routine was archived, so it did not run." }
  const [current] = await db.$primary.select({ paused: PersonalAgentTable.paused_at, adminBudget: PersonalAgentTable.admin_monthly_budget_micros, ownerBudget: PersonalAgentRevisionTable.monthly_budget_micros })
    .from(PersonalAgentTable).innerJoin(PersonalAgentRevisionTable, eq(PersonalAgentRevisionTable.id, PersonalAgentTable.current_revision_id))
    .where(and(eq(PersonalAgentTable.id, agentId), eq(PersonalAgentTable.organization_id, organizationId))).limit(1)
  if (!current) return { ok: false, code: "execution_failed", message: "This routine's agent no longer exists, so it did not run." }
  const memberId = normalizeDenTypeId("member", input.actingMemberId)
  const [member] = await db.$primary.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt),
  )).limit(1)
  const access = member && await personalAgentAccess({ organizationId, memberId }, agentId)
  if (access?.state !== "active" || (routine.trigger !== "manual" && access.role !== "owner")) return { ok: false, code: "execution_failed", message: "The person this run is for no longer has access to this agent, so it did not run." }
  if (current.paused || access.pausedAt !== null) return { ok: false, code: "execution_failed", message: "An admin paused this agent, so it did not run." }
  if (!input.headless) {
    return { ok: false, code: "execution_runtime_unavailable", message: "This agent limits which tools it may use, and only OpenWork Cloud's headless runtime can apply that. The run was not started." }
  }
  const [spend, orgTools, agentTools, rules] = await Promise.all([
    personalAgentSpend(organizationId, [{ agentId, ownerBudgetMicros: current.ownerBudget, adminBudgetMicros: current.adminBudget }]),
    readSubjectToolPolicy({ organizationId, kind: "organization", id: organizationId }),
    readSubjectToolPolicy({ organizationId, kind: "agent", id: agentId }),
    readOrganizationWrittenToolRules(organizationId, { fresh: true }),
  ])
  if (spend.get(agentId)?.overBudget) return { ok: false, code: "execution_failed", message: "This agent reached its budget for the month, so it did not run." }
  const mcpScopes = [...new Set([
    personalAgentRunScope(input.runId),
    ...agentToolLimitScopes(personalAgentToolPolicyBlocks(agentTools)),
    ...agentToolLimitScopes(personalAgentToolPolicyBlocks(orgTools)),
  ])]
  if (Buffer.byteLength(JSON.stringify(headlessRunTokenScopes({ scopes: mcpScopes }))) > 65_535) {
    return { ok: false, code: "execution_failed", message: "This agent has too many tool settings for a run. Shorten its tool settings before trying again." }
  }
  return { ok: true, agentName: pinned.agentName, brief: pinned.brief, organizationRules: rules.trim(), mcpScopes }
}
