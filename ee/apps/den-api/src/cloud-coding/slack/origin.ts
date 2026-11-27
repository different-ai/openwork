import type { DenTypeId } from "@openwork-ee/utils/typeid"

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

export async function cloudCodingSlackOrigin(_input: {
  runTokenId: string
  organizationId: DenTypeId<"organization">
  userId: string
}): Promise<CloudCodingSlackOrigin | null> {
  return null
}
