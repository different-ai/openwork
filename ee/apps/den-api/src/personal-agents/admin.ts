import { and, asc, desc, eq, inArray, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, AutomationRunTable, AutomationTable, MemberTable, PersonalAgentOrgPolicyTable, PersonalAgentRevisionTable, PersonalAgentRoutineStateTable, PersonalAgentShareTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { personalAgentToolPolicyBlocks } from "@openwork/automations"
import {
  EMPTY_PERSONAL_AGENT_TOOL_POLICY,
  PERSONAL_AGENT_TOOL_POLICY_MAX_SCOPE_CHARACTERS,
  type PersonalAgentAdminItem,
  type PersonalAgentAdminList,
  type PersonalAgentEventDetail,
  type PersonalAgentOrgPolicy,
  type PersonalAgentShare,
  type PersonalAgentToolPolicy,
  type SetPersonalAgentAudience,
  type SetPersonalAgentOrgPolicy,
} from "@openwork/types/den/personal-agents"
import { getExternalMcpConnection } from "../capability-sources/external-mcp-connections.js"
import { db } from "../db.js"
import { invalidateOrganizationWrittenToolRules, readSubjectToolPolicies, replaceSubjectToolPolicy, writeOrganizationWrittenToolRules } from "../tool-permissions/rules.js"
import { personalAgentOrganizationRules } from "./org-rules.js"
import { agentToolLimitScopes } from "../mcp/workbot-turn-limits.js"
import { peopleMemberCondition } from "../setup-agent-members.js"
import { personalAgentPeople, personOrUnknown, type PersonalAgentCaller } from "./access.js"
import { EMPTY_PERSONAL_AGENT_AUDIENCE, personalAgentAudiences, replacePersonalAgentAudience } from "./audience.js"
import { deletePersonalAgentLoans } from "./share-cleanup.js"
import { listPersonalAgentEvents, recordPersonalAgentEvent, type PersonalAgentEventAction } from "./events.js"
import { personalAgentRepository } from "./repository.js"
import { personalAgentRoutineSummaries } from "./routine-summaries.js"
import { personalAgentSpend } from "./spend.js"

export class PersonalAgentAdminInputError extends Error {}

type AgentRow = typeof PersonalAgentTable.$inferSelect

type AdminChange = { kind: "pause" } | { kind: "resume" }
  | { kind: "budget"; monthlyBudgetMicros: number | null }
  | { kind: "transfer"; memberId: string }

type AdminEvent = { action: PersonalAgentEventAction; detail?: PersonalAgentEventDetail }

function agentFilter(organizationId: string, agentId: string) {
  return and(
    eq(PersonalAgentTable.organization_id, normalizeDenTypeId("organization", organizationId)),
    eq(PersonalAgentTable.id, normalizeDenTypeId("personalAgent", agentId)),
  )
}

async function findAgent(organizationId: string, agentId: string): Promise<AgentRow | undefined> {
  if (!isDenTypeId("personalAgent", agentId)) return undefined
  const [agent] = await db.$primary.select().from(PersonalAgentTable).where(agentFilter(organizationId, agentId)).limit(1)
  return agent
}

function writeAccess(policy: PersonalAgentToolPolicy): PersonalAgentAdminItem["writeAccess"] {
  const counts = { allowed: 0, ask: 0, blocked: 0 }
  for (const access of Object.values(policy.connections)) {
    if (access === "block") counts.blocked += 1
  }
  for (const tools of Object.values(policy.tools)) {
    for (const access of Object.values(tools)) {
      if (access === "allow") counts.allowed += 1
      if (access === "ask") counts.ask += 1
      if (access === "block") counts.blocked += 1
    }
  }
  return counts
}

async function latestRunOfAnyone(routineIds: readonly string[]): Promise<Map<string, PersonalAgentAdminItem["routines"][number]["latestRun"]>> {
  const latest = new Map<string, PersonalAgentAdminItem["routines"][number]["latestRun"]>()
  for (const routineId of routineIds) {
    if (!isDenTypeId("automation", routineId)) continue
    const [run] = await db.$primary.select({
      id: AutomationRunTable.id,
      status: AutomationRunTable.status,
      createdAt: AutomationRunTable.created_at,
      finishedAt: AutomationRunTable.finished_at,
    }).from(AutomationRunTable).where(eq(AutomationRunTable.automation_id, normalizeDenTypeId("automation", routineId)))
      .orderBy(desc(AutomationRunTable.created_at), desc(AutomationRunTable.id)).limit(1)
    latest.set(routineId, run ? { id: run.id, status: run.status, createdAt: run.createdAt.getTime(), finishedAt: run.finishedAt?.getTime() ?? null } : null)
  }
  return latest
}

async function adminItems(organizationId: string, agents: AgentRow[]): Promise<PersonalAgentAdminItem[]> {
  if (agents.length === 0) return []
  const agentIds = agents.map((agent) => agent.id)
  const [revisions, shares, routines, audiences, toolPolicies] = await Promise.all([
    db.$primary.select({
      id: PersonalAgentRevisionTable.id,
      monthlyBudgetMicros: PersonalAgentRevisionTable.monthly_budget_micros,
    }).from(PersonalAgentRevisionTable).where(inArray(PersonalAgentRevisionTable.id, agents.map((agent) => agent.current_revision_id))),
    db.$primary.select().from(PersonalAgentShareTable).where(and(
      eq(PersonalAgentShareTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      inArray(PersonalAgentShareTable.agent_id, agentIds),
    )).orderBy(asc(PersonalAgentShareTable.created_at), asc(PersonalAgentShareTable.id)),
    personalAgentRoutineSummaries(agentIds),
    personalAgentAudiences(organizationId, agentIds),
    readSubjectToolPolicies(organizationId, "agent", agentIds),
  ])
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]))
  const lastRuns = await latestRunOfAnyone([...routines.values()].flatMap((list) => list.map((routine) => routine.id)))
  const [people, spend] = await Promise.all([
    personalAgentPeople(organizationId, [...agents.map((agent) => agent.owner_member_id), ...shares.map((share) => share.member_id)]),
    personalAgentSpend(organizationId, agents.map((agent) => ({
      agentId: agent.id,
      ownerBudgetMicros: revisionById.get(agent.current_revision_id)?.monthlyBudgetMicros ?? null,
      adminBudgetMicros: agent.admin_monthly_budget_micros,
    }))),
  ])
  const sharedWith = new Map<string, PersonalAgentShare[]>()
  for (const share of shares) {
    let entries = sharedWith.get(share.agent_id)
    if (!entries) sharedWith.set(share.agent_id, entries = [])
    entries.push({ ...personOrUnknown(people, share.member_id), role: share.role, createdAt: share.created_at.getTime() })
  }
  return agents.map((agent) => {
    const agentSpend = spend.get(agent.id)
    if (!agentSpend) throw new Error("personal_agent_spend_missing")
    return {
      agent: {
        id: agent.id,
        organizationId: agent.organization_id,
        ownerMemberId: agent.owner_member_id,
        name: agent.name,
        state: agent.state,
        currentRevisionId: agent.current_revision_id,
        createdAt: agent.created_at.getTime(),
        updatedAt: agent.updated_at.getTime(),
        archivedAt: agent.archived_at?.getTime() ?? null,
        pausedAt: agent.paused_at?.getTime() ?? null,
      },
      owner: personOrUnknown(people, agent.owner_member_id),
      sharedWith: sharedWith.get(agent.id) ?? [],
      audience: audiences.get(agent.id) ?? EMPTY_PERSONAL_AGENT_AUDIENCE,
      writeAccess: writeAccess(toolPolicies.get(agent.id) ?? EMPTY_PERSONAL_AGENT_TOOL_POLICY),
      spend: agentSpend,
      routines: (routines.get(agent.id) ?? []).map((routine) => ({ ...routine, latestRun: lastRuns.get(routine.id) ?? null })),
    }
  })
}

