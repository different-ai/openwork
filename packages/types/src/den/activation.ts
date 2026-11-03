import { z } from "zod"

/**
 * The "Get set up" checklist: the six activation recipe steps every surface shows,
 * in this order. Den computes each step from what actually happened (`GET /v1/me/activation`, and
 * `GET /v1/workbot/activation` for Workbot); clients only report what Den cannot see itself
 * (`POST /v1/me/activation/events`).
 */
export const ACTIVATION_STEP_IDS = ["first_response", "invite_teammate", "use_skill", "own_provider", "gateway_provider", "connector"] as const
export const activationStepIdSchema = z.enum(ACTIVATION_STEP_IDS)
export type ActivationStepId = z.infer<typeof activationStepIdSchema>

export const activationStepSchema = z.object({
  id: activationStepIdSchema,
  /** Checked off only once the step really worked (an answer arrived, a provider was saved, a connection is ready). */
  done: z.boolean(),
  /** Current state in a person's words, e.g. "Answered in 2.1 s" or "Google Workspace connected". */
  detail: z.string().max(200).optional(),
  /** The caller cannot do this step: who can, e.g. "Avery manages AI Gateway". */
  lockedReason: z.string().max(200).optional(),
})
export type ActivationStep = z.infer<typeof activationStepSchema>

export const activationStateSchema = z.object({
  steps: z.array(activationStepSchema),
  /** The person hid the checklist; surfaces collapse it to one quiet "Next" line. */
  dismissed: z.boolean(),
})
export type ActivationState = z.infer<typeof activationStateSchema>

/** What a client may report: steps only it can observe, and hiding the checklist. */
export const ACTIVATION_CLIENT_EVENTS = ["first_response", "use_skill", "own_provider", "dismiss"] as const
export const activationEventRequestSchema = z.object({
  step: z.enum(ACTIVATION_CLIENT_EVENTS),
  /** first_response only: how long the first answer took. */
  durationMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
}).strict()
export type ActivationEventRequest = z.infer<typeof activationEventRequestSchema>
export type ActivationClientEvent = ActivationEventRequest["step"]

/** Row titles, shared by Desktop and Workbot so both surfaces read the same. */
export const ACTIVATION_STEP_TITLES: Record<ActivationStepId, string> = {
  first_response: "Get your first answer",
  invite_teammate: "Invite a teammate",
  use_skill: "Use a skill",
  own_provider: "Set up a model provider",
  gateway_provider: "Share a provider on AI Gateway",
  connector: "Connect an app",
}

/** The six steps in recipe order; a step Den did not send counts as not done. */
export function orderedActivationSteps(state: Pick<ActivationState, "steps">): ActivationStep[] {
  return ACTIVATION_STEP_IDS.map((id) => state.steps.find((step) => step.id === id) ?? { id, done: false })
}

export function activationProgress(state: Pick<ActivationState, "steps">) {
  const steps = orderedActivationSteps(state)
  const done = steps.filter((step) => step.done).length
  return { done, total: steps.length, complete: done === steps.length }
}

/** The step the person can act on next: the first unfinished one that is not locked, else the first unfinished one. */
export function nextActivationStep(state: Pick<ActivationState, "steps">): ActivationStep | null {
  const open = orderedActivationSteps(state).filter((step) => !step.done)
  return open.find((step) => !step.lockedReason) ?? open[0] ?? null
}

/**
 * Where a surface shows the checklist: nowhere before the first answer (never before) and once all six are done;
 * one quiet "Next" line after the person hides it; otherwise the full card or chip.
 */
export function activationChecklistPresentation(state: ActivationState | null | undefined): "hidden" | "next" | "full" {
  if (!state) return "hidden"
  const steps = orderedActivationSteps(state)
  if (!steps.find((step) => step.id === "first_response")?.done) return "hidden"
  if (activationProgress(state).complete) return "hidden"
  return state.dismissed ? "next" : "full"
}

/** Answered in 2.1 s / Answered in 12 s, from a duration in milliseconds. */
export function answeredInDetail(durationMs: number): string {
  const seconds = durationMs / 1000
  return `Answered in ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
}
