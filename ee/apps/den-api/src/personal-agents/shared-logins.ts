import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, PersonalAgentOrgPolicyTable, PersonalAgentShareTable, PersonalAgentSharedLoginTable, PersonalAgentTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { externalMcpConnectionReadyForMember, getExternalMcpConnection, memberCanUseExternalMcpConnection, type ExternalMcpConnectionRow } from "../capability-sources/external-mcp-connections.js"
import { db } from "../db.js"
import { listTeamsForMember } from "../member-teams.js"
import { personalAgentRunId } from "../mcp/workbot-turn-limits.js"
import { withPrimaryReads } from "../read-routing.js"
import { activePersonalAgentMember, canManagePersonalAgent, personalAgentAccess, personalAgentPeople, personOrUnknown, type PersonalAgentAccess, type PersonalAgentCaller } from "./access.js"
import { recordPersonalAgentEvent } from "./events.js"
import { personalAgentOrgPolicy } from "./permissions-policy.js"
import { personalAgentDispatchContext } from "./permissions-dispatch.js"

export function supportsPersonalAgentSharedLogin(connection: ExternalMcpConnectionRow): boolean {
  return connection.kind === "external_mcp" && connection.credentialMode === "per_member" && connection.authType !== "none"
}

function loginScope(organizationId: string, agentId: string) {
  return and(
    eq(PersonalAgentSharedLoginTable.organization_id, normalizeDenTypeId("organization", organizationId)),
    eq(PersonalAgentSharedLoginTable.agent_id, normalizeDenTypeId("personalAgent", agentId)),
  )
}

export async function personalAgentSharedLogins(organizationId: string, agentId: string) {
  const rows = await db.$primary.select().from(PersonalAgentSharedLoginTable).where(loginScope(organizationId, agentId))
  return new Map(rows.map((row) => [row.connection_id, row.member_id]))
}

async function memberHasConnection(connection: ExternalMcpConnectionRow, memberId: DenTypeId<"member">) {
  const organizationId = connection.organizationId
  const teams = await listTeamsForMember({ organizationId, memberId })
  return memberCanUseExternalMcpConnection({ connectionId: connection.id, orgMembershipId: memberId, teamIds: teams.map((team) => team.id) })
}

export async function setPersonalAgentSharedLogin(caller: PersonalAgentCaller, access: PersonalAgentAccess, connectionId: string, shared: boolean): Promise<void> {
  const organizationId = normalizeDenTypeId("organization", caller.organizationId)
  const agentId = normalizeDenTypeId("personalAgent", access.agentId)
  const memberId = normalizeDenTypeId("member", caller.memberId)
  if (!shared) {
    if (!isDenTypeId("externalMcpConnection", connectionId)) return
    const changed = await db.transaction(async (tx) => {
      const [agent] = await tx.select({ owner: PersonalAgentTable.owner_member_id }).from(PersonalAgentTable).where(and(
        eq(PersonalAgentTable.id, agentId), eq(PersonalAgentTable.organization_id, organizationId))).limit(1).for("update")
      const condition = and(loginScope(organizationId, agentId), eq(PersonalAgentSharedLoginTable.connection_id, normalizeDenTypeId("externalMcpConnection", connectionId)))
      const [existing] = await tx.select().from(PersonalAgentSharedLoginTable).where(condition).limit(1).for("update")
      if (!existing) return false
      if (existing.member_id !== memberId && agent?.owner !== memberId) throw new Error("personal_agent_forbidden")
      await tx.delete(PersonalAgentSharedLoginTable).where(condition)
      return true
    })
    if (changed) await recordPersonalAgentEvent({ organizationId, agentId, actorMemberId: memberId, action: "share.changed", detail: { what: "shared_login", on: false } })
    return
  }
  if (!canManagePersonalAgent(access.role) || access.state !== "active") throw new Error("personal_agent_forbidden")
  if (!(await personalAgentOrgPolicy(organizationId))?.shared_logins) throw new Error("personal_agent_shared_logins_off")
  if (!isDenTypeId("externalMcpConnection", connectionId)) throw new Error("personal_agent_shared_login_connection_unavailable")
  const connection = await withPrimaryReads(async () => {
    const row = await getExternalMcpConnection({ organizationId, connectionId: normalizeDenTypeId("externalMcpConnection", connectionId) })
    if (!row || !supportsPersonalAgentSharedLogin(row) || !await memberHasConnection(row, memberId)
      || !await externalMcpConnectionReadyForMember(row, memberId)) return null
    return row
  })
  if (!connection) throw new Error("personal_agent_shared_login_connection_unavailable")
  const condition = and(loginScope(organizationId, agentId), eq(PersonalAgentSharedLoginTable.connection_id, connection.id))
  const changed = await db.transaction(async (tx) => {
    const [agent] = await tx.select().from(PersonalAgentTable).where(eq(PersonalAgentTable.id, agentId)).for("update")
    const [member] = await tx.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.id, memberId),
      eq(MemberTable.organizationId, organizationId), activePersonalAgentMember())).limit(1).for("share")
    const [share] = await tx.select({ role: PersonalAgentShareTable.role }).from(PersonalAgentShareTable)
      .where(and(eq(PersonalAgentShareTable.agent_id, agentId), eq(PersonalAgentShareTable.member_id, memberId))).limit(1)
    if (!member || agent?.state !== "active" || (agent.owner_member_id !== memberId && share?.role !== "manager")) throw new Error("personal_agent_forbidden")
    const [policy] = await tx.select({ shared: PersonalAgentOrgPolicyTable.shared_logins }).from(PersonalAgentOrgPolicyTable)
      .where(eq(PersonalAgentOrgPolicyTable.organization_id, organizationId)).limit(1).for("share")
    if (!policy?.shared) throw new Error("personal_agent_shared_logins_off")
    const [existing] = await tx.select().from(PersonalAgentSharedLoginTable).where(condition).limit(1)
    if (existing?.member_id === memberId) return false
    if (existing) await tx.update(PersonalAgentSharedLoginTable).set({ member_id: memberId }).where(condition)
    else await tx.insert(PersonalAgentSharedLoginTable).values({ id: createDenTypeId("personalAgentSharedLogin"), organization_id: organizationId, agent_id: agentId, connection_id: connection.id, member_id: memberId })
    return true
  })
  if (changed) await recordPersonalAgentEvent({ organizationId, agentId, actorMemberId: memberId, action: "share.changed", detail: { what: "shared_login", connection: connection.name.slice(0, 160), on: shared } })
}

