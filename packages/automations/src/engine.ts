import { z } from "zod"
import {
  automationErrorSchema,
  automationRevisionSchema,
  automationRunEventTypeSchema,
  automationRunSchema,
  automationSchema,
  automationUsageSchema,
} from "@openwork/types/automations"

const engineIdSchema = z.string().trim().min(1).max(240)
const timestampSchema = z.number().int().nonnegative()

export type AutomationEngineAttachmentValue =
  | string
  | number
  | boolean
  | null
  | AutomationEngineAttachmentValue[]
  | { [key: string]: AutomationEngineAttachmentValue }

export const automationEngineAttachmentValueSchema: z.ZodType<
  AutomationEngineAttachmentValue
> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(automationEngineAttachmentValueSchema),
  z.record(z.string(), automationEngineAttachmentValueSchema),
]))

/**
 * Provider-neutral behavior Den can rely on before admitting work. Receipts,
 * events, and results remain readable after the Den process that admitted the
 * run has stopped.
 */
export const automationEngineCapabilityDeclarationSchema = z.object({
  adapterId: engineIdSchema,
  protocolVersion: z.literal(1),
  admission: z.literal("idempotent"),
  reattachment: z.literal("receipt"),
  eventDelivery: z.literal("ordered_at_least_once"),
  resultPersistence: z.literal("durable"),
  cancellation: z.enum(["supported", "best_effort", "unsupported"]),
  isolation: z.object({
    location: z.literal("cloud"),
    filesystem: z.literal("none"),
    shell: z.literal(false),
    browser: z.literal(false),
    computer: z.literal(false),
    connect: z.literal("run-scoped"),
    network: z.literal("provider-and-connect-only"),
  }),
})
export type AutomationEngineCapabilityDeclaration = z.infer<
  typeof automationEngineCapabilityDeclarationSchema
>

export const automationEngineCapabilityAccessSchema = z.object({
  endpoint: z.string().url(),
  bearerToken: z.string().min(1).max(16_384),
  expiresAt: timestampSchema,
})
export type AutomationEngineCapabilityAccess = z.infer<
  typeof automationEngineCapabilityAccessSchema
>

export const automationEngineAdmissionRequestSchema = z.object({
  admissionKey: z.string().trim().min(1).max(512),
  automation: automationSchema,
  revision: automationRevisionSchema,
  run: automationRunSchema,
  capabilityAccess: automationEngineCapabilityAccessSchema,
  requestedAt: timestampSchema,
}).superRefine((request, context) => {
  if (request.revision.automationId !== request.automation.id) {
    context.addIssue({ code: "custom", message: "Revision does not belong to the Automation" })
  }
  if (
    request.run.automationId !== request.automation.id
    || request.run.revisionId !== request.revision.id
  ) {
    context.addIssue({ code: "custom", message: "Run does not belong to the Automation revision" })
  }
})
export type AutomationEngineAdmissionRequest = z.infer<
  typeof automationEngineAdmissionRequestSchema
>

/**
 * Persistence-safe reattachment receipt. `attachment` is opaque to Den and
 * must not contain credentials; the adapter owns its shape and interpretation.
 */
export const automationEngineAdmissionReceiptSchema = z.object({
  receiptVersion: z.literal(1),
  adapterId: engineIdSchema,
  executionId: engineIdSchema,
  admissionKey: z.string().trim().min(1).max(512),
  runId: engineIdSchema,
  admittedAt: timestampSchema,
  attachment: z.record(z.string(), automationEngineAttachmentValueSchema),
})
export type AutomationEngineAdmissionReceipt = z.infer<
  typeof automationEngineAdmissionReceiptSchema
>

export const automationEngineExecutionStateSchema = z.enum([
  "admitted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
])
export type AutomationEngineExecutionState = z.infer<
  typeof automationEngineExecutionStateSchema
>

/** Stable event identity plus a strictly increasing per-execution sequence. */
export const automationEngineEventSchema = z.object({
  id: engineIdSchema,
  idempotencyKey: z.string().trim().min(1).max(512),
  executionId: engineIdSchema,
  runId: engineIdSchema,
  sequence: z.number().int().positive(),
  type: automationRunEventTypeSchema,
  payload: z.record(z.string(), automationEngineAttachmentValueSchema),
  createdAt: timestampSchema,
})
export type AutomationEngineEvent = z.infer<typeof automationEngineEventSchema>

