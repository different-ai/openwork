import { and, asc, eq } from "@openwork-ee/den-db/drizzle"
import { AutomationRunTable, AutomationTable, PersonalAgentMemoryTable, PersonalAgentRoutineStateTable, PersonalAgentShareTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { PERSONAL_AGENT_MEMORY_MAX_LENGTH, PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH, type PersonalAgentMemory, type SetPersonalAgentMemory } from "@openwork/types/den/personal-agents"
import { db } from "../db.js"
import { canManagePersonalAgent, personalAgentPeople, personOrUnknown, type PersonalAgentAccess, type PersonalAgentTransaction } from "./access.js"
import { recordPersonalAgentEvent } from "./events.js"

type AgentScope = { organizationId: string; agentId: string }

export const PERSONAL_AGENT_MEMORY_ERRORS = {
  personal_agent_memory_conflict: "Someone else changed the memory. Reload it and try again.",
  personal_agent_memory_full: "The memory is full. Ask the owner to tidy it.",
} as const

function agentScope(input: AgentScope) {
  return { organizationId: normalizeDenTypeId("organization", input.organizationId), agentId: normalizeDenTypeId("personalAgent", input.agentId) }
}

function notesOfAgent(input: ReturnType<typeof agentScope>) {
  return and(eq(PersonalAgentMemoryTable.agent_id, input.agentId), eq(PersonalAgentMemoryTable.organization_id, input.organizationId))
}

function statesOfAgent(input: ReturnType<typeof agentScope>) {
  return and(eq(PersonalAgentRoutineStateTable.agent_id, input.agentId), eq(PersonalAgentRoutineStateTable.organization_id, input.organizationId))
}

function routinesOfAgent(input: ReturnType<typeof agentScope>) {
  return and(eq(AutomationTable.agent_id, input.agentId), eq(AutomationTable.organization_id, input.organizationId))
}

function routineStates(input: ReturnType<typeof agentScope>, ownerMemberId: string, routineId?: string) {
  return db.$primary.select({
    routineId: AutomationTable.id, name: AutomationTable.name,
    state: PersonalAgentRoutineStateTable.state, updatedAt: PersonalAgentRoutineStateTable.updated_at,
  }).from(PersonalAgentRoutineStateTable)
    .innerJoin(AutomationTable, eq(AutomationTable.id, PersonalAgentRoutineStateTable.automation_id))
    .innerJoin(PersonalAgentTable, and(eq(PersonalAgentTable.id, AutomationTable.agent_id), eq(PersonalAgentTable.owner_member_id, normalizeDenTypeId("member", ownerMemberId))))
    .where(and(statesOfAgent(input), routinesOfAgent(input), routineId === undefined ? undefined : eq(AutomationTable.id, normalizeDenTypeId("automation", routineId))))
    .orderBy(asc(AutomationTable.name), asc(AutomationTable.id))
}

export async function readPersonalAgentMemory(access: PersonalAgentAccess): Promise<PersonalAgentMemory> {
  const scope = agentScope(access)
  const [[memory], routines] = await Promise.all([
    db.$primary.select().from(PersonalAgentMemoryTable).where(notesOfAgent(scope)).limit(1),
    access.role === "owner" ? routineStates(scope, access.ownerMemberId) : [],
  ])
  const memberId = memory?.updated_by_member_id
  const updatedBy = memberId ? personOrUnknown(await personalAgentPeople(scope.organizationId, [memberId]), memberId) : null
  return {
    notes: memory?.notes ?? "",
    version: memory?.version ?? 0,
    updatedAt: memory?.updated_at.getTime() ?? null,
    updatedBy,
    canEdit: access.state === "active" && canManagePersonalAgent(access.role),
    routines: routines.map((routine) => ({ ...routine, updatedAt: routine.updatedAt.getTime() })),
  }
}

export async function readPersonalAgentRunMemory(input: AgentScope & { routineId: string; memberId: string }) {
  const scope = agentScope(input)
  const [[memory], [routine]] = await Promise.all([
    db.$primary.select({ notes: PersonalAgentMemoryTable.notes }).from(PersonalAgentMemoryTable).where(notesOfAgent(scope)).limit(1),
    routineStates(scope, input.memberId, input.routineId).limit(1),
  ])
  return { notes: memory?.notes ?? "", ...(routine ? { routineState: { name: routine.name, state: routine.state } } : {}) }
}

async function lockAgent(tx: PersonalAgentTransaction, scope: ReturnType<typeof agentScope>) {
  const [agent] = await tx.select().from(PersonalAgentTable).where(and(
    eq(PersonalAgentTable.id, scope.agentId), eq(PersonalAgentTable.organization_id, scope.organizationId),
  )).limit(1).for("update")
  return agent
}

async function requireMemoryEditor(tx: PersonalAgentTransaction, scope: ReturnType<typeof agentScope>, memberId: string) {
  const agent = await lockAgent(tx, scope)
  if (!agent || agent.state !== "active") throw new Error("personal_agent_not_found")
  if (agent.owner_member_id === memberId) return
  const [share] = await tx.select({ role: PersonalAgentShareTable.role }).from(PersonalAgentShareTable).where(and(
    eq(PersonalAgentShareTable.agent_id, scope.agentId), eq(PersonalAgentShareTable.organization_id, scope.organizationId),
    eq(PersonalAgentShareTable.member_id, normalizeDenTypeId("member", memberId)),
  )).limit(1).for("share")
  if (share?.role !== "manager") throw new Error("personal_agent_forbidden")
}

async function lockNotes(tx: PersonalAgentTransaction, scope: ReturnType<typeof agentScope>) {
  const [current] = await tx.select().from(PersonalAgentMemoryTable).where(notesOfAgent(scope)).limit(1).for("update")
  return current
}

async function writeNotes(tx: PersonalAgentTransaction, scope: ReturnType<typeof agentScope>, input: {
  notes: string; version: number; memberId: string | null; runId?: string | null
}) {
  const changes = {
    notes: input.notes, version: input.version + 1, updated_at: new Date(),
    updated_by_member_id: input.memberId ? normalizeDenTypeId("member", input.memberId) : null,
    updated_by_run_id: input.runId ? normalizeDenTypeId("automationRun", input.runId) : null,
  }
  if (input.version === 0) await tx.insert(PersonalAgentMemoryTable).values({ ...changes, organization_id: scope.organizationId, agent_id: scope.agentId })
  else await tx.update(PersonalAgentMemoryTable).set(changes).where(notesOfAgent(scope))
}

export async function setPersonalAgentMemory(access: PersonalAgentAccess, memberId: string, input: SetPersonalAgentMemory) {
  const scope = agentScope(access)
  await db.transaction(async (tx) => {
    await requireMemoryEditor(tx, scope, memberId)
    const current = await lockNotes(tx, scope)
    const version = current?.version ?? 0
    if (version !== input.expectedVersion) throw new Error("personal_agent_memory_conflict")
    await writeNotes(tx, scope, { notes: input.notes, version, memberId })
    await recordPersonalAgentEvent({ ...scope, actorMemberId: memberId, action: "memory.edited" }, tx)
  })
  return readPersonalAgentMemory(access)
}

export async function appendPersonalAgentMemoryNote(tx: PersonalAgentTransaction, input: {
  organizationId: string
  agentId: string
  note: string
  memberId: string | null
  runId?: string | null
}): Promise<void> {
  const scope = agentScope(input)
  const agent = await lockAgent(tx, scope)
  if (!agent || agent.state !== "active") throw new Error("personal_agent_not_found")
  const current = await lockNotes(tx, scope)
  const previous = current?.notes ?? ""
  const notes = `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}- ${input.note}`
  if (notes.length > PERSONAL_AGENT_MEMORY_MAX_LENGTH) throw new Error("personal_agent_memory_full")
  await writeNotes(tx, scope, { ...input, memberId: input.runId ? null : input.memberId, notes, version: current?.version ?? 0 })
  await recordPersonalAgentEvent({ ...scope, actorMemberId: input.memberId ?? agent.owner_member_id, action: "memory.note_added" }, tx)
}

export async function rememberPersonalAgentNote(access: PersonalAgentAccess, memberId: string, note: string) {
  const scope = agentScope(access)
  await db.transaction(async (tx) => {
    await requireMemoryEditor(tx, scope, memberId)
    await appendPersonalAgentMemoryNote(tx, { ...scope, memberId, note })
  })
  return readPersonalAgentMemory(access)
}

async function lockRoutineRun(tx: PersonalAgentTransaction, input: AgentScope & { runId: string }) {
  const scope = agentScope(input)
  const agent = await lockAgent(tx, scope)
  if (!agent || agent.state !== "active" || agent.paused_at) return null
  const [row] = await tx.select({ run: AutomationRunTable, routine: AutomationTable }).from(AutomationRunTable)
    .innerJoin(AutomationTable, eq(AutomationRunTable.automation_id, AutomationTable.id))
    .where(and(routinesOfAgent(scope), eq(AutomationRunTable.id, normalizeDenTypeId("automationRun", input.runId))))
    .limit(1).for("update")
  if (!row || row.routine.state === "archived" || row.run.cancel_requested_at) return null
  const memberId = row.run.acting_member_id ?? row.routine.owner_member_id
  return { ...row, memberId, owner: memberId === agent.owner_member_id }
}

export async function rememberPersonalAgentRunNote(input: AgentScope & { runId: string; memberId: string; note: string }) {
  return db.transaction(async (tx) => {
    const context = await lockRoutineRun(tx, input)
    if (!context?.owner || context.memberId !== input.memberId || !["claimed", "running"].includes(context.run.status)) return false
    await appendPersonalAgentMemoryNote(tx, input)
    return true
  })
}

export async function savePersonalAgentRoutineState(input: AgentScope & {
  runId: string; state: string; writtenByAgent: boolean; memberId: string
}) {
  const scope = agentScope(input)
  return db.transaction(async (tx) => {
    const context = await lockRoutineRun(tx, input)
    if (!context?.owner || context.memberId !== normalizeDenTypeId("member", input.memberId)) return false
    const { run, routine } = context
    if (input.writtenByAgent ? !["claimed", "running"].includes(run.status) : run.status !== "succeeded") return false
    const where = and(statesOfAgent(scope), eq(PersonalAgentRoutineStateTable.automation_id, routine.id))
    const [current] = await tx.select({ runId: PersonalAgentRoutineStateTable.run_id, writtenByAgent: PersonalAgentRoutineStateTable.written_by_agent })
      .from(PersonalAgentRoutineStateTable).where(where).limit(1).for("update")
    if (!input.writtenByAgent && current?.runId === run.id && current.writtenByAgent) return false
    if (current && current.runId !== run.id) {
      const [previousRun] = await tx.select({ createdAt: AutomationRunTable.created_at }).from(AutomationRunTable)
        .where(eq(AutomationRunTable.id, current.runId)).limit(1).for("share")
      if (previousRun && previousRun.createdAt >= run.created_at) return false
    }
    const changes = {
      run_id: run.id, state: input.state.slice(0, PERSONAL_AGENT_ROUTINE_STATE_MAX_LENGTH),
      written_by_agent: input.writtenByAgent, updated_at: new Date(),
    }
    if (current) await tx.update(PersonalAgentRoutineStateTable).set(changes).where(where)
    else await tx.insert(PersonalAgentRoutineStateTable).values({ ...changes, automation_id: routine.id, agent_id: scope.agentId, organization_id: scope.organizationId })
    return true
  })
}
