import { z } from "zod"

const idSchema = z.string().trim().min(1).max(160)
const timestampSchema = z.number().int().nonnegative()
const nullableTimestampSchema = timestampSchema.nullable()
const timezoneSchema = z.string().trim().min(1).max(120).refine((timezone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0))
    return true
  } catch {
    return false
  }
}, "Expected a valid IANA timezone")

export const automationStateSchema = z.enum(["active", "inactive", "needs_attention", "archived"])
export type AutomationState = z.infer<typeof automationStateSchema>

export const automationRunStatusSchema = z.enum([
  "queued", "claimed", "running", "succeeded", "failed", "cancelled", "skipped",
])
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>

export const automationRunTriggerSchema = z.enum(["scheduled", "recovery", "manual"])
export type AutomationRunTrigger = z.infer<typeof automationRunTriggerSchema>

export const automationScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), timezone: timezoneSchema, at: timestampSchema }),
  z.object({
    kind: z.literal("daily"),
    timezone: timezoneSchema,
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("weekly"),
    timezone: timezoneSchema,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7)
      .transform((days) => [...new Set(days)].sort((left, right) => left - right)),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
])
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>

/**
 * `variant` is the model's reasoning/thinking level, the same value the
 * composer sends as its behavior pill. It is optional because most models
 * expose no variants, and null means "whatever the provider defaults to".
 */
export const automationModelSchema = z.object({
  providerId: idSchema,
  modelId: idSchema,
  variant: z.string().trim().min(1).max(60).nullable().optional(),
})
export type AutomationModel = z.infer<typeof automationModelSchema>

export const automationSavedScriptReferenceSchema = z.object({
  pluginId: idSchema,
  configObjectId: idSchema,
  configObjectVersionId: idSchema,
}).strict()
export type AutomationSavedScriptReference = z.infer<typeof automationSavedScriptReferenceSchema>

export const automationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    instructions: z.string().trim().min(1).max(100_000),
    model: automationModelSchema,
  }).strict(),
  z.object({
    kind: z.literal("saved_script"),
    script: automationSavedScriptReferenceSchema,
    input: z.unknown().optional(),
  }).strict(),
])
export type AutomationAction = z.infer<typeof automationActionSchema>

/**
 * Canonical identity for the free Automation starter model. Runtime provider
 * configuration belongs to the desktop's OpenCode installation, not Den.
 */
export const AUTOMATION_FREE_MODEL = {
  providerId: "opencode",
  modelId: "big-pickle",
  providerName: "OpenCode Zen",
  modelName: "Big Pickle",
} as const

export const automationNeedsAttentionReasonSchema = z.object({
  code: z.enum([
    "owner_membership_lost",
    "model_access_lost",
    "provider_unavailable",
    "connect_access_unavailable",
    "execution_runtime_unavailable",
  ]),
  message: z.string().trim().min(1).max(2_000),
  occurredAt: timestampSchema,
})
export type AutomationNeedsAttentionReason = z.infer<typeof automationNeedsAttentionReasonSchema>

export const automationSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  ownerMemberId: idSchema,
  name: z.string().trim().min(1).max(120),
  state: automationStateSchema,
  currentRevisionId: idSchema,
  nextDueAt: nullableTimestampSchema,
  latestRunAt: nullableTimestampSchema,
  latestSuccessfulRunId: idSchema.nullable().optional(),
  latestSuccessfulResult: z.unknown().optional(),
  needsAttentionReason: automationNeedsAttentionReasonSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: nullableTimestampSchema,
})
export type Automation = z.infer<typeof automationSchema>

export const automationRevisionSchema = z.object({
  id: idSchema,
  automationId: idSchema,
  version: z.number().int().positive(),
  instructions: z.string().trim().min(1).max(100_000),
  schedule: automationScheduleSchema,
  model: automationModelSchema,
  action: automationActionSchema.optional(),
  executionTarget: z.enum(["desktop", "cloud"]).optional(),
  maximumRuntimeMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
  digest: z.string().trim().min(16).max(128),
  createdAt: timestampSchema,
})
export type AutomationRevision = z.infer<typeof automationRevisionSchema>

export const automationErrorSchema = z.object({
  code: z.enum([
    "owner_membership_lost",
    "model_access_lost",
    "provider_unavailable",
    "connect_access_unavailable",
    "execution_runtime_unavailable",
    "execution_failed",
    "execution_timed_out",
    "runner_unavailable",
    "cancelled",
    "lease_lost",
    "internal_error",
  ]),
  message: z.string().trim().min(1).max(2_000),
  retryable: z.boolean(),
})
export type AutomationError = z.infer<typeof automationErrorSchema>

export const automationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costMicros: z.number().int().nonnegative().nullable(),
})
export type AutomationUsage = z.infer<typeof automationUsageSchema>

