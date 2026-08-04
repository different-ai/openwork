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

export const scheduledTaskExecutionTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-workspace"),
    workspaceId: idSchema,
  }),
  z.object({
    kind: z.literal("den-worker"),
    organizationId: idSchema,
    workerId: idSchema,
    workspaceId: idSchema,
  }),
])
export type ScheduledTaskExecutionTarget = z.infer<typeof scheduledTaskExecutionTargetSchema>

export const scheduledTaskSchedulerOwnerSchema = z.enum(["local-server", "den"])
export type ScheduledTaskSchedulerOwner = z.infer<typeof scheduledTaskSchedulerOwnerSchema>

export const scheduledTaskExecutionAvailabilitySchema = z.enum([
  "app-open",
  "background-device",
  "cloud",
])
export type ScheduledTaskExecutionAvailability = z.infer<
  typeof scheduledTaskExecutionAvailabilitySchema
>

export const scheduledTaskExecutionPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-user"),
    identityId: idSchema,
  }),
  z.object({
    kind: z.literal("den-membership"),
    organizationId: idSchema,
    membershipId: idSchema,
  }),
])
export type ScheduledTaskExecutionPrincipal = z.infer<
  typeof scheduledTaskExecutionPrincipalSchema
>

export const scheduledTaskCapabilityActionClassSchema = z.enum([
  "read",
  "write",
  "execute",
  "communicate",
  "destructive",
  "self-modifying",
])
export type ScheduledTaskCapabilityActionClass = z.infer<
  typeof scheduledTaskCapabilityActionClassSchema
>

export const scheduledTaskCapabilityReferenceSchema = z.object({
  id: idSchema,
  source: z.enum(["openwork", "den-mcp", "skill", "provider", "custom"]),
  actionClass: scheduledTaskCapabilityActionClassSchema,
  reviewedVersion: z.string().trim().min(1).max(240).nullable(),
  reviewedDigest: z.string().trim().min(1).max(512).nullable(),
}).refine(
  (reference) => reference.reviewedVersion !== null || reference.reviewedDigest !== null,
  "A capability reference needs a reviewed version or digest",
)
export type ScheduledTaskCapabilityReference = z.infer<
  typeof scheduledTaskCapabilityReferenceSchema
>

const localAbsoluteRootSchema = z.string().trim().min(1).max(4_096).refine(
  (root) => root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\"),
  "Expected a canonical absolute workspace root",
)

const denRelativeRootSchema = z.string().trim().min(1).max(4_096).refine(
  (root) => {
    if (root.startsWith("/") || root.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(root)) {
      return false
    }
    return !root.split(/[\\/]/).some((part) => part === "..")
  },
  "Expected a worker-workspace-relative root without parent traversal",
)

/**
 * Reviewed filesystem authority is relative to the selected execution target.
 * Local adapters canonicalize absolute roots; Den adapters resolve portable
 * relative roots inside the leased worker workspace.
 */
export const scheduledTaskFilesystemScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local-workspace-roots"),
    roots: z.array(localAbsoluteRootSchema).min(1).max(32),
  }),
  z.object({
    kind: z.literal("den-worker-relative-roots"),
    roots: z.array(denRelativeRootSchema).min(1).max(32),
  }),
])
export type ScheduledTaskFilesystemScope = z.infer<
  typeof scheduledTaskFilesystemScopeSchema
>

export const scheduledTaskPlacementSchema = z.object({
  target: scheduledTaskExecutionTargetSchema,
  schedulerOwner: scheduledTaskSchedulerOwnerSchema,
  executionAvailability: scheduledTaskExecutionAvailabilitySchema,
  executionPrincipal: scheduledTaskExecutionPrincipalSchema,
  capabilityReferences: z.array(scheduledTaskCapabilityReferenceSchema).max(200),
}).superRefine((placement, context) => {
  if (
    placement.target.kind === "local-workspace"
    && placement.schedulerOwner !== "local-server"
  ) {
    context.addIssue({
      code: "custom",
      message: "A local workspace must be scheduled by the local server",
      path: ["schedulerOwner"],
    })
  }
  if (placement.target.kind === "den-worker" && placement.schedulerOwner !== "den") {
    context.addIssue({
      code: "custom",
      message: "A Den worker must be scheduled by Den",
      path: ["schedulerOwner"],
    })
  }
  if (
    placement.executionPrincipal.kind === "den-membership"
    && placement.target.kind === "den-worker"
    && placement.executionPrincipal.organizationId !== placement.target.organizationId
  ) {
    context.addIssue({
      code: "custom",
      message: "The execution principal and target must belong to one organization",
      path: ["executionPrincipal", "organizationId"],
    })
  }
})
export type ScheduledTaskPlacement = z.infer<typeof scheduledTaskPlacementSchema>

