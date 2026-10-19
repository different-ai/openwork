import { z } from "zod"

/**
 * Workbot's live stream (`GET /v1/workbot/events`, server-sent events): reply text as it is written, a step
 * starting, and "re-read the conversation" when something changed. The stream ends every few minutes and the client
 * reopens it; one re-read picks up anything missed while it was closed.
 */

/** Reply text streamed for one turn's model call `step`, before that call is stored; and whether it started a step. */
export type LiveText = { step: number; text: string; working?: { on: "computer" | "other"; since: number } }

export const liveEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), messageId: z.string(), status: z.string().optional() }),
  z.object({ type: z.literal("text"), messageId: z.string(), step: z.number(), delta: z.string(), reset: z.boolean().optional() }),
  z.object({ type: z.literal("working"), messageId: z.string(), step: z.number(), on: z.enum(["computer", "other"]) }),
])
export type LiveEvent = z.infer<typeof liveEventSchema>

/**
 * Splits what has arrived into complete event blocks (`data:` lines joined) and what is still incomplete. Comments
 * (keep-alives) and the `ready` event carry nothing for the conversation and are dropped.
 */
export function takeEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let rest = buffer.replace(/\r\n?/g, "\n")
  let boundary = rest.indexOf("\n\n")
  while (boundary !== -1) {
    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    boundary = rest.indexOf("\n\n")
    if (block.startsWith(":") || /^event:\s*ready/m.test(block)) continue
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    if (data) events.push(data)
  }
  return { events, rest }
}

/** One event's data, validated; null when it isn't one the conversation understands. */
export function parseLiveEvent(data: string): LiveEvent | null {
  try {
    const parsed = liveEventSchema.safeParse(JSON.parse(data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The live text by message after one text or working event (a `changed` event re-reads instead). */
export function applyLiveEvent(current: Readonly<Record<string, LiveText>>, event: Exclude<LiveEvent, { type: "changed" }>, now: number): Record<string, LiveText> {
  const previous = current[event.messageId]
  if (previous && event.step < previous.step) return { ...current }
  const sameStep = previous?.step === event.step
  if (event.type === "working") {
    return { ...current, [event.messageId]: { step: event.step, text: sameStep ? previous.text : "", working: { on: event.on, since: now } } }
  }
  const text = event.reset || !sameStep ? event.delta : previous.text + event.delta
  return { ...current, [event.messageId]: { step: event.step, text, ...(sameStep && previous.working && !event.reset ? { working: previous.working } : {}) } }
}

/** How long to wait before reopening the stream: at once the first time, then 1, 2, 4 and at most 8 seconds. */
export function reconnectDelay(attempt: number) {
  return Math.min(10_000, attempt <= 1 ? 250 : 1_000 * 2 ** Math.min(attempt - 2, 3))
}
