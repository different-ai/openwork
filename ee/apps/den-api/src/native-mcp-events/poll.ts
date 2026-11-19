import { z } from "zod"
import { markFeaturesUsed } from "../feature-usage.js"
import { canonicalArguments } from "../mcp-events/protocol.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import { fingerprint, NativeEventError } from "./protocol.js"
import { readNativeSource, type NativeActor } from "./sources.js"

/** The publisher's own observer checks a source this often; a faster client poll sees nothing new. */
export const POLL_INTERVAL_MS = 5000
export const pollSchema = z.object({
  name: z.string().min(1).max(256), arguments: z.record(z.string(), z.json()),
  cursor: z.string().max(8192).nullable().optional(),
  maxAgeMs: z.number().int().nonnegative().optional(), maxEvents: z.number().int().positive().optional(),
})
const CURSOR = /^v1\.([a-f0-9]{16})\.([a-f0-9]{64})$/

/**
 * SEP-3415 poll delivery (`mcpThreads`), for clients that cannot receive a
 * webhook. Den keeps nothing per client: the cursor is the observation the
 * client last saw, so a poll reads the source once and reports a change since
 * then. Like webhook delivery, this is the observed state, not a transition
 * log: changes between two polls collapse into one event.
 */
export async function pollNativeEvent(actor: NativeActor, input: z.infer<typeof pollSchema>) {
  if (Buffer.byteLength(canonicalArguments(input.arguments)) > 16_384) throw new NativeEventError(-32602, "Event filters are too large")
  if (await checkRateLimit(`native-mcp-event-poll:${actor.organizationId}:${actor.memberId}`, 120, 60_000, Date.now()) !== null) throw new NativeEventError(-32025, "Too many poll requests", { limit: "requests", max: 120 })
  const source = await readNativeSource(actor, input.name, input.arguments)
  const subscription = fingerprint([actor.organizationId, actor.userId, input.name, input.arguments]).slice(0, 16)
  const observation = fingerprint(source.data)
  const previous = CURSOR.exec(input.cursor ?? "")
  // A cursor from another subscription is not a position in this one: start from now and say so.
  const known = previous?.[1] === subscription
  const changed = known && previous[2] !== observation
  markFeaturesUsed({ organizationId: actor.organizationId, memberId: actor.memberId, keys: ["mcpThreads"] })
  return {
    resultType: "complete" as const,
    // The id is the subscription and state, so a retried poll returns the same event.
    events: changed && source.emit ? [{ eventId: fingerprint([subscription, observation]), name: input.name, timestamp: new Date().toISOString(), data: source.data }] : [],
    cursor: `v1.${subscription}.${observation}`,
    truncated: Boolean(input.cursor) && !known,
    hasMore: false,
    nextPollMs: POLL_INTERVAL_MS,
  }
}
