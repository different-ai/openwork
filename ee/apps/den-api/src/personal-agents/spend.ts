import { and, eq, gte, inArray, lt } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentSpend } from "@openwork/types/den/personal-agents"
import { db } from "../db.js"
import { personalAgentOrgPolicy } from "./permissions-policy.js"

export type PersonalAgentBudgets = { agentId: string; ownerBudgetMicros: number | null; adminBudgetMicros: number | null }

export async function personalAgentSpend(organizationId: string, agents: readonly PersonalAgentBudgets[]): Promise<Map<string, PersonalAgentSpend>> {
  if (!agents.length) return new Map()
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  const [policy, runs] = await Promise.all([
    personalAgentOrgPolicy(organizationId),
    db.$primary.select({ agentId: AutomationTable.agent_id, usage: AutomationRunTable.usage })
      .from(AutomationTable).innerJoin(AutomationRunTable, eq(AutomationRunTable.automation_id, AutomationTable.id))
      .where(and(eq(AutomationTable.organization_id, normalizeDenTypeId("organization", organizationId)),
        inArray(AutomationTable.agent_id, agents.map(({ agentId }) => normalizeDenTypeId("personalAgent", agentId))),
        gte(AutomationRunTable.created_at, start), lt(AutomationRunTable.created_at, end))),
  ])
  const totals = new Map<string, { monthMicros: number; unpricedTokens: number }>()
  for (const run of runs) {
    if (!run.agentId) continue
    const total = totals.get(run.agentId) ?? { monthMicros: 0, unpricedTokens: 0 }
    const input = run.usage.inputTokens ?? 0
    const output = run.usage.outputTokens ?? 0
    if (run.usage.costMicros !== null) {
      total.monthMicros += run.usage.costMicros
    } else {
      total.unpricedTokens += input + output
    }
    totals.set(run.agentId, total)
  }
  return new Map(agents.map(({ agentId, ownerBudgetMicros, adminBudgetMicros }) => {
    const limits = [ownerBudgetMicros, adminBudgetMicros, policy?.monthly_budget_micros ?? null].filter((limit) => limit !== null)
    const budgetMicros = limits.length ? Math.min(...limits) : null
    const { monthMicros, unpricedTokens } = totals.get(agentId) ?? { monthMicros: 0, unpricedTokens: 0 }
    return [agentId, { monthMicros, unpricedTokens, budgetMicros, ownerBudgetMicros, adminBudgetMicros, overBudget: budgetMicros !== null && monthMicros >= budgetMicros }]
  }))
}
