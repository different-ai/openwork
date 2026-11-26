import { eq } from "@openwork-ee/den-db/drizzle"
import { PersonalAgentOrgPolicyTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { type PersonalAgentOrgPolicy, type PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import { readOrganizationWrittenToolRules, readSubjectToolPolicy } from "../tool-permissions/rules.js"
import { db } from "../db.js"

export type PersonalAgentOrganizationRules = PersonalAgentOrgPolicy

type ToolRule = "block" | "ask" | "allow"
export async function personalAgentOrganizationRules(organizationId: string, options?: { fresh?: boolean }): Promise<PersonalAgentOrganizationRules> {
  const id = normalizeDenTypeId("organization", organizationId)
  const [[row], toolPolicy, rules] = await Promise.all([
    db.$primary.select().from(PersonalAgentOrgPolicyTable).where(eq(PersonalAgentOrgPolicyTable.organization_id, id)).limit(1),
    readSubjectToolPolicy({ organizationId: id, kind: "organization", id }),
    readOrganizationWrittenToolRules(id, options),
  ])
  return { toolPolicy, rules, sharedLogins: row?.shared_logins ?? false, shareMode: row?.share_mode ?? "everyone",
    monthlyBudgetMicros: row?.monthly_budget_micros ?? null }
}

export function personalAgentToolRule(policy: PersonalAgentToolPolicy, connectionId: string, toolName: string): ToolRule | null {
  if (policy.connections[connectionId] === "block") return "block"
  const tools = policy.tools[connectionId]
  return tools && Object.hasOwn(tools, toolName) ? tools[toolName] : null
}

export function organizationToolRule(rules: PersonalAgentOrganizationRules, connectionId: string, toolName: string): ToolRule | null {
  return personalAgentToolRule(rules.toolPolicy, connectionId, toolName)
}
