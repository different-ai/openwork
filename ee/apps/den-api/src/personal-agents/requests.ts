import { and, count, desc, eq, gte, inArray, ne, or } from "@openwork-ee/den-db/drizzle"
import { AutomationTable, PersonalAgentRequestTable, PersonalAgentShareTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentChange, PersonalAgentRequest, PersonalAgentRequestDecision } from "@openwork/types/den/personal-agents"
import { automationService } from "../automations/service.js"
import { db } from "../db.js"
import { canManagePersonalAgent, personalAgentOwnerScope, personalAgentPeople, personOrUnknown, type PersonalAgentAccess, type PersonalAgentCaller } from "./access.js"
import { personalAgentRequestEventDetail, recordPersonalAgentEvent } from "./events.js"
import { organizationToolRule, personalAgentOrganizationRules, type PersonalAgentOrganizationRules } from "./org-rules.js"
import { personalAgentRepository } from "./repository.js"
import { personalAgentService } from "./service.js"

type RequestRow = typeof PersonalAgentRequestTable.$inferSelect

function requiresToolApproval(row: RequestRow, rules?: PersonalAgentOrganizationRules) {
  return Boolean(rules && row.connection_id && row.tool_name && organizationToolRule(rules, row.connection_id, row.tool_name) === "ask")
}

function decisions(access: PersonalAgentAccess, memberId: string, row: RequestRow, rules?: PersonalAgentOrganizationRules): PersonalAgentRequestDecision[] {
  if (row.status !== "pending" || access.state !== "active") return []
  if (row.kind === "change") return access.role === "owner" ? ["deny", "approve"] : []
  if (access.role === "owner") return requiresToolApproval(row, rules) ? ["deny", "allow_once"] : ["deny", "allow_once", "always_allow"]
  if (access.role === "manager") return row.requested_by_member_id === access.ownerMemberId ? [] : ["deny", "allow_once"]
  return row.requested_by_member_id === memberId ? ["deny", "allow_once"] : []
}

async function requestViews(access: PersonalAgentAccess, memberId: string, rows: RequestRow[]): Promise<PersonalAgentRequest[]> {
  const [people, rules] = await Promise.all([
    personalAgentPeople(access.organizationId, rows.flatMap((row) => [row.requested_by_member_id, ...(row.decided_by_member_id ? [row.decided_by_member_id] : [])])),
    canManagePersonalAgent(access.role) && rows.some((row) => row.kind === "tool" && row.status === "pending")
      ? personalAgentOrganizationRules(access.organizationId, { fresh: true }) : undefined,
  ])
  return rows.map((row) => ({
    id: row.id, agentId: row.agent_id, kind: row.kind, status: row.status, requestedBy: personOrUnknown(people, row.requested_by_member_id),
    requestedByCaller: row.requested_by_member_id === memberId,
    runId: row.run_id, connectionId: row.connection_id, connectionName: row.connection_name, toolName: row.tool_name, toolTitle: row.tool_title,
    summary: row.summary, change: row.change, decidedBy: row.decided_by_member_id ? personOrUnknown(people, row.decided_by_member_id) : null,
    decidedAt: row.decided_at?.getTime() ?? null, createdAt: row.created_at.getTime(), canDecide: decisions(access, memberId, row, rules),
  }))
}

function requestOfAgent(access: PersonalAgentAccess) {
  return and(eq(PersonalAgentRequestTable.organization_id, normalizeDenTypeId("organization", access.organizationId)),
    eq(PersonalAgentRequestTable.agent_id, normalizeDenTypeId("personalAgent", access.agentId)))
}

export async function listPersonalAgentRequests(access: PersonalAgentAccess, caller: PersonalAgentCaller) {
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const rows = await db.$primary.select().from(PersonalAgentRequestTable).where(and(requestOfAgent(access),
    or(eq(PersonalAgentRequestTable.status, "pending"), gte(PersonalAgentRequestTable.decided_at, cutoff)),
    canManagePersonalAgent(access.role) ? undefined : eq(PersonalAgentRequestTable.requested_by_member_id, memberId),
  )).orderBy(desc(PersonalAgentRequestTable.created_at), desc(PersonalAgentRequestTable.id)).limit(50)
  return { items: await requestViews(access, memberId, rows) }
}

function changedFields(change: PersonalAgentChange) {
  return [
    change.newRoutine && "new routine", change.schedule && "schedule", change.instructions && "instructions",
    change.name && "name", change.active !== undefined && "on/off", change.brief && "brief", change.toolPolicy && "tool policy",
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
    kind: "change", requested_by_member_id: memberId, summary, change: changed, created_at: new Date(),
  })
  const [row] = await db.$primary.select().from(PersonalAgentRequestTable).where(eq(PersonalAgentRequestTable.id, id)).limit(1)
  const [view] = await requestViews(access, memberId, [row])
  await recordPersonalAgentEvent({ organizationId: access.organizationId, agentId: access.agentId, actorMemberId: memberId, action: "request.asked",
    detail: { requester: view.requestedBy.name, kind: "change", changes: changedFields(changed) },
  })
  return view
}

