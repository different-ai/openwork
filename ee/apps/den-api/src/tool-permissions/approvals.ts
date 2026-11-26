import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable, PersonalAgentShareTable, PersonalAgentTable, TeamMemberTable, TeamTable, ToolApprovalTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ToolApproval, ToolApprovalDecision } from "@openwork/types/den/tool-permissions"
import { db } from "../db.js"
import { cachedOrganizationFeatureEnabled, organizationFeatureEnabled } from "../features.js"
import { loadApplicableToolPermissionRules } from "./evaluate.js"
import { setSubjectToolRule, type ToolPermissionTransaction } from "./rules.js"

export type ToolApprovalRow = typeof ToolApprovalTable.$inferSelect
export type ToolApprovalContext =
  | { kind: "agent" | "automation"; id: string; label: string; runId: string }
  | { kind: "agent"; id: string; label: string; runId: null; chatTurnId: string }
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
    "chatTurnId" in input.context ? isNull(table.run_id) : isNull(table.chat_turn_id),
    eq(table.connection_id, input.connectionId), sql`binary ${table.tool_name} = ${input.toolName}`)
}

async function lockMember(tx: ToolPermissionTransaction, input: ToolApprovalKey) {
  const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizeDenTypeId("member", input.memberId)),
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", input.organizationId)), isNull(MemberTable.removedAt),
  )).for("update")
  return Boolean(member)
}

type PendingToolApproval = ToolApprovalKey & { connectionName: string; toolTitle: string; connectorAccess?: true }
export const CONNECTOR_ONLY_TOOL_NAME = "*"

async function createPending(tx: ToolPermissionTransaction, input: PendingToolApproval) {
  const [existing] = await tx.select({ id: table.id }).from(table).where(and(match(input),
    input.connectorAccess ? eq(table.connector_access, true) : isNull(table.connector_access),
    eq(table.status, "pending"), gte(table.created_at, pendingToolApprovalCutoff()),
  )).limit(1).for("update")
  if (existing) return { id: existing.id, created: false }
  const id = createDenTypeId("toolApproval")
  await tx.insert(table).values({
    id, organization_id: normalizeDenTypeId("organization", input.organizationId),
    requested_by_member_id: normalizeDenTypeId("member", input.memberId), context_kind: input.context.kind, context_id: input.context.id,
    context_label: input.context.label?.slice(0, 160) ?? null,
    run_id: input.context.runId === null ? null : normalizeDenTypeId("automationRun", input.context.runId),
    chat_turn_id: "chatTurnId" in input.context ? normalizeDenTypeId("personalAgentChatTurn", input.context.chatTurnId) : null,
    connection_id: input.connectionId, connection_name: input.connectionName.slice(0, 160), tool_name: input.toolName, tool_title: input.toolTitle.slice(0, 240),
    connector_access: input.connectorAccess ?? null,
  })
  return { id, created: true }
}

export async function createOrReuseToolApproval(input: PendingToolApproval): Promise<boolean> {
  return db.transaction(async (tx) => await lockMember(tx, input) && (await createPending(tx, input)).created)
}

export type AgentConnectorApprovalKey = ToolApprovalKey & { context: Extract<ToolApprovalContext, { kind: "agent" | "automation" }> & { kind: "agent" } }

export function agentApprovalContext(agent: { agentId: string; agentName: string }, execution: { kind: "chat" | "run"; id: string }): AgentConnectorApprovalKey["context"] {
  const base: { kind: "agent"; id: string; label: string } = { kind: "agent", id: agent.agentId, label: agent.agentName }
  return execution.kind === "chat" ? { ...base, runId: null, chatTurnId: execution.id } : { ...base, runId: execution.id }
}

export async function requestAgentConnectorApproval(input: AgentConnectorApprovalKey & { connectionName: string; toolTitle: string }) {
  return db.transaction(async (tx) => await lockMember(tx, input) ? createPending(tx, { ...input, connectorAccess: true }) : null)
}

function availableInExecution(context: ToolApprovalContext) {
  const differentTurn = "chatTurnId" in context ? ne(table.chat_turn_id, normalizeDenTypeId("personalAgentChatTurn", context.chatTurnId)) : undefined
  const differentRun = context.runId ? ne(table.run_id, normalizeDenTypeId("automationRun", context.runId)) : undefined
  return and(eq(table.status, "allowed_once"), differentTurn, differentRun,
    gte(table.decided_at, new Date(Date.now() - 7 * DAY)))
}

export async function approvedAgentConnectorTools(input: Omit<AgentConnectorApprovalKey, "toolName">) {
  const runId = input.context.runId ? normalizeDenTypeId("automationRun", input.context.runId) : null
  const rows = await db.$primary.select({ toolName: table.tool_name }).from(table).where(and(
    eq(table.organization_id, normalizeDenTypeId("organization", input.organizationId)),
    eq(table.requested_by_member_id, normalizeDenTypeId("member", input.memberId)),
    eq(table.context_kind, "agent"), eq(table.context_id, input.context.id), eq(table.connection_id, input.connectionId),
    eq(table.connector_access, true), ne(table.tool_name, CONNECTOR_ONLY_TOOL_NAME),
    or(availableInExecution(input.context), runId ? and(eq(table.status, "used"), eq(table.used_by_run_id, runId)) : undefined),
  ))
  return new Set(rows.map(({ toolName }) => toolName))
}

