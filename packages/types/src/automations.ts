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

export const automationStateSchema = z.enum(["active", "inactive", "needs_attention", "archived"]).meta({ ref: "AutomationState" })
export type AutomationState = z.infer<typeof automationStateSchema>

export const automationRunStatusSchema = z.enum([
  "queued", "claimed", "running", "succeeded", "failed", "cancelled", "skipped",
]).meta({ ref: "AutomationRunStatus" })
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>

export const automationRunTriggerSchema = z.enum(["scheduled", "recovery", "manual"]).meta({ ref: "AutomationRunTrigger" })
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

/**
 * "The model this organization's cloud runs on." Valid only for cloud agent
 * Automations on the headless runtime, where the runner's configured model
 * runs them, so neither a person nor an agent has to pick a provider.
 */
export const AUTOMATION_CLOUD_DEFAULT_MODEL = {
  providerId: "openwork-cloud",
  modelId: "default",
  providerName: "OpenWork Cloud",
  modelName: "Cloud default",
} as const

export function isAutomationCloudDefaultModel(model: { providerId: string; modelId: string }): boolean {
  return model.providerId === AUTOMATION_CLOUD_DEFAULT_MODEL.providerId && model.modelId === AUTOMATION_CLOUD_DEFAULT_MODEL.modelId
}

export const automationNeedsAttentionReasonSchema = z.object({
  code: z.enum([
    "owner_membership_lost",
    "model_access_lost",
    "provider_unavailable",
    "connect_access_unavailable",
    "openwork_web_access_required",
    "execution_runtime_unavailable",
  ]),
  message: z.string().trim().min(1).max(2_000),
  occurredAt: timestampSchema,
}).meta({ ref: "AutomationNeedsAttentionReason" })
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
}).meta({ ref: "Automation" })
export type Automation = z.infer<typeof automationSchema>

/**
 * The workspace an Automation is pinned to at creation/update time.
 *
 * Before this field existed, both executors resolved the runner's *currently
 * active* workspace at run time, so activating a different workspace silently
 * retargeted every automation. A pinned id makes targeting explicit; null
 * keeps the legacy active-workspace fallback for existing records.
 */
export const automationWorkspaceIdSchema = z.string().trim().min(1).max(240)

export const automationRevisionSchema = z.object({
  id: idSchema,
  automationId: idSchema,
  version: z.number().int().positive(),
  instructions: z.string().trim().min(1).max(100_000),
  schedule: automationScheduleSchema,
  model: automationModelSchema,
  action: automationActionSchema.optional(),
  executionTarget: z.enum(["desktop", "cloud"]).optional(),
  workspaceId: automationWorkspaceIdSchema.nullable().optional(),
  maximumRuntimeMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
  digest: z.string().trim().min(16).max(128),
  createdAt: timestampSchema,
}).meta({ ref: "AutomationRevision" })
export type AutomationRevision = z.infer<typeof automationRevisionSchema>

export const automationErrorSchema = z.object({
  code: z.enum([
    "owner_membership_lost",
    "model_access_lost",
    "provider_unavailable",
    "connect_access_unavailable",
    "openwork_web_access_required",
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
}).meta({ ref: "AutomationError" })
export type AutomationError = z.infer<typeof automationErrorSchema>

export const automationUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costMicros: z.number().int().nonnegative().nullable(),
}).meta({ ref: "AutomationUsage" })
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
}).meta({ ref: "AutomationExecutionThread" })
export type AutomationExecutionThread = z.infer<typeof automationExecutionThreadSchema>

/**
 * Where an Automation runs: on one of the owner's connected desktops, or in
 * OpenWork Cloud. The owner may move it between the two (a new revision) or run
 * it once on the other target; agents may only ever move work to the cloud.
 */
export const automationExecutionTargetSchema = z.enum(["desktop", "cloud"])
export type AutomationExecutionTarget = z.infer<typeof automationExecutionTargetSchema>

export const AUTOMATION_MODEL_ATTENTION_CAPABILITY = "model_attention_v1" as const
export const REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY = "remote_session_v1"
/**
 * The runner can answer read, send, and stop requests for the remote sessions
 * it delivered. Released runners registered only remote_session_v1 and would
 * misread the request work item, so Den routes requests by this capability.
 */
