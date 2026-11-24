import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  CapabilityUsageEventTable,
  CapabilityUsageRollupTable,
  GatewayProviderTable,
  InvitationTable,
  LlmProviderTable,
  MemberTable,
  TelemetryEventTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ActivationClientEvent, ActivationEventRequest } from "@openwork/types/den/activation"
import { computeActivationState, type ActivationFacts } from "./activation-steps.js"
import { calculateDesktopPolicyForOrgMember } from "./desktop-policies.js"
import { db } from "./db.js"
import { organizationFeatureEnabled } from "./features.js"
import type { MemberTeamSummary, OrganizationContext } from "./orgs.js"
import { roleIncludesOwner } from "./organization-member-guards.js"
import { resolveMemberPermissionsFromContext } from "./permissions/resolve.js"
import { listMemberUsableConnectionFacts } from "./routes/org/mcp-connections.js"
import { stableTelemetryEventId } from "./workbot/telemetry.js"

const CLIENT_EVENT_TYPES: Record<ActivationClientEvent, string> = {
  first_response: "activation.first_response",
  use_skill: "activation.use_skill",
  own_provider: "activation.own_provider",
  connector: "activation.connector",
  dismiss: "activation.dismissed",
}
const ACTIVATION_EVENT_KEY = "once"
const ANSWER_EVENT_TYPES = ["task.completed", "workbot.turn_completed"]

type Actor = { organizationId: string; memberId: string }

function eventId(actor: Actor, type: string) {
  return stableTelemetryEventId(actor, type, ACTIVATION_EVENT_KEY)
}

export async function recordActivationEvent(actor: Actor & { userId: string }, event: ActivationEventRequest, source: "app" | "workbot") {
  if (event.step === "connector" && !(await organizationFeatureEnabled(actor.organizationId, "activationLocalSetup", { userId: actor.userId }))) return
  const type = CLIENT_EVENT_TYPES[event.step]
  await db.insert(TelemetryEventTable).values({
    id: eventId(actor, type),
    org_id: normalizeDenTypeId("organization", actor.organizationId),
    member_id: normalizeDenTypeId("member", actor.memberId),
    event_type: type,
    event_timestamp: new Date(),
    source,
    session_id: null,
    duration_ms: event.step === "first_response" ? event.durationMs ?? null : null,
    success: true,
  }).onDuplicateKeyUpdate({ set: { id: sql`${TelemetryEventTable.id}` } })
}

