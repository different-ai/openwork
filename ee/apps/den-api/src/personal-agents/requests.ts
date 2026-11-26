import { and, count, desc, eq, gte, inArray, ne, or } from "@openwork-ee/den-db/drizzle"
import { AutomationTable, PersonalAgentRequestTable, PersonalAgentShareTable, PersonalAgentTable, ToolApprovalTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentChange, PersonalAgentRequest, PersonalAgentRequestDecision } from "@openwork/types/den/personal-agents"
import { automationService } from "../automations/service.js"
import { db } from "../db.js"
import { canManagePersonalAgent, personalAgentOwnerScope, personalAgentPeople, personOrUnknown, type PersonalAgentAccess, type PersonalAgentCaller } from "./access.js"
import { personalAgentRequestEventDetail, recordPersonalAgentEvent } from "./events.js"
import { decideToolApproval, listAgentToolApprovals, pendingToolApprovalCutoff, toolApprovalRequiresAsk, type ToolApprovalRow } from "../tool-permissions/approvals.js"
import { appendPersonalAgentMemoryNote } from "./memory.js"
import { personalAgentService } from "./service.js"

type ChangeRow = typeof PersonalAgentRequestTable.$inferSelect
type RequestRow = (ChangeRow & { kind: "change" }) | (ToolApprovalRow & { kind: "tool" })

function decisions(access: PersonalAgentAccess, memberId: string, row: RequestRow, requiresAsk = false): PersonalAgentRequestDecision[] {
  if (row.status !== "pending" || access.state !== "active") return []
  if (row.kind === "change") return access.role === "owner" ? ["deny", "approve"] : []
  if (access.role === "owner") return requiresAsk ? ["deny", "allow_once"] : ["deny", "allow_once", "always_allow"]
  return row.requested_by_member_id === memberId ? ["deny", "allow_once"] : []
}

async function requestViews(access: PersonalAgentAccess, memberId: string, rows: RequestRow[]): Promise<PersonalAgentRequest[]> {
  const people = await personalAgentPeople(access.organizationId, rows.flatMap((row) => [row.requested_by_member_id, ...(row.decided_by_member_id ? [row.decided_by_member_id] : [])]))
  return Promise.all(rows.map(async (row) => ({
    id: row.id, agentId: access.agentId, kind: row.kind, status: row.status, requestedBy: personOrUnknown(people, row.requested_by_member_id),
    requestedByCaller: row.requested_by_member_id === memberId,
    runId: row.kind === "tool" ? row.run_id : null, connectionId: row.kind === "tool" ? row.connection_id : null,
    connectionName: row.kind === "tool" ? row.connection_name : null, toolName: row.kind === "tool" ? row.tool_name : null,
    toolTitle: row.kind === "tool" ? row.tool_title : null, summary: row.kind === "change" ? row.summary : null,
    change: row.kind === "change" ? row.change : null, decidedBy: row.decided_by_member_id ? personOrUnknown(people, row.decided_by_member_id) : null,
    decidedAt: row.decided_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(),
    canDecide: decisions(access, memberId, row, row.kind === "tool" && row.status === "pending" && access.role === "owner" && await toolApprovalRequiresAsk(row)),
  })))
}

function requestOfAgent(access: PersonalAgentAccess) {
  return and(eq(PersonalAgentRequestTable.organization_id, normalizeDenTypeId("organization", access.organizationId)),
    eq(PersonalAgentRequestTable.agent_id, normalizeDenTypeId("personalAgent", access.agentId)))
}

