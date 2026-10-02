import { randomUUID } from "node:crypto"
import { and, asc, desc, count, eq, gt, inArray, isNotNull, isNull, lt, lte, or } from "@openwork-ee/den-db/drizzle"
import {
  SlackAssistantInstallationTable as Installation,
  SlackAssistantIdentityTable as Identity,
  SlackAssistantEventTable as Event,
  SlackAssistantThreadTable as Thread,
  SlackAssistantOAuthStateTable as State,
  ConnectedAccountTable,
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
import { slackRuntimeForOrganization, type SlackRuntime } from "./headless.js"

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
export async function slackRuntimeForInstallation(installation: InstallationRow): Promise<SlackRuntime> {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, installation.organizationId))
    .limit(1)
  return slackRuntimeForOrganization(organization?.metadata)
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

const LINK_BACKFILL_INTERVAL_MS = 10 * 60_000
const LINK_BACKFILL_MAX_MEMBERS = 200
const lastLinkBackfill = new Map<string, number>()

/**
 * Members who connected Slack before the assistant was installed have a token but no Slack identity link,
 * which used to force them to disconnect and reconnect. Link them from their existing token instead
 * (auth.test through bindSlackOAuthMember, which also replays their pending requests). Runs at most once
 * per installation every ten minutes per process. Returns how many members were newly linked.
 */
export async function linkConnectedSlackMembers(installation: InstallationRow, client = slackClient, now = Date.now) {
  const last = lastLinkBackfill.get(installation.connectionId)
  if (last !== undefined && now() - last < LINK_BACKFILL_INTERVAL_MS) return 0
  lastLinkBackfill.set(installation.connectionId, now())
  const connection = await getExternalMcpConnection({
    organizationId: installation.organizationId,
    connectionId: installation.connectionId,
  })
  if (!connection || !isSlackConnection(connection) || !installation.teamId) return 0
  const [accounts, linked] = await Promise.all([
    db
      .select({ memberId: ConnectedAccountTable.orgMembershipId })
      .from(ConnectedAccountTable)
      .where(
        and(
          eq(ConnectedAccountTable.organizationId, installation.organizationId),
          eq(ConnectedAccountTable.providerId, installation.connectionId),
        ),
      )
      .limit(LINK_BACKFILL_MAX_MEMBERS),
    db.select({ memberId: Identity.memberId }).from(Identity).where(eq(Identity.connectionId, installation.connectionId)),
  ])
  const alreadyLinked = new Set(linked.map((row) => row.memberId))
  let count = 0
  for (const { memberId } of accounts) {
    if (alreadyLinked.has(memberId)) continue
    try {
      await bindSlackOAuthMember(connection, memberId, client)
      count += 1
    } catch {
      // Wrong workspace, revoked token or an identity bound elsewhere: that member reconnects as before.
    }
  }
  return count
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
  // The headless runner needs no per-member OpenWork Web computer.
  const runtime = slackRuntimeForOrganization(organization?.metadata)
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
      webAccess: runtime === "headless" || access.hasAccess,
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
    runtime,
  }
}
export type SlackActor = NonNullable<Awaited<ReturnType<typeof resolveSlackActor>>>

