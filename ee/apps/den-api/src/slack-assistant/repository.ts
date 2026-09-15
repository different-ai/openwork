import { randomUUID } from "node:crypto"
import { and, asc, desc, count, eq, gt, inArray, isNotNull, isNull, lt, lte, or } from "@openwork-ee/den-db/drizzle"
import {
  SlackAssistantInstallationTable as Installation,
  SlackAssistantIdentityTable as Identity,
  SlackAssistantEventTable as Event,
  SlackAssistantThreadTable as Thread,
  SlackAssistantOAuthStateTable as State,
  ExternalMcpConnectionTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../db.js"
import {
  getExternalMcpConnection,
  memberCanUseExternalMcpConnection,
  readConnectedAccountForExternalMcpIdentity,
  type ExternalMcpConnectionRow,
} from "../capability-sources/external-mcp-connections.js"
import { memberFacingMcpConnectionsEnabled } from "../capability-sources/external-mcp-rollout.js"
import { organizationHasCapability } from "../organization-capabilities.js"
import { getOpenWorkWebRuntimeAccess } from "../openwork-web-runtime-access.js"
import { listTeamsForMember } from "../orgs.js"
import { canUseSlackAssistant, scopeKey, slackClient, type SlackEvent } from "./protocol.js"

export type InstallationRow = typeof Installation.$inferSelect
export type EventRow = typeof Event.$inferSelect
export type ThreadRow = typeof Thread.$inferSelect
export async function getInstallation(connectionId: DenTypeId<"externalMcpConnection">) {
  return (await db.select().from(Installation).where(eq(Installation.connectionId, connectionId)).limit(1))[0] ?? null
}
export async function slackAssistantEnabledForInstallation(installation: InstallationRow) {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, installation.organizationId))
    .limit(1)
  return organizationHasCapability(organization?.metadata, "slackAssistant")
}
export function isSlackConnection(connection: ExternalMcpConnectionRow) {
  return (
    connection.credentialMode === "per_member" &&
    connection.authType === "oauth" &&
    connection.oauthIssuerReviewRequiredAt === null &&
    new URL(connection.url).hostname === "mcp.slack.com"
  )
}

// Called only after the member completes the existing user OAuth flow. MCP's
// oauth.v2.user.access has a standard token response; auth.test recovers the
// provider-authenticated user/team (the equivalent of oauth.v2.access's
// authed_user.id), never an email or an id supplied by the browser.
export async function bindSlackOAuthMember(
  connection: ExternalMcpConnectionRow,
  memberId: DenTypeId<"member">,
  client = slackClient,
) {
  if (!isSlackConnection(connection)) return
  const installation = await getInstallation(connection.id)
  if (!installation?.teamId) return
  const account = await readConnectedAccountForExternalMcpIdentity({ connection, orgMembershipId: memberId })
  if (!account.current || !account.value?.accessToken) return
  const actor = z
    .object({ user_id: z.string(), team_id: z.string(), bot_id: z.string().optional() })
    .parse(await client(account.value.accessToken)("auth.test", {}))
  if (actor.bot_id || actor.team_id !== installation.teamId) throw new Error("slack_assistant_wrong_workspace")
  await db.transaction(async (tx) => {
    // Share the connector deletion lock so a late OAuth callback cannot
    // recreate an identity after its connection has been removed.
    const [current] = await tx
      .select()
      .from(ExternalMcpConnectionTable)
      .where(eq(ExternalMcpConnectionTable.id, connection.id))
      .for("update")
    if (!current || !isSlackConnection(current)) throw new Error("slack_assistant_connection_changed")
    const [installed] = await tx
      .select()
      .from(Installation)
      .where(eq(Installation.connectionId, connection.id))
      .for("update")
    if (!installed || installed.teamId !== actor.team_id) throw new Error("slack_assistant_connection_changed")
    const existing = await tx
      .select()
      .from(Identity)
      .where(
        and(
          eq(Identity.connectionId, connection.id),
          eq(Identity.teamId, actor.team_id),
          eq(Identity.slackUserId, actor.user_id),
        ),
      )
      .for("update")
    if (existing[0] && existing[0].memberId !== memberId) throw new Error("slack_assistant_identity_already_bound")
    await tx.delete(Identity).where(and(eq(Identity.connectionId, connection.id), eq(Identity.memberId, memberId)))
    await tx.insert(Identity).values({
      id: scopeKey(connection.id, actor.team_id, actor.user_id),
      connectionId: connection.id,
      memberId,
      teamId: actor.team_id,
      slackUserId: actor.user_id,
    })
    await tx
      .update(Event)
      .set({ status: "pending", availableAt: new Date() })
      .where(
        and(
          eq(Event.connectionId, connection.id),
          eq(Event.teamId, actor.team_id),
          eq(Event.slackUserId, actor.user_id),
          eq(Event.status, "awaiting_link"),
          gt(Event.createdAt, new Date(Date.now() - 15 * 60_000)),
        ),
      )
  })
}

