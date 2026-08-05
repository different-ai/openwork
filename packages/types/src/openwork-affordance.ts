import { z } from "zod"

export const MICX_AFFORDANCE_SCHEMA_VERSION = 1

export const micxAffordanceKindSchema = z.enum(["query", "command", "guidance"])
export type MicxAffordanceKind = z.infer<typeof micxAffordanceKindSchema>

export const micxProviderKindSchema = z.enum(["builtin", "extension", "mcp", "connect"])
export type MicxProviderKind = z.infer<typeof micxProviderKindSchema>

export const micxProviderRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: micxProviderKindSchema,
})
export type MicxProviderRef = z.infer<typeof micxProviderRefSchema>

export const micxAffordanceArgumentSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  required: z.boolean(),
  description: z.string().trim().min(1).optional(),
})
export type MicxAffordanceArgument = z.infer<typeof micxAffordanceArgumentSchema>

export const micxAffordanceEffectsSchema = z.object({
  data: z.enum(["none", "read", "write"]),
  ui: z.enum(["none", "focus", "navigate", "layout", "dialog"]),
  external: z.boolean(),
})
export type MicxAffordanceEffects = z.infer<typeof micxAffordanceEffectsSchema>

export const micxAffordanceAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).optional(),
})
export type MicxAffordanceAvailability = z.infer<typeof micxAffordanceAvailabilitySchema>

export const micxAffordanceExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("micx") }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().trim().min(1),
  }),
])
export type MicxAffordanceExecutor = z.infer<typeof micxAffordanceExecutorSchema>

export const micxAffordanceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  kind: micxAffordanceKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: micxProviderRefSchema,
  arguments: z.array(micxAffordanceArgumentSchema),
  effects: micxAffordanceEffectsSchema,
  confirmation: z.enum(["never", "destructive", "always"]),
  availability: micxAffordanceAvailabilitySchema,
  executor: micxAffordanceExecutorSchema,
})
export type MicxAffordanceDescriptor = z.infer<typeof micxAffordanceDescriptorSchema>

export const micxAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  actor: z.string().trim().min(1).optional(),
})
export type MicxAffordanceRequest = z.infer<typeof micxAffordanceRequestSchema>

const micxAffordanceSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  result: z.unknown().optional(),
  revision: z.number().int().nonnegative().optional(),
  effects: micxAffordanceEffectsSchema,
})

const micxAffordanceFailureSchema = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
  code: z.enum(["unavailable", "invalid-args", "conflict", "failed"]),
  revision: z.number().int().nonnegative().optional(),
})

export const micxAffordanceResultSchema = z.discriminatedUnion("ok", [
  micxAffordanceSuccessSchema,
  micxAffordanceFailureSchema,
])
export type MicxAffordanceResult = z.infer<typeof micxAffordanceResultSchema>
