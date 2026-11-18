import { z } from "zod"
import { WORKBOT_MESSAGE_PREFIX } from "./thread.js"

/** A live event from the runner: `changed` (re-read the thread), `text` (reply text as it is written), `tool` (a call starting). */
export const runnerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), messageId: z.string(), status: z.string().optional() }),
  z.object({ type: z.literal("text"), messageId: z.string(), step: z.number(), delta: z.string(), reset: z.boolean().optional() }),
  z.object({ type: z.literal("tool"), messageId: z.string(), step: z.number(), tool: z.string(), description: z.string().optional(), view: z.enum(["browser", "computer"]).optional() }),
])

/** What the page receives: Workbot turns only, under the page's own ids. */
export type WorkbotPageEvent =
  | { type: "changed"; messageId: string; status?: string }
  | { type: "text"; messageId: string; step: number; delta: string; reset?: boolean }
  /**
   * A step is starting: only whether it is work on Workbot's computer, and whether that work is in the background
   * (commands, with no screen to watch), never the tool's name (DESIGN C3). Screen work names its `surface` (its
   * browser or the rest of its computer) as soon as the model has written which, so the page shows browser work as
   * browser work from its first frame; until then the page doesn't guess. Computer work says what it is doing in
   * `update` as soon as the model has written that, the same words the stored step shows.
   */
  | { type: "working"; messageId: string; step: number; on: "computer" | "other"; background?: true; surface?: "browser" | "computer"; update?: string }

/** The runner names a background task after the turn that started it: `<messageId>.t1`, `.t2`, … */
const TASK_ID = /\.t\d+$/

/** When each task last told the page about a step, so a busy task re-reads the page at most this often. */
const taskSteps = new Map<string, number>()
const TASK_STEP_EVERY_MS = 3_000

/** Turns one runner event into what the page may see, or null when it isn't one of this person's Workbot turns. */
export function toWorkbotPageEvent(raw: unknown): WorkbotPageEvent | null {
  const parsed = runnerEventSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.messageId.startsWith(WORKBOT_MESSAGE_PREFIX)) return null
  const event = parsed.data
  const messageId = event.messageId.slice(WORKBOT_MESSAGE_PREFIX.length)
  if (TASK_ID.test(event.messageId)) {
    // A background task works out of sight: the page re-reads when one starts, pauses or ends, and, at most every
    // few seconds, when it starts a step, so the task sheet and the header follow it while it runs. Its words never
    // stream to the page.
    if (event.type === "changed" && event.status) return { ...event, messageId }
    if (event.type !== "tool") return null
    const now = Date.now()
    const last = taskSteps.get(event.messageId) ?? 0
    if (now - last < TASK_STEP_EVERY_MS) return null
    taskSteps.set(event.messageId, now)
    if (taskSteps.size > 500) taskSteps.delete(taskSteps.keys().next().value ?? "")
    return { type: "changed", messageId }
  }
  if (event.type === "tool") {
    // Cut like the stored step's updates (thread.ts), so the live words and the stored ones match.
    const doing = event.description?.trim().slice(0, 80)
    const update = doing ? { update: doing } : {}
    if (event.tool === "desktop") return { type: "working", messageId, step: event.step, on: "computer", ...(event.view ? { surface: event.view } : {}), ...update }
    if (event.tool === "bash" || event.tool === "look") return { type: "working", messageId, step: event.step, on: "computer", background: true, ...update }
    return { type: "working", messageId, step: event.step, on: "other" }
  }
  return { ...event, messageId }
}
