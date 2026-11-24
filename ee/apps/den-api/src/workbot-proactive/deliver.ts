import type { AgentMemberCheckMessage } from "@openwork-ee/den-db/schema"
import type { AgentDestinationBlock } from "@openwork/types/den/workbot-proactive"
import {
  resolveWorkbotDirectMessageTarget,
  sendWorkbotDirectMessage,
  type WorkbotDirectMessageResult,
  type WorkbotDirectMessageTarget,
} from "../slack-assistant/direct-message.js"

export type DeliveryResult = { ok: true; message?: AgentMemberCheckMessage } | { ok: false; code: AgentDestinationBlock | "send_failed" }

export type DeliveryDeps = {
  target: (input: { organizationId: string; userId: string }) => Promise<WorkbotDirectMessageTarget>
  send: (input: { organizationId: string; userId: string; text: string; permalink?: boolean }) => Promise<WorkbotDirectMessageResult>
}

export const defaultDeliveryDeps: DeliveryDeps = {
  target: (input) => resolveWorkbotDirectMessageTarget(input),
  send: (input) => sendWorkbotDirectMessage(input),
}

export async function destinationBlock(input: { organizationId: string; userId: string }, deps: Pick<DeliveryDeps, "target"> = defaultDeliveryDeps): Promise<AgentDestinationBlock | null> {
  const target = await deps.target(input)
  return target.ok ? null : target.reason
}

export async function deliverAgentMessage(input: { organizationId: string; userId: string; text: string }, deps: DeliveryDeps = defaultDeliveryDeps): Promise<DeliveryResult> {
  const sent = await deps.send({ ...input, permalink: true })
  if (sent.ok) return { ok: true, message: { channelId: sent.channelId, messageTs: sent.messageTs, permalink: sent.permalink ?? null } }
  return { ok: false, code: sent.reason === "slack_error" ? "send_failed" : sent.reason }
}
