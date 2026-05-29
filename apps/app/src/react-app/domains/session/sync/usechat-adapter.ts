/** @jsxImportSource react */
import type { UIMessage, UIMessageChunk, ChatTransport } from "ai";
import type { FilePart, Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/v2/client";

import { abortSessionSafe } from "../../../../app/lib/opencode-session";
import type { OpenworkSessionSnapshot } from "../../../../app/lib/openwork-server";
import { normalizeEvent, safeStringify } from "../../../../app/utils";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX, type OpencodeEvent } from "../../../../app/types";
import { createClient } from "../../../../app/lib/opencode";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
  shouldDeferInProgressTool,
  STRUCTURED_OUTPUT_TOOL,
} from "./parse-tool-parts";

type TransportOptions = {
  baseUrl: string;
  openworkToken: string;
  sessionId: string;
};

type ToolStreamState = {
  inputSent: boolean;
  inputText: string;
  outputSent: boolean;
  errorSent: boolean;
  attachmentIds: Set<string>;
};

type PendingDelta = {
  delta: string;
};

type InternalPartState = {
  textStarted: Set<string>;
  reasoningStarted: Set<string>;
  textValues: Map<string, string>;
  reasoningValues: Map<string, string>;
  pendingDeltas: Map<string, PendingDelta[]>;
  partKinds: Map<string, Part["type"]>;
  partSessions: Map<string, string>;
  ignoredParts: Set<string>;
  messageRoles: Map<string, string>;
  pendingRoleEvents: Map<string, OpencodeEvent[]>;
  tools: Map<string, ToolStreamState>;
  assistantMessageId: string | null;
  streamFinished: boolean;
};

