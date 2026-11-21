import { createHash } from "node:crypto"
import { z } from "zod"
import { toolAppSchema, toolCallSchema, type RepeatLimits, type ToolCall, type ToolResult } from "./types.js"

export const MAX_STEP_ATTEMPTS = 5
export function retryDelayMs(attempt: number) {
  return attempt === 4 ? 30_000 : attempt === 5 ? 120_000 : 0
}
export const CHECKPOINT_INTERVAL_MS = 2_000

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
  app: toolAppSchema.optional(),
})
const usageSchema = z.object({ inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() })

export const pendingStepSchema = z.object({
  text: z.string(),
  toolCalls: z.array(toolCallSchema),
  usage: usageSchema,
  model: z.string().optional(),
  results: z.array(z.object({ callId: z.string(), result: toolResultSchema })),
})
export type PendingStep = z.infer<typeof pendingStepSchema>

export const stepStateSchema = z.object({
  v: z.literal(1),
  steps: z.number(),
  toolCalls: z.number(),
  stretchStartedAt: z.number(),
  repeat: repeatStateSchema,
  mcp: z.boolean().nullable(),
  readOnly: z.boolean().nullable(),
  cutOffs: z.number().optional(),
  pending: pendingStepSchema.optional(),
})
export type StepState = z.infer<typeof stepStateSchema>

export type StepResult = { kind: "done" } | { kind: "next" } | { kind: "wait"; ms: number } | { kind: "stopped" }

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
  if (exhausted) return { state: { ...next, askedToStop: true }, stuck: false, waitMs: 0 }
  return { state: next, stuck: false, waitMs: waits[Math.min(identicalSteps - 2, waits.length - 1)] ?? 0 }
}

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
