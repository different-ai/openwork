/**
 * The OpenCode v2 wire boundary, plus the server routes that pick an engine
 * and a model.
 *
 * v2 payloads are mapped into the v1 wire shapes `wire.ts` already parses, so
 * snapshots, transcripts, and waits behave the same on either engine.
 */
import { z } from "zod";

import type { HeadlessThreadModel } from "./types.js";
import type { MessageWire, SessionWire } from "./wire.js";

/** `GET /experimental/engine-v2-preview/status`. Only these two flags matter here. */
export const engineStatusSchema = z
  .object({ enabled: z.boolean(), chatRouting: z.boolean() })
  .passthrough();

/** `GET /workspace/:id/default-model`. */
export const defaultModelSchema = z
  .object({
    model: z
      .object({ providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().min(1).optional() })
      .passthrough()
      .nullable(),
  })
  .passthrough();

export function toHeadlessModel(model: z.infer<typeof defaultModelSchema>["model"]): HeadlessThreadModel | null {
  if (!model) return null;
  return {
    providerId: model.providerID,
    modelId: model.modelID,
    ...(model.variant === undefined ? {} : { variant: model.variant }),
  };
}

/** v2 routes wrap every payload in `{ data }`. */
function data<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema }).passthrough();
}

const modelRefSchema = z
  .object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
  .passthrough();

export const v2SessionSchema = data(
  z
    .object({
      id: z.string(),
      metadata: z.record(z.string(), z.unknown()).nullish(),
      title: z.string().nullish(),
      openworkHomeDirectory: z.string().optional(),
      location: z.object({ directory: z.string().optional() }).passthrough().optional(),
      time: z.object({ created: z.number().optional() }).passthrough().optional(),
      model: modelRefSchema.optional(),
    })
    .passthrough(),
);

const tokensSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  reasoning: z.number().nonnegative().optional(),
  cache: z.object({
    read: z.number().nonnegative().optional(),
    write: z.number().nonnegative().optional(),
  }).optional(),
});

const v2ContentSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    text: z.string().optional(),
    name: z.string().optional(),
    tool: z.string().optional(),
    callID: z.string().optional(),
    time: z.object({ created: z.number().optional(), ran: z.number().optional(), completed: z.number().optional() }).passthrough().optional(),
    state: z.object({
      status: z.string().optional(),
      input: z.unknown().optional(),
      content: z.unknown().optional(),
      result: z.unknown().optional(),
      error: z.unknown().optional(),
      title: z.string().optional(),
    }).passthrough().optional(),
  })
  .passthrough();

const v2MessageSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    role: z.string().optional(),
    time: z.object({ created: z.number().optional(), completed: z.number().optional() }).passthrough().optional(),
    text: z.string().optional(),
    content: z.array(v2ContentSchema).optional(),
    error: z.unknown().optional(),
    cost: z.number().nonnegative().optional(),
    tokens: tokensSchema.optional(),
  })
  .passthrough();

/** One page of `GET /api/session/:id/message`, newest first. */
export const v2MessagePageSchema = z
  .object({
    data: z.array(v2MessageSchema),
    cursor: z.object({ next: z.string().nullish() }).passthrough().optional(),
  })
  .passthrough();

/** `GET /api/session/active`: only running sessions are listed. */
export const v2ActiveSchema = data(z.record(z.string(), z.object({ type: z.string() }).passthrough()));

export const v2InterruptSchema = data(z.object({ interrupted: z.boolean() }).passthrough());

type V2Session = z.infer<typeof v2SessionSchema>["data"];
type V2Message = z.infer<typeof v2MessageSchema>;
type V2Content = z.infer<typeof v2ContentSchema>;

export function v2SessionModel(session: V2Session): HeadlessThreadModel | null {
  if (!session.model) return null;
  return {
    providerId: session.model.providerID,
    modelId: session.model.id,
    ...(session.model.variant === undefined ? {} : { variant: session.model.variant }),
  };
}

export function fromV2Session(session: V2Session): SessionWire {
  const directory = session.openworkHomeDirectory ?? session.location?.directory;
  return {
    id: session.id,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(directory === undefined ? {} : { directory }),
    ...(session.time?.created === undefined ? {} : { time: { created: session.time.created } }),
  };
}