export async function listAdminPersonalAgents(organizationId: string): Promise<PersonalAgentAdminList> {
  const [agents, policy] = await Promise.all([
    db.$primary.select().from(PersonalAgentTable).where(and(
      eq(PersonalAgentTable.organization_id, normalizeDenTypeId("organization", organizationId)),
      eq(PersonalAgentTable.state, "active"),
    )).orderBy(desc(PersonalAgentTable.created_at), desc(PersonalAgentTable.id)).limit(200),
    getAdminPersonalAgentPolicy(organizationId),
  ])
  const items = await adminItems(organizationId, agents)
  return { items, policy, monthMicros: items.reduce((total, item) => total + item.spend.monthMicros, 0) }
}

export async function changeAdminPersonalAgent(caller: PersonalAgentCaller, agentId: string, change: AdminChange) {
  if (!isDenTypeId("personalAgent", agentId)) return undefined
  const { organizationId, memberId } = caller
  const filter = agentFilter(organizationId, agentId)
  const result = await db.transaction(async (tx): Promise<{ agent: AgentRow; event?: AdminEvent } | undefined> => {
    const [agent] = await tx.select().from(PersonalAgentTable).where(filter).limit(1).for("update")
    if (!agent || agent.state === "archived") return undefined
    const now = new Date()
    if (change.kind === "pause" || change.kind === "resume") {
      const pause = change.kind === "pause"
      if (pause === (agent.paused_at !== null)) return { agent }
      const patch = {
        paused_at: pause ? now : null,
        paused_by_member_id: pause ? normalizeDenTypeId("member", memberId) : null,
        updated_at: now,
      }
      await tx.update(PersonalAgentTable).set(patch).where(filter)
      return { agent: { ...agent, ...patch }, event: { action: pause ? "agent.paused" : "agent.resumed" } }
    }
    if (change.kind === "budget") {
      const patch = { admin_monthly_budget_micros: change.monthlyBudgetMicros, updated_at: now }
      await tx.update(PersonalAgentTable).set(patch).where(filter)
      return { agent: { ...agent, ...patch }, event: { action: "agent.budget_set", detail: { monthlyBudgetMicros: change.monthlyBudgetMicros } } }
    }
    const invalidOwner = () => new PersonalAgentAdminInputError("Choose a person who is a member of this organization.")
    if (!isDenTypeId("member", change.memberId)) throw invalidOwner()
    const newOwnerId = normalizeDenTypeId("member", change.memberId)
    const [newOwner] = await tx.select({ name: AuthUserTable.name }).from(MemberTable)
      .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.id, newOwnerId), eq(MemberTable.organizationId, agent.organization_id), peopleMemberCondition(), isNotNull(MemberTable.userId)))
      .limit(1).for("update")
    if (!newOwner) throw invalidOwner()
    if (agent.owner_member_id === newOwnerId) return { agent }
    const [oldOwner] = await tx.select({ name: AuthUserTable.name }).from(MemberTable)
      .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.id, agent.owner_member_id), eq(MemberTable.organizationId, agent.organization_id))).limit(1)
    const patch = { owner_member_id: newOwnerId, updated_at: now }
    const routines = and(eq(AutomationTable.organization_id, agent.organization_id), eq(AutomationTable.agent_id, agent.id))
    await tx.update(AutomationTable).set(patch).where(routines)
    await tx.update(AutomationRunTable).set({ acting_member_id: agent.owner_member_id }).where(and(
      isNull(AutomationRunTable.acting_member_id),
      inArray(AutomationRunTable.automation_id, tx.select({ id: AutomationTable.id }).from(AutomationTable).where(routines)),
    ))
    await tx.update(PersonalAgentTable).set(patch).where(filter)
    await tx.delete(PersonalAgentRoutineStateTable).where(and(
      eq(PersonalAgentRoutineStateTable.organization_id, agent.organization_id), eq(PersonalAgentRoutineStateTable.agent_id, agent.id),
    ))
    await tx.delete(PersonalAgentShareTable).where(and(
      eq(PersonalAgentShareTable.organization_id, agent.organization_id), eq(PersonalAgentShareTable.agent_id, agent.id),
      eq(PersonalAgentShareTable.member_id, newOwnerId),
    ))
    const [oldOwnerShare] = await tx.select({ role: PersonalAgentShareTable.role }).from(PersonalAgentShareTable).where(and(
      eq(PersonalAgentShareTable.agent_id, agent.id), eq(PersonalAgentShareTable.member_id, agent.owner_member_id))).limit(1)
    if (oldOwnerShare?.role !== "manager") await deletePersonalAgentLoans(tx, agent.organization_id, agent.owner_member_id, agent.id)
    return { agent: { ...agent, ...patch }, event: { action: "agent.transferred", detail: { from: oldOwner?.name ?? "Someone who left", to: newOwner.name } } }
  })
  if (!result) return undefined
  if (result.event) await recordPersonalAgentEvent({ organizationId, agentId, actorMemberId: memberId, ...result.event })
  const [item] = await adminItems(organizationId, [result.agent])
  return item
}

