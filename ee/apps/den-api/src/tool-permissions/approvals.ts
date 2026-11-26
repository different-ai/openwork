import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable, PersonalAgentTable, TeamMemberTable, TeamTable, ToolApprovalTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ToolApproval, ToolApprovalDecision } from "@openwork/types/den/tool-permissions"
import { db } from "../db.js"
import { cachedOrganizationFeatureEnabled, organizationFeatureEnabled } from "../features.js"
import { loadApplicableToolPermissionRules } from "./evaluate.js"
import { setSubjectToolRule, type ToolPermissionTransaction } from "./rules.js"

export type ToolApprovalRow = typeof ToolApprovalTable.$inferSelect
export type ToolApprovalContext =
  | { kind: "agent" | "automation"; id: string; label: string; runId: string }
  | { kind: "chat"; id: null; label: null; runId: null }
export type ToolApprovalKey = { organizationId: string; memberId: string; context: ToolApprovalContext; connectionId: string; toolName: string }
const table = ToolApprovalTable
const DAY = 86_400_000

export function pendingToolApprovalCutoff() {
  return new Date(Date.now() - 30 * DAY)
}

function match(input: ToolApprovalKey) {
  return and(eq(table.organization_id, normalizeDenTypeId("organization", input.organizationId)),
    eq(table.requested_by_member_id, normalizeDenTypeId("member", input.memberId)), eq(table.context_kind, input.context.kind),
    input.context.id === null ? isNull(table.context_id) : eq(table.context_id, input.context.id),
    eq(table.connection_id, input.connectionId), sql`binary ${table.tool_name} = ${input.toolName}`)
}

async function lockMember(tx: ToolPermissionTransaction, input: ToolApprovalKey) {
  const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizeDenTypeId("member", input.memberId)),
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", input.organizationId)), isNull(MemberTable.removedAt),
  )).for("update")
  return Boolean(member)
}

type PendingToolApproval = ToolApprovalKey & { connectionName: string; toolTitle: string }

async function createPending(tx: ToolPermissionTransaction, input: PendingToolApproval): Promise<boolean> {
  const [existing] = await tx.select({ id: table.id }).from(table).where(and(match(input), eq(table.status, "pending"), gte(table.created_at, pendingToolApprovalCutoff()))).limit(1).for("update")
  if (existing) return false
  await tx.insert(table).values({
    id: createDenTypeId("toolApproval"), organization_id: normalizeDenTypeId("organization", input.organizationId),
    requested_by_member_id: normalizeDenTypeId("member", input.memberId), context_kind: input.context.kind, context_id: input.context.id,
    context_label: input.context.label?.slice(0, 160) ?? null,
    run_id: input.context.runId === null ? null : normalizeDenTypeId("automationRun", input.context.runId),
    connection_id: input.connectionId, connection_name: input.connectionName.slice(0, 160), tool_name: input.toolName, tool_title: input.toolTitle.slice(0, 240),
  })
  return true
}

export async function createOrReuseToolApproval(input: PendingToolApproval): Promise<boolean> {
  return db.transaction(async (tx) => await lockMember(tx, input) && createPending(tx, input))
}

async function claim(tx: ToolPermissionTransaction, input: ToolApprovalKey): Promise<boolean> {
  const runId = input.context.runId === null ? null : normalizeDenTypeId("automationRun", input.context.runId)
  if (runId) {
    const [used] = await tx.select({ id: table.id }).from(table).where(and(match(input), eq(table.status, "used"), eq(table.used_by_run_id, runId))).limit(1).for("update")
    if (used) return true
  }
  const [available] = await tx.select({ id: table.id }).from(table).where(and(match(input), eq(table.status, "allowed_once"),
    runId ? ne(table.run_id, runId) : undefined,
    gte(table.decided_at, new Date(Date.now() - 7 * DAY)),
  )).orderBy(table.decided_at, table.id).limit(1).for("update")
  if (!available) return false
  await tx.update(table).set({ status: "used", used_by_run_id: runId, used_at: new Date() }).where(eq(table.id, available.id))
  return true
}

export async function claimToolApproval(input: ToolApprovalKey): Promise<boolean> {
  return db.transaction(async (tx) => await lockMember(tx, input) && claim(tx, input))
}

export async function claimOrRequestToolApproval(input: PendingToolApproval): Promise<"claimed" | "created" | "pending" | "member_missing"> {
  return db.transaction(async (tx) => {
    if (!await lockMember(tx, input)) return "member_missing"
    if (await claim(tx, input)) return "claimed"
    return await createPending(tx, input) ? "created" : "pending"
  })
}

export function toolApprovalView(row: ToolApprovalRow): ToolApproval {
  return { id: row.id, context: { kind: row.context_kind, id: row.context_id, label: row.context_label }, runId: row.run_id,
    connectionId: row.connection_id, connectionName: row.connection_name, toolName: row.tool_name, toolTitle: row.tool_title,
    status: row.status, createdAt: row.created_at.toISOString() }
}