export const REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY = "remote_session_control_v1"
export const AUTOMATION_MODEL_ATTENTION_CAPABILITY_HEADER = "x-openwork-automation-model-attention" as const
export const automationDesktopRunnerCapabilitySchema = z.enum([
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
])
export const AUTOMATION_DESKTOP_RUNNER_CAPABILITY_LIMIT = 3
export type AutomationDesktopRunnerCapability = z.infer<typeof automationDesktopRunnerCapabilitySchema>

export const automationDesktopRunnerRegistrationSchema = z.object({
  runnerId: idSchema.min(8),
  protocolVersion: z.literal(1),
  supportedExecutionTargets: z.array(z.literal("desktop")).length(1),
  capabilities: z.array(automationDesktopRunnerCapabilitySchema).max(AUTOMATION_DESKTOP_RUNNER_CAPABILITY_LIMIT).default([]),
  appVersion: z.string().trim().min(1).max(80),
  platform: z.enum(["darwin", "win32", "linux"]),
  concurrency: z.number().int().min(1).max(4),
})
export type AutomationDesktopRunnerRegistration = z.infer<typeof automationDesktopRunnerRegistrationSchema>

/**
 * How long a desktop counts as connected after it was last seen. Registration
 * refreshes presence every few minutes and idle event streams deliberately do
 * not write to the database, so this is generous enough to survive an idle
 * desktop and short enough to catch one that was closed.
 */
export const AUTOMATION_DESKTOP_RUNNER_PRESENCE_WINDOW_MS = 10 * 60_000

/** Whether a Desktop Automation has anywhere to run right now. */
export const automationDesktopRunnerPresenceSchema = z.object({
  connected: z.boolean(),
  lastSeenAt: timestampSchema.nullable(),
}).meta({ ref: "AutomationDesktopRunnerPresence" })
export type AutomationDesktopRunnerPresence = z.infer<typeof automationDesktopRunnerPresenceSchema>

/** One of the owner's registered desktops. Any connected one may run a Desktop Automation. */
export const automationDesktopTargetSchema = z.object({
  kind: z.literal("desktop"),
  id: idSchema,
  platform: z.enum(["darwin", "win32", "linux"]),
  appVersion: z.string().trim().min(1).max(80),
  lastSeenAt: timestampSchema,
  connected: z.boolean(),
}).meta({ ref: "AutomationDesktopTarget" })
export type AutomationDesktopTarget = z.infer<typeof automationDesktopTargetSchema>

/**
 * Whether the owner can run agent Automations in OpenWork Cloud right now, and
 * on which runtime: the shared headless runner or their OpenWork Web computer.
 * `runtime` is null when Cloud is unavailable.
 */
export const automationCloudTargetSchema = z.object({
  kind: z.literal("cloud"),
  available: z.boolean(),
  runtime: z.enum(["headless", "web"]).nullable(),
  /** The owner has an OpenWork Web computer, so a cloud run can also use its files. */
  cloudComputer: z.boolean(),
}).meta({ ref: "AutomationCloudTarget" })
export type AutomationCloudTarget = z.infer<typeof automationCloudTargetSchema>

/** Every place the owner's Automations can run: their desktops, then Cloud. */
export const automationExecutionTargetListSchema = z.object({
  items: z.array(z.discriminatedUnion("kind", [automationDesktopTargetSchema, automationCloudTargetSchema])),
}).meta({ ref: "AutomationExecutionTargetList" })
export type AutomationExecutionTargetList = z.infer<typeof automationExecutionTargetListSchema>

export const automationRunnerNotificationSchema = z.object({
  type: z.enum(["automation_work_available", "automation_cancellation_available"]),
  cursor: z.string().trim().min(1).max(40),
}).strict()
export type AutomationRunnerNotification = z.infer<typeof automationRunnerNotificationSchema>

export const automationRunnerWorkItemSchema = z.union([
  // The automation-run item shape predates remote-session commands and is
  // consumed by released desktop runners: it must keep every field it has
  // always carried.
  z.object({
    runId: idSchema,
    executionTarget: z.literal("desktop"),
    /**
     * Present only for a run pinned to one workspace. A workspace exists on the
     * desktop that has its folder, so a runner without it leaves the run for
     * the owner's desktop that does. Released runners ignore the field.
     */
    workspaceId: automationWorkspaceIdSchema.optional(),
  }),
  z.object({ kind: z.literal("remote_session_create"), commandId: idSchema }),
  // Listed only for runners that registered remote_session_control_v1.
  z.object({ kind: z.literal("remote_session_request"), requestId: idSchema }),
])
/** Runs a desktop may claim per work poll; a runner skips the ones pinned elsewhere. */
export const AUTOMATION_RUNNER_WORK_RUN_LIMIT = 20
export const automationRunnerWorkResponseSchema = z.object({
  // Up to the run limit plus five remote-session commands and five remote-session requests.
  items: z.array(automationRunnerWorkItemSchema).max(AUTOMATION_RUNNER_WORK_RUN_LIMIT + 10),
})
export type AutomationRunnerWorkResponse = z.infer<typeof automationRunnerWorkResponseSchema>

