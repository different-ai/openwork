import { and, count, eq, inArray, isNull, ne, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable, OrganizationTable, PersonalAgentTable, TeamTable, ToolPermissionOrgPolicyTable, ToolPermissionRuleTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { EMPTY_PERSONAL_AGENT_TOOL_POLICY, PERSONAL_AGENT_TOOL_POLICY_MAX_TOOLS, type PersonalAgentToolPolicy } from "@openwork/types/den/personal-agents"
import { TOOL_PERMISSION_EVERY_TOOL, TOOL_PERMISSION_RULES_MAX_PER_ORGANIZATION, type ToolPermissionAccess, type ToolPermissionRule } from "@openwork/types/den/tool-permissions"
import { db } from "../db.js"

export type ToolPermissionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type RuleRow = typeof ToolPermissionRuleTable.$inferSelect
export type ToolPermissionSubject = { organizationId: string; kind: RuleRow["subject_kind"]; id: string }
type RuleTarget = { connectionId: string; toolName: string; rule: ToolPermissionAccess | null }
const table = ToolPermissionRuleTable

function subjectFilter(subject: ToolPermissionSubject) {
  return and(eq(table.organization_id, normalizeDenTypeId("organization", subject.organizationId)),
    eq(table.subject_kind, subject.kind), eq(table.subject_id, subject.id))
}

export async function readSubjectToolPolicies(organizationId: string, kind: ToolPermissionSubject["kind"], ids: string[], reader: ToolPermissionTransaction | typeof db.$primary = db.$primary): Promise<Map<string, PersonalAgentToolPolicy>> {
  const policies = new Map<string, PersonalAgentToolPolicy>()
  if (!ids.length) return policies
  const rows = await reader.select().from(table).where(and(eq(table.organization_id, normalizeDenTypeId("organization", organizationId)),
    eq(table.subject_kind, kind), inArray(table.subject_id, ids)))
  for (const row of rows) {
    let policy = policies.get(row.subject_id)
    if (!policy) policies.set(row.subject_id, policy = { connections: {}, tools: {} })
    if (row.tool_name === TOOL_PERMISSION_EVERY_TOOL) {
      if (row.rule === "block" || (kind === "agent" && row.rule === "allow")) {
        Object.defineProperty(policy.connections, row.connection_id, { value: row.rule, enumerable: true, configurable: true })
      }
    } else {
      if (!Object.hasOwn(policy.tools, row.connection_id)) Object.defineProperty(policy.tools, row.connection_id, { value: {}, enumerable: true })
      Object.defineProperty(policy.tools[row.connection_id], row.tool_name, { value: row.rule, enumerable: true, configurable: true })
    }
  }
  return policies
}

export async function readSubjectToolPolicy(subject: ToolPermissionSubject, reader?: Parameters<typeof readSubjectToolPolicies>[3]): Promise<PersonalAgentToolPolicy> {
  return (await readSubjectToolPolicies(subject.organizationId, subject.kind, [subject.id], reader)).get(subject.id) ?? EMPTY_PERSONAL_AGENT_TOOL_POLICY
}

async function lockSubject(tx: ToolPermissionTransaction, subject: ToolPermissionSubject) {
  const org = normalizeDenTypeId("organization", subject.organizationId)
  if (subject.kind === "agent") {
    const [row] = await tx.select({ id: PersonalAgentTable.id }).from(PersonalAgentTable).where(and(
      eq(PersonalAgentTable.id, normalizeDenTypeId("personalAgent", subject.id)), eq(PersonalAgentTable.organization_id, org),
    )).for("update")
    if (!row) throw new Error("tool_permission_subject_not_found")
    return
  }
  const [organization] = await tx.select({ id: OrganizationTable.id }).from(OrganizationTable).where(eq(OrganizationTable.id, org)).for("update")
  if (!organization) throw new Error("tool_permission_subject_not_found")
  if (subject.kind === "organization" && org === subject.id) return
  if (subject.kind === "member") {
    const [row] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.id, normalizeDenTypeId("member", subject.id)),
      eq(MemberTable.organizationId, org), isNull(MemberTable.removedAt))).for("update")
    if (row) return
  }
  if (subject.kind === "team") {
    const [row] = await tx.select({ id: TeamTable.id }).from(TeamTable).where(and(eq(TeamTable.id, normalizeDenTypeId("team", subject.id)),
      eq(TeamTable.organizationId, org))).for("update")
    if (row) return
  }
  throw new Error("tool_permission_subject_not_found")
}

export async function deleteSubjectToolRules(tx: ToolPermissionTransaction, subject: ToolPermissionSubject): Promise<void> {
  await tx.delete(table).where(subjectFilter(subject))
}

async function insertRules(tx: ToolPermissionTransaction, subject: ToolPermissionSubject, updatedByMemberId: string, targets: Array<RuleTarget & { rule: ToolPermissionAccess }>) {
  const organization = normalizeDenTypeId("organization", subject.organizationId)
  if (subject.kind !== "agent") {
    const [current] = await tx.select({ total: count() }).from(table).where(and(eq(table.organization_id, organization), ne(table.subject_kind, "agent")))
    if (current.total + targets.length > TOOL_PERMISSION_RULES_MAX_PER_ORGANIZATION) throw new Error("tool_permission_rules_limit")
  }
  for (let index = 0; index < targets.length; index += 200) {
    await tx.insert(table).values(targets.slice(index, index + 200).map((target) => ({
      id: createDenTypeId("toolPermissionRule"), organization_id: organization, subject_kind: subject.kind, subject_id: subject.id,
      connection_id: target.connectionId, tool_name: target.toolName, rule: target.rule, updated_by_member_id: normalizeDenTypeId("member", updatedByMemberId),
    })))
  }
}