function roleOf(message: V2Message): string {
  return message.role ?? message.type ?? "";
}

function fromV2Content(messageId: string, content: V2Content, index: number): MessageWire["parts"] {
  const id = content.id ?? `${messageId}:${index}`;
  if ((content.type === "text" || content.type === "reasoning") && content.text !== undefined) {
    const start = content.time?.created;
    const end = content.time?.completed;
    return [{
      id,
      type: content.type,
      text: content.text,
      ...(start === undefined ? {} : { time: { start, ...(end === undefined ? {} : { end }) } }),
    }];
  }
  if (content.type === "tool") {
    const tool = content.name ?? content.tool;
    if (tool === undefined) return [];
    const state = content.state;
    const output = state ? v2ToolOutput(state.content, state.result) : undefined;
    const error = state?.status === "error" ? v2ErrorText(state.error ?? state.result) : undefined;
    const start = content.time?.ran ?? content.time?.created;
    const end = content.time?.completed;
    return [{
      id,
      type: "tool",
      tool,
      callID: content.callID ?? id,
      ...(state?.status === undefined ? {} : {
        state: {
          status: state.status,
          ...(state.input === undefined ? {} : { input: state.input }),
          ...(state.status === "completed" && output !== undefined ? { output } : {}),
          ...(error === undefined ? {} : { error }),
          ...(state.title === undefined ? {} : { title: state.title }),
          ...(start === undefined ? {} : { time: { start, ...(end === undefined ? {} : { end }) } }),
        },
      }),
    }];
  }
  return [];
}

/** A v2 tool's text content, or its structured result as JSON. */
function v2ToolOutput(content: unknown, result: unknown): string | undefined {
  if (Array.isArray(content)) {
    const text = content.flatMap((item) => {
      const parsed = z.object({ type: z.literal("text"), text: z.string() }).passthrough().safeParse(item);
      return parsed.success ? [parsed.data.text] : [];
    });
    if (text.length > 0) return text.join("\n");
  }
  if (typeof result === "string") return result;
  if (result === undefined) return undefined;
  try {
    return JSON.stringify(result);
  } catch {
    return undefined;
  }
}

function v2ErrorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  const parsed = z.object({ message: z.string().optional(), type: z.string().optional() }).passthrough().safeParse(error);
  if (!parsed.success) return undefined;
  return parsed.data.message ?? parsed.data.type;
}

/** v2 errors are `{ type, message }`; give them the `name` v1 errors carry. */
function fromV2Error(error: unknown): unknown {
  const parsed = z.object({ type: z.string().optional(), name: z.string().optional() }).passthrough().safeParse(error);
  if (!parsed.success) return error;
  const name = parsed.data.name ?? (parsed.data.type && parsed.data.type !== "unknown" ? parsed.data.type : "UnknownError");
  return { ...parsed.data, name };
}

/**
 * Maps v2 messages, oldest first, into v1 message shapes. Only user and
 * assistant turns are kept: v2 also records model switches, compactions, and
 * system entries that the conversation does not show.
 *
 * v2 assistant messages carry no `parentID`, so each one is attributed to the
 * nearest preceding user message, which is the turn that produced it.
 */
export function fromV2Messages(messages: V2Message[]): MessageWire[] {
  let parentId: string | null = null;
  return messages.flatMap((message): MessageWire[] => {
    const role = roleOf(message);
    if (role !== "user" && role !== "assistant") return [];
    if (role === "user") parentId = message.id;
    const parts = message.content
      ? message.content.flatMap((content, index) => fromV2Content(message.id, content, index))
      : message.text === undefined ? [] : [{ id: `${message.id}:0`, type: "text", text: message.text }];
    return [{
      info: {
        id: message.id,
        role,
        ...(role === "assistant" && parentId !== null ? { parentID: parentId } : {}),
        ...(message.time?.created === undefined ? {} : {
          time: {
            created: message.time.created,
            ...(message.time.completed === undefined ? {} : { completed: message.time.completed }),
          },
        }),
        ...(role === "assistant" && message.error !== undefined && message.error !== null ? { error: fromV2Error(message.error) } : {}),
        ...(message.tokens === undefined ? {} : { tokens: message.tokens }),
        ...(message.cost === undefined ? {} : { cost: message.cost }),
      },
      parts,
    }];
  });
}