/** Workspaces and models a desktop reports per workspace; anything beyond is dropped. */
export const DESKTOP_INVENTORY_WORKSPACE_LIMIT = 50
export const DESKTOP_INVENTORY_MODEL_LIMIT = 200
const desktopInventoryIdSchema = z.string().trim().min(1).max(240)

export const desktopInventoryModelSchema = z.object({
  providerId: z.string().trim().min(1).max(160),
  modelId: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(200),
})
export type DesktopInventoryModel = z.infer<typeof desktopInventoryModelSchema>

export const desktopInventoryWorkspaceSchema = z.object({
  workspaceId: desktopInventoryIdSchema,
  name: z.string().trim().min(1).max(120),
  /** The workspace the desktop uses when a remote session names none. */
  active: z.boolean(),
  engine: z.enum(["v1", "v2"]),
  defaultModel: z.object({
    providerId: z.string().trim().min(1).max(160),
    modelId: z.string().trim().min(1).max(160),
    variant: z.string().trim().min(1).max(60).optional(),
  }).nullable(),
  /** Models the workspace can use right now; empty when the desktop could not list them. */
  models: z.array(desktopInventoryModelSchema).max(DESKTOP_INVENTORY_MODEL_LIMIT),
})
export type DesktopInventoryWorkspace = z.infer<typeof desktopInventoryWorkspaceSchema>

/**
 * What a desktop runner has, reported to `PUT /v1/automation-runner/inventory`
 * when it connects and when it changes. Den keeps only the latest report per
 * runner. Objects are deliberately not strict so either side can add fields.
 */
export const desktopRunnerInventorySchema = z.object({
  computer: z.object({
    label: z.string().trim().min(1).max(120),
    platform: z.enum(["darwin", "win32", "linux"]),
    appVersion: z.string().trim().min(1).max(80),
  }),
  workspaces: z.array(desktopInventoryWorkspaceSchema).max(DESKTOP_INVENTORY_WORKSPACE_LIMIT),
})
export type DesktopRunnerInventory = z.infer<typeof desktopRunnerInventorySchema>
export const desktopRunnerInventoryResponseSchema = z.object({
  ok: z.literal(true),
  updatedAt: timestampSchema,
})

export const remoteSessionCommandAssignmentSchema = z.object({
  commandId: idSchema,
  kind: z.literal("remote_session_create"),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().min(1).max(100_000).nullable(),
  model: z.object({
    providerId: idSchema,
    modelId: idSchema,
    variant: z.string().trim().min(1).max(60).nullable(),
  }).nullable(),
  expiresAt: timestampSchema,
  /**
   * The workspace the caller chose. The desktop creates the session there or
   * fails with `workspace_unavailable`; absent means its active workspace.
   */
  workspaceId: desktopInventoryIdSchema.nullable().optional(),
})
export const remoteSessionCommandClaimResponseSchema = z.object({
  assignment: remoteSessionCommandAssignmentSchema,
})
const remoteSessionCommandResultSummarySchema = z.string().max(4096).optional()
const remoteSessionCommandErrorSchema = z.object({
  code: z.string().trim().min(1).max(60),
  message: z.string().trim().min(1).max(2000),
})
export const remoteSessionCommandCompleteRequestSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("delivered"),
    sessionId: z.string().trim().min(1).max(240),
    workspaceId: z.string().trim().min(1).max(240),
    resultSummary: remoteSessionCommandResultSummarySchema,
    error: z.never().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    sessionId: z.never().optional(),
    workspaceId: z.never().optional(),
    resultSummary: remoteSessionCommandResultSummarySchema,
    error: remoteSessionCommandErrorSchema,
  }),
])
export type RemoteSessionCommandCompleteRequest = z.infer<typeof remoteSessionCommandCompleteRequestSchema>
export const remoteSessionCommandCompleteResponseSchema = z.object({
  command: z.object({
    id: idSchema,
    status: z.enum(["delivered", "failed"]),
    sessionId: z.string().max(240).nullable(),
    workspaceId: z.string().max(240).nullable(),
  }),
})