export async function listPersonalAgentRequests(access: PersonalAgentAccess, caller: PersonalAgentCaller) {
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const onlyMember = canManagePersonalAgent(access.role) ? undefined : memberId
  const [changes, approvals] = await Promise.all([
    db.$primary.select().from(PersonalAgentRequestTable).where(and(requestOfAgent(access),
      or(eq(PersonalAgentRequestTable.status, "pending"), gte(PersonalAgentRequestTable.decided_at, cutoff)),
      onlyMember ? eq(PersonalAgentRequestTable.requested_by_member_id, onlyMember) : undefined,
    )).orderBy(desc(PersonalAgentRequestTable.created_at), desc(PersonalAgentRequestTable.id)).limit(50),
    listAgentToolApprovals(access.organizationId, access.agentId, { memberId: onlyMember }),
  ])
  const rows: RequestRow[] = [...changes.map(asChange), ...approvals.map(asTool)]
  rows.sort((left, right) => right.created_at.getTime() - left.created_at.getTime() || right.id.localeCompare(left.id))
  return { items: await requestViews(access, memberId, rows.slice(0, 50)) }
}

function asChange(row: ChangeRow): RequestRow {
  return { ...row, kind: "change" }
}

function asTool(row: ToolApprovalRow): RequestRow {
  return { ...row, kind: "tool" }
}

function changedFields(change: PersonalAgentChange) {
  return [
    change.newRoutine && "new routine", change.schedule && "schedule", change.instructions && "instructions",
    change.name && "name", change.active !== undefined && "on/off", change.brief && "brief", change.toolPolicy && "tool policy", change.memoryNote && "memory",
  ].filter(Boolean).join(", ")
}

async function changeRoutine(access: PersonalAgentAccess, change: PersonalAgentChange) {
  const routineId = change.routineId
  if (routineId) {
    const routine = await automationService.get(personalAgentOwnerScope(access), routineId)
    if (routine?.automation.agentId !== access.agentId || routine.automation.state === "archived") throw new Error("personal_agent_routine_not_found")
    return routine
  }
  if (!change.schedule && !change.instructions && !change.name && change.active === undefined) return null
  const rows = await db.$primary.select({ id: AutomationTable.id }).from(AutomationTable).where(and(
    eq(AutomationTable.organization_id, normalizeDenTypeId("organization", access.organizationId)),
    eq(AutomationTable.agent_id, normalizeDenTypeId("personalAgent", access.agentId)), ne(AutomationTable.state, "archived"),
  )).limit(2)
  if (rows.length !== 1) throw new Error(rows.length ? "personal_agent_routine_ambiguous" : "personal_agent_routine_required")
  const routine = await automationService.get(personalAgentOwnerScope(access), rows[0].id)
  if (!routine || routine.automation.state === "archived") throw new Error("personal_agent_routine_not_found")
  return routine
}

export async function createPersonalAgentChangeRequest(access: PersonalAgentAccess, caller: PersonalAgentCaller, input: { summary?: string; change: PersonalAgentChange }) {
  if (access.state !== "active") throw new Error("personal_agent_forbidden")
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const routine = await changeRoutine(access, input.change)
  const id = createDenTypeId("personalAgentRequest")
  const changed = routine ? { ...input.change, routineId: routine.automation.id } : input.change
  const summary = input.summary ?? (changed.newRoutine ? `Add a routine: ${changed.newRoutine.name}`
    : routine ? `Change ${routine.automation.name}: ${changedFields(changed)}` : `Change the agent: ${changedFields(changed)}`)
  await db.insert(PersonalAgentRequestTable).values({
    id, organization_id: normalizeDenTypeId("organization", access.organizationId), agent_id: normalizeDenTypeId("personalAgent", access.agentId),
    requested_by_member_id: memberId, summary, change: changed, created_at: new Date(),
  })
  const [row] = await db.$primary.select().from(PersonalAgentRequestTable).where(eq(PersonalAgentRequestTable.id, id)).limit(1)
  const [view] = await requestViews(access, memberId, [asChange(row)])
  await recordPersonalAgentEvent({ organizationId: access.organizationId, agentId: access.agentId, actorMemberId: memberId, action: "request.asked",
    detail: { requester: view.requestedBy.name, kind: "change", changes: changedFields(changed) },
  })
  return view
}