export async function listPendingMemberToolApprovals(organizationId: string, memberId: string): Promise<ToolApproval[]> {
  const rows = await db.$primary.select().from(table).where(and(eq(table.organization_id, normalizeDenTypeId("organization", organizationId)),
    eq(table.requested_by_member_id, normalizeDenTypeId("member", memberId)), eq(table.status, "pending"),
    inArray(table.context_kind, ["automation", "chat"]), gte(table.created_at, pendingToolApprovalCutoff()),
  )).orderBy(desc(table.created_at), desc(table.id))
  return rows.map(toolApprovalView)
}

export async function listAgentToolApprovals(organizationId: string, agentId: string, options: { memberId?: string; limit?: number } = {}): Promise<ToolApprovalRow[]> {
  return db.$primary.select().from(table).where(and(eq(table.organization_id, normalizeDenTypeId("organization", organizationId)),
    eq(table.context_kind, "agent"), eq(table.context_id, agentId),
    options.memberId ? eq(table.requested_by_member_id, normalizeDenTypeId("member", options.memberId)) : undefined,
    or(and(eq(table.status, "pending"), gte(table.created_at, pendingToolApprovalCutoff())), gte(table.decided_at, new Date(Date.now() - 7 * DAY))),
  )).orderBy(desc(table.created_at), desc(table.id)).limit(options.limit ?? 50)
}

export async function toolApprovalRequiresAsk(row: ToolApprovalRow, tx?: ToolPermissionTransaction) {
  const organizationId = row.organization_id
  const teamAndMember = tx
    ? await organizationFeatureEnabled(organizationId, "toolPermissions", { database: tx, lock: "share" })
    : await cachedOrganizationFeatureEnabled(organizationId, "toolPermissions")
  const memberId = teamAndMember ? row.requested_by_member_id : undefined
  const query = memberId && (tx ?? db.$primary).select({ id: TeamTable.id }).from(TeamTable)
    .innerJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamMemberTable.orgMembershipId, memberId)))
  const teams = query ? await (tx ? query.for("share") : query) : []
  const rules = await loadApplicableToolPermissionRules({ organizationId, memberId, teamIds: teams.map(({ id }) => id),
    connectionId: row.connection_id, toolName: row.tool_name }, tx)
  return rules.some(({ rule }) => rule === "ask")
}

export async function decideToolApproval(input: {
  organizationId: string; memberId: string; approvalId: string; decision: ToolApprovalDecision | "always_allow"
  agent?: { id: string; onAlwaysAllow?: (tx: ToolPermissionTransaction) => Promise<void> }
}): Promise<(ToolApprovalRow & { status: "denied" | "allowed_once" | "always_allowed" }) | null> {
  if (!isDenTypeId("toolApproval", input.approvalId)) return null
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const memberId = normalizeDenTypeId("member", input.memberId)
  return db.transaction(async (tx) => {
    const [agent] = input.agent ? await tx.select().from(PersonalAgentTable).where(and(
      eq(PersonalAgentTable.id, normalizeDenTypeId("personalAgent", input.agent.id)), eq(PersonalAgentTable.organization_id, organizationId),
    )).limit(1).for("update") : []
    if (input.agent && (!agent || agent.state !== "active")) return null
    const [row] = await tx.select().from(table).where(and(eq(table.id, normalizeDenTypeId("toolApproval", input.approvalId)),
      eq(table.organization_id, organizationId), agent ? and(eq(table.context_kind, "agent"), eq(table.context_id, agent.id))
        : and(inArray(table.context_kind, ["chat", "automation"]), eq(table.requested_by_member_id, memberId)),
    )).limit(1).for("update")
    if (!row || (row.status === "pending" && row.created_at < pendingToolApprovalCutoff())) return null
    const owner = agent?.owner_member_id === memberId
    if (!owner && memberId !== row.requested_by_member_id) {
      throw new Error("tool_approval_forbidden")
    }
    if (row.status !== "pending") throw new Error("tool_approval_decided")
    if (input.decision === "always_allow") {
      if (!agent || !owner) throw new Error("tool_approval_forbidden")
      if (await toolApprovalRequiresAsk(row, tx)) throw new Error("personal_agent_organization_asks")
      await setSubjectToolRule({ organizationId, kind: "agent", id: agent.id }, { connectionId: row.connection_id, toolName: row.tool_name, rule: "allow" }, memberId, tx)
      await tx.update(PersonalAgentTable).set({ updated_at: new Date() }).where(eq(PersonalAgentTable.id, agent.id))
      await input.agent?.onAlwaysAllow?.(tx)
    }
    const status: "denied" | "allowed_once" | "always_allowed" = input.decision === "deny" ? "denied" : input.decision === "allow_once" ? "allowed_once" : "always_allowed"
    const changes = { status, decided_by_member_id: memberId, decided_at: new Date() }
    await tx.update(table).set(changes).where(eq(table.id, row.id))
    return { ...row, ...changes }
  })
}