export async function resolveSlackActor(installation: InstallationRow, slackUserId: string) {
  const connection = await getExternalMcpConnection({
    organizationId: installation.organizationId,
    connectionId: installation.connectionId,
  })
  if (!connection || !isSlackConnection(connection)) return null
  const identities = await db
    .select()
    .from(Identity)
    .where(
      and(
        eq(Identity.connectionId, installation.connectionId),
        eq(Identity.teamId, installation.teamId ?? ""),
        eq(Identity.slackUserId, slackUserId),
      ),
    )
    .limit(1)
  const identity = identities[0]
  if (!identity) return null
  const members = await db
    .select()
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.id, identity.memberId),
        eq(MemberTable.organizationId, installation.organizationId),
        isNull(MemberTable.removedAt),
      ),
    )
    .limit(1)
  const member = members[0]
  if (!member?.userId) return null
  const [organizations, teams, account, access] = await Promise.all([
    db.select().from(OrganizationTable).where(eq(OrganizationTable.id, installation.organizationId)).limit(1),
    listTeamsForMember({ organizationId: installation.organizationId, memberId: member.id }),
    readConnectedAccountForExternalMcpIdentity({ connection, orgMembershipId: member.id }),
    getOpenWorkWebRuntimeAccess(installation.organizationId),
  ])
  const organization = organizations[0]
  const granted = await memberCanUseExternalMcpConnection({
    connectionId: connection.id,
    orgMembershipId: member.id,
    teamIds: teams.map((t) => t.id),
  })
  if (
    !organization ||
    !canUseSlackAssistant({
      capabilityEnabled: organizationHasCapability(organization.metadata, "slackAssistant"),
      enabled: installation.enabled,
      individualAccounts: true,
      mcpEnabled: memberFacingMcpConnectionsEnabled(organization.metadata, { gatingEnabled: true }),
      webAccess: access.hasAccess,
      activeMember: true,
      granted,
      connected: account.current && Boolean(account.value?.accessToken),
    }) ||
    !account.current ||
    !account.value?.accessToken
  )
    return null
  return {
    memberId: member.id,
    userId: member.userId,
    organizationId: organization.id,
    connection,
    userToken: account.value.accessToken,
  }
}
export type SlackActor = NonNullable<Awaited<ReturnType<typeof resolveSlackActor>>>

