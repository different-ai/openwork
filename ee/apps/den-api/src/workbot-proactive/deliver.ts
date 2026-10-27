import type { AgentDestinationBlock } from "@openwork/types/den/workbot-proactive"
import {
  resolveWorkbotDirectMessageTarget,
  sendWorkbotDirectMessage,
  type WorkbotDirectMessageResult,
  type WorkbotDirectMessageTarget,
} from "../slack-assistant/direct-message.js"

/**
 * Delivery: Den, not the model, sends the message after the delivery policy passed, and the model never picks who
 * gets it. Always a DM from the Workbot Slack app's own bot, so the member is notified and nobody else sees it: the
 * agent reads private email, and its messages go only to the member.
 */

export type DeliveryResult = { ok: true } | { ok: false; code: AgentDestinationBlock | "send_failed" }

export type DeliveryDeps = {
  target: (input: { organizationId: string; userId: string }) => Promise<WorkbotDirectMessageTarget>
  send: (input: { organizationId: string; userId: string; text: string }) => Promise<WorkbotDirectMessageResult>
}

export const defaultDeliveryDeps: DeliveryDeps = {
  target: (input) => resolveWorkbotDirectMessageTarget(input),
  send: (input) => sendWorkbotDirectMessage(input),
}

/** Why a message couldn't reach the member now (no Slack app, Slack not linked), or null. Sends nothing. */
export async function destinationBlock(input: { organizationId: string; userId: string }, deps: Pick<DeliveryDeps, "target"> = defaultDeliveryDeps): Promise<AgentDestinationBlock | null> {
  const target = await deps.target(input)
  return target.ok ? null : target.reason
}

export async function deliverAgentMessage(input: { organizationId: string; userId: string; text: string }, deps: DeliveryDeps = defaultDeliveryDeps): Promise<DeliveryResult> {
  const sent = await deps.send(input)
  if (sent.ok) return { ok: true }
  return { ok: false, code: sent.reason === "slack_error" ? "send_failed" : sent.reason }
}
