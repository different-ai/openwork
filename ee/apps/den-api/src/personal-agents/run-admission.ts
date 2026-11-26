import { and, eq, isNull, or } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, MemberTable, PersonalAgentRequestTable, PersonalAgentRevisionTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { personalAgentToolPolicyBlocks } from "@openwork/automations"
import { db } from "../db.js"
import { agentToolLimitScopes, headlessRunTokenScopes, personalAgentRunScope, personalAgentToolChoiceScope } from "../mcp/workbot-turn-limits.js"
import { personalAgentAccess } from "./access.js"
import { evaluatePersonalAgentTool, organizationToolRule, personalAgentOrganizationRules, personalAgentToolRule } from "./org-rules.js"
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
  const [spend, organizationPolicy] = await Promise.all([
    personalAgentSpend(organizationId, [{ agentId, ownerBudgetMicros: current.ownerBudget, adminBudgetMicros: current.adminBudget }]),
    personalAgentOrganizationRules(organizationId, { fresh: true }),
  ])
  if (spend.get(agentId)?.overBudget) return { ok: false, code: "execution_failed", message: "This agent reached its budget for the month, so it did not run." }
  const orgTools = organizationPolicy.toolPolicy
  const runId = normalizeDenTypeId("automationRun", input.runId)
  const blocked = (connectionId: string, toolName: string) => evaluatePersonalAgentTool({
    agent: personalAgentToolRule(pinned.toolPolicy, connectionId, toolName),
    organization: organizationToolRule(organizationPolicy, connectionId, toolName),
    readOnly: false,
  }) === "block"
  const choices = new Set([
    personalAgentRunScope(runId),
    ...agentToolLimitScopes(personalAgentToolPolicyBlocks(pinned.toolPolicy)),
    ...agentToolLimitScopes(personalAgentToolPolicyBlocks(orgTools)),
  ])
  for (const [connectionId, tools] of Object.entries(pinned.toolPolicy.tools)) {
    for (const [toolName, choice] of Object.entries(tools)) {
      if (choice !== "block" && personalAgentToolRule(pinned.toolPolicy, connectionId, toolName) !== "block") choices.add(personalAgentToolChoiceScope(choice, connectionId, toolName))
    }
  }
  return db.transaction(async (tx): Promise<PersonalAgentRunAdmission> => {
    const allowances = await tx.select().from(PersonalAgentRequestTable).where(and(
      eq(PersonalAgentRequestTable.agent_id, agentId), eq(PersonalAgentRequestTable.kind, "tool"),
      eq(PersonalAgentRequestTable.requested_by_member_id, memberId),
      or(eq(PersonalAgentRequestTable.status, "allowed_once"), eq(PersonalAgentRequestTable.used_by_run_id, runId)),
    )).for("update")
    for (const allowance of allowances) {
      if (allowance.connection_id && allowance.tool_name && !blocked(allowance.connection_id, allowance.tool_name)) {
        choices.add(personalAgentToolChoiceScope("allow_once", allowance.connection_id, allowance.tool_name))
      }
    }
    const mcpScopes = [...choices]
    if (Buffer.byteLength(JSON.stringify(headlessRunTokenScopes({ scopes: mcpScopes }))) > 65_535) {
      return { ok: false, code: "execution_failed", message: "This agent has too many tool settings for a run. Shorten its tool settings before trying again." }
    }
    for (const allowance of allowances) {
      if (allowance.status !== "allowed_once") continue
      await tx.update(PersonalAgentRequestTable).set({ status: "used", used_by_run_id: runId }).where(eq(PersonalAgentRequestTable.id, allowance.id))
    }
    return { ok: true, agentName: pinned.agentName, brief: pinned.brief, organizationRules: organizationPolicy.rules.trim(), mcpScopes }
  })
}