export const automationExecutionThreadSchema = z.object({
  id: idSchema,
  threadKind: z.literal("automation"),
  executionLocation: z.enum(["desktop", "cloud"]),
  automationId: idSchema,
  automationRunId: idSchema,
  engineKind: idSchema,
  /** Native OpenCode session identity for agent runs. */
  nativeThreadId: idSchema.nullable().optional(),
  workspaceId: idSchema.nullable().optional(),
})
export type AutomationExecutionThread = z.infer<typeof automationExecutionThreadSchema>

/** Creation surface fixes execution placement: Desktop stays local; Web runs in Cloud. */
export const automationExecutionTargetSchema = z.enum(["desktop", "cloud"])
export type AutomationExecutionTarget = z.infer<typeof automationExecutionTargetSchema>

export const AUTOMATION_MODEL_ATTENTION_CAPABILITY = "model_attention_v1" as const
export const AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER = "x-openwork-automation-model-attention" as const
export const automationDesktopRunnerCapabilitySchema = z.literal(AUTOMATION_MODEL_ATTENTION_CAPABILITY)
export type AutomationDesktopRunnerCapability = z.infer<typeof automationDesktopRunnerCapabilitySchema>

export const automationDesktopRunnerRegistrationSchema = z.object({
  runnerId: idSchema.min(8),
  protocolVersion: z.literal(1),
  supportedExecutionTargets: z.array(z.literal("desktop")).length(1),
  capabilities: z.array(automationDesktopRunnerCapabilitySchema).max(1).default([]),
  appVersion: z.string().trim().min(1).max(80),
  platform: z.enum(["darwin", "win32", "linux"]),
  concurrency: z.number().int().min(1).max(4),
})
export type AutomationDesktopRunnerRegistration = z.infer<typeof automationDesktopRunnerRegistrationSchema>

export const automationRunnerNotificationSchema = z.object({
  type: z.enum(["automation_work_available", "automation_cancellation_available"]),
  cursor: z.string().trim().min(1).max(40),
}).strict()
export type AutomationRunnerNotification = z.infer<typeof automationRunnerNotificationSchema>

export const automationRunnerWorkItemSchema = z.object({
  runId: idSchema,
  executionTarget: z.literal("desktop"),
})
export const automationRunnerWorkResponseSchema = z.object({
  items: z.array(automationRunnerWorkItemSchema).max(4),
})
export type AutomationRunnerWorkResponse = z.infer<typeof automationRunnerWorkResponseSchema>

export const automationDesktopRunnerAssignmentSchema = z.object({
  executionTarget: z.literal("desktop"),
  runId: idSchema,
  automationId: idSchema,
  automationName: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(100_000),
  model: automationModelSchema,
  timeoutMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
  leaseExpiresAt: timestampSchema,
  attempt: z.number().int().positive(),
})
export type AutomationDesktopRunnerAssignment = z.infer<typeof automationDesktopRunnerAssignmentSchema>

export const automationDesktopRunnerResultSchema = z.object({
  attempt: z.number().int().positive(),
  status: z.enum(["succeeded", "failed", "cancelled"]),
  sessionId: z.string().trim().min(1).max(240).nullable(),
  workspaceId: z.string().trim().min(1).max(240).nullable(),
  resultSummary: z.string().max(20_000).nullable(),
  usage: automationUsageSchema,
  error: automationErrorSchema.nullable(),
})
export type AutomationDesktopRunnerResult = z.infer<typeof automationDesktopRunnerResultSchema>

export const automationRunnerHeartbeatRequestSchema = z.object({ attempt: z.number().int().positive() })
export const automationRunnerHeartbeatResponseSchema = z.object({
  attempt: z.number().int().positive(),
  leaseValid: z.literal(true),
  cancelRequested: z.boolean(),
  leaseExpiresAt: timestampSchema,
})
export const automationRunnerEventRequestSchema = z.object({
  attempt: z.number().int().positive(),
  sequence: z.number().int().positive(),
  type: z.enum(["user", "assistant", "capability_search", "capability_execution", "usage", "warning", "terminal"]),
  payload: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
})
export const automationRunnerLeaseRejectionSchema = z.object({
  error: z.literal("runner_lease_lost"),
})
export const automationRunnerUnavailableOutcomeSchema = z.object({
  status: z.literal("skipped"),
  reason: z.literal("runner_unavailable"),
  executionTarget: automationExecutionTargetSchema,
})

export const automationRunnerTokenResponseSchema = z.object({
  token: z.string().trim().min(32).max(512),
  expiresAt: timestampSchema,
  eventsPath: z.literal("/v1/automation-runners/events"),
})
export type AutomationRunnerTokenResponse = z.infer<typeof automationRunnerTokenResponseSchema>

