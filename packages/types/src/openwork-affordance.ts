import { z } from "zod"

export const OPENWORK_AFFORDANCE_SCHEMA_VERSION = 1

export const openworkAffordanceKindSchema = z.enum(["query", "command", "guidance"])
export type OpenworkAffordanceKind = z.infer<typeof openworkAffordanceKindSchema>

export const openworkProviderKindSchema = z.enum(["builtin", "extension", "mcp", "connect"])
export type OpenworkProviderKind = z.infer<typeof openworkProviderKindSchema>

export const openworkProviderRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: openworkProviderKindSchema,
})
export type OpenworkProviderRef = z.infer<typeof openworkProviderRefSchema>

export const openworkAffordanceArgumentSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  required: z.boolean(),
  description: z.string().trim().min(1).optional(),
})
export type OpenworkAffordanceArgument = z.infer<typeof openworkAffordanceArgumentSchema>

export const openworkAffordanceEffectsSchema = z.object({
  data: z.enum(["none", "read", "write"]),
  ui: z.enum(["none", "focus", "navigate", "layout", "dialog"]),
  external: z.boolean(),
})
export type OpenworkAffordanceEffects = z.infer<typeof openworkAffordanceEffectsSchema>

export const openworkAffordanceAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).optional(),
})
export type OpenworkAffordanceAvailability = z.infer<typeof openworkAffordanceAvailabilitySchema>

export const openworkAffordanceExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("openwork") }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().trim().min(1),
  }),
])
export type OpenworkAffordanceExecutor = z.infer<typeof openworkAffordanceExecutorSchema>

export const openworkAffordanceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  kind: openworkAffordanceKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: openworkProviderRefSchema,
  arguments: z.array(openworkAffordanceArgumentSchema),
  effects: openworkAffordanceEffectsSchema,
  confirmation: z.enum(["never", "destructive", "always"]),
  availability: openworkAffordanceAvailabilitySchema,
  executor: openworkAffordanceExecutorSchema,
})
export type OpenworkAffordanceDescriptor = z.infer<typeof openworkAffordanceDescriptorSchema>

/**
 * Where a request came from: the conversation (session) whose agent issued
 * it. Set by the OpenWork bridge, never by the agent, so UI commands such as
 * opening a browser tab can act for the requesting conversation instead of
 * whichever one happens to be on screen.
 */
export const openworkAffordanceOriginSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1).optional(),
})
export type OpenworkAffordanceOrigin = z.infer<typeof openworkAffordanceOriginSchema>

export const openworkAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  actor: z.string().trim().min(1).optional(),
  origin: openworkAffordanceOriginSchema.optional(),
})
export type OpenworkAffordanceRequest = z.infer<typeof openworkAffordanceRequestSchema>

const openworkAffordanceSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  result: z.unknown().optional(),
  revision: z.number().int().nonnegative().optional(),
  effects: openworkAffordanceEffectsSchema,
})

/**
 * Structured outcomes an action can report so the agent can decide instead of
 * retrying a transport-looking error. Warnings travel back through the channel
 * the request came from: an agent never gets a dialog, it gets one of these.
 * - `target_working`: the target session is still working; stop it first
 *   (session.stop) if the person wants it closed, otherwise leave it running.
 * - `self_archive_while_working`: a session asked to archive itself (or its
 *   parent) from inside its own running turn; finish the turn, the reviewer
 *   archives.
 */
export const openworkAffordanceFailureCodeSchema = z.enum([
  "unavailable",
  "invalid-args",
  "conflict",
  "failed",
  "target_working",
  "self_archive_while_working",
])
export type OpenworkAffordanceFailureCode = z.infer<typeof openworkAffordanceFailureCodeSchema>

const openworkAffordanceFailureSchema = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
  code: openworkAffordanceFailureCodeSchema,
  hint: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
})

export const openworkAffordanceResultSchema = z.discriminatedUnion("ok", [
  openworkAffordanceSuccessSchema,
  openworkAffordanceFailureSchema,
])
export type OpenworkAffordanceResult = z.infer<typeof openworkAffordanceResultSchema>
