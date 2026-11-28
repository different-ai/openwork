import { randomUUID } from "node:crypto"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from "@openwork-ee/den-db/drizzle"
import { CloudCodingSlackNoticeTable as Notice, CloudCodingPushApprovalTable as Approval, SlackAssistantEventTable as Event } from "@openwork-ee/den-db/schema"
import { z } from "zod"
import { db } from "../../db.js"
import { automationUpdateChangedRows } from "../../automations/update-result.js"
import { appLogger } from "../../observability/logger.js"
import { organizationFeatureEnabled } from "../../features.js"
import { scopeKey, SlackApiError, slackClient } from "../../slack-assistant/protocol.js"
import { getInstallation, resolveSlackActor } from "../../slack-assistant/repository.js"
import { checkpointSchema } from "../../slack-assistant/run.js"
import type { CloudCodingTaskRow } from "../tasks.js"
import { getCloudCodingApproval, getCloudCodingPullRequest, type CloudCodingApprovalRow } from "../gateway/approvals.js"
import { findSlackApprovalMember, slackApprovalCoordinates } from "./origin.js"
import { slackRunOrigin } from "../../slack-assistant/desktop-handoff.js"
import { cloudCodingSlackMessage } from "./messages.js"

export type CloudCodingSlackNotice = typeof Notice.$inferSelect
const LEASE_MS = 60_000
const POLL_MS = 2_000
const CONTINUE_MS = 20_000
const postedSchema = z.object({ ts: z.string().min(1) })

export async function queueCloudCodingSlackNotice(tx: AuditTx, { approval, task }: { approval: CloudCodingApprovalRow; task: CloudCodingTaskRow }): Promise<void> {
  if (task.surface !== "slack" || !task.runTokenId) return
  const userId = await findSlackApprovalMember(tx, task.organizationId, task.orgMembershipId)
  if (!userId) return
  const origin = await slackRunOrigin({ runTokenId: task.runTokenId, organizationId: task.organizationId, userId }, tx)
  if (!origin?.checkpoint) return
  const { event, checkpoint } = origin
  const coordinates = slackApprovalCoordinates(event, checkpoint)
  if (!coordinates) return
  await tx.insert(Notice).values({
    approvalId: approval.id, organizationId: approval.organizationId, orgMembershipId: approval.orgMembershipId,
    connectionId: event.connectionId, eventId: event.id, requesterSlackUserId: event.slackUserId, ...coordinates,
  }).onDuplicateKeyUpdate({ set: { approvalId: approval.id } })
}

export type NoticeSweepDeps = { slack: typeof slackClient; now: () => number }
const defaultDeps: NoticeSweepDeps = { slack: slackClient, now: Date.now }

async function claimNotices(now: Date, limit: number, approvalId?: CloudCodingSlackNotice["approvalId"]) {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ notice: Notice }).from(Notice).innerJoin(Approval, eq(Approval.id, Notice.approvalId))
      .where(and(
        approvalId ? eq(Notice.approvalId, approvalId) : lte(Notice.availableAt, now),
        or(isNull(Notice.leaseUntil), lte(Notice.leaseUntil, now)),
        or(
          and(eq(Approval.status, "pending"), isNull(Notice.messageTs)),
          and(isNotNull(Notice.messageTs), or(isNull(Notice.shownStatus), ne(Notice.shownStatus, Approval.status))),
          and(inArray(Approval.status, ["pending", "approved"]), lte(Approval.expiresAt, now)),
          and(eq(Approval.status, "approved"), isNull(Notice.continuedAt), lte(Approval.decidedAt, new Date(now.getTime() - CONTINUE_MS))),
        ),
      )).orderBy(asc(Notice.availableAt)).limit(limit).for("update", { skipLocked: true })
    const leaseOwner = randomUUID()
    if (rows.length) await tx.update(Notice).set({ leaseOwner, leaseUntil: new Date(now.getTime() + LEASE_MS) })
      .where(inArray(Notice.approvalId, rows.map(({ notice }) => notice.approvalId)))
    return rows.map(({ notice }) => ({ ...notice, leaseOwner }))
  })
}

function owned(notice: CloudCodingSlackNotice) {
  return and(eq(Notice.approvalId, notice.approvalId), eq(Notice.leaseOwner, notice.leaseOwner ?? ""))
}

