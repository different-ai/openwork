import type { ToolPermissionTransaction } from "./rules.js"
import type { ToolPermissionAccess } from "@openwork/types/den/tool-permissions"

type ToolPermissionCaller = { kind: "ordinary" } | { kind: "agent"; readOnly: boolean }

export function evaluateToolPermission(rules: readonly (ToolPermissionAccess | null)[], caller: ToolPermissionCaller): ToolPermissionAccess {
  if (rules.includes("block")) return "block"
  if (rules.includes("ask")) return "ask"
  if (rules.includes("allow")) return "allow"
  return caller.kind === "agent" && !caller.readOnly ? "ask" : "allow"
}

export function matchesToolPermissionName(ruleName: string, toolName: string): boolean {
  return ruleName === "*" || ruleName === toolName
}

export type ToolPermissionRuleScope = { mode: "ordinary"; agentId?: never } | { mode: "agent"; agentId: string }

export async function loadApplicableToolPermissionRules(input: ToolPermissionRuleScope & {
  organizationId: string; memberId?: string; teamIds?: readonly string[]; connectionId: string; toolName: string
}, tx?: ToolPermissionTransaction) {
  const [{ db }, { and, eq, inArray, or }, { ToolPermissionRuleTable: table }, { normalizeDenTypeId }] = await Promise.all([
    import("../db.js"), import("@openwork-ee/den-db/drizzle"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/utils/typeid"),
  ])
  const org = normalizeDenTypeId("organization", input.organizationId)
  const query = (tx ?? db.$primary).select({ kind: table.subject_kind, toolName: table.tool_name, rule: table.rule }).from(table).where(and(
    eq(table.organization_id, org), eq(table.connection_id, input.connectionId), inArray(table.tool_name, ["*", input.toolName]),
    or(and(eq(table.subject_kind, "organization"), eq(table.subject_id, org)),
      input.memberId ? and(eq(table.subject_kind, "member"), eq(table.subject_id, input.memberId)) : undefined,
      input.teamIds?.length ? and(eq(table.subject_kind, "team"), inArray(table.subject_id, input.teamIds)) : undefined,
      input.mode === "agent" ? and(eq(table.subject_kind, "agent"), eq(table.subject_id, input.agentId)) : undefined),
  ))
  const rows = await (tx ? query.for("share") : query)
  return rows.filter((row) => matchesToolPermissionName(row.toolName, input.toolName))
}