function recordValue(value: unknown, key: string) {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function firstStringValue(records: unknown[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function firstNumberValue(records: unknown[], keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = recordValue(record, key);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

export function describeOpencodeSessionError(error: unknown, fallback = "Session failed") {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === "string") return error.trim() || fallback;
  if (!error || typeof error !== "object") return fallback;

  const data = recordValue(error, "data");
  const cause = recordValue(error, "cause");
  const causeData = recordValue(cause, "data");
  const records = [error, data, cause, causeData].filter(Boolean);
  const message = firstStringValue(records, ["message", "detail", "reason", "error"]);
  const status = firstNumberValue(records, ["statusCode", "status"]);
  const provider = firstStringValue(records, ["providerID", "providerId", "provider"]);
  const code = firstStringValue(records, ["code", "errorCode"]);
  const responseBody = firstStringValue(records, ["responseBody", "body", "response"]);

  const lines = [message ?? fallback];
  if (status && !lines[0]?.includes(String(status))) lines.push(`Status: ${status}`);
  if (provider && !lines[0]?.includes(provider)) lines.push(`Provider: ${provider}`);
  if (code) lines.push(`Code: ${code}`);
  if (responseBody && responseBody !== message) lines.push(`Response: ${responseBody}`);
  if (lines.some((line) => line !== fallback)) return lines.join("\n");

  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : fallback;
}

function sessionErrorMessageId(turnKey: string) {
  return `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${turnKey}`;
}

/**
 * Build the synthetic chat message that surfaces a session error.
 *
 * The error is keyed to the *turn* that failed (`turnKey`), not the session.
 * Both the live `session.error` event and the snapshot reload derive the same
 * `turnKey` from the errored assistant message id, so they reconcile to one
 * message instead of duplicating — while a brand new error on a later turn
 * still produces its own message instead of overwriting the previous one.
 */
export function createSessionErrorUIMessage(turnKey: string, text: string, options?: { created?: number }): UIMessage {
  const id = sessionErrorMessageId(turnKey);
  const created = options?.created;
  return {
    id,
    role: "assistant",
    ...(typeof created === "number" ? { metadata: { opencode: { created } } } : {}),
    parts: [{
      type: "text",
      text,
      state: "done",
      providerMetadata: { opencode: { partId: `${id}:text` } },
    }],
  };
}

function fileProviderMetadata(part: FilePart) {
  if (part.source) {
    return { opencode: { partId: part.id, source: part.source } };
  }
  return { opencode: { partId: part.id } };
}

function getTextPartValue(part: Part) {
  if (part.type === "text") {
    return part.text;
  }
  if (part.type === "reasoning") {
    return part.text;
  }
  return "";
}

function getTextPartDelta(part: TextPart | ReasoningPart, delta: string, values: Map<string, string>) {
  const nextText = part.text;
  if (delta) {
    const previous = values.get(part.id);
    values.set(part.id, nextText);
    if (previous && nextText.startsWith(previous)) return nextText.slice(previous.length);
    return delta;
  }

  const previous = values.get(part.id);
  values.set(part.id, nextText);
  if (previous === undefined) return nextText;
  if (nextText.startsWith(previous)) return nextText.slice(previous.length);
  if (nextText !== previous) return nextText;
  return "";
}

function mapFilePart(part: FilePart): UIMessage["parts"][number] {
  return {
    type: "file",
    url: part.url,
    filename: part.filename,
    mediaType: part.mime,
    providerMetadata: fileProviderMetadata(part),
  };
}

function mapFileSourcePart(part: FilePart): UIMessage["parts"][number] | null {
  const source = part.source;
  if (!source) return null;

  const sourceId = `${part.id}:source`;
  const providerMetadata = { opencode: { partId: sourceId, sourcePartId: part.id, source } };

  if (source.type === "resource") {
    if (source.uri.startsWith("http://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    if (source.uri.startsWith("https://")) {
      return { type: "source-url", sourceId, url: source.uri, title: source.uri, providerMetadata };
    }
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.uri, providerMetadata };
  }

  if (source.type === "symbol") {
    return { type: "source-document", sourceId, mediaType: part.mime, title: source.name, filename: source.path, providerMetadata };
  }

  return { type: "source-document", sourceId, mediaType: part.mime, title: source.path, filename: source.path, providerMetadata };
}

function mapFileParts(part: FilePart): UIMessage["parts"] {
  const sourcePart = mapFileSourcePart(part);
  if (sourcePart) return [mapFilePart(part), sourcePart];
  return [mapFilePart(part)];
}

function mapSnapshotToolParts(part: ToolPart): UIMessage["parts"] {
  if (part.tool === STRUCTURED_OUTPUT_TOOL) {
    const mapped = parseStructuredOutputUIPart(part);
    return mapped ? [mapped] : [];
  }

  const mapped = parseDynamicToolUIPart(part);
  if (!mapped) return [];

  if (part.state.status === "completed" && part.state.attachments) {
    return [mapped, ...part.state.attachments.flatMap(mapFileParts)];
  }

  return [mapped];
}

export function snapshotToUIMessages(snapshot: OpenworkSessionSnapshot): UIMessage[] {
  return snapshot.messages.flatMap((message) => {
    const created = message.info.time?.created;
    const uiMessage = {
      id: message.info.id,
      role: message.info.role,
      ...(typeof created === "number" ? { metadata: { opencode: { created } } } : {}),
      parts: message.parts.flatMap<UIMessage["parts"][number]>((part) => {
        if (part.type === "text") {
          if (part.synthetic || part.ignored) return [];
          return [{
            type: "text",
            text: getTextPartValue(part),
            state: "done" as const,
            providerMetadata: { opencode: { partId: part.id } },
          }];
        }
        if (part.type === "reasoning") {
          return [{
            type: "reasoning",
            text: getTextPartValue(part),
            state: "done" as const,
            providerMetadata: { opencode: { partId: part.id } },
          }];
        }
        if (part.type === "file") {
          return mapFileParts(part);
        }
        if (part.type === "tool") {
          return mapSnapshotToolParts(part);
        }
        if (part.type === "agent") {
          return [{
            type: "text",
            text: part.name ? `@${part.name}` : "@agent",
            state: "done",
            providerMetadata: { opencode: { partId: part.id } },
          }];
        }
        if (part.type === "step-start") {
          return [{ type: "step-start", providerMetadata: { opencode: { partId: part.id } } }];
        }
        return [];
      }),
    };

    // Surface a failed turn as its own synthetic error message keyed by the
    // errored assistant message id. The live `session.error` event keys its
    // message off the latest assistant turn the same way, so the two
    // reconcile to one message instead of duplicating — while a later turn's
    // error still gets its own message. An empty assistant carcass for the
    // errored turn is dropped so the error reads as that turn's outcome.
    const error = message.info.role === "assistant" && "error" in message.info ? message.info.error : undefined;
    if (!error) return [uiMessage];

    const errorMessage = createSessionErrorUIMessage(message.info.id, describeOpencodeSessionError(error), { created });
    return uiMessage.parts.length > 0 ? [uiMessage, errorMessage] : [errorMessage];
  });
}

function extractLastUserText(messages: UIMessage[]) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return "";
  return lastUser.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      return [];
    })
    .join("")
    .trim();
}