export const REMOTE_SESSION_FINAL_TEXT_MAX_LENGTH = 20_000
export const remoteSessionStatusSchema = z.enum(["running", "waiting", "idle", "error"])
export const remoteSessionWaitingForSchema = z.enum(["permission", "question"])
export const remoteSessionEngineSchema = z.enum(["v1", "v2"])
export const remoteSessionModelSchema = z.object({
  providerId: idSchema,
  modelId: idSchema,
  variant: z.string().trim().min(1).max(60).nullable().optional(),
})
/**
 * Progress the claiming desktop runner reports for a delivered remote-session
 * command's local session, so Den callers can follow it to the final answer.
 */
export const remoteSessionCommandSessionReportSchema = z.object({
  status: remoteSessionStatusSchema,
  waitingFor: remoteSessionWaitingForSchema.nullable().optional(),
  engine: remoteSessionEngineSchema.optional(),
  model: remoteSessionModelSchema.nullable().optional(),
  finalText: z.string().max(REMOTE_SESSION_FINAL_TEXT_MAX_LENGTH).optional(),
  error: remoteSessionCommandErrorSchema.nullable().optional(),
  messageCount: z.number().int().min(0).optional(),
  observedAt: timestampSchema,
})
export type RemoteSessionCommandSessionReport = z.infer<typeof remoteSessionCommandSessionReportSchema>
export const remoteSessionCommandSessionReportResponseSchema = z.object({ ok: z.literal(true) })

/**
 * Den -> desktop request/response channel for a delivered remote session:
 * read its transcript, send a follow-up, or stop it. Only the runner that
 * delivered the session receives the request.
 */