export async function personalAgentCredentialMember(input: {
  scopes?: ReadonlySet<string>
  connection: ExternalMcpConnectionRow
  actingMemberId: DenTypeId<"member">
}): Promise<DenTypeId<"member">> {
  const { connection, actingMemberId } = input
  const runId = input.scopes && personalAgentRunId(input.scopes)
  if (!runId || !supportsPersonalAgentSharedLogin(connection)) return actingMemberId
  const organizationId = connection.organizationId
  if (!(await personalAgentOrgPolicy(organizationId))?.shared_logins) return actingMemberId
  const context = await personalAgentDispatchContext(runId, organizationId, actingMemberId)
  if (!context || context.paused) return actingMemberId
  const [login] = await db.$primary.select({ memberId: PersonalAgentSharedLoginTable.member_id }).from(PersonalAgentSharedLoginTable)
    .innerJoin(MemberTable, and(eq(MemberTable.id, PersonalAgentSharedLoginTable.member_id), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt)))
    .where(and(loginScope(organizationId, context.agentId), eq(PersonalAgentSharedLoginTable.connection_id, connection.id))).limit(1)
  if (!login) return actingMemberId
  return await effectivePersonalAgentLogin(connection, context.agentId, login.memberId) ?? actingMemberId
}

export async function effectivePersonalAgentLogin(connection: ExternalMcpConnectionRow, agentId: string, memberId: DenTypeId<"member">) {
  if (!supportsPersonalAgentSharedLogin(connection)) return null
  const organizationId = connection.organizationId
  const [member] = await db.$primary.select({ id: MemberTable.id }).from(MemberTable).where(and(eq(MemberTable.id, memberId),
    eq(MemberTable.organizationId, organizationId), activePersonalAgentMember())).limit(1)
  if (!member) return null
  const access = await personalAgentAccess({ organizationId, memberId }, agentId, true)
  if (!access || access.state !== "active" || access.pausedAt !== null || !canManagePersonalAgent(access.role)) return null
  const ready = await withPrimaryReads(async () => await memberHasConnection(connection, memberId)
    && await externalMcpConnectionReadyForMember(connection, memberId))
  return ready ? memberId : null
}

export async function sharedLoginPerson(connection: ExternalMcpConnectionRow, agentId: string, memberId: DenTypeId<"member"> | undefined) {
  if (!memberId || !await effectivePersonalAgentLogin(connection, agentId, memberId)) return null
  return personOrUnknown(await personalAgentPeople(connection.organizationId, [memberId]), memberId)
}