function createPartState(): InternalPartState {
  return {
    textStarted: new Set<string>(),
    reasoningStarted: new Set<string>(),
    textValues: new Map<string, string>(),
    reasoningValues: new Map<string, string>(),
    pendingDeltas: new Map<string, PendingDelta[]>(),
    partKinds: new Map<string, Part["type"]>(),
    partSessions: new Map<string, string>(),
    ignoredParts: new Set<string>(),
    messageRoles: new Map<string, string>(),
    pendingRoleEvents: new Map<string, OpencodeEvent[]>(),
    tools: new Map<string, ToolStreamState>(),
    assistantMessageId: null,
    streamFinished: false,
  };
}

function ensureAssistantStart(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: InternalPartState,
  messageId: string,
) {
  if (state.assistantMessageId) return;
  state.assistantMessageId = messageId;
  controller.enqueue({ type: "start", messageId });
}

function finalizeOpenParts(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: InternalPartState,
) {
  for (const id of state.textStarted) {
    controller.enqueue({ type: "text-end", id });
  }
  for (const id of state.reasoningStarted) {
    controller.enqueue({ type: "reasoning-end", id });
  }
  state.textStarted.clear();
  state.reasoningStarted.clear();
}

function enqueueFilePart(controller: ReadableStreamDefaultController<UIMessageChunk>, part: FilePart) {
  controller.enqueue({
    type: "file",
    url: part.url,
    mediaType: part.mime,
    providerMetadata: fileProviderMetadata(part),
  });
  const sourcePart = mapFileSourcePart(part);
  if (!sourcePart) return;
  if (sourcePart.type === "source-url") controller.enqueue(sourcePart);
  if (sourcePart.type === "source-document") controller.enqueue(sourcePart);
}

function enqueueTextDelta(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: InternalPartState,
  partId: string,
  delta: string,
  reasoning: boolean,
) {
  const values = reasoning ? state.reasoningValues : state.textValues;
  const previous = values.get(partId);
  if (previous) values.set(partId, `${previous}${delta}`);
  else values.set(partId, delta);

  if (reasoning) {
    if (!state.reasoningStarted.has(partId)) {
      state.reasoningStarted.add(partId);
      controller.enqueue({ type: "reasoning-start", id: partId });
    }
    controller.enqueue({ type: "reasoning-delta", id: partId, delta });
    return;
  }

  if (!state.textStarted.has(partId)) {
    state.textStarted.add(partId);
    controller.enqueue({ type: "text-start", id: partId });
  }
  controller.enqueue({ type: "text-delta", id: partId, delta });
}

function flushPendingDeltas(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: InternalPartState,
  part: TextPart | ReasoningPart,
) {
  const pending = state.pendingDeltas.get(part.id);
  if (!pending) return;
  const reasoning = part.type === "reasoning";
  for (const item of pending) {
    enqueueTextDelta(controller, state, part.id, item.delta, reasoning);
  }
  state.pendingDeltas.delete(part.id);
}

function queuePendingRoleEvent(state: InternalPartState, messageId: string, event: OpencodeEvent) {
  const pending = state.pendingRoleEvents.get(messageId);
  if (pending) pending.push(event);
  else state.pendingRoleEvents.set(messageId, [event]);
}

function handleToolPart(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: InternalPartState,
  part: ToolPart,
) {
  if (part.tool === STRUCTURED_OUTPUT_TOOL) {
    handleStructuredOutputPart(controller, state, part);
    return;
  }

  const toolName = part.tool;
  const toolState = state.tools.get(part.callID) ?? {
    inputSent: false,
    inputText: "",
    outputSent: false,
    errorSent: false,
    attachmentIds: new Set<string>(),
  };
  const inputText = safeStringify(part.state.input);

  if (!shouldDeferInProgressTool(part) && (!toolState.inputSent || inputText !== toolState.inputText)) {
    controller.enqueue({
      type: "tool-input-available",
      toolCallId: part.callID,
      toolName,
      input: part.state.input,
    });
    toolState.inputSent = true;
    toolState.inputText = inputText;
  }

  if (!toolState.errorSent && part.state.status === "error") {
    controller.enqueue({
      type: "tool-output-error",
      toolCallId: part.callID,
      errorText: part.state.error,
    });
    toolState.errorSent = true;
  } else if (!toolState.outputSent && part.state.status === "completed") {
    controller.enqueue({
      type: "tool-output-available",
      toolCallId: part.callID,
      output: part.state.output,
    });
    toolState.outputSent = true;
    if (part.state.attachments) {
      for (const attachment of part.state.attachments) {
        const attachmentId = attachment.id;
        if (toolState.attachmentIds.has(attachmentId)) continue;
        enqueueFilePart(controller, attachment);
        toolState.attachmentIds.add(attachmentId);
      }
    }
  }

  state.tools.set(part.callID, toolState);
}