export async function archiveAdminPersonalAgent({ organizationId, memberId }: PersonalAgentCaller, agentId: string) {
  const agent = await findAgent(organizationId, agentId)
  if (!agent) return undefined
  if (agent.state !== "archived") {
    const archived = await personalAgentRepository.archive({ organizationId, agentId: agent.id, ownerMemberId: agent.owner_member_id, now: Date.now(), adminMemberId: memberId })
    if (!archived) return undefined
  }
  const row = await findAgent(organizationId, agent.id)
  if (!row) return undefined
  const [item] = await adminItems(organizationId, [row])
  return item
}

export async function setAdminPersonalAgentAudience(caller: PersonalAgentCaller, agentId: string, input: SetPersonalAgentAudience): Promise<PersonalAgentAdminItem | undefined> {
  const agent = await replacePersonalAgentAudience(caller, agentId, input, "admin")
  if (!agent) return undefined
  const [item] = await adminItems(caller.organizationId, [agent])
  return item
}

export async function getAdminPersonalAgentPolicy(organizationId: string): Promise<PersonalAgentOrgPolicy> {
  return personalAgentOrganizationRules(organizationId, { fresh: true })
}

async function organizationToolPolicy(organizationId: string, policy: PersonalAgentToolPolicy): Promise<PersonalAgentToolPolicy> {
  if (Object.values(policy.connections).some((access) => access !== "block")) {
    throw new PersonalAgentAdminInputError("A whole connection can only be blocked. Choose individual tools to allow them or ask first.")
  }
  const canonicalIds = new Map<string, string>()
  const invalidConnection = () => new PersonalAgentAdminInputError("Choose a connection added to this organization. Built-in connections cannot be blocked here.")
  for (const connectionId of new Set([...Object.keys(policy.connections), ...Object.keys(policy.tools)])) {
    if (!isDenTypeId("externalMcpConnection", connectionId)) throw invalidConnection()
    const connection = await getExternalMcpConnection({
      organizationId: normalizeDenTypeId("organization", organizationId),
      connectionId: normalizeDenTypeId("externalMcpConnection", connectionId),
    })
    if (!connection || connection.kind !== "external_mcp") throw invalidConnection()
    canonicalIds.set(connectionId, connection.id)
  }
  const canonical = (connectionId: string) => canonicalIds.get(connectionId) ?? connectionId
  const connections: PersonalAgentToolPolicy["connections"] = {}
  for (const [id, access] of Object.entries(policy.connections)) connections[canonical(id)] = access
  const tools: PersonalAgentToolPolicy["tools"] = {}
  for (const [id, entries] of Object.entries(policy.tools)) tools[canonical(id)] = { ...tools[canonical(id)], ...entries }
  if (JSON.stringify(agentToolLimitScopes(personalAgentToolPolicyBlocks({ connections, tools }))).length > PERSONAL_AGENT_TOOL_POLICY_MAX_SCOPE_CHARACTERS) {
    throw new PersonalAgentAdminInputError("This policy blocks too many individual tools. Block the whole connection instead.")
  }
  return { connections, tools }
}