export async function enqueueSlackEvent(installation: InstallationRow, eventId: string, event: SlackEvent) {
  const id = scopeKey(installation.connectionId, eventId)
  return db.transaction(async (tx) => {
    // Serialize ingress quota admission per installed workspace. Retries are
    // checked first and do not consume the quota a second time.
    await tx
      .select({ id: Installation.connectionId })
      .from(Installation)
      .where(eq(Installation.connectionId, installation.connectionId))
      .for("update")
    const existing = (await tx.select({ id: Event.id }).from(Event).where(eq(Event.id, id)).limit(1))[0]
    if (existing) return existing.id
    const minute = new Date(Date.now() - 60_000)
    const [total] = await tx
      .select({ total: count() })
      .from(Event)
      .where(and(eq(Event.connectionId, installation.connectionId), gt(Event.createdAt, minute)))
    const [member] = await tx
      .select({ total: count() })
      .from(Event)
      .where(
        and(
          eq(Event.connectionId, installation.connectionId),
          eq(Event.slackUserId, event.user ?? ""),
          gt(Event.createdAt, minute),
        ),
      )
    const invocation = event.type === "app_mention" || event.type === "message"
    if (invocation && ((total?.total ?? 0) >= 120 || (member?.total ?? 0) >= 10)) return null
    await tx.insert(Event).values({
      id,
      connectionId: installation.connectionId,
      teamId: installation.teamId ?? "",
      slackUserId: event.user ?? "",
      channelId: event.channel ?? "",
      threadTs: event.thread_ts ?? event.ts ?? "",
      payload: JSON.stringify(event),
      createdAt: new Date(),
      availableAt: new Date(),
    })
    return id
  })
}

export async function claimSlackEvent(): Promise<EventRow | null> {
  return db.transaction(async (tx) => {
    const now = new Date()
    const rows = await tx
      .select()
      .from(Event)
      .where(
        and(
          inArray(Event.status, ["pending", "running"]),
          lte(Event.availableAt, now),
          or(isNull(Event.leaseUntil), lte(Event.leaseUntil, now)),
        ),
      )
      .orderBy(asc(Event.availableAt))
      .limit(1)
      .for("update", { skipLocked: true })
    const event = rows[0]
    if (!event) return null
    const leaseOwner = randomUUID()
    await tx
      .update(Event)
      .set({ leaseOwner, leaseUntil: new Date(Date.now() + 120_000) })
      .where(eq(Event.id, event.id))
    return { ...event, leaseOwner }
  })
}
export async function checkpointEvent(
  event: EventRow,
  changes: Partial<Pick<EventRow, "checkpoint" | "status" | "cancelled" | "attempts">>,
  delayMs = 0,
) {
  await db
    .update(Event)
    .set({ ...changes, availableAt: new Date(Date.now() + delayMs), leaseUntil: null, leaseOwner: null })
    .where(and(eq(Event.id, event.id), eq(Event.leaseOwner, event.leaseOwner ?? "")))
}
export async function lockSlackThread(event: EventRow, actor: SlackActor) {
  const id = scopeKey(event.connectionId, event.teamId, event.channelId, event.threadTs, actor.memberId)
  return db.transaction(async (tx) => {
    await tx
      .insert(Thread)
      .values({
        id,
        connectionId: event.connectionId,
        memberId: actor.memberId,
        channelId: event.channelId,
        threadTs: event.threadTs,
      })
      .onDuplicateKeyUpdate({ set: { id } })
    const thread = (await tx.select().from(Thread).where(eq(Thread.id, id)).for("update"))[0]
    if (!thread || (thread.activeEventId && thread.activeEventId !== event.id)) return null
    await tx.update(Thread).set({ activeEventId: event.id }).where(eq(Thread.id, id))
    return thread
  })
}
export async function releaseSlackThread(event: EventRow) {
  await renewSlackLease(event)
  await db.update(Thread).set({ activeEventId: null }).where(eq(Thread.activeEventId, event.id))
}
export async function saveSlackSession(threadId: string, sessionId: string, workspaceId: string) {
  await db.update(Thread).set({ sessionId, workspaceId }).where(eq(Thread.id, threadId))
}
export async function cancelSlackThread(installation: InstallationRow, event: SlackEvent) {
  if (!event.user || !event.channel || !event.thread_ts) return
  // Private replies may run in a DM while the source mention was in a channel.
  // Search only this signed actor's active events, then match source or output.
  const candidates = await db
    .select()
    .from(Event)
    .where(
      and(
        eq(Event.connectionId, installation.connectionId),
        eq(Event.slackUserId, event.user),
        inArray(Event.status, ["pending", "running"]),
      ),
    )
  for (const candidate of candidates) {
    const output = z
      .object({ channel: z.string().optional(), threadTs: z.string().optional() })
      .safeParse(candidate.checkpoint ? JSON.parse(candidate.checkpoint) : {})
    const matchesSource = candidate.channelId === event.channel && candidate.threadTs === event.thread_ts
    const matchesOutput =
      output.success && output.data.channel === event.channel && output.data.threadTs === event.thread_ts
    if (matchesSource || matchesOutput)
      await db.update(Event).set({ cancelled: true, availableAt: new Date() }).where(eq(Event.id, candidate.id))
  }
}
export async function revokeSlackInstallation(connectionId: DenTypeId<"externalMcpConnection">) {
  await db
    .update(Installation)
    .set({ enabled: false, botToken: null })
    .where(eq(Installation.connectionId, connectionId))
  await db.delete(Identity).where(eq(Identity.connectionId, connectionId))
  await db
    .update(Event)
    .set({ cancelled: true, availableAt: new Date() })
    .where(and(eq(Event.connectionId, connectionId), inArray(Event.status, ["pending", "running", "awaiting_link"])))
}