function handleStructuredOutputPart(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: InternalPartState,
  part: ToolPart,
) {
  const partId = `structured-output-${part.callID}`;
  const toolState = state.tools.get(part.callID) ?? {
    inputSent: false,
    inputText: "",
    outputSent: false,
    errorSent: false,
    attachmentIds: new Set<string>(),
  };
  if (part.state.status === "completed" && !toolState.outputSent) {
    enqueueTextDelta(controller, state, partId, safeStringify(part.state.input), false);
    toolState.outputSent = true;
  }

  if ((part.state.status === "completed" || part.state.status === "error") && state.textStarted.has(partId)) {
    controller.enqueue({ type: "text-end", id: partId });
    state.textStarted.delete(partId);
  }

  state.tools.set(part.callID, toolState);
}

function handleEventChunk(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: InternalPartState,
  event: OpencodeEvent,
  sessionId: string,
) {
  if (state.streamFinished) return;

  if (event.type === "session.error") {
    const record = (event.properties ?? {}) as Record<string, unknown>;
    if (record.sessionID !== sessionId) return;
    const errorText = describeOpencodeSessionError(record.error);
    finalizeOpenParts(controller, state);
    controller.enqueue({ type: "error", errorText: errorText || "Session failed" });
    controller.enqueue({ type: "finish", finishReason: "error" });
    state.streamFinished = true;
    controller.close();
    return;
  }

  if (event.type === "session.idle") {
    const record = (event.properties ?? {}) as Record<string, unknown>;
    if (record.sessionID !== sessionId) return;
    finalizeOpenParts(controller, state);
    controller.enqueue({ type: "finish", finishReason: "stop" });
    state.streamFinished = true;
    controller.close();
    return;
  }

  if (event.type === "message.updated") {
    const record = (event.properties ?? {}) as Record<string, unknown>;
    const info = record.info as { id?: string; role?: string; sessionID?: string } | undefined;
    if (!info || info.sessionID !== sessionId || typeof info.id !== "string" || typeof info.role !== "string") {
      return;
    }
    state.messageRoles.set(info.id, info.role);
    const pending = state.pendingRoleEvents.get(info.id);
    if (info.role !== "assistant") {
      if (pending) state.pendingRoleEvents.delete(info.id);
      return;
    }
    ensureAssistantStart(controller, state, info.id);
    if (pending) {
      state.pendingRoleEvents.delete(info.id);
      for (const pendingEvent of pending) handleEventChunk(controller, state, pendingEvent, sessionId);
    }
    return;
  }

  if (event.type === "message.part.updated") {
    const record = (event.properties ?? {}) as Record<string, unknown>;
    const part = record.part as Part | undefined;
    if (!part || part.sessionID !== sessionId) return;
    state.partSessions.set(part.id, part.sessionID);
    if (state.messageRoles.get(part.messageID) === "user") return;
    if (!state.messageRoles.get(part.messageID)) {
      queuePendingRoleEvent(state, part.messageID, event);
      return;
    }

    ensureAssistantStart(controller, state, part.messageID);

    if (part.type === "text") {
      if (part.synthetic || part.ignored) {
        state.ignoredParts.add(part.id);
        state.pendingDeltas.delete(part.id);
        return;
      }
      state.partKinds.set(part.id, part.type);
      if (!state.textStarted.has(part.id)) {
        state.textStarted.add(part.id);
        controller.enqueue({ type: "text-start", id: part.id });
      }
      flushPendingDeltas(controller, state, part);
      const textDelta = getTextPartDelta(part, "", state.textValues);
      if (textDelta) controller.enqueue({ type: "text-delta", id: part.id, delta: textDelta });
      return;
    }

    if (part.type === "reasoning") {
      state.partKinds.set(part.id, part.type);
      if (!state.reasoningStarted.has(part.id)) {
        state.reasoningStarted.add(part.id);
        controller.enqueue({ type: "reasoning-start", id: part.id });
      }
      flushPendingDeltas(controller, state, part);
      const reasoningDelta = getTextPartDelta(part, "", state.reasoningValues);
      if (reasoningDelta) controller.enqueue({ type: "reasoning-delta", id: part.id, delta: reasoningDelta });
      return;
    }

    if (part.type === "tool") {
      state.partKinds.set(part.id, part.type);
      handleToolPart(controller, state, part);
      return;
    }

    if (part.type === "file") {
      state.partKinds.set(part.id, part.type);
      enqueueFilePart(controller, part);
      return;
    }

    if (part.type === "step-start") {
      controller.enqueue({ type: "start-step" });
      return;
    }

    if (part.type === "step-finish") {
      finalizeOpenParts(controller, state);
      controller.enqueue({ type: "finish-step" });
    }
    return;
  }

  if (event.type === "message.part.delta") {
    const record = (event.properties ?? {}) as Record<string, unknown>;
    const messageID = typeof record.messageID === "string" ? record.messageID : null;
    const partID = typeof record.partID === "string" ? record.partID : null;
    const recordSessionID = typeof record.sessionID === "string" ? record.sessionID : null;
    const field = typeof record.field === "string" ? record.field : null;
    const delta = typeof record.delta === "string" ? record.delta : "";
    if (!messageID || !partID || !field || !delta) return;
    const ownerSessionID = recordSessionID ?? state.partSessions.get(partID) ?? null;
    if (ownerSessionID !== sessionId) return;
    if (state.messageRoles.get(messageID) === "user" || state.ignoredParts.has(partID)) return;
    if (!state.messageRoles.get(messageID)) {
      queuePendingRoleEvent(state, messageID, event);
      return;
    }

    ensureAssistantStart(controller, state, messageID);

    const kind = state.partKinds.get(partID);
    if (!kind) {
      const pending = state.pendingDeltas.get(partID);
      if (pending) pending.push({ delta });
      else state.pendingDeltas.set(partID, [{ delta }]);
      return;
    }

    if (kind === "reasoning") {
      enqueueTextDelta(controller, state, partID, delta, true);
      return;
    }

    if (kind === "text" && field === "text") {
      enqueueTextDelta(controller, state, partID, delta, false);
      return;
    }

  }
}

