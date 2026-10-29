import { createHash } from "node:crypto"
import { z } from "zod"
import { toolCallSchema, type RepeatLimits, type ToolCall, type ToolResult } from "./types.js"

/**
 * Step mode (`execution: "steps"`): a turn runs one step at a time from what is stored, instead of in one go.
 *
 * A step is: build the context, one streaming model call, that call's tool calls, then one SQLite transaction that
 * writes the step's messages and tool results, its bookkeeping (this state), the turn's next step and the attempt
 * reset. Between steps nothing runs, so on celld a runner deploy switches the cell there instead of cancelling work.
 *
 * - **Crash loops.** `attempt` counts a step's starts and is written before its model call; a commit resets it. A
 *   step that keeps dying (the cell is cancelled or crashes in it) runs again at once twice, then after 30 s and 2
 *   minutes, then its turn fails with `step_crash_loop`.
 * - **No repeated writes.** Once the model has answered with tool calls, the answer is kept (`pending`) before any
 *   call runs, and each result as it returns. A step that dies there finishes from it: a call without a recorded
 *   result is never run again, it gets an error result so the model can check its effect.
 * - **Stream checkpoints.** A long model call keeps its text so far (at most every 2 s). A step that restarts after a
 *   cancel continues that text where the provider accepts a partial answer (Anthropic Messages without extended
 *   thinking) and otherwise starts over. Nothing but text is kept, so a half-written tool call is never run.
 */

/** A step's starts before its turn fails with `step_crash_loop`. */
export const MAX_STEP_ATTEMPTS = 5
/** How long to wait before a step's attempt `n`: at once for the first three, then 30 s and 2 minutes. */
export function retryDelayMs(attempt: number) {
  return attempt === 4 ? 30_000 : attempt === 5 ? 120_000 : 0
}
/** A long model call keeps its text so far at most this often. */
export const CHECKPOINT_INTERVAL_MS = 2_000

/** Same calls, same inputs, same results as the step before: waiting on something, or stuck (see REPEAT_WAITS_MS). */
export const repeatStateSchema = z.object({
  lastStep: z.string(),
  identicalSteps: z.number(),
  repeatStartedAt: z.number(),
  askedToStop: z.boolean(),
})
export type RepeatState = z.infer<typeof repeatStateSchema>
export const FRESH_REPEAT: RepeatState = { lastStep: "", identicalSteps: 0, repeatStartedAt: 0, askedToStop: false }

const toolResultSchema = z.object({
  output: z.string(),
  isError: z.boolean(),
  images: z.array(z.object({ mediaType: z.string(), data: z.string() })).optional(),
  documents: z.array(z.object({ mediaType: z.literal("application/pdf"), data: z.string(), name: z.string() })).optional(),
})
const usageSchema = z.object({ inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() })

/** The model's answer for a step whose tool calls are running, and their results so far. */
export const pendingStepSchema = z.object({
  text: z.string(),
  toolCalls: z.array(toolCallSchema),
  usage: usageSchema,
  model: z.string().optional(),
  results: z.array(z.object({ callId: z.string(), result: toolResultSchema })),
})
export type PendingStep = z.infer<typeof pendingStepSchema>

/** What one run of a step-mode turn keeps between steps. Never credentials. */
export const stepStateSchema = z.object({
  v: z.literal(1),
  /** Model calls in this run (HEADLESS_MAX_STEPS) and their tool calls, for the turn's log line. */
  steps: z.number(),
  toolCalls: z.number(),
  /** When this run started, or its credentials were last refreshed: the turn timeout applies to each stretch. */
  stretchStartedAt: z.number(),
  repeat: repeatStateSchema,
  /**
   * Whether the turn has an MCP token and is read-only, so a run whose held credentials were lost (the cell
   * restarted) asks Den for the same kind; null when that wasn't known either.
   */
  mcp: z.boolean().nullable(),
  readOnly: z.boolean().nullable(),
  /** Replies in a row that stopped at the output-token cap; the next step asks for less (CUT_OFF_INSTRUCTION). */
  cutOffs: z.number().optional(),
  pending: pendingStepSchema.optional(),
})
export type StepState = z.infer<typeof stepStateSchema>

export type StepResult = { kind: "done" } | { kind: "next" } | { kind: "wait"; ms: number } | { kind: "stopped" }

/**
 * The repeat check after a step (the same rule in both modes). `stuck`: the model was already asked to stop and
 * repeated the step anyway, so the turn fails. Otherwise `waitMs` before the next step (0 for none).
 */
export function afterStep(
  state: RepeatState,
  toolCalls: readonly ToolCall[],
  outcomes: readonly ToolResult[],
  limits: Required<RepeatLimits>,
  waits: readonly number[],
  now: number,
): { state: RepeatState; stuck: boolean; waitMs: number } {
  const signature = createHash("sha256")
    .update(JSON.stringify(toolCalls.map((call, index) => [call.name, call.input, outcomes[index]?.output, outcomes[index]?.isError])))
    .digest("hex")
  const identicalSteps = signature === state.lastStep ? state.identicalSteps + 1 : 1
  if (identicalSteps === 1) return { state: { lastStep: signature, identicalSteps, repeatStartedAt: now, askedToStop: false }, stuck: false, waitMs: 0 }
  const failing = outcomes.every((outcome) => outcome.isError)
  const exhausted = failing ? identicalSteps >= limits.maxIdenticalFailures : now - state.repeatStartedAt >= limits.maxWaitingMs
  const next = { ...state, lastStep: signature, identicalSteps }
  if (exhausted && state.askedToStop) return { state: next, stuck: true, waitMs: 0 }
  // Let the model report what it was waiting for, instead of ending on a generic failure.
  if (exhausted) return { state: { ...next, askedToStop: true }, stuck: false, waitMs: 0 }
  return { state: next, stuck: false, waitMs: waits[Math.min(identicalSteps - 2, waits.length - 1)] ?? 0 }
}

/**
 * Keeps a streaming answer's text so far, at most once per interval: the newest text is written when the interval
 * since the last write is up. Writes never throw into the stream.
 */
export class CheckpointWriter {
  private latest = ""
  private saved = ""
  private last: number
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly save: (text: string) => void,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.last = now()
  }

  note(text: string) {
    this.latest = text
    if (this.timer || text === this.saved) return
    this.timer = setTimeout(() => this.flush(), Math.max(0, this.last + this.intervalMs - this.now()))
  }

  private flush() {
    this.timer = undefined
    this.last = this.now()
    if (this.latest === this.saved) return
    this.saved = this.latest
    try {
      this.save(this.latest)
    } catch (error) {
      console.warn(`[headless-runner] checkpoint not saved ${JSON.stringify({ error: error instanceof Error ? error.message : "unknown" })}`)
    }
  }

  stop() {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