export const automationRunSchema = z.object({
  id: idSchema,
  automationId: idSchema,
  revisionId: idSchema,
  trigger: automationRunTriggerSchema,
  scheduledFor: nullableTimestampSchema,
  idempotencyKey: z.string().trim().min(1).max(512),
  status: automationRunStatusSchema,
  leaseOwner: z.string().trim().min(1).max(240).nullable(),
  leaseExpiresAt: nullableTimestampSchema,
  heartbeatAt: nullableTimestampSchema,
  attemptCount: z.number().int().min(0).max(2),
  executionTarget: automationExecutionTargetSchema,
  executionThread: automationExecutionThreadSchema.nullable(),
  providerId: idSchema,
  modelId: idSchema,
  modelVariant: z.string().trim().min(1).max(60).nullable().default(null),
  startedAt: nullableTimestampSchema,
  finishedAt: nullableTimestampSchema,
  error: automationErrorSchema.nullable(),
  resultSummary: z.string().max(20_000).nullable(),
  codemodeReceiptId: idSchema.nullable().optional(),
  validatedResult: z.unknown().optional(),
  usage: automationUsageSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type AutomationRun = z.infer<typeof automationRunSchema>

export const automationRunEventTypeSchema = z.enum([
  "user", "assistant", "capability_search", "capability_execution", "usage", "warning", "terminal",
])
export type AutomationRunEventType = z.infer<typeof automationRunEventTypeSchema>

export const automationRunEventSchema = z.object({
  id: idSchema,
  runId: idSchema,
  attempt: z.number().int().positive(),
  sequence: z.number().int().positive(),
  type: automationRunEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
})
export type AutomationRunEvent = z.infer<typeof automationRunEventSchema>

const legacyCreateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(100_000),
  schedule: automationScheduleSchema,
  model: automationModelSchema,
})

const actionCreateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  schedule: automationScheduleSchema,
  action: automationActionSchema,
  executionTarget: automationExecutionTargetSchema,
}).superRefine((value, context) => {
  const validPair = value.executionTarget === "cloud"
  if (!validPair) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Action-based Automations are created by Web and run in OpenWork Cloud.",
      path: ["executionTarget"],
    })
  }
})

/** Cloud Chat/Web creation cannot express Desktop placement. */
export const createCloudAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  schedule: automationScheduleSchema,
  action: automationActionSchema,
}).strict().transform((value) => ({ ...value, executionTarget: "cloud" as const }))
export type CreateCloudAutomation = z.input<typeof createCloudAutomationSchema>

export const createAutomationSchema = z.union([actionCreateAutomationSchema, legacyCreateAutomationSchema])
/**
 * Published desktop clients still construct the legacy agent definition.
 * Keep that source-level contract stable while Den accepts the expanded
 * canonical definition through the separately named server type.
 */
export type CreateAutomation = z.infer<typeof legacyCreateAutomationSchema>
export type CreateAutomationDefinition = z.infer<typeof createAutomationSchema>

/**
 * What an in-app agent may hand back when a person describes recurring work.
 *
 * A proposal is inert: it names the Automation the person could create, and
 * nothing more. Automations are active the moment they exist, so creation stays
 * behind an explicit human action in the renderer, which owns the Den session.
 * The model is optional because the renderer resolves the person's own default.
 */
export const automationProposalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(100_000),
  schedule: automationScheduleSchema,
  model: automationModelSchema.optional(),
})
export type AutomationProposal = z.infer<typeof automationProposalSchema>

export const updateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().trim().min(1).max(100_000).optional(),
  schedule: automationScheduleSchema.optional(),
  model: automationModelSchema.optional(),
  action: automationActionSchema.optional(),
  /** Accepted for round-tripping; execution placement itself is immutable. */
  executionTarget: automationExecutionTargetSchema.optional(),
}).strict().refine(
  (input) => Object.keys(input).length > 0,
  "At least one behavior-changing field is required",
)
export type UpdateAutomation = z.infer<typeof updateAutomationSchema>

export const automationListSchema = z.object({
  items: z.array(z.object({
    automation: automationSchema,
    revision: automationRevisionSchema,
    latestRun: automationRunSchema.nullable(),
  })),
  nextCursor: z.string().nullable(),
})
export type AutomationList = z.infer<typeof automationListSchema>

export const automationDetailSchema = z.object({
  automation: automationSchema,
  revision: automationRevisionSchema,
  latestRun: automationRunSchema.nullable(),
})
export type AutomationDetail = z.infer<typeof automationDetailSchema>

export const automationRunReceiptSchema = z.object({
  run: automationRunSchema,
  automation: automationSchema,
  revision: automationRevisionSchema,
  events: z.array(automationRunEventSchema),
})
export type AutomationRunReceipt = z.infer<typeof automationRunReceiptSchema>

export const AUTOMATION_MAXIMUM_ATTEMPTS = 2
export const AUTOMATION_RETRY_DELAY_MS = 30_000
export const AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS = 15 * 60_000
export const AUTOMATION_MAXIMUM_RUNTIME_MS = 60 * 60_000