export function createOpenworkChatTransport(options: TransportOptions): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      const client = createClient(options.baseUrl, undefined, {
        token: options.openworkToken,
        mode: "openwork",
      });

      return new ReadableStream<UIMessageChunk>({
        async start(controller) {
          const state = createPartState();
          const lastUserText = extractLastUserText(messages);

          if (!lastUserText) {
            controller.enqueue({ type: "error", errorText: "No user message to send." });
            controller.close();
            return;
          }

          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            controller.close();
          };

          abortSignal?.addEventListener("abort", () => {
            void abortSessionSafe(client, options.sessionId).finally(() => {
              if (!state.streamFinished) {
                controller.enqueue({ type: "abort", reason: "user cancelled" });
              }
              close();
            });
          });

          try {
            const sub = await client.event.subscribe(undefined, { signal: abortSignal });

            const consume = (async () => {
              for await (const raw of sub.stream) {
                if (closed) return;
                const event = normalizeEvent(raw);
                if (!event) continue;
                handleEventChunk(controller, state, event, options.sessionId);
                if (state.streamFinished) return;
              }
            })();

            const result = await client.session.promptAsync({
              sessionID: options.sessionId,
              parts: [{ type: "text", text: lastUserText }],
            });
            if (result.error) {
              throw new Error(
                result.error instanceof Error ? result.error.message : safeStringify(result.error),
              );
            }

            await consume;
            if (!state.streamFinished && !closed) {
              finalizeOpenParts(controller, state);
              controller.enqueue({ type: "finish", finishReason: "stop" });
              close();
            }
          } catch (error) {
            if (closed) return;
            finalizeOpenParts(controller, state);
            controller.enqueue({
              type: "error",
              errorText: error instanceof Error ? error.message : "Failed to stream response.",
            });
            close();
          }
        },
        async cancel() {
          await abortSessionSafe(client, options.sessionId);
        },
      });
    },

    async reconnectToStream() {
      return null;
    },
  };
}
