import { z } from "zod";

import { engineEventTypes, type EngineEvent, type EngineGlobalEventEnvelope } from "./events.js";

const sessionTimeSchema = z
  .object({
    created: z.number().optional(),
    updated: z.number().optional(),
    completed: z.number().optional(),
    archived: z.number().optional(),
  })
  .passthrough();

const sessionSummarySchema = z
  .object({
    additions: z.number().optional(),
    deletions: z.number().optional(),
    files: z.number().optional(),
  })
  .passthrough();

export const sessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number() }).passthrough(),
]);

export const sessionTodoSchema = z
  .object({
    content: z.string(),
    status: z.string(),
    priority: z.string(),
  })
  .passthrough();

export const sessionInfoSchema = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    slug: z.string().nullish(),
    parentID: z.string().nullish(),
    directory: z.string().nullish(),
    time: sessionTimeSchema.optional(),
    summary: sessionSummarySchema.optional(),
  })
  .passthrough();

const sessionMessageInfoSchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    role: z.string(),
    parentID: z.string().nullish(),
    time: sessionTimeSchema.optional(),
  })
  .passthrough();

export const sessionPartSchema = z
  .object({
    id: z.string(),
    messageID: z.string(),
    sessionID: z.string(),
  })
  .passthrough();

export const sessionMessageSchema = z
  .object({
    info: sessionMessageInfoSchema,
    parts: z.array(sessionPartSchema),
  })
  .passthrough();

export const sessionListSchema = z.array(sessionInfoSchema);
export const sessionMessagesSchema = z.array(sessionMessageSchema);
export const sessionTodosSchema = z.array(sessionTodoSchema);
export const sessionStatusesSchema = z.record(z.string(), sessionStatusSchema);

export const sessionSnapshotSchema = z.object({
  session: sessionInfoSchema,
  messages: sessionMessagesSchema,
  todos: sessionTodosSchema,
  status: sessionStatusSchema,
});

const eventPropertiesSchema = z.record(z.string(), z.unknown());

export const engineEventWireSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    properties: eventPropertiesSchema,
  })
  .refine((value) => engineEventTypes.some((type) => type === value.type), {
    message: "Unsupported engine event type",
    path: ["type"],
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEngineEvent(value: unknown): value is EngineEvent {
  const result = engineEventWireSchema.safeParse(value);
  return result.success;
}

function isEngineEventEnvelope(value: unknown): value is EngineEvent | EngineGlobalEventEnvelope {
  if (isEngineEvent(value)) return true;
  if (!isRecord(value)) return false;
  if (typeof value.directory !== "string") return false;
  return isEngineEvent(value.payload);
}

export const engineEventSchema = z.custom<EngineEvent>(isEngineEvent, "Invalid engine event");
export const engineEventEnvelopeSchema = z.custom<EngineEvent | EngineGlobalEventEnvelope>(
  isEngineEventEnvelope,
  "Invalid engine event envelope",
);

export type SessionInfoReadModel = z.infer<typeof sessionInfoSchema>;
export type SessionMessageReadModel = z.infer<typeof sessionMessageSchema>;
export type SessionTodoReadModel = z.infer<typeof sessionTodoSchema>;
export type SessionStatusReadModel = z.infer<typeof sessionStatusSchema>;
export type SessionSnapshotReadModel = z.infer<typeof sessionSnapshotSchema>;