export function createLocalScheduledTaskPlacement(input: {
  workspaceId: string
  identityId: string
  executionAvailability?: "app-open" | "background-device"
  capabilityReferences?: ScheduledTaskCapabilityReference[]
}): ScheduledTaskPlacement {
  return scheduledTaskPlacementSchema.parse({
    target: { kind: "local-workspace", workspaceId: input.workspaceId },
    schedulerOwner: "local-server",
    executionAvailability: input.executionAvailability ?? "app-open",
    executionPrincipal: { kind: "local-user", identityId: input.identityId },
    capabilityReferences: input.capabilityReferences ?? [],
  })
}

export const scheduledTaskModelSchema = z.object({
  providerId: z.string().trim().min(1).max(160).nullable(),
  modelId: z.string().trim().min(1).max(240).nullable(),
  agent: z.string().trim().min(1).max(160).nullable(),
}).refine(
  (model) => (model.providerId === null) === (model.modelId === null),
  "providerId and modelId must either both be set or both be null",
)
export type ScheduledTaskModel = z.infer<typeof scheduledTaskModelSchema>

export const scheduledTaskStateSchema = z.enum([
  "draft",
  "ready",
  "enabled",
  "paused",
  "needs-attention",
  "deleted",
])
export type ScheduledTaskState = z.infer<typeof scheduledTaskStateSchema>

export const scheduledTaskRunStatusSchema = z.enum([
  "scheduled",
  "claimed",
  "running",
  "retrying",
  "completed",
  "failed",
  "cancelled",
  "needs-attention",
  "missed",
  "skipped-overlap",
  "ambiguous",
])
export type ScheduledTaskRunStatus = z.infer<typeof scheduledTaskRunStatusSchema>

export const scheduledTaskAttemptStatusSchema = z.enum([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
  "needs-attention",
  "timed-out",
  "ambiguous",
])
export type ScheduledTaskAttemptStatus = z.infer<typeof scheduledTaskAttemptStatusSchema>

export const scheduledTaskErrorCodeSchema = z.enum([
  "adapter-unavailable",
  "capability-unavailable",
  "credential-unavailable",
  "grant-expired",
  "grant-revoked",
  "invalid-grant",
  "invalid-revision",
  "permission-required",
  "question-required",
  "session-create-failed",
  "dispatch-failed",
  "execution-failed",
  "execution-timed-out",
  "cancellation-failed",
  "workspace-inaccessible",
  "workspace-removed",
  "signed-out",
  "ambiguous-outcome",
  "internal-error",
])
export type ScheduledTaskErrorCode = z.infer<typeof scheduledTaskErrorCodeSchema>

export const scheduledTaskTypedErrorSchema = z.object({
  code: scheduledTaskErrorCodeSchema,
  message: z.string().trim().min(1).max(2_000),
  retryable: z.boolean(),
  ambiguous: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ScheduledTaskTypedError = z.infer<typeof scheduledTaskTypedErrorSchema>

export const scheduledTaskNeedsAttentionSchema = z.object({
  code: z.enum([
    "approval-required",
    "question-required",
    "capability-lost",
    "credential-unavailable",
    "grant-expired",
    "grant-revoked",
    "missed-occurrence",
    "signed-out",
    "stale-revision",
    "workspace-inaccessible",
    "workspace-removed",
  ]),
  message: z.string().trim().min(1).max(2_000),
  repairable: z.boolean(),
  runId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  createdAt: timestampSchema,
})
export type ScheduledTaskNeedsAttention = z.infer<typeof scheduledTaskNeedsAttentionSchema>

export const scheduledTaskScheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("manual"),
    timezone: timezoneSchema,
  }),
  z.object({
    kind: z.literal("daily"),
    timezone: timezoneSchema,
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("weekly"),
    timezone: timezoneSchema,
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
])
export type ScheduledTaskSchedule = z.infer<typeof scheduledTaskScheduleSchema>

export const scheduledTaskDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(""),
  prompt: z.string().trim().min(1).max(100_000),
  workspaceId: idSchema,
  placement: scheduledTaskPlacementSchema.optional(),
  schedule: scheduledTaskScheduleSchema,
  model: scheduledTaskModelSchema,
  maximumRuntimeMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1_000),
  overlapPolicy: z.literal("skip"),
  retryPolicy: z.object({
    maximumAttempts: z.number().int().min(1).max(2),
    delayMs: z.number().int().min(0).max(15 * 60 * 1_000),
  }),
  missedRunPolicy: z.object({
    kind: z.literal("skip"),
    graceMs: z.number().int().min(0).max(60 * 60 * 1_000),
    maximumRecoverableOccurrences: z.literal(1),
  }),
})
export type ScheduledTaskDefinition = z.infer<typeof scheduledTaskDefinitionSchema>

