import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, SlackAssistantEventTable as Event } from "@openwork-ee/den-db/schema"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { slackRunOrigin } from "../../slack-assistant/desktop-handoff.js"

export type CloudCodingSlackOrigin = {
  connectionId: DenTypeId<"externalMcpConnection">
  eventId: string
  sessionId: string
  runnerMessageId: string
  teamId: string
  channelId: string
  threadTs: string
  requesterSlackUserId: string
}

type OriginInput = { runTokenId: string; organizationId: DenTypeId<"organization">; userId: string }

export async function cloudCodingSlackOrigin(input: OriginInput): Promise<CloudCodingSlackOrigin | null> {
  const origin = await slackRunOrigin(input)
  const sessionId = origin?.checkpoint?.sessionId
  if (!origin?.checkpoint || !sessionId) return null
  const { event, checkpoint: cp } = origin
  const coordinates = slackApprovalCoordinates(event, cp)
  if (!coordinates) return null
  return {
    connectionId: event.connectionId,
    eventId: event.id,
    sessionId,
    runnerMessageId: `msg_${event.id}`,
    ...coordinates,
    requesterSlackUserId: event.slackUserId,
  }
}

export function slackApprovalCoordinates(
  event: Pick<typeof Event.$inferSelect, "teamId" | "channelId" | "threadTs">,
  cp: { channel?: string; threadTs?: string; recipientTeamId?: string; privateReply: boolean },
) {
  const channelId = cp.channel ?? event.channelId
  const threadTs = cp.threadTs ?? event.threadTs
  if (!channelId || !threadTs || (cp.privateReply && !channelId.startsWith("D"))) return null
  return { teamId: cp.recipientTeamId ?? event.teamId, channelId, threadTs }
}

export async function findSlackApprovalMember(tx: Pick<AuditTx, "select">, organizationId: DenTypeId<"organization">, memberId: DenTypeId<"member">) {
  const [member] = await tx.select({ userId: MemberTable.userId }).from(MemberTable)
    .where(and(eq(MemberTable.id, memberId), eq(MemberTable.organizationId, organizationId), isNull(MemberTable.removedAt))).limit(1)
  return member?.userId ?? null
}
