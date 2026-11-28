import type { AgentMemberCheckMessage } from "@openwork-ee/den-db/schema"
import type { AgentDestinationBlock } from "@openwork/types/den/workbot-proactive"
import { markFeaturesUsed } from "../feature-usage.js"
import { slackRichEnabled } from "../slack-assistant/rich-delivery.js"
import { composeSlackMessages, type SlackOutgoingMessage, type SlackPart } from "../slack-assistant/rich-message.js"
import {
  resolveWorkbotDirectMessageTarget,
  sendWorkbotDirectMessage,
  type WorkbotDirectMessageResult,
  type WorkbotDirectMessageTarget,
} from "../slack-assistant/direct-message.js"

export type DeliveryResult = { ok: true; message?: AgentMemberCheckMessage } | { ok: false; code: AgentDestinationBlock | "send_failed" }

export type DeliveryDeps = {
  target: (input: { organizationId: string; userId: string }) => Promise<WorkbotDirectMessageTarget>
  send: (input: { organizationId: string; userId: string; text: string; permalink?: boolean; rich?: readonly SlackOutgoingMessage[] }) => Promise<WorkbotDirectMessageResult>
  rich: (input: { organizationId: string; userId: string }) => Promise<boolean>
  markRichUsed: (input: { organizationId: string; memberId: string }) => void
}

export type AgentDelivery = { organizationId: string; userId: string; memberId?: string; text: string; parts?: readonly SlackPart[] }

export const defaultDeliveryDeps: DeliveryDeps = {
  target: (input) => resolveWorkbotDirectMessageTarget(input),
  send: (input) => sendWorkbotDirectMessage(input),
  rich: (input) => slackRichEnabled(input.organizationId, input.userId),
  markRichUsed: (input) => markFeaturesUsed({ ...input, keys: ["slackRichMessages"] }),
}

export async function destinationBlock(input: { organizationId: string; userId: string }, deps: Pick<DeliveryDeps, "target"> = defaultDeliveryDeps): Promise<AgentDestinationBlock | null> {
  const target = await deps.target(input)
  return target.ok ? null : target.reason
}

export async function deliverAgentMessage(input: AgentDelivery, deps: DeliveryDeps = defaultDeliveryDeps): Promise<DeliveryResult> {
  const rich = input.parts?.length && (await deps.rich(input)) ? composeSlackMessages(input.parts, { link: (url) => url }) : []
  const sent = await deps.send({ organizationId: input.organizationId, userId: input.userId, text: input.text, permalink: true, ...(rich.length ? { rich } : {}) })
  if (sent.ok && rich.length && input.memberId) deps.markRichUsed({ organizationId: input.organizationId, memberId: input.memberId })
  if (sent.ok) return { ok: true, message: { channelId: sent.channelId, messageTs: sent.messageTs, permalink: sent.permalink ?? null } }
  return { ok: false, code: sent.reason === "slack_error" ? "send_failed" : sent.reason }
}