async function decidePersonalAgentToolRequest(access: PersonalAgentAccess, memberId: string, approvalId: string, decision: PersonalAgentRequestDecision) {
  if (decision === "approve" || access.state !== "active") throw new Error("personal_agent_forbidden")
  const row = await decideToolApproval({ organizationId: access.organizationId, memberId, approvalId, decision,
    agent: { id: access.agentId, onAlwaysAllow: (tx) => recordPersonalAgentEvent({
      organizationId: access.organizationId, agentId: access.agentId, actorMemberId: memberId,
      action: "agent.updated", detail: { name: false, brief: false, tools: true, budget: false },
    }, tx) } }).catch((error: unknown) => {
    if (error instanceof Error && error.message === "tool_approval_decided") throw new Error("personal_agent_request_decided")
    if (error instanceof Error && error.message === "tool_approval_forbidden") throw new Error("personal_agent_forbidden")
    throw error
  })
  if (!row) return null
  const [view] = await requestViews(access, memberId, [asTool(row)])
  await recordPersonalAgentEvent({ organizationId: access.organizationId, agentId: access.agentId, actorMemberId: memberId,
    action: `request.${row.status}`, detail: personalAgentRequestEventDetail({ requester: view.requestedBy.name, kind: "tool", tool: row.tool_title, connection: row.connection_name }),
  })
  return view
}