export async function setAdminPersonalAgentPolicy({ organizationId, memberId }: PersonalAgentCaller, change: SetPersonalAgentOrgPolicy) {
  const toolPolicy = change.toolPolicy && await organizationToolPolicy(organizationId, change.toolPolicy)
  const updatedBy = normalizeDenTypeId("member", memberId)
  const rules = change.rules?.trim()
  const orgId = normalizeDenTypeId("organization", organizationId)
  await db.transaction(async (tx) => {
    if (toolPolicy) await replaceSubjectToolPolicy({ organizationId: orgId, kind: "organization", id: orgId }, toolPolicy, updatedBy, tx)
    if (rules !== undefined) await writeOrganizationWrittenToolRules(orgId, rules, updatedBy, tx)
    await tx.insert(PersonalAgentOrgPolicyTable).values({
      organization_id: normalizeDenTypeId("organization", organizationId),
      monthly_budget_micros: change.monthlyBudgetMicros ?? null,
      share_mode: change.shareMode,
      shared_logins: change.sharedLogins,
      updated_by_member_id: updatedBy,
    }).onDuplicateKeyUpdate({ set: {
      monthly_budget_micros: change.monthlyBudgetMicros,
      share_mode: change.shareMode,
      shared_logins: change.sharedLogins,
      updated_by_member_id: updatedBy,
      updated_at: new Date(),
    } })
    if (change.sharedLogins === false) await deletePersonalAgentLoans(tx, normalizeDenTypeId("organization", organizationId))
  })
  if (rules !== undefined) invalidateOrganizationWrittenToolRules(orgId)
  const event = { organizationId, agentId: null, actorMemberId: memberId }
  if (toolPolicy) await recordPersonalAgentEvent({ ...event, action: "organization.tools_changed", detail: {
    blockedTools: Object.values(toolPolicy.tools).reduce((total, tools) => total + Object.values(tools).filter((access) => access === "block").length, 0),
    blockedConnections: Object.keys(toolPolicy.connections).length,
  } })
  if (change.shareMode !== undefined) await recordPersonalAgentEvent({
    ...event, action: "organization.sharing_changed", detail: { shareMode: change.shareMode },
  })
  if (change.sharedLogins !== undefined) await recordPersonalAgentEvent({
    ...event, action: "organization.shared_logins_changed", detail: { on: change.sharedLogins },
  })
  if (rules !== undefined) await recordPersonalAgentEvent({
    ...event, action: "organization.rules_changed",
  })
  if (change.monthlyBudgetMicros !== undefined) await recordPersonalAgentEvent({
    ...event, action: "organization.budget_set", detail: { monthlyBudgetMicros: change.monthlyBudgetMicros },
  })
  return getAdminPersonalAgentPolicy(organizationId)
}

export async function listAdminPersonalAgentEvents(organizationId: string, query: { limit: number; agentId?: string }) {
  if (query.agentId !== undefined && !await findAgent(organizationId, query.agentId)) return undefined
  return { items: await listPersonalAgentEvents({ organizationId, ...query }) }
}