async function enqueueContinuation(notice: CloudCodingSlackNotice, approval: CloudCodingApprovalRow, now: Date) {
  const [source] = await db.$primary.select().from(Event).where(and(eq(Event.id, notice.eventId), eq(Event.connectionId, notice.connectionId))).limit(1)
  if (!source || source.cancelled || source.slackUserId !== notice.requesterSlackUserId) return false
  const parsed = checkpointSchema.safeParse(source.checkpoint ? JSON.parse(source.checkpoint) : {})
  if (!parsed.success || !parsed.data.sessionId) return false
  const cp = parsed.data
  const coordinates = slackApprovalCoordinates(source, cp)
  if (coordinates?.channelId !== notice.channelId || coordinates.threadTs !== notice.threadTs) return false
  const id = scopeKey("cloud-coding-slack-continuation", approval.id)
  return db.transaction(async (tx) => {
    const [current] = await tx.select({ id: Approval.id }).from(Approval)
      .where(and(eq(Approval.id, approval.id), eq(Approval.status, "approved"), gt(Approval.expiresAt, now))).for("update")
    if (!current || await getCloudCodingPullRequest(approval.id, tx)) return false
    const result = await tx.update(Notice).set({ continuedAt: now }).where(and(owned(notice), isNull(Notice.continuedAt), gt(Notice.leaseUntil, now)))
    if (!automationUpdateChangedRows(result)) return false
    const payload = { type: "cloud_coding_continuation" }
    const checkpoint = checkpointSchema.parse({
      phase: "send", sessionId: cp.sessionId, sessionResets: 1, channel: notice.channelId, threadTs: notice.threadTs,
      recipientUserId: notice.requesterSlackUserId, recipientTeamId: notice.teamId, privateReply: cp.privateReply,
      live: cp.live, workbot: cp.workbot, driveFiles: cp.driveFiles, answerReply: cp.answerReply,
      cloudCodingContinuation: { approvalId: approval.id, memberId: notice.orgMembershipId },
      prompt: `The person approved the push for cloud coding task ${approval.taskId}. Call cloud-coding:start with taskId ${approval.taskId}, run the setup command it returns, then run the wait command to push the approved commit and open the pull request. Reply with the pull request link.`,
    })
    await tx.insert(Event).values({ id, connectionId: source.connectionId, teamId: source.teamId, slackUserId: source.slackUserId,
      channelId: source.channelId, threadTs: source.threadTs, checkpoint: JSON.stringify(checkpoint), payload: JSON.stringify(payload),
      createdAt: now, availableAt: now }).onDuplicateKeyUpdate({ set: { id } })
    return true
  })
}

async function processNotice(notice: CloudCodingSlackNotice, deps: NoticeSweepDeps) {
  const now = new Date(deps.now())
  const renewed = await db.update(Notice).set({ leaseUntil: new Date(deps.now() + LEASE_MS) })
    .where(and(owned(notice), gt(Notice.leaseUntil, now)))
  if (!automationUpdateChangedRows(renewed)) return
  const scope = { organizationId: notice.organizationId, memberId: notice.orgMembershipId }
  const approval = await getCloudCodingApproval(scope, notice.approvalId)
  if (!approval) return
  const installation = await getInstallation(notice.connectionId)
  if (!installation?.botToken || installation.organizationId !== notice.organizationId || installation.teamId !== notice.teamId) return
  const { status } = approval
  const continuationDue = status === "approved" && !notice.continuedAt && approval.decidedAt && now.getTime() - approval.decidedAt.getTime() >= CONTINUE_MS
  if (status === "pending" || continuationDue) {
    const actor = await resolveSlackActor(installation, notice.requesterSlackUserId)
    const allowed = actor?.memberId === notice.orgMembershipId && await organizationFeatureEnabled(notice.organizationId, "cloudCoding", { userId: actor.userId })
    if (status === "pending" && !allowed) return
    if (continuationDue && allowed) await enqueueContinuation(notice, approval, now)
  }
  if (!notice.messageTs && status !== "pending" || notice.messageTs && notice.shownStatus === status) return
  const pr = status === "pushed" ? await getCloudCodingPullRequest(approval.id) : null
  const shownStatus = status === "pushed" && !pr ? "approved" : status
  if (notice.shownStatus === shownStatus && notice.messageTs) return
  const message = cloudCodingSlackMessage({ ...approval, status: shownStatus }, notice.requesterSlackUserId, pr)
  const slack = deps.slack(installation.botToken)
  const payload = { channel: notice.channelId, ...message, unfurl_links: false, unfurl_media: false }
  let messageTs = notice.messageTs
  if (messageTs) await slack("chat.update", { ...payload, ts: messageTs })
  else {
    const current = await getCloudCodingApproval(scope, notice.approvalId)
    if (current?.status !== "pending") return
    messageTs = postedSchema.parse(await slack("chat.postMessage", { ...payload, thread_ts: notice.threadTs })).ts
  }
  await db.update(Notice).set({ messageTs, shownStatus }).where(owned(notice))
}

async function sweep(deps: NoticeSweepDeps, limit: number, approvalId?: CloudCodingSlackNotice["approvalId"]) {
  const notices = await claimNotices(new Date(deps.now()), limit, approvalId)
  for (const notice of notices) {
    let attempts = 0
    let delayMs = POLL_MS
    try {
      await processNotice(notice, deps)
    } catch (error) {
      attempts = notice.attempts + 1
      delayMs = Math.max(error instanceof SlackApiError ? error.retryAfterMs ?? 0 : 0, Math.min(600_000, 2_000 * 2 ** Math.min(attempts, 9)))
      appLogger.warn("cloud_coding_slack_notice_failed", { approval_id: notice.approvalId, attempt: attempts })
    } finally {
      await db.update(Notice).set({ attempts, availableAt: new Date(deps.now() + delayMs), leaseOwner: null, leaseUntil: null }).where(owned(notice))
    }
  }
  return notices.length
}

export function sweepCloudCodingSlackNotices(deps: NoticeSweepDeps = defaultDeps, limit = 20) {
  return sweep(deps, limit)
}

export function refreshCloudCodingSlackNotice(approvalId: CloudCodingSlackNotice["approvalId"]) {
  return sweep(defaultDeps, 1, approvalId)
}

export function startCloudCodingSlackNoticeWorker() {
  if (process.env.DEN_SLACK_ASSISTANT_WORKER_ENABLED === "false") return async () => {}
  let running: Promise<unknown> | null = null
  const timer = setInterval(() => {
    if (running) return
    running = sweepCloudCodingSlackNotices().catch(() => appLogger.warn("cloud_coding_slack_queue_unavailable", {}))
      .finally(() => { running = null })
  }, POLL_MS)
  timer.unref()
  return async () => {
    clearInterval(timer)
    await running
  }
}