function positiveIntegerEnv(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Load limits. Read per call so a deployment (or a test) can tune them without a restart of this module.
 * - ingress: requests accepted per minute, per workspace and per person; over it, the person is told.
 * - runningPerMember: one person's tasks running at once; more wait their turn instead of crowding others out.
 * - liveStreamsPerWorkspace: tasks streaming live progress at once; beyond it new tasks show Slack's working
 *   status and post their answer, which keeps a busy workspace inside Slack's per-method rate limits.
 */
export function slackLoadLimits() {
  return {
    ingressPerWorkspacePerMinute: positiveIntegerEnv("DEN_SLACK_INGRESS_PER_MINUTE", 600),
    ingressPerMemberPerMinute: positiveIntegerEnv("DEN_SLACK_INGRESS_PER_MEMBER_PER_MINUTE", 10),
    runningPerMember: positiveIntegerEnv("DEN_SLACK_RUNNING_PER_MEMBER", 3),
    liveStreamsPerWorkspace: positiveIntegerEnv("DEN_SLACK_LIVE_STREAMS_PER_WORKSPACE", 20),
  }
}

/** A request over the intake limit gets this status; the worker tells the person, then marks it sent. */
export const THROTTLED_STATUS = "throttled"
export const THROTTLED_SENT_STATUS = "throttled_sent"

const LEASE_MS = 120_000
const LEASE_RECHECK_MS = 20_000
/** When this process last claimed or extended each lease it holds. */
const leaseRenewedAt = new Map<string, number>()
const leaseKey = (eventId: string, owner: string | null) => `${eventId}:${owner ?? ""}`

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
    const limits = slackLoadLimits()
    const row = {
      id,
      connectionId: installation.connectionId,
      teamId: installation.teamId ?? "",
      slackUserId: event.user ?? "",
      channelId: event.channel ?? "",
      threadTs: event.thread_ts ?? event.ts ?? "",
      payload: JSON.stringify(event),
      createdAt: new Date(),
      availableAt: new Date(),
    }
    if (
      invocation &&
      ((total?.total ?? 0) >= limits.ingressPerWorkspacePerMinute || (member?.total ?? 0) >= limits.ingressPerMemberPerMinute)
    ) {
      // Never drop a request silently: the person hears that it was not taken, at most once a minute.
      const [noticed] = await tx
        .select({ total: count() })
        .from(Event)
        .where(
          and(
            eq(Event.connectionId, installation.connectionId),
            eq(Event.slackUserId, event.user ?? ""),
            inArray(Event.status, [THROTTLED_STATUS, THROTTLED_SENT_STATUS]),
            gt(Event.createdAt, minute),
          ),
        )
      if (!(noticed?.total ?? 0)) await tx.insert(Event).values({ ...row, status: THROTTLED_STATUS })
      return null
    }
    await tx.insert(Event).values(row)
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
          inArray(Event.status, ["pending", "running", THROTTLED_STATUS]),
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
      .set({ leaseOwner, leaseUntil: new Date(Date.now() + LEASE_MS) })
      .where(eq(Event.id, event.id))
    leaseRenewedAt.set(leaseKey(event.id, leaseOwner), Date.now())
    return { ...event, leaseOwner }
  })
}
export async function checkpointEvent(
  event: EventRow,
  changes: Partial<Pick<EventRow, "checkpoint" | "status" | "cancelled" | "attempts">>,
  delayMs = 0,
) {
  leaseRenewedAt.delete(leaseKey(event.id, event.leaseOwner))
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
    if (!thread) return { thread: null, busy: false }
    // `busy`: another of this member's tasks is running here, so this message waits its turn.
    if (thread.activeEventId && thread.activeEventId !== event.id) return { thread: null, busy: true }
    if (thread.activeEventId !== event.id) {
      // Messages in a thread run in the order they were sent: an older one still waiting goes first.
      const older = await tx
        .select({ id: Event.id })
        .from(Event)
        .where(
          and(
            eq(Event.connectionId, event.connectionId),
            eq(Event.slackUserId, event.slackUserId),
            eq(Event.channelId, event.channelId),
            eq(Event.threadTs, event.threadTs),
            inArray(Event.status, ["pending", "running"]),
            eq(Event.cancelled, false),
            or(lt(Event.createdAt, event.createdAt), and(eq(Event.createdAt, event.createdAt), lt(Event.id, event.id))),
          ),
        )
        .limit(1)
      if (older.length) return { thread: null, busy: false }
    }
    await tx.update(Thread).set({ activeEventId: event.id }).where(eq(Thread.id, id))
    return { thread, busy: false }
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
  const matches = candidates.filter((candidate) => {
    const output = z
      .object({ channel: z.string().optional(), threadTs: z.string().optional() })
      .safeParse(candidate.checkpoint ? JSON.parse(candidate.checkpoint) : {})
    const matchesSource = candidate.channelId === event.channel && candidate.threadTs === event.thread_ts
    const matchesOutput =
      output.success && output.data.channel === event.channel && output.data.threadTs === event.thread_ts
    return matchesSource || matchesOutput
  })
  // Stop ends the task that is running; messages the member sent while it ran start next. With nothing
  // running yet, Stop cancels the request itself.
  const running = matches.filter((candidate) => candidate.status === "running")
  for (const candidate of running.length ? running : matches)
    await db.update(Event).set({ cancelled: true, availableAt: new Date() }).where(eq(Event.id, candidate.id))
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
    .set({ checkpoint: serialized, leaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(Event.id, event.id), eq(Event.leaseOwner, event.leaseOwner ?? ""), gt(Event.leaseUntil, new Date())))
  if (!updatedRows(result)) throw new SlackLeaseLostError()
  leaseRenewedAt.set(leaseKey(event.id, event.leaseOwner), Date.now())
  event.checkpoint = serialized
}
export class SlackLeaseLostError extends Error {
  constructor() {
    super("slack_assistant_lease_lost")
  }
}
/**
 * Extends this worker's lease before it acts. Within LEASE_RECHECK_MS of the last claim or renewal the lease
 * cannot have expired (it lasts LEASE_MS), so the write is skipped; `force` always checks, for the first act of
 * each processing pass, so a worker that stalled notices a lost lease before it publishes anything.
 */
