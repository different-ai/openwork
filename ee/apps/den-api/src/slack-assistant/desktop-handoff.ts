import { randomUUID } from "node:crypto"
import { and, asc, eq, gt, inArray, isNull, lt, lte, or } from "@openwork-ee/den-db/drizzle"
import {
  OAuthAccessTokenTable,
  SlackAssistantDesktopHandoffTable as Handoff,
  SlackAssistantEventTable as Event,
  SlackAssistantInstallationTable as Installation,
  SlackAssistantRunTokenTable as RunToken,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { automationUpdateChangedRows } from "../automations/update-result.js"
import { DEN_MCP_HEADLESS_RUN_CLIENT_ID } from "../mcp/headless-run-token.js"
import { appLogger } from "../observability/logger.js"
import {
  databaseRemoteSessionCommandStore,
  type RemoteSessionCommand,
  type RemoteSessionCommandStore,
} from "../remote-sessions/commands.js"
import { desktopHandoffMessage, type DesktopHandoffNotice } from "./desktop-handoff-messages.js"
import { SlackApiError, slackClient, type SlackCall } from "./protocol.js"
import { getInstallation, resolveSlackActor } from "./repository.js"
import { checkpointSchema } from "./run.js"

export type HandoffRow = typeof Handoff.$inferSelect
type Outcome = NonNullable<HandoffRow["postedOutcome"]>

const LEASE_MS = 60_000
const POLL_MS = 5_000
const MAX_POST_ATTEMPTS = 10
export const HANDOFF_MAX_AGE_MS = 7 * 86_400_000
const CLAIMED_GRACE_MS = 5 * 60_000
const PERMANENT_SLACK_ERRORS = ["invalid_auth", "token_revoked", "account_inactive", "channel_not_found", "is_archived", "not_in_channel", "missing_scope"]

function eventIdFromMessageId(messageId: string | undefined) {
  const match = /^msg_([a-f0-9]{64})(?:\.t\d{1,3}(?:\.r)?)?$/.exec(messageId ?? "")
  return match?.[1] ?? null
}

function tokenIdOrNull(value: string) {
  try {
    return normalizeDenTypeId("oauthAccessToken", value)
  } catch {
    return null
  }
}

export async function recordSlackRunToken(input: { tokenId: string; expiresAt: Date; userId: string; messageId?: string }) {
  const eventId = eventIdFromMessageId(input.messageId)
  const tokenId = tokenIdOrNull(input.tokenId)
  if (!eventId || !tokenId) return false
  await db.delete(RunToken).where(lt(RunToken.expiresAt, new Date()))
  const [event] = await db.select({ connectionId: Event.connectionId }).from(Event).where(eq(Event.id, eventId)).limit(1)
  if (!event) return false
  await db.insert(RunToken).values({
    tokenId,
    connectionId: event.connectionId,
    eventId,
    userId: normalizeDenTypeId("user", input.userId),
    expiresAt: input.expiresAt,
  })
  return true
}

export async function slackRunOrigin(input: {
  organizationId: DenTypeId<"organization">
  userId: string
  runTokenId: string
}, database: Pick<typeof db, "select"> = db.$primary) {
  const tokenId = tokenIdOrNull(input.runTokenId)
  if (!tokenId) return null
  const userId = normalizeDenTypeId("user", input.userId)
  const now = new Date()
  const [link] = await database
    .select({ event: Event, organizationId: Installation.organizationId })
    .from(RunToken)
    .innerJoin(OAuthAccessTokenTable, eq(OAuthAccessTokenTable.id, RunToken.tokenId))
    .innerJoin(Event, and(eq(Event.id, RunToken.eventId), eq(Event.connectionId, RunToken.connectionId)))
    .innerJoin(Installation, eq(Installation.connectionId, RunToken.connectionId))
    .where(
      and(
        eq(RunToken.tokenId, tokenId),
        eq(RunToken.userId, userId),
        gt(RunToken.expiresAt, now),
        eq(OAuthAccessTokenTable.clientId, DEN_MCP_HEADLESS_RUN_CLIENT_ID),
        eq(OAuthAccessTokenTable.userId, userId),
        eq(OAuthAccessTokenTable.referenceId, input.organizationId),
        gt(OAuthAccessTokenTable.expiresAt, now),
        isNull(OAuthAccessTokenTable.revoked),
      ),
    )
    .limit(1)
  if (!link || link.organizationId !== input.organizationId) return null
  const { event } = link
  try {
    const output = checkpointSchema.safeParse(event.checkpoint ? JSON.parse(event.checkpoint) : {})
    return { event, checkpoint: output.success ? output.data : null }
  } catch {
    return { event, checkpoint: null }
  }
}

export async function linkDesktopCommandToSlack(input: {
  commandId: string
  organizationId: DenTypeId<"organization">
  userId: string
  runTokenId: string
}) {
  const origin = await slackRunOrigin(input)
  if (!origin) return false
  const { event, checkpoint: cp } = origin
  const now = new Date()
  await db.insert(Handoff).values({
    commandId: normalizeDenTypeId("remoteSessionCommand", input.commandId),
    connectionId: event.connectionId,
    organizationId: input.organizationId,
    userId: normalizeDenTypeId("user", input.userId),
    eventId: event.id,
    teamId: cp?.recipientTeamId ?? event.teamId,
    channelId: cp?.channel ?? event.channelId,
    threadTs: cp?.threadTs ?? event.threadTs,
    recipientUserId: cp?.recipientUserId ?? event.slackUserId,
    availableAt: new Date(now.getTime() + POLL_MS),
    createdAt: now,
  })
  return true
}

export type HandoffStep =
  | { action: "wait" }
  | { action: "close"; outcome: Outcome }
  | { action: "reset_waiting" }
  | { action: "post"; notice: DesktopHandoffNotice; outcome: Outcome | null }

export function nextHandoffStep(
  command: RemoteSessionCommand | null,
  handoff: Pick<HandoffRow, "waitingPosted" | "createdAt">,
  now: number,
): HandoffStep {
  if (!command) return { action: "close", outcome: "abandoned" }
  if (command.status === "failed")
    return { action: "post", notice: { kind: "undeliverable", message: command.error?.message ?? null, code: command.error?.code ?? null }, outcome: "undeliverable" }
  if (
    command.status === "expired" ||
    (command.status === "pending" && command.expiresAt <= now) ||
    (command.status === "claimed" && command.expiresAt + CLAIMED_GRACE_MS <= now)
  )
    return { action: "post", notice: { kind: "expired" }, outcome: "expired" }
  const session = command.status === "delivered" ? command.session : null
  if (session?.status === "idle")
    return { action: "post", notice: { kind: "finished", finalText: session.finalText }, outcome: "finished" }
  if (session?.status === "error")
    return { action: "post", notice: { kind: "failed", message: session.lastError?.message ?? null }, outcome: "failed" }
  if (now - handoff.createdAt.getTime() >= HANDOFF_MAX_AGE_MS) return { action: "close", outcome: "abandoned" }
  if (session?.status === "waiting" && !handoff.waitingPosted)
    return { action: "post", notice: { kind: "waiting", waitingFor: session.waitingFor }, outcome: null }
  if (session && session.status !== "waiting" && handoff.waitingPosted) return { action: "reset_waiting" }
  return { action: "wait" }
}

async function claimHandoffs(limit: number, now: Date): Promise<HandoffRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(Handoff)
      .where(
        and(
          isNull(Handoff.postedOutcome),
          lte(Handoff.availableAt, now),
          or(isNull(Handoff.leaseUntil), lte(Handoff.leaseUntil, now)),
        ),
      )
      .orderBy(asc(Handoff.availableAt))
      .limit(limit)
      .for("update", { skipLocked: true })
    if (!rows.length) return []
    const leaseOwner = randomUUID()
    await tx
      .update(Handoff)
      .set({ leaseOwner, leaseUntil: new Date(now.getTime() + LEASE_MS) })
      .where(inArray(Handoff.commandId, rows.map((row) => row.commandId)))
    return rows.map((row) => ({ ...row, leaseOwner }))
  })
}

