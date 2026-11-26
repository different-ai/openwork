import type { ToolPermissionAccess } from "@openwork/types/den/tool-permissions"

export function evaluateToolPermission(rules: readonly (ToolPermissionAccess | null)[], readOnly: boolean): ToolPermissionAccess {
  if (rules.includes("block")) return "block"
  if (rules.includes("ask")) return "ask"
  if (rules.includes("allow")) return "allow"
  return readOnly ? "allow" : "ask"
}

export function matchesToolPermissionName(ruleName: string, toolName: string): boolean {
  return ruleName === "*" || ruleName === toolName
}

export async function loadApplicableToolPermissionRules(input: {
  organizationId: string; memberId?: string; teamIds?: readonly string[]; agentId?: string; connectionId: string; toolName: string
}) {
  const [{ db }, { and, eq, inArray, or }, { ToolPermissionRuleTable: table }, { normalizeDenTypeId }] = await Promise.all([
    import("../db.js"), import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/utils/typeid"),
  ])
  const org = normalizeDenTypeId("organization", input.organizationId)
  const rows = await db.$primary.select({ kind: table.subject_kind, toolName: table.tool_name, rule: table.rule }).from(table).where(and(
    eq(table.organization_id, org), eq(table.connection_id, input.connectionId), inArray(table.tool_name, ["*", input.toolName]),
    or(and(eq(table.subject_kind, "organization"), eq(table.subject_id, org)),
      input.memberId ? and(eq(table.subject_kind, "member"), eq(table.subject_id, input.memberId)) : undefined,
      input.teamIds?.length ? and(eq(table.subject_kind, "team"), inArray(table.subject_id, input.teamIds)) : undefined,
      input.agentId ? and(eq(table.subject_kind, "agent"), eq(table.subject_id, input.agentId)) : undefined),
  ))
  return rows.filter((row) => matchesToolPermissionName(row.toolName, input.toolName))
}