export const scheduledTaskRevisionSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  revision: z.number().int().positive(),
  definition: scheduledTaskDefinitionSchema,
  createdAt: timestampSchema,
  createdBy: z.string().trim().min(1).max(240),
  reviewedAt: nullableTimestampSchema,
  reviewedBy: z.string().trim().min(1).max(240).nullable(),
})
export type ScheduledTaskRevision = z.infer<typeof scheduledTaskRevisionSchema>

export const scheduledTaskGrantSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  revision: z.number().int().positive(),
  taskRevisionId: idSchema,
  workspaceId: idSchema,
  placement: scheduledTaskPlacementSchema.optional(),
  placementIdentity: z.string().trim().min(1).max(4_096).optional(),
  filesystemScope: scheduledTaskFilesystemScopeSchema.optional(),
  /** @deprecated Local compatibility projection; use filesystemScope. */
  authorizedWorkspaceRoots: z.array(localAbsoluteRootSchema).max(32).default([]),
  capabilityIds: z.array(z.string().trim().min(1).max(240)).max(200),
  actionClasses: z.array(z.enum(["read", "write", "execute"])).min(1).max(3),
  filesystem: z.object({
    read: z.boolean(),
    write: z.boolean(),
  }),
  maximumRuntimeMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1_000),
  model: scheduledTaskModelSchema,
  communicationPolicy: z.literal("deny"),
  destructiveActionPolicy: z.literal("deny"),
  selfModificationPolicy: z.literal("deny"),
  grantor: z.string().trim().min(1).max(240),
  reviewedAt: timestampSchema,
  expiresAt: nullableTimestampSchema,
  revokedAt: nullableTimestampSchema,
  revocationReason: z.string().trim().min(1).max(2_000).nullable(),
  createdAt: timestampSchema,
}).superRefine((grant, context) => {
  if (!grant.placement || !grant.filesystemScope) return
  const expectedScope = grant.placement.target.kind === "local-workspace"
    ? "local-workspace-roots"
    : "den-worker-relative-roots"
  if (grant.filesystemScope.kind !== expectedScope) {
    context.addIssue({
      code: "custom",
      message: "Filesystem authority must match the reviewed execution target",
      path: ["filesystemScope", "kind"],
    })
  }
})
export type ScheduledTaskGrant = z.infer<typeof scheduledTaskGrantSchema>

export const scheduledTaskSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  state: scheduledTaskStateSchema,
  enabled: z.boolean(),
  draftRevisionId: idSchema,
  activeRevisionId: idSchema.nullable(),
  activeGrantId: idSchema.nullable(),
  nextRunAt: nullableTimestampSchema,
  needsAttention: scheduledTaskNeedsAttentionSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: nullableTimestampSchema,
})
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>

export const scheduledTaskArtifactReferenceSchema = z.object({
  id: idSchema,
  kind: z.enum(["file", "url"]),
  value: z.string().trim().min(1).max(8_192),
  name: z.string().trim().min(1).max(512).nullable(),
})
export type ScheduledTaskArtifactReference = z.infer<typeof scheduledTaskArtifactReferenceSchema>

export const scheduledTaskAttemptSchema = z.object({
  id: idSchema,
  runId: idSchema,
  attempt: z.number().int().positive().max(2),
  status: scheduledTaskAttemptStatusSchema,
  sessionId: idSchema.nullable(),
  startedAt: timestampSchema,
  completedAt: nullableTimestampSchema,
  error: scheduledTaskTypedErrorSchema.nullable(),
})
export type ScheduledTaskAttempt = z.infer<typeof scheduledTaskAttemptSchema>

export const scheduledTaskRunSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  taskRevisionId: idSchema,
  grantRevisionId: idSchema,
  placement: scheduledTaskPlacementSchema.optional(),
  occurrenceId: idSchema,
  trigger: z.enum(["manual", "scheduled", "recovery"]),
  status: scheduledTaskRunStatusSchema,
  scheduledFor: nullableTimestampSchema,
  claimedAt: timestampSchema,
  startedAt: nullableTimestampSchema,
  completedAt: nullableTimestampSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  idempotencyKey: z.string().trim().min(1).max(512),
  sessionId: idSchema.nullable(),
  attemptCount: z.number().int().nonnegative().max(2),
  boundedUsage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costMicros: z.number().int().nonnegative().nullable(),
  }),
  error: scheduledTaskTypedErrorSchema.nullable(),
  needsAttention: scheduledTaskNeedsAttentionSchema.nullable(),
  artifacts: z.array(scheduledTaskArtifactReferenceSchema).max(200),
  cancelRequestedAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})
export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>

export const scheduledTaskSchedulePreviewSchema = z.object({
  schedule: scheduledTaskScheduleSchema,
  generatedAt: timestampSchema,
  occurrences: z.array(timestampSchema).max(5),
  warnings: z.array(z.string().trim().min(1).max(500)),
})
export type ScheduledTaskSchedulePreview = z.infer<typeof scheduledTaskSchedulePreviewSchema>