const decisionsApplied = { deny: "denied", allow_once: "allowed_once", always_allow: "always_allowed", approve: "approved" } as const

export async function decidePersonalAgentRequest(access: PersonalAgentAccess, caller: PersonalAgentCaller, requestId: string, decision: PersonalAgentRequestDecision) {
  if (!isDenTypeId("personalAgentRequest", requestId)) return null
  const memberId = normalizeDenTypeId("member", caller.memberId)
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
    if ((decision === "approve" || decision === "always_allow") && agent.owner_member_id !== memberId) throw new Error("personal_agent_forbidden")
    if (request.kind === "change" && access.role === "owner" && agent.state !== "active" && decision === "approve") {
      throw new Error("personal_agent_change_stale")
    }
    if (!decisions(access, memberId, request).includes(decision)) throw new Error("personal_agent_forbidden")
    if (decision === "always_allow" && request.connection_id && request.tool_name) {
      if (requiresToolApproval(request, await personalAgentOrganizationRules(access.organizationId, { fresh: true }))) {
        throw new Error("personal_agent_organization_asks")
      }
      const current = await personalAgentRepository.get({ ...scope, agentId: access.agentId })
      if (!current) throw new Error("personal_agent_not_found")
      const policy = current.revision.toolPolicy
      const updated = await personalAgentService.update(scope, access.agentId, { toolPolicy: {
        connections: policy.connections,
        tools: { ...policy.tools, [request.connection_id]: { ...policy.tools[request.connection_id], [request.tool_name]: "allow" } },
      } }, memberId, tx)
      if (!updated) throw new Error("personal_agent_not_found")
    }
    if (decision === "approve" && request.change) {
      const { newRoutine, schedule, instructions, brief, name, active, toolPolicy, routineId } = request.change
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
    const changes = { status: decisionsApplied[decision], decided_by_member_id: memberId, decided_at: new Date() }
    await tx.update(PersonalAgentRequestTable).set(changes).where(eq(PersonalAgentRequestTable.id, request.id))
    return { ...request, ...changes }
  })
  if (!row) return null
  const [view] = await requestViews(access, memberId, [row])
  await recordPersonalAgentEvent({ organizationId: access.organizationId, agentId: access.agentId, actorMemberId: memberId,
    action: `request.${decisionsApplied[decision]}`, detail: row.kind === "change" && row.change ? { requester: view.requestedBy.name, kind: row.kind, changes: changedFields(row.change) }
      : personalAgentRequestEventDetail({ requester: view.requestedBy.name, kind: row.kind, tool: row.tool_title, connection: row.connection_name }),
  })
  return view
}

export async function openPersonalAgentRequestCounts(caller: PersonalAgentCaller, agentIds: readonly string[]): Promise<Map<string, number>> {
  const ids = agentIds.filter((id) => isDenTypeId("personalAgent", id)).map((id) => normalizeDenTypeId("personalAgent", id))
  if (!ids.length) return new Map()
  const memberId = normalizeDenTypeId("member", caller.memberId)
  const rows = await db.$primary.select({ agentId: PersonalAgentRequestTable.agent_id, total: count() }).from(PersonalAgentRequestTable)
    .innerJoin(PersonalAgentTable, eq(PersonalAgentTable.id, PersonalAgentRequestTable.agent_id))
    .leftJoin(PersonalAgentShareTable, and(eq(PersonalAgentShareTable.agent_id, PersonalAgentTable.id), eq(PersonalAgentShareTable.member_id, memberId)))
    .where(and(
      eq(PersonalAgentRequestTable.organization_id, normalizeDenTypeId("organization", caller.organizationId)), inArray(PersonalAgentRequestTable.agent_id, ids),
      eq(PersonalAgentRequestTable.status, "pending"), eq(PersonalAgentTable.state, "active"),
      or(eq(PersonalAgentTable.owner_member_id, memberId), eq(PersonalAgentShareTable.role, "manager"), and(
        eq(PersonalAgentShareTable.role, "collaborator"), eq(PersonalAgentRequestTable.kind, "tool"), eq(PersonalAgentRequestTable.requested_by_member_id, memberId),
      )),
    )).groupBy(PersonalAgentRequestTable.agent_id)
  return new Map(rows.map(({ agentId, total }) => [agentId, total]))
}