export async function readActivationFacts(input: { organizationContext: OrganizationContext; memberTeams: MemberTeamSummary[] }): Promise<ActivationFacts> {
  const { organizationContext, memberTeams } = input
  const organizationId = organizationContext.organization.id
  const member = organizationContext.currentMember
  const actor = { organizationId, memberId: member.id }
  const reportedIds = Object.values(CLIENT_EVENT_TYPES).map((type) => eventId(actor, type))
  const now = new Date()

  const [localSetup, permissions, reported, others, pending, invitedByMe, owners, gatewayProvider, addedProvider, connections, desktopPolicy, orgProvider] = await Promise.all([
    organizationFeatureEnabled(organizationId, "activationLocalSetup", { userId: member.userId }),
    resolveMemberPermissionsFromContext(organizationContext, memberTeams.map((team) => team.id)),
    db.select({ type: TelemetryEventTable.event_type, durationMs: TelemetryEventTable.duration_ms })
      .from(TelemetryEventTable)
      .where(inArray(TelemetryEventTable.id, reportedIds)),
    db.select({ value: count() }).from(MemberTable).where(and(
      eq(MemberTable.organizationId, organizationId),
      isNull(MemberTable.removedAt),
      eq(MemberTable.isSetupAgent, false),
      ne(MemberTable.id, member.id),
    )),
    db.select({ value: count() }).from(InvitationTable).where(and(
      eq(InvitationTable.organizationId, organizationId),
      eq(InvitationTable.status, "pending"),
      gt(InvitationTable.expiresAt, now),
    )),
    db.select({ value: count() }).from(InvitationTable).where(and(
      eq(InvitationTable.organizationId, organizationId),
      eq(InvitationTable.inviterId, member.userId),
      or(eq(InvitationTable.status, "accepted"), and(eq(InvitationTable.status, "pending"), gt(InvitationTable.expiresAt, now))),
    )),
    db.select({ role: MemberTable.role, name: AuthUserTable.name })
      .from(MemberTable)
      .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(and(eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt), sql`${MemberTable.role} like ${"%owner%"}`))
      .orderBy(asc(MemberTable.createdAt))
      .limit(5),
    db.select({ name: GatewayProviderTable.name }).from(GatewayProviderTable)
      .where(and(eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
      .orderBy(asc(GatewayProviderTable.created_at))
      .limit(1),
    db.select({ name: LlmProviderTable.name }).from(LlmProviderTable)
      .where(and(eq(LlmProviderTable.organizationId, organizationId), eq(LlmProviderTable.createdByOrgMembershipId, member.id), ne(LlmProviderTable.source, "openwork")))
      .orderBy(asc(LlmProviderTable.createdAt))
      .limit(1),
    listMemberUsableConnectionFacts({ context: { organizationContext, memberTeams, session: null } }).catch(() => []),
    calculateDesktopPolicyForOrgMember({ organizationId, orgMemberId: member.id }),
    db.select({ id: LlmProviderTable.id }).from(LlmProviderTable)
      .where(eq(LlmProviderTable.organizationId, organizationId))
      .limit(1),
  ])

  const reportedType = (step: ActivationClientEvent) => reported.find((row) => row.type === CLIENT_EVENT_TYPES[step])
  const firstAnswer = reportedType("first_response")
  const answered = firstAnswer ? true : (await db.select({ id: TelemetryEventTable.id }).from(TelemetryEventTable).where(and(
    eq(TelemetryEventTable.org_id, organizationId),
    eq(TelemetryEventTable.member_id, member.id),
    inArray(TelemetryEventTable.event_type, ANSWER_EVENT_TYPES),
  )).limit(1)).length > 0
  const skillUsed = Boolean(reportedType("use_skill")) || (await Promise.all([
    db.select({ id: CapabilityUsageEventTable.id }).from(CapabilityUsageEventTable).where(and(
      eq(CapabilityUsageEventTable.organization_id, organizationId),
      eq(CapabilityUsageEventTable.org_membership_id, member.id),
      eq(CapabilityUsageEventTable.kind, "skill"),
    )).limit(1),
    db.select({ id: CapabilityUsageRollupTable.id }).from(CapabilityUsageRollupTable).where(and(
      eq(CapabilityUsageRollupTable.organization_id, organizationId),
      eq(CapabilityUsageRollupTable.org_membership_id, member.id),
      eq(CapabilityUsageRollupTable.kind, "skill"),
    )).limit(1),
  ])).some((rows) => rows.length > 0)
  const ready = connections.find((fact) => fact.setupRequired !== true && fact.connectedForMe && !fact.needsReconnect)
  const teammates = Number(others[0]?.value ?? 0)
  const pendingCount = Number(pending[0]?.value ?? 0)

  return {
    firstResponse: { done: answered, durationMs: firstAnswer?.durationMs ?? null },
    invite: {
      canInvite: permissions.has("invitations.manage"),
      invitedByMe: Number(invitedByMe[0]?.value ?? 0),
      teammates: teammates + pendingCount,
      joined: teammates + 1,
      pending: pendingCount,
    },
    skillUsed,
    ownProvider: {
      reportedOnDevice: Boolean(reportedType("own_provider")),
      addedProviderName: addedProvider[0]?.name ?? null,
      orgProvided: orgProvider.length > 0,
      canConfigure: desktopPolicy.allowCustomProviders !== false,
    },
    gateway: {
      canManage: permissions.has("gateway_providers.manage"),
      hasProvider: gatewayProvider.length > 0,
      providerName: permissions.has("gateway_providers.view") ? gatewayProvider[0]?.name ?? null : null,
    },
    readyConnectionName: ready?.name ?? null,
    connectionOnDevice: Boolean(reportedType("connector")),
    localSetup,
    ownerName: owners.find((row) => roleIncludesOwner(row.role))?.name ?? null,
    dismissed: Boolean(reportedType("dismiss")),
  }
}

export { computeActivationState, type ActivationFacts }

export async function readActivationState(input: { organizationContext: OrganizationContext; memberTeams: MemberTeamSummary[] }) {
  return computeActivationState(await readActivationFacts(input))
}
