import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { and, desc, eq, inArray } from "./drizzle"
import { monotonicPermissionRowTime } from "./permission-states"
import type { PermissionDatabase } from "./permissions"
import {
  PermissionSetRuleTable,
  PermissionSetTable,
  permissionRuleActionValues,
  type PermissionChangeSource,
  type PermissionRuleAction,
  type PermissionRuleEntry,
} from "./schema"

type OrganizationId = typeof PermissionSetTable.$inferSelect.organizationId
type PermissionSetId = typeof PermissionSetTable.$inferSelect.id
type OrgMembershipId = NonNullable<typeof PermissionSetRuleTable.$inferSelect.changedByOrgMembershipId>

/** One OpenCode permission rule in a set: an action, a pattern, and whether it is allowed. */
export type PermissionSetRule = { action: PermissionRuleAction } & PermissionRuleEntry

function isRuleEntry(value: unknown): value is PermissionRuleEntry {
  return typeof value === "object" && value !== null && "resource" in value && "effect" in value
    && typeof value.resource === "string" && (value.effect === "allow" || value.effect === "deny")
}

/** JSON columns arrive as strings on engines like MariaDB (JSON = LONGTEXT alias). */
function ruleEntries(value: unknown): PermissionRuleEntry[] {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(parsed) ? parsed.filter(isRuleEntry).map(({ resource, effect }) => ({ resource, effect })) : []
}

/** Each set's current rules: action by action, each action's rules in order. Sets without rules are absent. */
export async function readPermissionSetRules(database: PermissionDatabase, setIds: readonly PermissionSetId[]): Promise<Map<PermissionSetId, PermissionSetRule[]>> {
  if (setIds.length === 0) return new Map()
  const rows = await database
    .select({ permissionSetId: PermissionSetRuleTable.permissionSetId, action: PermissionSetRuleTable.action, rules: PermissionSetRuleTable.rules })
    .from(PermissionSetRuleTable)
    .where(inArray(PermissionSetRuleTable.permissionSetId, [...setIds]))
    .orderBy(desc(PermissionSetRuleTable.createdAt), desc(PermissionSetRuleTable.id))
  const latest = new Map<PermissionSetId, Map<PermissionRuleAction, PermissionRuleEntry[]>>()
  for (const row of rows) {
    const actions = latest.get(row.permissionSetId) ?? new Map<PermissionRuleAction, PermissionRuleEntry[]>()
    if (!actions.has(row.action)) actions.set(row.action, ruleEntries(row.rules))
    latest.set(row.permissionSetId, actions)
  }
  const result = new Map<PermissionSetId, PermissionSetRule[]>()
  for (const [setId, actions] of latest) {
    const rules = permissionRuleActionValues.flatMap((action) => (actions.get(action) ?? []).map((entry) => ({ action, ...entry })))
    if (rules.length > 0) result.set(setId, rules)
  }
  return result
}

/**
 * Records one action's whole rule list for a set. Call inside the transaction
 * that holds lockPermissionSet, so the new row becomes the current one.
 */
export async function appendPermissionSetRules(tx: PermissionDatabase, input: {
  organizationId: OrganizationId
  permissionSetId: PermissionSetId
  action: PermissionRuleAction
  rules: readonly PermissionRuleEntry[]
  source: PermissionChangeSource
  changedByOrgMembershipId?: OrgMembershipId | null
}): Promise<void> {
  const latest = await tx
    .select({ createdAt: PermissionSetRuleTable.createdAt })
    .from(PermissionSetRuleTable)
    .where(and(eq(PermissionSetRuleTable.permissionSetId, input.permissionSetId), eq(PermissionSetRuleTable.action, input.action)))
    .orderBy(desc(PermissionSetRuleTable.createdAt), desc(PermissionSetRuleTable.id))
    .limit(1)
  await tx.insert(PermissionSetRuleTable).values({
    id: createDenTypeId("permissionSetRule"),
    organizationId: input.organizationId,
    permissionSetId: input.permissionSetId,
    action: input.action,
    rules: input.rules.map(({ resource, effect }) => ({ resource, effect })),
    source: input.source,
    changedByOrgMembershipId: input.changedByOrgMembershipId ?? null,
    createdAt: monotonicPermissionRowTime(new Date(), latest[0]?.createdAt),
  })
}
