import { z } from "zod"

const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)
const label = z.string().min(1).max(255)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const metadata = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/),
  z.union([z.string().max(128), z.number().finite(), z.boolean()]))
  .refine((value) => Object.keys(value).length <= 16, "At most 16 metadata fields")

// Content is deliberately absent. Adding content collection requires a separate
// consent contract; enabling Models or metadata analytics never grants it.
export const modelsAnalyticsEventSchema = z.object({
  id: identifier,
  type: z.enum(["task.started", "task.completed", "task.failed", "task.cancelled", "tool.executed", "skill.loaded", "model.call"]),
  timestamp: z.iso.datetime(),
  sessionId: identifier,
  taskId: identifier,
  callId: identifier.optional(),
  durationMs: count.optional(),
  status: z.enum(["completed", "failed", "cancelled"]).optional(),
  model: label.optional(),
  provider: label.optional(),
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  cacheReadTokens: count.optional(),
  cacheWriteTokens: count.optional(),
  costUsd: z.number().finite().nonnegative().optional(),
  usageComplete: z.boolean().optional(),
  tool: identifier.optional(),
  skill: identifier.optional(),
  skillVersion: identifier.optional(),
  mcp: identifier.optional(),
  metadata: metadata.optional(),
}).strict()

export type ModelsAnalyticsEvent = z.infer<typeof modelsAnalyticsEventSchema>

// Only the authenticated inference service may supply consumption records.
export const modelsTaskBatchSchema = z.object({
  events: z.array(modelsAnalyticsEventSchema.refine((event) => event.type !== "model.call"
    && event.costUsd === undefined && event.inputTokens === undefined && event.outputTokens === undefined
    && event.cacheReadTokens === undefined && event.cacheWriteTokens === undefined
    && event.usageComplete === undefined && event.provider === undefined && event.model === undefined,
  "Runtime events cannot report model consumption")).min(1).max(50),
}).strict()

export const modelsAnalyticsSettingsSchema = z.object({
  available: z.boolean(),
  subscribed: z.boolean(),
  modelsEnabled: z.boolean(),
  enabled: z.boolean(),
  consentedAt: z.string().nullable(),
  consentVersion: z.number().nullable(),
  exportEnabled: z.boolean(),
  langfuseHost: z.string().nullable(),
  langfuseConfigured: z.boolean(),
})
export type ModelsAnalyticsSettings = z.infer<typeof modelsAnalyticsSettingsSchema>

export const modelsAnalyticsChoiceSchema = z.object({
  enabled: z.boolean(),
  consentVersion: z.literal(1).optional(),
}).strict().refine((value) => !value.enabled || value.consentVersion === 1, "Confirm the task analytics choice")

export const modelsAnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  memberId: identifier.optional(),
  taskId: identifier.optional(),
  sessionId: identifier.optional(),
  before: z.iso.datetime().optional(),
  beforeId: identifier.optional(),
}).refine((query) => Boolean(query.before) === Boolean(query.beforeId), "A cursor needs both time and id")

export const modelsAnalyticsRecordSchema = modelsAnalyticsEventSchema.extend({
  memberId: z.string(),
  source: z.enum(["app", "inference"]),
})
export const modelsAnalyticsActivitySchema = z.object({
  events: z.array(modelsAnalyticsRecordSchema),
  next: z.object({ before: z.string(), beforeId: z.string() }).nullable(),
})
export const modelsConsumptionSchema = z.object({
  groups: z.array(z.object({
    model: z.string().nullable(),
    provider: z.string().nullable(),
    memberId: z.string(),
    day: z.string(),
    calls: z.number(),
    failedCalls: z.number(),
    incompleteCalls: z.number(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    cacheReadTokens: z.number().nullable(),
    costUsd: z.number().nullable(),
  })),
})
