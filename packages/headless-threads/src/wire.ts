/**
 * The wire boundary: schemas for what the OpenWork server already returns on
 * its session routes, plus the mapping into the headless thread types.
 *
 * Every schema is permissive about fields it does not name, so an engine or
 * server that grows a field does not break a benchmark run mid-campaign.
 */
import { z } from "zod";

import type {
  HeadlessThread,
  HeadlessThreadMessage,
  HeadlessThreadMessagePart,
  HeadlessThreadSnapshot,
  HeadlessThreadStatus,
  HeadlessThreadTodo,
} from "./types.js";

const timeSchema = z
  .object({
    created: z.number().optional(),
    updated: z.number().optional(),
  })
  .passthrough();

export const threadStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number() }),
]);

const sessionSchema = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    directory: z.string().nullish(),
    time: timeSchema.optional(),
  })
  .passthrough();

const partSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    text: z.string().optional(),
    tool: z.string().optional(),
    callID: z.string().optional(),
    state: z.object({ status: z.string().optional() }).passthrough().optional(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    info: z
      .object({
        id: z.string(),
        role: z.string(),
        time: timeSchema.optional(),
      })
      .passthrough(),
    parts: z.array(partSchema),
  })
  .passthrough();

const todoSchema = z
  .object({
    content: z.string(),
    status: z.string(),
    priority: z.string(),
  })
  .passthrough();

export const createThreadResponseSchema = z.object({
  item: sessionSchema,
  started: z.boolean(),
});

export const threadSnapshotResponseSchema = z.object({
  item: z.object({
    session: sessionSchema,
    messages: z.array(messageSchema),
    todos: z.array(todoSchema),
    status: threadStatusSchema,
  }),
});

export const threadMessagesResponseSchema = z.object({
  items: z.array(messageSchema),
});

export const abortResponseSchema = z.object({
  ok: z.boolean(),
});

type SessionWire = z.infer<typeof sessionSchema>;
type MessageWire = z.infer<typeof messageSchema>;
type PartWire = z.infer<typeof partSchema>;
type TodoWire = z.infer<typeof todoSchema>;

function optionalString(value: string | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function toPart(part: PartWire): HeadlessThreadMessagePart {
  const mapped: HeadlessThreadMessagePart = { id: part.id };
  if (part.type !== undefined) mapped.type = part.type;
  if (part.text !== undefined) mapped.text = part.text;
  if (part.tool !== undefined) mapped.tool = part.tool;
  if (part.callID !== undefined) mapped.callId = part.callID;
  if (part.state?.status !== undefined) mapped.toolStatus = part.state.status;
  if (part.synthetic !== undefined) mapped.synthetic = part.synthetic;
  if (part.ignored !== undefined) mapped.ignored = part.ignored;
  return mapped;
}

export function toThreadMessage(message: MessageWire): HeadlessThreadMessage {
  return {
    id: message.info.id,
    role: message.info.role,
    createdAt: message.info.time?.created ?? null,
    parts: message.parts.map(toPart),
  };
}

function toTodo(todo: TodoWire): HeadlessThreadTodo {
  return { content: todo.content, status: todo.status, priority: todo.priority };
}

export function toThread(session: SessionWire, workspaceId: string, started: boolean): HeadlessThread {
  return {
    id: session.id,
    workspaceId,
    title: optionalString(session.title),
    directory: optionalString(session.directory),
    createdAt: session.time?.created ?? null,
    started,
  };
}

export function toSnapshot(item: z.infer<typeof threadSnapshotResponseSchema>["item"]): HeadlessThreadSnapshot {
  return {
    threadId: item.session.id,
    title: optionalString(item.session.title),
    directory: optionalString(item.session.directory),
    status: item.status,
    messages: item.messages.map(toThreadMessage),
    todos: item.todos.map(toTodo),
  };
}

/** Busy and retry both mean the engine still owns the turn. */
export function isRunning(status: HeadlessThreadStatus): boolean {
  return status.type === "busy" || status.type === "retry";
}