async function claim(tx: ToolPermissionTransaction, input: ToolApprovalKey, connectorAccess = false): Promise<boolean> {
  if (input.toolName === CONNECTOR_ONLY_TOOL_NAME) return false
  const runId = input.context.runId === null ? null : normalizeDenTypeId("automationRun", input.context.runId)
  const scope = and(match(input), connectorAccess ? eq(table.connector_access, true) : isNull(table.connector_access))
  if (runId) {
    const [used] = await tx.select({ id: table.id }).from(table).where(and(scope, eq(table.status, "used"), eq(table.used_by_run_id, runId))).limit(1).for("update")
    if (used) return true
  }
  const [available] = await tx.select({ id: table.id }).from(table).where(and(scope, availableInExecution(input.context))).orderBy(table.decided_at, table.id).limit(1).for("update")
  if (!available) return false
  await tx.update(table).set({ status: "used", used_by_run_id: runId, used_at: new Date() }).where(eq(table.id, available.id))
  return true
}

export async function claimToolApproval(input: ToolApprovalKey): Promise<boolean> {
  return db.transaction(async (tx) => await lockMember(tx, input) && claim(tx, input))
}

export async function claimAgentConnectorToolApproval(input: AgentConnectorApprovalKey) {
  return db.transaction(async (tx) => await lockMember(tx, input) && claim(tx, input, true))
}

export async function claimOrRequestToolApproval(input: PendingToolApproval): Promise<"claimed" | "created" | "pending" | "member_missing"> {
  return db.transaction(async (tx) => {
    if (!await lockMember(tx, input)) return "member_missing"
    if (await claim(tx, input)) return "claimed"
    return (await createPending(tx, input)).created ? "created" : "pending"
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

export async function toolApprovalRules(row: Pick<ToolApprovalRow, "organization_id" | "requested_by_member_id" | "connection_id" | "tool_name">, tx?: ToolPermissionTransaction, agentId?: string) {
  const organizationId = row.organization_id
  const teamAndMember = tx
    ? await organizationFeatureEnabled(organizationId, "toolPermissions", { database: tx, lock: "share" })
    : await cachedOrganizationFeatureEnabled(organizationId, "toolPermissions")
  const memberId = teamAndMember ? row.requested_by_member_id : undefined
  const query = memberId && (tx ?? db.$primary).select({ id: TeamTable.id }).from(TeamTable)
    .innerJoin(TeamMemberTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamMemberTable.orgMembershipId, memberId)))
  const teams = query ? await (tx ? query.for("share") : query) : []
  return loadApplicableToolPermissionRules({ organizationId, memberId, teamIds: teams.map(({ id }) => id),
    agentId, connectionId: row.connection_id, toolName: row.tool_name }, tx)
}

export async function toolApprovalRequiresAsk(row: ToolApprovalRow, tx?: ToolPermissionTransaction) {
  return (await toolApprovalRules(row, tx)).some(({ rule }) => rule === "ask")
}

type ConnectorApprovalAgent = typeof PersonalAgentTable.$inferSelect

type DecidedToolApproval = ToolApprovalRow & { status: "pending" | "denied" | "allowed_once" | "always_allowed" }

export async function decideToolApproval(input: {
  organizationId: string; memberId: string; approvalId: string; decision: ToolApprovalDecision | "always_allow" | "turn_on"
  agent?: {
    id: string
    onAlwaysAllow?: (tx: ToolPermissionTransaction) => Promise<void>
    connectorState?: (tx: ToolPermissionTransaction, row: ToolApprovalRow, agent: ConnectorApprovalAgent) => Promise<"on" | "off" | "blocked" | "disabled">
  }
}): Promise<DecidedToolApproval | null> {
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
    const requester = memberId === row.requested_by_member_id
    const [manager] = !owner && agent && row.connector_access && input.decision === "turn_on"
      ? await tx.select({ id: PersonalAgentShareTable.member_id }).from(PersonalAgentShareTable).where(and(
        eq(PersonalAgentShareTable.organization_id, organizationId), eq(PersonalAgentShareTable.agent_id, agent.id),
        eq(PersonalAgentShareTable.member_id, memberId), eq(PersonalAgentShareTable.role, "manager"),
      )).limit(1).for("share") : []
    if (!owner && !requester && !manager) throw new Error("tool_approval_forbidden")
    if (row.status !== "pending") throw new Error("tool_approval_decided")
    if (row.connector_access) {
      if (!agent || !input.agent?.connectorState || input.decision === "always_allow") throw new Error("tool_approval_forbidden")
      if (row.owner_requested_at && (!owner || input.decision === "allow_once")) throw new Error("tool_approval_forbidden")
      if (input.decision !== "deny") {
        const state = await input.agent.connectorState(tx, row, agent)
        if (state === "blocked" || state === "disabled") throw new Error("personal_agent_connector_unavailable")
      }
      if (input.decision === "allow_once" && row.tool_name === CONNECTOR_ONLY_TOOL_NAME) throw new Error("tool_approval_forbidden")
      if (input.decision === "turn_on") {
        if (!owner) {
          if (!manager) throw new Error("tool_approval_forbidden")
          const changes = { owner_requested_at: new Date() }
          await tx.update(table).set(changes).where(eq(table.id, row.id))
          return { ...row, ...changes, status: "pending" }
        }
        await setSubjectToolRule({ organizationId, kind: "agent", id: agent.id }, {
          connectionId: row.connection_id, toolName: CONNECTOR_ONLY_TOOL_NAME, rule: "allow",
        }, memberId, tx)
        await tx.update(PersonalAgentTable).set({ updated_at: new Date() }).where(eq(PersonalAgentTable.id, agent.id))
        await input.agent.onAlwaysAllow?.(tx)
      }
    } else if (input.decision === "turn_on") {
      throw new Error("tool_approval_forbidden")
    }
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
