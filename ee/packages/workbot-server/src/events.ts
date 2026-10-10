import { z } from "zod"
import { WORKBOT_MESSAGE_PREFIX } from "./thread.js"

/** A live event from the runner: `changed` (re-read the thread), `text` (reply text as it is written), `tool` (a call starting). */
export const runnerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), messageId: z.string(), status: z.string().optional() }),
  z.object({ type: z.literal("text"), messageId: z.string(), step: z.number(), delta: z.string(), reset: z.boolean().optional() }),
  z.object({ type: z.literal("tool"), messageId: z.string(), step: z.number(), tool: z.string() }),
])

/** What the page receives: Workbot turns only, under the page's own ids. */
export type WorkbotPageEvent =
  | { type: "changed"; messageId: string; status?: string }
  | { type: "text"; messageId: string; step: number; delta: string; reset?: boolean }
  /** A step is starting: only whether it is work on Workbot's computer, never the tool's name (DESIGN C3). */
  | { type: "working"; messageId: string; step: number; on: "computer" | "other" }

/** The runner names a background task after the turn that started it: `<messageId>.t1`, `.t2`, … */
const TASK_ID = /\.t\d+$/

/** Turns one runner event into what the page may see, or null when it isn't one of this person's Workbot turns. */
export function toWorkbotPageEvent(raw: unknown): WorkbotPageEvent | null {
  const parsed = runnerEventSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.messageId.startsWith(WORKBOT_MESSAGE_PREFIX)) return null
  const event = parsed.data
  // A background task works out of sight: the page only re-reads when one starts, pauses or ends.
  if (TASK_ID.test(event.messageId) && !(event.type === "changed" && event.status)) return null
  const messageId = event.messageId.slice(WORKBOT_MESSAGE_PREFIX.length)
  if (event.type === "tool") return { type: "working", messageId, step: event.step, on: event.tool === "bash" || event.tool === "look" ? "computer" : "other" }
  return { ...event, messageId }
}