export const REMOTE_SESSION_REQUEST_RESULT_MAX_BYTES = 256 * 1024
export const REMOTE_SESSION_TRANSCRIPT_TEXT_MAX_LENGTH = 20_000
export const REMOTE_SESSION_TOOL_SUMMARY_MAX_LENGTH = 2_000
export const REMOTE_SESSION_TRANSCRIPT_PAGE_MAX = 100
export const remoteSessionRequestActionSchema = z.enum(["read", "send", "stop"])
export type RemoteSessionRequestAction = z.infer<typeof remoteSessionRequestActionSchema>
const remoteSessionMessageIdSchema = z.string().regex(/^msg_[a-zA-Z0-9]+$/).max(160)
export const remoteSessionReadInputSchema = z.object({
  from: z.enum(["start", "end"]),
  cursor: z.string().trim().min(1).max(160).nullable(),
  limit: z.number().int().min(1).max(REMOTE_SESSION_TRANSCRIPT_PAGE_MAX),
})
export const remoteSessionSendInputSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  messageId: remoteSessionMessageIdSchema.nullable(),
  model: remoteSessionModelSchema.nullable(),
})
export const remoteSessionStopInputSchema = z.object({
  messageId: z.string().trim().min(1).max(160).nullable(),
})
export const remoteSessionRequestInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), input: remoteSessionReadInputSchema }),
  z.object({ action: z.literal("send"), input: remoteSessionSendInputSchema }),
  z.object({ action: z.literal("stop"), input: remoteSessionStopInputSchema }),
])
export type RemoteSessionRequestInput = z.infer<typeof remoteSessionRequestInputSchema>
const remoteSessionRequestAssignmentBase = {
  requestId: idSchema,
  kind: z.literal("remote_session_request"),
  /** The remote-session command that delivered this session. */
  commandId: idSchema,
  sessionId: z.string().trim().min(1).max(240),
  workspaceId: z.string().trim().min(1).max(240),
  engine: remoteSessionEngineSchema.nullable(),
  expiresAt: timestampSchema,
}
export const remoteSessionRequestAssignmentSchema = z.discriminatedUnion("action", [
  z.object({ ...remoteSessionRequestAssignmentBase, action: z.literal("read"), input: remoteSessionReadInputSchema }),
  z.object({ ...remoteSessionRequestAssignmentBase, action: z.literal("send"), input: remoteSessionSendInputSchema }),
  z.object({ ...remoteSessionRequestAssignmentBase, action: z.literal("stop"), input: remoteSessionStopInputSchema }),
])
export type RemoteSessionRequestAssignment = z.infer<typeof remoteSessionRequestAssignmentSchema>
export const remoteSessionRequestClaimResponseSchema = z.object({
  assignment: remoteSessionRequestAssignmentSchema,
})
const boundedSummarySchema = z.string().max(REMOTE_SESSION_TOOL_SUMMARY_MAX_LENGTH).nullable()
export const remoteSessionTranscriptToolCallSchema = z.object({
  id: z.string().max(240),
  name: z.string().max(240),
  status: z.string().max(60).nullable(),
  input: boundedSummarySchema,
  output: boundedSummarySchema,
  error: boundedSummarySchema,
  truncated: z.boolean(),
})
export const remoteSessionTranscriptMessageSchema = z.object({
  id: z.string().max(240),
  role: z.enum(["user", "assistant"]),
  createdAt: timestampSchema.nullable(),
  text: z.string().max(REMOTE_SESSION_TRANSCRIPT_TEXT_MAX_LENGTH),
  truncated: z.boolean(),
  toolCalls: z.array(remoteSessionTranscriptToolCallSchema).max(200),
  error: remoteSessionCommandErrorSchema.nullable(),
})
export type RemoteSessionTranscriptMessage = z.infer<typeof remoteSessionTranscriptMessageSchema>
export const remoteSessionReadResultSchema = z.object({
  title: z.string().max(240).nullable(),
  status: remoteSessionStatusSchema,
  waitingFor: remoteSessionWaitingForSchema.nullable(),
  lastError: remoteSessionCommandErrorSchema.nullable(),
  messageCount: z.number().int().min(0),
  from: z.enum(["start", "end"]),
  messages: z.array(remoteSessionTranscriptMessageSchema).max(REMOTE_SESSION_TRANSCRIPT_PAGE_MAX),
  /** Pass back as cursor (with the same from) for the next page; null when there is none. */
  nextCursor: z.string().max(160).nullable(),
})
export type RemoteSessionReadResult = z.infer<typeof remoteSessionReadResultSchema>
export const remoteSessionSendResultSchema = z.object({
  messageId: z.string().max(160).nullable(),
  alreadyPresent: z.boolean(),
})
export const remoteSessionStopResultSchema = z.object({
  stopped: z.boolean(),
  reason: z.enum(["different_turn"]).nullable(),
})
export const remoteSessionRequestResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), result: remoteSessionReadResultSchema }),
  z.object({ action: z.literal("send"), result: remoteSessionSendResultSchema }),
  z.object({ action: z.literal("stop"), result: remoteSessionStopResultSchema }),
])
export type RemoteSessionRequestResult = z.infer<typeof remoteSessionRequestResultSchema>
export const remoteSessionRequestCompleteRequestSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("done"),
    outcome: remoteSessionRequestResultSchema,
    error: z.never().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    outcome: z.never().optional(),
    error: remoteSessionCommandErrorSchema,
  }),
]).refine(
  (body) => body.status !== "done"
    || new TextEncoder().encode(JSON.stringify(body.outcome)).byteLength <= REMOTE_SESSION_REQUEST_RESULT_MAX_BYTES,
  { message: `The result must be at most ${REMOTE_SESSION_REQUEST_RESULT_MAX_BYTES} bytes`, path: ["outcome"] },
)
export type RemoteSessionRequestCompleteRequest = z.infer<typeof remoteSessionRequestCompleteRequestSchema>
export const remoteSessionRequestCompleteResponseSchema = z.object({
  request: z.object({ id: idSchema, status: z.enum(["done", "failed"]) }),
})
export const remoteSessionRequestPendingResponseSchema = z.object({
  items: z.array(z.object({ kind: z.literal("remote_session_request"), requestId: idSchema })).max(5),
})

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
  /** Pinned target workspace; absent for records created before pinning existed. */
  workspaceId: automationWorkspaceIdSchema.nullable().optional(),
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
}).meta({ ref: "AutomationRunnerTokenResponse" })
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
}).meta({ ref: "AutomationRun" })
export type AutomationRun = z.infer<typeof automationRunSchema>

export const automationRunEventTypeSchema = z.enum([
  "user", "assistant", "capability_search", "capability_execution", "usage", "warning", "terminal",
]).meta({ ref: "AutomationRunEventType" })
export type AutomationRunEventType = z.infer<typeof automationRunEventTypeSchema>

export const automationRunEventSchema = z.object({
  id: idSchema,
  runId: idSchema,
  attempt: z.number().int().positive(),
  sequence: z.number().int().positive(),
  type: automationRunEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
}).meta({ ref: "AutomationRunEvent" })
export type AutomationRunEvent = z.infer<typeof automationRunEventSchema>

const legacyCreateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(100_000),
  schedule: automationScheduleSchema,
  model: automationModelSchema,
  workspaceId: automationWorkspaceIdSchema.nullable().optional(),
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
  /** Workspace the proposing conversation ran in; the renderer pins it on create. */
  workspaceId: automationWorkspaceIdSchema.optional(),
})
export type AutomationProposal = z.infer<typeof automationProposalSchema>

export const updateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().trim().min(1).max(100_000).optional(),
  schedule: automationScheduleSchema.optional(),
  model: automationModelSchema.optional(),
  action: automationActionSchema.optional(),
  /**
   * Moves the Automation between the owner's desktops and the cloud. A pinned
   * workspace belongs to one computer, so moving drops it unless `workspaceId`
   * is set in the same request. Workflows run only in the cloud.
   */
  executionTarget: automationExecutionTargetSchema.optional(),
  /** Re-pin to a different workspace; null clears the pin (legacy active-workspace fallback). */
  workspaceId: automationWorkspaceIdSchema.nullable().optional(),
}).strict().refine(
  (input) => Object.keys(input).length > 0,
  "At least one behavior-changing field is required",
)
export type UpdateAutomation = z.infer<typeof updateAutomationSchema>

/**
 * Optional body of a manual run. `executionTarget` runs this one occurrence on
 * the other target (a Desktop Automation once in the cloud, or the reverse)
 * without changing the Automation. Older clients send `{}` or no body.
 */
export const runAutomationNowSchema = z.object({
  executionTarget: automationExecutionTargetSchema.optional(),
})
export type RunAutomationNow = z.infer<typeof runAutomationNowSchema>

export const automationListSchema = z.object({
  items: z.array(z.object({
    automation: automationSchema,
    revision: automationRevisionSchema,
    latestRun: automationRunSchema.nullable(),
  })),
  nextCursor: z.string().nullable(),
}).meta({ ref: "AutomationList" })
export type AutomationList = z.infer<typeof automationListSchema>

/** Most days one calendar range read may cover (a month view plus padding). */
export const AUTOMATION_RUN_RANGE_MAX_DAYS = 45

export const automationRunRangeQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().describe("Inclusive lower bound, epoch milliseconds."),
  to: z.coerce.number().int().positive().describe("Exclusive upper bound, epoch milliseconds."),
  cursor: z.string().trim().min(1).max(160).optional().describe("nextCursor from the previous page."),
  limit: z.coerce.number().int().min(1).max(500).optional().describe("Maximum runs to scan for this page (default 200)."),
}).refine((value) => value.to > value.from, { message: "to must be after from", path: ["to"] })
  .refine((value) => value.to - value.from <= AUTOMATION_RUN_RANGE_MAX_DAYS * 24 * 60 * 60 * 1_000, {
    message: `The range may cover at most ${AUTOMATION_RUN_RANGE_MAX_DAYS} days`, path: ["to"],
  })
export type AutomationRunRangeQuery = z.infer<typeof automationRunRangeQuerySchema>

/**
 * Runs of every Automation the caller owns, placed by scheduledFor (else
 * startedAt, else createdAt). A non-null `nextCursor` means more may exist.
 */
export const automationRunRangeSchema = z.object({
  items: z.array(automationRunSchema),
  nextCursor: z.string().nullable(),
}).meta({ ref: "AutomationRunRange" })
export type AutomationRunRange = z.infer<typeof automationRunRangeSchema>

export const automationDetailSchema = z.object({
  automation: automationSchema,
  revision: automationRevisionSchema,
  latestRun: automationRunSchema.nullable(),
}).meta({ ref: "AutomationDetail" })
export type AutomationDetail = z.infer<typeof automationDetailSchema>

export const automationRunReceiptSchema = z.object({
  run: automationRunSchema,
  automation: automationSchema,
  revision: automationRevisionSchema,
  events: z.array(automationRunEventSchema),
}).meta({ ref: "AutomationRunReceipt" })
export type AutomationRunReceipt = z.infer<typeof automationRunReceiptSchema>

export const AUTOMATION_MAXIMUM_ATTEMPTS = 2
export const AUTOMATION_RETRY_DELAY_MS = 30_000
export const AUTOMATION_DEFAULT_MAXIMUM_RUNTIME_MS = 15 * 60_000
export const AUTOMATION_MAXIMUM_RUNTIME_MS = 60 * 60_000
