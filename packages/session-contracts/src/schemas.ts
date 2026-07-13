import { z } from "zod"

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

export type SessionInfoReadModel = z.infer<typeof openWorkSessionInfoSchema>
export type SessionMessageReadModel = z.infer<typeof openWorkSessionMessageSchema>
export type SessionTodoReadModel = z.infer<typeof openWorkSessionTodoSchema>
export type SessionStatusReadModel = z.infer<typeof openWorkSessionStatusSchema>
export type SessionSnapshotReadModel = z.infer<typeof openWorkSessionSnapshotSchema>