function owned(handoff: HandoffRow) {
  return and(
    eq(Handoff.commandId, handoff.commandId),
    eq(Handoff.leaseOwner, handoff.leaseOwner ?? ""),
    isNull(Handoff.postedOutcome),
  )
}

async function settle(
  handoff: HandoffRow,
  changes: Partial<Pick<HandoffRow, "postedOutcome" | "waitingPosted" | "attempts">>,
  delayMs: number,
  now: number,
) {
  const result = await db
    .update(Handoff)
    .set({ ...changes, availableAt: new Date(now + delayMs), leaseOwner: null, leaseUntil: null })
    .where(owned(handoff))
  return automationUpdateChangedRows(result)
}

async function holdLease(handoff: HandoffRow, now: number) {
  const result = await db
    .update(Handoff)
    .set({ leaseUntil: new Date(now + LEASE_MS) })
    .where(and(owned(handoff), gt(Handoff.leaseUntil, new Date(now))))
  return automationUpdateChangedRows(result)
}

export type HandoffSweepDeps = {
  slack: (token: string) => SlackCall
  commandStore: RemoteSessionCommandStore
  now: () => number
}

const defaultSweepDeps: HandoffSweepDeps = {
  slack: slackClient,
  commandStore: databaseRemoteSessionCommandStore,
  now: Date.now,
}

