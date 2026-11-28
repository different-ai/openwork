import type { Context } from "hono"
import { eq } from "@openwork-ee/den-db/drizzle"
import { CloudCodingSlackNoticeTable as Notice } from "@openwork-ee/den-db/schema"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_SLACK_ACTION_PREFIX } from "@openwork/types/den/cloud-coding"
import { attributeAuditRequest, auditChangeCapture, auditSessionUserAttribution } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { organizationFeatureEnabled } from "../../features.js"
import { appLogger } from "../../observability/logger.js"
import { slackClient } from "../../slack-assistant/protocol.js"
import { resolveSlackActor, type InstallationRow } from "../../slack-assistant/repository.js"
import { decideCloudCodingApproval, getCloudCodingApproval } from "../gateway/approvals.js"
import { recordGatewayEvent } from "../gateway/audit.js"
import { refreshCloudCodingSlackNotice } from "./notices.js"
import { slackRequester } from "./messages.js"

type Click = { actionId: string; decision: "allow_once" | "deny"; userId: string; channel: string; messageTs: string }

export async function handleCloudCodingSlackAction(c: Context, installation: InstallationRow, click: Click) {
  const suffix = `:${click.decision}`
  if (!click.actionId.startsWith(CLOUD_CODING_SLACK_ACTION_PREFIX) || !click.actionId.endsWith(suffix)) return
  const approvalId = click.actionId.slice(CLOUD_CODING_SLACK_ACTION_PREFIX.length, -suffix.length)
  if (!isDenTypeId("cloudCodingPushApproval", approvalId)) return
  const [notice] = await db.$primary.select().from(Notice).where(eq(Notice.approvalId, approvalId)).limit(1)
  if (!notice || !notice.messageTs || notice.connectionId !== installation.connectionId || notice.organizationId !== installation.organizationId ||
      notice.teamId !== installation.teamId || notice.channelId !== click.channel || notice.messageTs !== click.messageTs) return
  const botToken = installation.botToken
  const privateReply = (text: string) => {
    if (botToken) void slackClient(botToken)("chat.postEphemeral", {
      channel: notice.channelId, thread_ts: notice.threadTs, user: click.userId, text,
    }).catch(() => appLogger.warn("cloud_coding_slack_ephemeral_failed", { approval_id: approvalId }))
  }
  const actor = await resolveSlackActor(installation, click.userId)
  if (!actor || actor.memberId !== notice.orgMembershipId || !await organizationFeatureEnabled(notice.organizationId, "cloudCoding", { userId: actor.userId })) {
    privateReply(`Only ${slackRequester(notice.requesterSlackUserId)} can approve or deny this push.`)
    return
  }
  const attribution = auditSessionUserAttribution(actor.userId, actor.memberId)
  if (!attribution) return
  const audited = await attributeAuditRequest(c, { organizationId: actor.organizationId, origin: "webhook", ...attribution })
  if (!audited.ok) {
    privateReply("OpenWork couldn't record your decision. Please try again.")
    return
  }
  const capture = auditChangeCapture(c)
  const scope = { organizationId: actor.organizationId, memberId: actor.memberId }
  const result = await decideCloudCodingApproval(scope, approvalId, click.decision, (tx, row) =>
    recordGatewayEvent(tx, capture, click.decision === "allow_once" ? "cloud_coding.push.approved" : "cloud_coding.push.denied", row))
  if (result === "not_pending") {
    const current = await getCloudCodingApproval(scope, approvalId)
    const status = current?.status
    privateReply(`This push was already ${status === "pushed" ? "approved and pushed" : status === "pending" || !status ? "decided" : status}.`)
  }
  if (result) void refreshCloudCodingSlackNotice(approvalId)
    .catch(() => appLogger.warn("cloud_coding_slack_refresh_failed", { approval_id: approvalId }))
}