export const scheduledTaskRunReceiptSchema = z.object({
  run: scheduledTaskRunSchema,
  taskRevision: scheduledTaskRevisionSchema,
  grantRevision: scheduledTaskGrantSchema,
  placement: scheduledTaskPlacementSchema.optional(),
  attempts: z.array(scheduledTaskAttemptSchema).max(2),
  sessionRoute: z.string().trim().min(1).nullable(),
  artifacts: z.array(scheduledTaskArtifactReferenceSchema).max(200),
})
export type ScheduledTaskRunReceipt = z.infer<typeof scheduledTaskRunReceiptSchema>

export const scheduledTaskExecutionRequestSchema = z.object({
  runId: idSchema,
  attemptId: idSchema,
  idempotencyKey: z.string().trim().min(1).max(512),
  placement: scheduledTaskPlacementSchema.optional(),
  taskRevision: scheduledTaskRevisionSchema,
  grantRevision: scheduledTaskGrantSchema,
})
export type ScheduledTaskExecutionRequest = z.infer<typeof scheduledTaskExecutionRequestSchema>

export const scheduledTaskExecutionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session-created"),
    at: timestampSchema,
    sessionId: idSchema,
  }),
  z.object({
    type: z.literal("dispatched"),
    at: timestampSchema,
    sessionId: idSchema,
  }),
  z.object({
    type: z.literal("running"),
    at: timestampSchema,
    sessionId: idSchema,
  }),
  z.object({
    type: z.literal("needs-attention"),
    at: timestampSchema,
    sessionId: idSchema,
    attention: scheduledTaskNeedsAttentionSchema,
  }),
  z.object({
    type: z.literal("terminal"),
    at: timestampSchema,
    sessionId: idSchema,
    status: z.enum(["completed", "failed", "cancelled", "ambiguous"]),
  }),
])
export type ScheduledTaskExecutionEvent = z.infer<typeof scheduledTaskExecutionEventSchema>

export const scheduledTaskExecutionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    sessionId: idSchema,
    artifacts: z.array(scheduledTaskArtifactReferenceSchema).max(200),
    boundedUsage: scheduledTaskRunSchema.shape.boundedUsage,
  }),
  z.object({
    status: z.literal("needs-attention"),
    sessionId: idSchema,
    attention: scheduledTaskNeedsAttentionSchema,
  }),
  z.object({
    status: z.enum(["failed", "cancelled", "ambiguous"]),
    sessionId: idSchema.nullable(),
    error: scheduledTaskTypedErrorSchema,
  }),
])
export type ScheduledTaskExecutionResult = z.infer<typeof scheduledTaskExecutionResultSchema>

export const createScheduledTaskDraftSchema = scheduledTaskDefinitionSchema
export type CreateScheduledTaskDraft = z.infer<typeof createScheduledTaskDraftSchema>

export const updateScheduledTaskDraftSchema = z.object({
  expectedRevisionId: idSchema,
  definition: scheduledTaskDefinitionSchema,
})
export type UpdateScheduledTaskDraft = z.infer<typeof updateScheduledTaskDraftSchema>

export const reviewScheduledTaskGrantSchema = z.object({
  expectedRevisionId: idSchema,
  filesystemScope: scheduledTaskFilesystemScopeSchema.optional(),
  /** @deprecated Local compatibility input; use filesystemScope. */
  authorizedWorkspaceRoots: z.array(localAbsoluteRootSchema).max(32).default([]),
  capabilityIds: z.array(z.string().trim().min(1).max(240)).max(200),
  actionClasses: z.array(z.enum(["read", "write", "execute"])).min(1).max(3),
  filesystem: z.object({
    read: z.boolean(),
    write: z.boolean(),
  }),
  maximumRuntimeMs: z.number().int().min(10_000).max(24 * 60 * 60 * 1_000),
  model: scheduledTaskDefinitionSchema.shape.model,
  expiresAt: nullableTimestampSchema,
  grantor: z.string().trim().min(1).max(240),
})
export type ReviewScheduledTaskGrant = z.infer<typeof reviewScheduledTaskGrantSchema>

export const proposeScheduledTaskDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(""),
  prompt: z.string().trim().min(1).max(100_000),
  workspaceId: idSchema.optional(),
  schedule: scheduledTaskScheduleSchema.optional(),
  model: scheduledTaskDefinitionSchema.shape.model.optional(),
  maximumRuntimeMs: scheduledTaskDefinitionSchema.shape.maximumRuntimeMs.optional(),
})
export type ProposeScheduledTaskDraft = z.infer<typeof proposeScheduledTaskDraftSchema>
