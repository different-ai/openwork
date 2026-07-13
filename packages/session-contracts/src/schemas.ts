import { z } from "zod"
import {
  OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES,
  OPEN_WORK_SESSION_EVENT_FRAME_VERSION,
} from "./events.js"

export const openWorkSessionTimeSchema = z
  .object({
    created: z.number().optional(),
    updated: z.number().optional(),
    completed: z.number().optional(),
    archived: z.number().optional(),
  })
  .passthrough()

export const openWorkSessionSummarySchema = z
  .object({
    additions: z.number().optional(),
    deletions: z.number().optional(),
    files: z.number().optional(),
  })
  .passthrough()

export const openWorkSessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({
    type: z.literal("retry"),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
  }),
])

export const openWorkSessionTodoSchema = z
  .object({
    content: z.string(),
    status: z.string(),
    priority: z.string(),
  })
  .passthrough()

export const openWorkSessionInfoSchema = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    slug: z.string().nullish(),
    parentID: z.string().nullish(),
    directory: z.string().nullish(),
    time: openWorkSessionTimeSchema.optional(),
    summary: openWorkSessionSummarySchema.optional(),
  })
  .passthrough()

export const openWorkSessionMessageInfoSchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    role: z.string(),
    parentID: z.string().nullish(),
    time: openWorkSessionTimeSchema.optional(),
  })
  .passthrough()

export const openWorkSessionPartSchema = z
  .object({
    id: z.string(),
    messageID: z.string(),
    sessionID: z.string(),
  })
  .passthrough()

export const openWorkSessionMessageSchema = z
  .object({
    info: openWorkSessionMessageInfoSchema,
    parts: z.array(openWorkSessionPartSchema),
  })
  .passthrough()

export const openWorkSessionListSchema = z.array(openWorkSessionInfoSchema)
export const openWorkSessionMessagesSchema = z.array(openWorkSessionMessageSchema)
export const openWorkSessionTodosSchema = z.array(openWorkSessionTodoSchema)
export const openWorkSessionStatusesSchema = z.record(z.string(), openWorkSessionStatusSchema)

export const openWorkSessionSnapshotSchema = z.object({
  session: openWorkSessionInfoSchema,
  messages: openWorkSessionMessagesSchema,
  todos: openWorkSessionTodosSchema,
  status: openWorkSessionStatusSchema,
})

export const openWorkSessionFailureSchema = z.object({
  code: z.enum([
    "provider_auth",
    "output_limit",
    "aborted",
    "structured_output",
    "context_overflow",
    "content_filter",
    "upstream_api",
    "unknown",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  providerId: z.string().optional(),
  statusCode: z.number().int().optional(),
  responseBody: z.string().optional(),
  reference: z.string().optional(),
  retries: z.number().int().nonnegative().optional(),
})

export const openWorkSessionStreamErrorSchema = z.object({
  code: z.enum([
    "OPENWORK_SESSION_STREAM_UNAUTHORIZED",
    "OPENWORK_SESSION_STREAM_FORBIDDEN",
    "OPENWORK_SESSION_STREAM_NOT_FOUND",
    "OPENWORK_SESSION_STREAM_ENGINE_UNAVAILABLE",
    "OPENWORK_SESSION_STREAM_INVALID_FRAME",
    "OPENWORK_SESSION_STREAM_DISCONNECTED",
  ]),
  message: z.string(),
  retryable: z.boolean(),
  status: z.number().int().optional(),
})

export const openWorkSessionEventSourceSchema = z.object({
  adapterId: z.string().min(1),
  eventType: z.string().min(1),
  eventId: z.string().min(1).optional(),
})

export const openWorkNormalizedSessionEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session.updated"),
    sessionId: z.string().min(1),
    info: openWorkSessionInfoSchema,
  }),
  z.object({
    kind: z.literal("session.failed"),
    sessionId: z.string().min(1),
    failure: openWorkSessionFailureSchema,
  }),
])

export const openWorkCompatibilitySessionEventSchema = z.object({
  kind: z.literal("compatibility"),
  sourceType: z.enum(OPEN_WORK_COMPATIBILITY_SESSION_EVENT_TYPES),
  properties: z.unknown(),
})

export const openWorkUnknownSessionEventSchema = z.object({
  kind: z.literal("unknown"),
  sourceType: z.string().min(1),
  reason: z.enum(["unsupported_type", "invalid_payload"]),
})

export const openWorkSessionEventSchema = z.union([
  openWorkNormalizedSessionEventSchema,
  openWorkCompatibilitySessionEventSchema,
  openWorkUnknownSessionEventSchema,
])

export const openWorkSessionStreamFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    schemaVersion: z.literal(OPEN_WORK_SESSION_EVENT_FRAME_VERSION),
    kind: z.literal("event"),
    workspaceId: z.string().min(1),
    source: openWorkSessionEventSourceSchema,
    event: openWorkSessionEventSchema,
  }),
  z.object({
    schemaVersion: z.literal(OPEN_WORK_SESSION_EVENT_FRAME_VERSION),
    kind: z.literal("stream.error"),
    workspaceId: z.string().min(1),
    source: openWorkSessionEventSourceSchema,
    error: openWorkSessionStreamErrorSchema,
  }),
])

export type SessionInfoReadModel = z.infer<typeof openWorkSessionInfoSchema>
export type SessionMessageReadModel = z.infer<typeof openWorkSessionMessageSchema>
export type SessionTodoReadModel = z.infer<typeof openWorkSessionTodoSchema>
export type SessionStatusReadModel = z.infer<typeof openWorkSessionStatusSchema>
export type SessionSnapshotReadModel = z.infer<typeof openWorkSessionSnapshotSchema>
export type SessionStreamFrameReadModel = z.infer<typeof openWorkSessionStreamFrameSchema>
