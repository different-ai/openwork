import { createHash } from "node:crypto"
import { HEADLESS_MAX_PROMPT_CHARS } from "@openwork-ee/headless-protocol"
import { requestExternalMcpEvents } from "../capability-sources/enterprise-mcp-client-adapter.js"
import { eventAccess, EventAccessError } from "./context.js"
import { eventPrompt, eventSchema, MAX_EVENT_BYTES, MAX_POLL_FAILURES, nextPollAt, polledSchema } from "./protocol.js"
import { acceptControl, acceptEvent, claimPoll, EventLimitError, finishPoll, stopSubscription, type EventSubscription } from "./repository.js"
import { publicOrigin } from "./subscriptions.js"

async function poll(subscription: EventSubscription) {
  if (!subscription.connectionId) throw new EventAccessError("Missing connection")
  const { connections } = await eventAccess(subscription, subscription.scopes)
  const connection = connections.find((entry) => entry.id === subscription.connectionId)
  if (!connection) throw new EventAccessError("Connection no longer available")
  return polledSchema.parse(await requestExternalMcpEvents({
    connection, member: { orgMembershipId: subscription.memberId },
    redirectUri: `${publicOrigin()}/v1/mcp-connections/${connection.id}/connect/callback`,
    method: "events/poll", params: { name: subscription.name, arguments: JSON.parse(subscription.arguments), cursor: subscription.cursor },
  }))
}

export async function pollMcpEvent(): Promise<boolean> {
  const subscription = await claimPoll()
  if (!subscription) return false
  try {
    const result = await poll(subscription)
    const cursor = result.cursor ?? subscription.cursor
    if (result.truncated && subscription.cursor !== null) {
      await acceptControl(subscription, { type: "gap", cursor }, `poll-gap-${createHash("sha256").update(cursor ?? "").digest("hex").slice(0, 32)}`)
    }
    for (const raw of result.events) {
      const event = eventSchema.safeParse(raw)
      if (!event.success || event.data.name !== subscription.name) continue
      if (Buffer.byteLength(JSON.stringify(event.data)) > MAX_EVENT_BYTES) continue
      if (eventPrompt(subscription.instruction, subscription, event.data).length > HEADLESS_MAX_PROMPT_CHARS) continue
      await acceptEvent(subscription, { eventId: event.data.eventId, name: event.data.name, timestamp: event.data.timestamp, data: event.data.data })
    }
    await finishPoll(subscription.id, { cursor, nextPollAt: nextPollAt(result.nextPollMs), pollFailures: 0 })
  } catch (error) {
    if (error instanceof EventAccessError) {
      await stopSubscription(subscription.id)
    } else if (error instanceof EventLimitError) {
      await finishPoll(subscription.id, { nextPollAt: null, pollFailures: subscription.pollFailures })
    } else if (subscription.pollFailures + 1 >= MAX_POLL_FAILURES) {
      await finishPoll(subscription.id, { nextPollAt: null, pollFailures: subscription.pollFailures + 1 })
      await acceptControl(subscription, { type: "terminated", error: { code: -32603, message: "The MCP server stopped answering polls." } }, "poll-terminated").catch(() => undefined)
    } else {
      await finishPoll(subscription.id, { nextPollAt: nextPollAt(undefined), pollFailures: subscription.pollFailures + 1 })
    }
  }
  return true
}