function updatedRows(result: unknown): number {
  if (Array.isArray(result)) return updatedRows(result[0])
  if (!result || typeof result !== "object") return 0
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return 0
}
export async function persistSlackCheckpoint(event: EventRow, checkpoint: unknown) {
  const serialized = JSON.stringify(checkpoint)
  const result = await db
    .update(Event)
    .set({ checkpoint: serialized, leaseUntil: new Date(Date.now() + 120_000) })
    .where(and(eq(Event.id, event.id), eq(Event.leaseOwner, event.leaseOwner ?? ""), gt(Event.leaseUntil, new Date())))
  if (!updatedRows(result)) throw new SlackLeaseLostError()
  event.checkpoint = serialized
}
export class SlackLeaseLostError extends Error {
  constructor() {
    super("slack_assistant_lease_lost")
  }
}
export async function renewSlackLease(event: EventRow) {
  const result = await db
    .update(Event)
    .set({ leaseUntil: new Date(Date.now() + 120_000) })
    .where(and(eq(Event.id, event.id), eq(Event.leaseOwner, event.leaseOwner ?? ""), gt(Event.leaseUntil, new Date())))
  if (!updatedRows(result)) throw new SlackLeaseLostError()
}
export async function removeSlackIdentities(connectionId: DenTypeId<"externalMcpConnection">, slackUserIds: string[]) {
  if (slackUserIds.length)
    await db
      .delete(Identity)
      .where(and(eq(Identity.connectionId, connectionId), inArray(Identity.slackUserId, slackUserIds)))
}
export async function findSlackThread(event: EventRow, actor: SlackActor) {
  return (
    (
      await db
        .select()
        .from(Thread)
        .where(
          eq(Thread.id, scopeKey(event.connectionId, event.teamId, event.channelId, event.threadTs, actor.memberId)),
        )
        .limit(1)
    )[0] ?? null
  )
}