export const automationEngineResultSchema = z.object({
  executionId: engineIdSchema,
  runId: engineIdSchema,
  status: z.enum(["succeeded", "failed", "cancelled"]),
  threadId: engineIdSchema.nullable(),
  resultSummary: z.string().max(20_000).nullable(),
  usage: automationUsageSchema,
  error: automationErrorSchema.nullable(),
  finalSequence: z.number().int().nonnegative(),
  finishedAt: timestampSchema,
}).superRefine((result, context) => {
  if (result.status === "succeeded" && result.error !== null) {
    context.addIssue({ code: "custom", message: "A succeeded engine result cannot contain an error" })
  }
  if (result.status !== "succeeded" && result.error === null) {
    context.addIssue({ code: "custom", message: "A failed or cancelled engine result needs an error" })
  }
})
export type AutomationEngineResult = z.infer<typeof automationEngineResultSchema>

export const automationEnginePendingResultSchema = z.object({
  status: z.literal("pending"),
  state: z.enum(["admitted", "running"]),
  executionId: engineIdSchema,
  runId: engineIdSchema,
  latestSequence: z.number().int().nonnegative(),
  updatedAt: timestampSchema,
})
export type AutomationEnginePendingResult = z.infer<
  typeof automationEnginePendingResultSchema
>

export const automationEngineReadResultSchema = z.union([
  automationEnginePendingResultSchema,
  automationEngineResultSchema,
])
export type AutomationEngineReadResult = z.infer<
  typeof automationEngineReadResultSchema
>

export const automationEngineCancellationResultSchema = z.object({
  executionId: engineIdSchema,
  runId: engineIdSchema,
  outcome: z.enum(["requested", "already_terminal", "unsupported", "not_found"]),
  requestedAt: timestampSchema,
})
export type AutomationEngineCancellationResult = z.infer<
  typeof automationEngineCancellationResultSchema
>

export interface AutomationEngineObserveOptions {
  /** Exclusive durable cursor. Omit it to observe from sequence one. */
  afterSequence?: number
  signal?: AbortSignal
}

export interface AutomationEngineAdapter {
  capabilities(): Promise<AutomationEngineCapabilityDeclaration>
  admit(
    request: AutomationEngineAdmissionRequest,
  ): Promise<AutomationEngineAdmissionReceipt>
  observe(
    receipt: AutomationEngineAdmissionReceipt,
    options?: AutomationEngineObserveOptions,
  ): AsyncIterable<AutomationEngineEvent>
  read(
    receipt: AutomationEngineAdmissionReceipt,
  ): Promise<AutomationEngineReadResult | null>
  cancel(
    receipt: AutomationEngineAdmissionReceipt,
  ): Promise<AutomationEngineCancellationResult>
}

export interface AutomationEngineEventSequenceValidator {
  readonly cursor: number
  accept(event: AutomationEngineEvent): void
}

/** Validates events before Den persists them and advances its durable cursor. */
export function createAutomationEngineEventSequenceValidator(
  rawReceipt: AutomationEngineAdmissionReceipt,
  afterSequence = 0,
): AutomationEngineEventSequenceValidator {
  const receipt = automationEngineAdmissionReceiptSchema.parse(rawReceipt)
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new Error("Automation engine event cursor must be a non-negative integer")
  }
  let cursor = afterSequence
  const eventKeys = new Set<string>()
  return {
    get cursor() {
      return cursor
    },
    accept(rawEvent) {
      const event = automationEngineEventSchema.parse(rawEvent)
      if (event.executionId !== receipt.executionId || event.runId !== receipt.runId) {
        throw new Error("Automation engine event receipt mismatch")
      }
      if (event.sequence !== cursor + 1) {
        throw new Error("Automation engine event sequence is not contiguous")
      }
      if (eventKeys.has(event.idempotencyKey)) {
        throw new Error("Automation engine event idempotency key was repeated")
      }
      eventKeys.add(event.idempotencyKey)
      cursor = event.sequence
    },
  }
}
