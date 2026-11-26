import { eq } from "@openwork-ee/den-db/drizzle"
import { PersonalAgentOrgPolicyTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { EMPTY_PERSONAL_AGENT_TOOL_POLICY, type PersonalAgentOrgPolicy, type PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import { db } from "../db.js"

export type PersonalAgentOrganizationRules = PersonalAgentOrgPolicy

type ToolRule = "block" | "ask" | "allow"
const cache = new Map<string, { expiresAt: number; rules: PersonalAgentOrganizationRules }>()

export async function personalAgentOrganizationRules(organizationId: string, options?: { fresh?: boolean }): Promise<PersonalAgentOrganizationRules> {
  const id = normalizeDenTypeId("organization", organizationId)
  const now = Date.now()
  if (!options?.fresh) {
    const cached = cache.get(id)
    if (cached && cached.expiresAt > now) return cached.rules
  }
  const [row] = await db.$primary.select().from(PersonalAgentOrgPolicyTable)
    .where(eq(PersonalAgentOrgPolicyTable.organization_id, id)).limit(1)
  const rules: PersonalAgentOrganizationRules = {
    toolPolicy: row?.tool_policy ?? EMPTY_PERSONAL_AGENT_TOOL_POLICY,
    rules: row?.rules ?? "",
    sharedLogins: row?.shared_logins ?? false,
    shareMode: row?.share_mode ?? "everyone",
    monthlyBudgetMicros: row?.monthly_budget_micros ?? null,
  }
  if (cache.size >= 512) cache.clear()
  cache.set(id, { rules, expiresAt: now + 5000 })
  return rules
}

export function personalAgentToolRule(policy: PersonalAgentToolPolicy, connectionId: string, toolName: string): ToolRule | null {
  if (policy.connections[connectionId] === "block") return "block"
  const tools = policy.tools[connectionId]
  return tools && Object.hasOwn(tools, toolName) ? tools[toolName] : null
}

export function organizationToolRule(rules: PersonalAgentOrganizationRules, connectionId: string, toolName: string): ToolRule | null {
  return personalAgentToolRule(rules.toolPolicy, connectionId, toolName)
}

export function evaluatePersonalAgentTool(input: {
  agent: ToolRule | null
  organization: ToolRule | null
  readOnly: boolean
  allowedOnce?: boolean
}): ToolRule {
  if (input.agent === "block" || input.organization === "block") return "block"
  if (input.allowedOnce) return "allow"
  if (input.agent === "ask" || input.organization === "ask") return "ask"
  if (input.agent === "allow" || input.organization === "allow") return "allow"
  return input.readOnly ? "allow" : "ask"
}