export async function admitSlackRun(event: EventRow, installation: InstallationRow) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: Installation.connectionId })
      .from(Installation)
      .where(eq(Installation.connectionId, event.connectionId))
      .for("update")
    const current = (await tx.select({ status: Event.status }).from(Event).where(eq(Event.id, event.id)))[0]
    if (current?.status === "running") return true
    // A burst of terminal failures pauses new work for this installation;
    // already admitted runs can finish. The window expires automatically.
    const [failures] = await tx
      .select({ total: count() })
      .from(Event)
      .where(
        and(
          eq(Event.connectionId, event.connectionId),
          eq(Event.status, "failed"),
          gt(Event.availableAt, new Date(Date.now() - 300_000)),
        ),
      )
    if ((failures?.total ?? 0) >= 5) return false
    const [row] = await tx
      .select({ total: count() })
      .from(Event)
      .where(
        and(
          eq(Event.connectionId, event.connectionId),
          eq(Event.slackUserId, event.slackUserId),
          gt(Event.createdAt, new Date(Date.now() - 86_400_000)),
          or(eq(Event.status, "running"), and(inArray(Event.status, ["done", "failed"]), isNotNull(Event.checkpoint))),
        ),
      )
    if ((row?.total ?? 0) >= installation.dailyLimit) return false
    await tx.update(Event).set({ status: "running" }).where(eq(Event.id, event.id))
    return true
  })
}
export async function pruneSlackEvents() {
  await db.delete(State).where(lt(State.expiresAt, new Date()))
  await db.delete(Event).where(and(eq(Event.status, "context"), lt(Event.createdAt, new Date(Date.now() - 1_800_000))))
  await db
    .update(Event)
    .set({ status: "expired", payload: JSON.stringify({ type: "expired" }) })
    .where(and(eq(Event.status, "awaiting_link"), lt(Event.createdAt, new Date(Date.now() - 900_000))))
  // Retain encrypted run content for seven days, then remove it together with
  // its dedupe record. Native sessions follow the member's existing retention.
  await db
    .delete(Event)
    .where(
      and(
        inArray(Event.status, ["done", "failed", "expired", "feedback_positive", "feedback_negative"]),
        lt(Event.createdAt, new Date(Date.now() - 7 * 86_400_000)),
      ),
    )
}
export async function latestSlackContext(event: EventRow) {
  const rows = await db
    .select({ payload: Event.payload })
    .from(Event)
    .where(
      and(
        eq(Event.connectionId, event.connectionId),
        eq(Event.slackUserId, event.slackUserId),
        eq(Event.status, "context"),
        gt(Event.createdAt, new Date(Date.now() - 30 * 60_000)),
      ),
    )
    .orderBy(desc(Event.createdAt))
    .limit(1)
  return rows[0]?.payload ?? null
}

export async function slackAssistantMetrics(connectionId: DenTypeId<"externalMcpConnection">) {
  const rows = await db
    .select({ status: Event.status, checkpoint: Event.checkpoint, createdAt: Event.createdAt })
    .from(Event)
    .where(and(eq(Event.connectionId, connectionId), gt(Event.createdAt, new Date(Date.now() - 86_400_000))))
    .orderBy(desc(Event.createdAt))
    .limit(1000)
  const firstText: number[] = [],
    final: number[] = []
  let completed = 0
  for (const row of rows) {
    const cp = z
      .object({ firstTextAt: z.number().optional(), completedAt: z.number().optional() })
      .safeParse(row.checkpoint ? JSON.parse(row.checkpoint) : {})
    if (!cp.success) continue
    if (cp.data.firstTextAt) firstText.push(cp.data.firstTextAt - row.createdAt.getTime())
    if (cp.data.completedAt) {
      final.push(cp.data.completedAt - row.createdAt.getTime())
      completed++
    }
  }
  const median = (values: number[]) =>
    values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : null
  return {
    completed,
    failed: rows.filter((r) => r.status === "failed").length,
    active: rows.filter((r) => r.status === "running").length,
    awaitingConnection: rows.filter((r) => r.status === "awaiting_link").length,
    helpful: rows.filter((r) => r.status === "feedback_positive").length,
    needsWork: rows.filter((r) => r.status === "feedback_negative").length,
    firstTextMedianMs: median(firstText),
    finalMedianMs: median(final),
    sampledEvents: rows.length,
  }
}
export async function recordSlackFeedback(
  installation: InstallationRow,
  actor: string,
  eventId: string,
  value: "positive" | "negative",
) {
  const source = (
    await db
      .select()
      .from(Event)
      .where(
        and(eq(Event.id, eventId), eq(Event.connectionId, installation.connectionId), eq(Event.slackUserId, actor)),
      )
      .limit(1)
  )[0]
  if (!source) return false
  const id = scopeKey("feedback", source.id, actor)
  await db
    .insert(Event)
    .values({
      id,
      connectionId: installation.connectionId,
      teamId: installation.teamId ?? "",
      slackUserId: actor,
      channelId: source.channelId,
      threadTs: source.threadTs,
      payload: JSON.stringify({ type: "feedback" }),
      status: `feedback_${value}`,
      createdAt: new Date(),
      availableAt: new Date(),
    })
    .onDuplicateKeyUpdate({ set: { status: `feedback_${value}` } })
  return true
}