export async function replaceSubjectToolPolicy(subject: ToolPermissionSubject, policy: PersonalAgentToolPolicy, updatedByMemberId: string, tx?: ToolPermissionTransaction): Promise<void> {
  const tools = Object.entries(policy.tools).flatMap(([connectionId, entries]) => Object.entries(entries)
    .filter(([name]) => name !== TOOL_PERMISSION_EVERY_TOOL).map(([toolName, rule]) => ({ connectionId, toolName, rule })))
  const connections = Object.entries(policy.connections).filter(([, rule]) => rule === "block" || (subject.kind === "agent" && rule === "allow"))
    .map(([connectionId, rule]) => ({ connectionId, toolName: TOOL_PERMISSION_EVERY_TOOL, rule }))
  const write = async (transaction: ToolPermissionTransaction) => {
    await lockSubject(transaction, subject)
    await deleteSubjectToolRules(transaction, subject)
    if (tools.length || connections.length) await insertRules(transaction, subject, updatedByMemberId, [...tools, ...connections])
  }
  await (tx ? write(tx) : db.transaction(write))
}

export async function setSubjectToolRule(subject: ToolPermissionSubject, target: RuleTarget, updatedByMemberId: string, tx?: ToolPermissionTransaction): Promise<void> {
  if (target.toolName === TOOL_PERMISSION_EVERY_TOOL && target.rule !== null && target.rule !== "block"
    && !(subject.kind === "agent" && target.rule === "allow")) throw new Error("tool_permission_invalid_wildcard")
  const write = async (transaction: ToolPermissionTransaction) => {
    await lockSubject(transaction, subject)
    await transaction.delete(table).where(and(subjectFilter(subject), eq(table.connection_id, target.connectionId), sql`binary ${table.tool_name} = ${target.toolName}`))
    if (target.rule !== null && subject.kind === "agent" && target.toolName !== TOOL_PERMISSION_EVERY_TOOL) {
      const existing = await transaction.select({ id: table.id }).from(table).where(and(
        subjectFilter(subject), eq(table.connection_id, target.connectionId), ne(table.tool_name, TOOL_PERMISSION_EVERY_TOOL),
      )).limit(PERSONAL_AGENT_TOOL_POLICY_MAX_TOOLS).for("share")
      if (existing.length >= PERSONAL_AGENT_TOOL_POLICY_MAX_TOOLS) throw new Error("agent_tool_approval_limit")
    }
    if (target.rule !== null) await insertRules(transaction, subject, updatedByMemberId, [{ ...target, rule: target.rule }])
  }
  await (tx ? write(tx) : db.transaction(write))
}

export async function listOrganizationToolRules(organizationId: string, connectionId?: string): Promise<ToolPermissionRule[]> {
  const org = normalizeDenTypeId("organization", organizationId)
  const rows = await db.$primary.select({ row: table, organization: OrganizationTable.name, team: TeamTable.name, member: AuthUserTable.name }).from(table)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, table.organization_id))
    .leftJoin(TeamTable, and(eq(table.subject_kind, "team"), eq(TeamTable.id, table.subject_id), eq(TeamTable.organizationId, org)))
    .leftJoin(MemberTable, and(eq(table.subject_kind, "member"), eq(MemberTable.id, table.subject_id), eq(MemberTable.organizationId, org), isNull(MemberTable.removedAt)))
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(table.organization_id, org), ne(table.subject_kind, "agent"), connectionId === undefined ? undefined : eq(table.connection_id, connectionId)))
    .orderBy(table.connection_id, table.tool_name, table.id)
  return rows.flatMap(({ row, organization, team, member }) => {
    const kind = row.subject_kind
    if (kind === "agent") return []
    const name = kind === "organization" ? organization : kind === "team" ? team ?? "Team" : member ?? "Member"
    return [{ id: row.id, subject: { kind, id: kind === "organization" ? null : row.subject_id, name: name.slice(0, 160) },
      connectionId: row.connection_id, toolName: row.tool_name, rule: row.rule, updatedAt: row.updated_at.toISOString() }]
  })
}

const writtenRules = new Map<string, { rules: string; expiresAt: number }>()

export async function readOrganizationWrittenToolRules(organizationId: string, options?: { fresh?: boolean }): Promise<string> {
  const id = normalizeDenTypeId("organization", organizationId)
  const now = Date.now()
  const cached = writtenRules.get(id)
  if (!options?.fresh && cached && cached.expiresAt > now) return cached.rules
  const [row] = await db.$primary.select({ rules: ToolPermissionOrgPolicyTable.rules }).from(ToolPermissionOrgPolicyTable)
    .where(eq(ToolPermissionOrgPolicyTable.organization_id, id)).limit(1)
  const rules = row?.rules ?? ""
  if (writtenRules.size >= 512) writtenRules.clear()
  writtenRules.set(id, { rules, expiresAt: now + 5000 })
  return rules
}

export async function writeOrganizationWrittenToolRules(organizationId: string, rules: string, memberId: string, tx?: ToolPermissionTransaction): Promise<void> {
  const id = normalizeDenTypeId("organization", organizationId)
  const fields = { rules: rules.trim(), updated_by_member_id: normalizeDenTypeId("member", memberId) }
  await (tx ?? db).insert(ToolPermissionOrgPolicyTable).values({ organization_id: id, ...fields })
    .onDuplicateKeyUpdate({ set: { ...fields, updated_at: new Date() } })
  invalidateOrganizationWrittenToolRules(id)
}

export function invalidateOrganizationWrittenToolRules(organizationId: string): void {
  writtenRules.delete(normalizeDenTypeId("organization", organizationId))
}
