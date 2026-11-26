import { and, desc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { PersonalAgentEventTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { PersonalAgentChange, PersonalAgentEvent, PersonalAgentEventDetail } from "@openwork/types/den/personal-agents"
import { db } from "../db.js"
import { personalAgentPeople, personOrUnknown, type PersonalAgentTransaction } from "./access.js"

export type PersonalAgentEventAction =
  | "agent.created" | "agent.updated" | "agent.archived" | "agent.paused" | "agent.resumed" | "agent.transferred"
  | "agent.budget_set" | "agent.tools_changed"
  | "share.added" | "share.changed" | "share.removed"
  | "routine.created" | "routine.changed"
  | "memory.edited" | "memory.note_added"
  | "request.asked" | "request.denied" | "request.allowed_once" | "request.always_allowed" | "request.approved"
  | "organization.tools_changed" | "organization.budget_set"
  | "organization.sharing_changed" | "organization.shared_logins_changed" | "organization.rules_changed"

export function personalAgentRequestEventDetail(request: {
  requester: string
  kind: "tool" | "change"
  tool?: string | null
  connection?: string | null
  change?: PersonalAgentChange | null
}): PersonalAgentEventDetail {
  return {
    requester: request.requester.slice(0, 240),
    kind: request.kind,
    tool: request.tool ?? null,
    connection: request.connection ?? null,
    changes: request.change ? ["schedule", "instructions", "brief"].filter((field) => field in (request.change ?? {})).join(", ") : null,
  }
}

export async function recordPersonalAgentEvent(input: {
  organizationId: string
  agentId: string | null
  actorMemberId: string
  action: PersonalAgentEventAction
  detail?: PersonalAgentEventDetail
}, tx?: PersonalAgentTransaction): Promise<void> {
  await (tx ?? db).insert(PersonalAgentEventTable).values({
    id: createDenTypeId("personalAgentEvent"),
    organization_id: normalizeDenTypeId("organization", input.organizationId),
    agent_id: input.agentId && isDenTypeId("personalAgent", input.agentId) ? normalizeDenTypeId("personalAgent", input.agentId) : null,
    actor_member_id: normalizeDenTypeId("member", input.actorMemberId),
    action: input.action,
    detail: input.detail ?? {},
  })
}

export async function listPersonalAgentEvents(input: { organizationId: string; agentId?: string; limit: number }): Promise<PersonalAgentEvent[]> {
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const rows = await db.$primary.select().from(PersonalAgentEventTable).where(and(
    eq(PersonalAgentEventTable.organization_id, organizationId),
    input.agentId && isDenTypeId("personalAgent", input.agentId)
      ? eq(PersonalAgentEventTable.agent_id, normalizeDenTypeId("personalAgent", input.agentId))
      : undefined,
  )).orderBy(desc(PersonalAgentEventTable.created_at), desc(PersonalAgentEventTable.id)).limit(input.limit)
  const agentIds = [...new Set(rows.flatMap((row) => row.agent_id ? [row.agent_id] : []))]
  const agents = agentIds.length
    ? await db.$primary.select({ id: PersonalAgentTable.id, name: PersonalAgentTable.name }).from(PersonalAgentTable).where(inArray(PersonalAgentTable.id, agentIds))
    : []
  const names = new Map(agents.map((agent) => [agent.id, agent.name]))
  const people = await personalAgentPeople(input.organizationId, rows.map((row) => row.actor_member_id))
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_id ? names.get(row.agent_id) ?? null : null,
    actor: personOrUnknown(people, row.actor_member_id),
    action: row.action,
    detail: row.detail,
    createdAt: row.created_at.getTime(),
  }))
}