export async function decidePersonalAgentRequest(access: PersonalAgentAccess, caller: PersonalAgentCaller, requestId: string, decision: PersonalAgentRequestDecision) {
  const memberId = normalizeDenTypeId("member", caller.memberId)
  if (isDenTypeId("toolApproval", requestId)) return decidePersonalAgentToolRequest(access, memberId, requestId, decision)
  if (!isDenTypeId("personalAgentRequest", requestId)) return null
  const scope = personalAgentOwnerScope(access)
  const row = await db.transaction(async (tx) => {
    const [request] = await tx.select().from(PersonalAgentRequestTable).where(and(requestOfAgent(access),
      eq(PersonalAgentRequestTable.id, normalizeDenTypeId("personalAgentRequest", requestId)),
    )).limit(1).for("update")
    if (!request) return null
    if (!canManagePersonalAgent(access.role) && memberId !== request.requested_by_member_id) throw new Error("personal_agent_forbidden")
    if (request.status !== "pending") throw new Error("personal_agent_request_decided")
    const [agent] = await tx.select().from(PersonalAgentTable).where(and(eq(PersonalAgentTable.id, request.agent_id),
      eq(PersonalAgentTable.organization_id, request.organization_id))).limit(1).for("update")
    if (!agent) return null
    if (agent.owner_member_id !== memberId) throw new Error("personal_agent_forbidden")
    if (agent.state !== "active" && decision === "approve") {
      throw new Error("personal_agent_change_stale")
    }
    if (!decisions(access, memberId, asChange(request)).includes(decision)) throw new Error("personal_agent_forbidden")
    if (decision === "approve") {
      const { newRoutine, schedule, instructions, brief, name, active, toolPolicy, routineId, memoryNote } = request.change
      try {
        const [routine] = routineId ? await tx.select().from(AutomationTable).where(and(
          eq(AutomationTable.id, normalizeDenTypeId("automation", routineId)), eq(AutomationTable.agent_id, agent.id),
        )).limit(1).for("update") : []
        if (routineId && (!routine || routine.state === "archived" || routine.updated_at > request.created_at)) throw new Error("personal_agent_change_stale")
        if (routine && (schedule || instructions || name || active !== undefined)) {
          const changed = await personalAgentService.updateRoutine(scope, access.agentId, routine.id, {
            ...(schedule !== undefined ? { schedule } : {}),
            ...(instructions !== undefined ? { instructions } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(active !== undefined ? { active } : {}),
          }, memberId, tx)
          if (!changed) throw new Error("personal_agent_change_stale")
        }
        if ((brief || toolPolicy) && !await personalAgentService.update(scope, access.agentId, { brief, toolPolicy }, memberId, tx)) {
          throw new Error("personal_agent_change_stale")
        }
        if (memoryNote) await appendPersonalAgentMemoryNote(tx, { organizationId: agent.organization_id, agentId: agent.id,
          note: memoryNote, memberId: request.requested_by_member_id })
        if (newRoutine && !await personalAgentService.createRoutine(scope, access.agentId, newRoutine, memberId, tx)) {
          throw new Error("personal_agent_change_stale")
        }
      } catch (error) {
        if (error instanceof Error && ["personal_agent_routine_not_found", "personal_agent_routine_required", "personal_agent_routine_ambiguous", "automation_not_found", "personal_agent_archived", "personal_agent_not_found"].includes(error.message)) {
          throw new Error("personal_agent_change_stale")
        }
        throw error
      }
    }
    const status: "approved" | "denied" = decision === "approve" ? "approved" : "denied"
    const changes = { status, decided_by_member_id: memberId, decided_at: new Date() }
    await tx.update(PersonalAgentRequestTable).set(changes).where(eq(PersonalAgentRequestTable.id, request.id))
    return { ...request, ...changes }
  })
  if (!row) return null
  const [view] = await requestViews(access, memberId, [asChange(row)])
  await recordPersonalAgentEvent({ organizationId: access.organizationId, agentId: access.agentId, actorMemberId: memberId,
    action: `request.${row.status}`, detail: { requester: view.requestedBy.name, kind: "change", changes: changedFields(row.change) },
  })
  return view
}

export async function openPersonalAgentRequestCounts(caller: PersonalAgentCaller, agentIds: readonly string[]): Promise<Map<string, number>> {
  const ids = agentIds.filter((id) => isDenTypeId("personalAgent", id)).map((id) => normalizeDenTypeId("personalAgent", id))
  if (!ids.length) return new Map()
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const organizationId = normalizeDenTypeId("organization", caller.organizationId)
  const manages = or(eq(PersonalAgentTable.owner_member_id, memberId), eq(PersonalAgentShareTable.role, "manager"))
  const share = and(eq(PersonalAgentShareTable.agent_id, PersonalAgentTable.id), eq(PersonalAgentShareTable.member_id, memberId))
  const [changes, approvals] = await Promise.all([
    db.$primary.select({ agentId: PersonalAgentRequestTable.agent_id, total: count() }).from(PersonalAgentRequestTable)
      .innerJoin(PersonalAgentTable, eq(PersonalAgentTable.id, PersonalAgentRequestTable.agent_id))
      .leftJoin(PersonalAgentShareTable, share).where(and(eq(PersonalAgentRequestTable.organization_id, organizationId),
        inArray(PersonalAgentRequestTable.agent_id, ids), eq(PersonalAgentRequestTable.status, "pending"), eq(PersonalAgentTable.state, "active"), manages,
      )).groupBy(PersonalAgentRequestTable.agent_id),
    db.$primary.select({ agentId: PersonalAgentTable.id, total: count() }).from(ToolApprovalTable)
      .innerJoin(PersonalAgentTable, eq(PersonalAgentTable.id, ToolApprovalTable.context_id))
      .leftJoin(PersonalAgentShareTable, share).where(and(eq(ToolApprovalTable.organization_id, organizationId),
        eq(ToolApprovalTable.context_kind, "agent"), inArray(PersonalAgentTable.id, ids), eq(ToolApprovalTable.status, "pending"), gte(ToolApprovalTable.created_at, pendingToolApprovalCutoff()),
        eq(PersonalAgentTable.state, "active"), or(eq(PersonalAgentTable.owner_member_id, memberId), eq(ToolApprovalTable.requested_by_member_id, memberId)),
      )).groupBy(PersonalAgentTable.id),
  ])
  const totals = new Map<string, number>()
  for (const { agentId, total } of [...changes, ...approvals]) totals.set(agentId, (totals.get(agentId) ?? 0) + total)
  return totals
}