async function processHandoff(handoff: HandoffRow, deps: HandoffSweepDeps) {
  const command = await deps.commandStore.get({
    commandId: handoff.commandId,
    organizationId: handoff.organizationId,
    createdByUserId: handoff.userId,
  })
  const step = nextHandoffStep(command, handoff, deps.now())
  if (step.action === "wait") return settle(handoff, {}, POLL_MS, deps.now())
  if (step.action === "close") return settle(handoff, { postedOutcome: step.outcome }, 0, deps.now())
  if (step.action === "reset_waiting") return settle(handoff, { waitingPosted: false }, POLL_MS, deps.now())

  const installation = await getInstallation(handoff.connectionId)
  const actor = installation?.botToken ? await resolveSlackActor(installation, handoff.recipientUserId) : null
  if (!installation?.botToken || !actor || actor.userId !== handoff.userId)
    return settle(handoff, { postedOutcome: "abandoned" }, 0, deps.now())

  if (!(await holdLease(handoff, deps.now()))) return false
  try {
    await deps.slack(installation.botToken)("chat.postMessage", {
      channel: handoff.channelId,
      thread_ts: handoff.threadTs,
      ...desktopHandoffMessage(handoff.recipientUserId, step.notice),
      unfurl_links: false,
      unfurl_media: false,
    })
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "post_failed"
    appLogger.warn("slack_desktop_handoff_post_failed", { command_id: handoff.commandId, code, attempt: handoff.attempts + 1 })
    if (PERMANENT_SLACK_ERRORS.includes(code) || handoff.attempts + 1 >= MAX_POST_ATTEMPTS)
      return settle(handoff, { postedOutcome: "abandoned" }, 0, deps.now())
    const retryMs = error instanceof SlackApiError && error.retryAfterMs ? error.retryAfterMs : 30_000
    return settle(handoff, { attempts: handoff.attempts + 1 }, retryMs, deps.now())
  }
  appLogger.info("slack_desktop_handoff_posted", { command_id: handoff.commandId, notice: step.notice.kind })
  return settle(
    handoff,
    step.outcome ? { postedOutcome: step.outcome, attempts: 0 } : { waitingPosted: true, attempts: 0 },
    POLL_MS,
    deps.now(),
  )
}

export async function sweepSlackDesktopHandoffs(deps: HandoffSweepDeps = defaultSweepDeps, limit = 20) {
  const handoffs = await claimHandoffs(limit, new Date(deps.now()))
  for (const handoff of handoffs) {
    try {
      await processHandoff(handoff, deps)
    } catch (error) {
      appLogger.warn("slack_desktop_handoff_failed", {
        command_id: handoff.commandId,
        code: error instanceof SlackApiError ? error.code : "worker_error",
      })
      await settle(handoff, { attempts: handoff.attempts + 1 }, 30_000, deps.now()).catch(() => false)
    }
  }
  return handoffs.length
}

export function startSlackDesktopHandoffWorker() {
  if (process.env.DEN_SLACK_ASSISTANT_WORKER_ENABLED === "false") return async () => {}
  let stopped = false
  let ticking = false
  const timer = setInterval(() => {
    if (stopped || ticking) return
    ticking = true
    void sweepSlackDesktopHandoffs()
      .catch(() => appLogger.warn("slack_desktop_handoff_queue_unavailable", {}))
      .finally(() => {
        ticking = false
      })
  }, 2_000)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
  }
}