export async function renewSlackLease(event: EventRow, options: { force?: boolean } = {}) {
  const key = leaseKey(event.id, event.leaseOwner)
  if (!options.force && Date.now() - (leaseRenewedAt.get(key) ?? 0) < LEASE_RECHECK_MS) return
  const result = await db
    .update(Event)
    .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
    .where(and(eq(Event.id, event.id), eq(Event.leaseOwner, event.leaseOwner ?? ""), gt(Event.leaseUntil, new Date())))
  if (!updatedRows(result)) {
    leaseRenewedAt.delete(key)
    throw new SlackLeaseLostError()
  }
  if (leaseRenewedAt.size > 10_000) leaseRenewedAt.clear()
  leaseRenewedAt.set(key, Date.now())
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

/**
 * - admitted: the run may start.
 * - paused: most recent runs in this workspace failed; new work waits out the window (already running work finishes).
 * - daily_limit: this person reached the workspace's daily run limit.
 * - busy: this person already has their maximum of tasks running; this one starts when one finishes.
 */
export type SlackAdmission = "admitted" | "paused" | "daily_limit" | "busy"

export async function admitSlackRun(event: EventRow, installation: InstallationRow): Promise<SlackAdmission> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: Installation.connectionId })
      .from(Installation)
      .where(eq(Installation.connectionId, event.connectionId))
      .for("update")
    const current = (await tx.select({ status: Event.status }).from(Event).where(eq(Event.id, event.id)))[0]
    if (current?.status === "running") return "admitted"
    // When most recent runs fail, the service is broken: pause new work for this installation instead of
    // failing every request. A handful of failures among many successes in a busy workspace does not pause it.
    // Already admitted runs can finish, and the window expires on its own.
    const window = new Date(Date.now() - 300_000)
    const [failures] = await tx
      .select({ total: count() })
      .from(Event)
      .where(and(eq(Event.connectionId, event.connectionId), eq(Event.status, "failed"), gt(Event.availableAt, window)))
    const failed = failures?.total ?? 0
    if (failed >= 5) {
      // Runs that completed in the same window: pause only when failures are at least half of what finished.
      const [completed] = await tx
        .select({ total: count() })
        .from(Event)
        .where(
          and(
            eq(Event.connectionId, event.connectionId),
            eq(Event.status, "done"),
            isNotNull(Event.checkpoint),
            gt(Event.availableAt, window),
          ),
        )
      if (failed >= (completed?.total ?? 0)) return "paused"
    }
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
    if ((row?.total ?? 0) >= installation.dailyLimit) return "daily_limit"
    // One person cannot take every slot: extra tasks wait (and are told so) until one of theirs finishes.
    const [running] = await tx
      .select({ total: count() })
      .from(Event)
      .where(
        and(eq(Event.connectionId, event.connectionId), eq(Event.slackUserId, event.slackUserId), eq(Event.status, "running")),
      )
    if ((running?.total ?? 0) >= slackLoadLimits().runningPerMember) return "busy"
    await tx.update(Event).set({ status: "running" }).where(eq(Event.id, event.id))
    return "admitted"
  })
}
/** Tasks in this workspace that are probably streaming live: running, and still within their live minutes. */
export async function liveSlackTasks(connectionId: DenTypeId<"externalMcpConnection">, liveWindowMs: number) {
  const [row] = await db
    .select({ total: count() })
    .from(Event)
    .where(
      and(
        eq(Event.connectionId, connectionId),
        eq(Event.status, "running"),
        gt(Event.createdAt, new Date(Date.now() - liveWindowMs)),
      ),
    )
  return row?.total ?? 0
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
        inArray(Event.status, ["done", "failed", "expired", "feedback_positive", "feedback_negative", THROTTLED_SENT_STATUS]),
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
