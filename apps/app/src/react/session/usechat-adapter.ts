/** @jsxImportSource react */
import type { UIMessage, UIMessageChunk, ChatTransport, DynamicToolUIPart } from "ai";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { abortSessionSafe } from "../../app/lib/opencode-session";
import type { OpenworkSessionMessage, OpenworkSessionSnapshot } from "../../app/lib/openwork-server";
import { normalizeEvent, safeStringify } from "../../app/utils";
import type { OpencodeEvent } from "../../app/types";
import { createClient } from "../../app/lib/opencode";

type TransportOptions = {
  baseUrl: string;
  openworkToken: string;
  sessionId: string;
};

type ToolStreamState = {
  inputSent: boolean;
  outputSent: boolean;
  errorSent: boolean;
  stepStarted: boolean;
  stepFinished: boolean;
};

type InternalPartState = {
  textStarted: Set<string>;
  reasoningStarted: Set<string>;
  partKinds: Map<string, Part["type"]>;
  partSessions: Map<string, string>;
  tools: Map<string, ToolStreamState>;
  assistantMessageId: string | null;
  streamFinished: boolean;
};

function getTextPartValue(part: Part) {
  if (part.type === "text") {
    return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
  }
  if (part.type === "reasoning") {
    return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
  }
  return "";
}

function mapToolPart(part: Part): DynamicToolUIPart {
  const record = part as Part & { tool?: string; state?: Record<string, unknown> };
  const state = (record.state ?? {}) as Record<string, unknown>;
  const toolName = typeof record.tool === "string" ? record.tool : "tool";
  const input = state.input;
  const output = state.output;
  const errorText = typeof state.error === "string" ? state.error : undefined;

  if (errorText) {
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId: part.id,
      state: "output-error",
      input,
      errorText,
    };
  }

  if (output !== undefined) {
    return {
      type: "dynamic-tool",
      toolName,
      toolCallId: part.id,
      state: "output-available",
      input,
      output,
    };
  }

  return {
    type: "dynamic-tool",
    toolName,
    toolCallId: part.id,
    state: "input-available",
    input,
  };
}

export function snapshotToUIMessages(snapshot: OpenworkSessionSnapshot): UIMessage[] {
  return snapshot.messages.map((message) => ({
    id: message.info.id,
    role: message.info.role,
    parts: message.parts.flatMap<UIMessage["parts"][number]>((part) => {
      if (part.type === "text") {
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
        const record = part as Part & { url?: string; filename?: string; mime?: string };
        return record.url
          ? [{
              type: "file",
              url: record.url,
              filename: record.filename,
              mediaType: record.mime ?? "application/octet-stream",
              providerMetadata: { opencode: { partId: part.id } },
            }]
          : [];
      }
      if (part.type === "tool") {
        return [{ ...mapToolPart(part), providerMetadata: { opencode: { partId: part.id } } }];
      }
      if (part.type === "step-start") {
        return [{ type: "step-start", providerMetadata: { opencode: { partId: part.id } } }];
      }
      return [];
    }),
  }));
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
    partKinds: new Map<string, Part["type"]>(),
    partSessions: new Map<string, string>(),
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

function handleToolPart(
  controller: ReadableStreamDefaultController<UIMessageChunk>,
  state: InternalPartState,
  part: Part,
) {
  const record = part as Part & { tool?: string; state?: Record<string, unknown> };
  const toolName = typeof record.tool === "string" ? record.tool : "tool";
  const toolState = state.tools.get(part.id) ?? {
    inputSent: false,
    outputSent: false,
    errorSent: false,
    stepStarted: false,
    stepFinished: false,
  };
  const current = (record.state ?? {}) as Record<string, unknown>;

  if (!toolState.stepStarted) {
    controller.enqueue({ type: "start-step" });
    toolState.stepStarted = true;
  }

  if (!toolState.inputSent) {
    controller.enqueue({
      type: "tool-input-available",
      toolCallId: part.id,
      toolName,
      input: current.input,
    });
    toolState.inputSent = true;
  }

  if (!toolState.errorSent && typeof current.error === "string" && current.error.trim()) {
    controller.enqueue({
      type: "tool-output-error",
      toolCallId: part.id,
      errorText: current.error,
    });
    toolState.errorSent = true;
    if (!toolState.stepFinished) {
      controller.enqueue({ type: "finish-step" });
      toolState.stepFinished = true;
    }
  } else if (!toolState.outputSent && current.output !== undefined) {
    controller.enqueue({
      type: "tool-output-available",
      toolCallId: part.id,
      output: current.output,
    });
    toolState.outputSent = true;
    if (!toolState.stepFinished) {
      controller.enqueue({ type: "finish-step" });
      toolState.stepFinished = true;
    }
  }

  state.tools.set(part.id, toolState);
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
    const errorObj = record.error;
    const errorText =
      typeof errorObj === "object" && errorObj && "message" in (errorObj as Record<string, unknown>)
        ? String((errorObj as Record<string, unknown>).message ?? "")
        : typeof record.error === "string"
          ? record.error
          : "Session failed";
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
    if (!info || info.sessionID !== sessionId || info.role !== "assistant" || typeof info.id !== "string") {
      return;
    }
    ensureAssistantStart(controller, state, info.id);
    return;
  }

  if (event.type === "message.part.updated") {
    const record = (event.properties ?? {}) as Record<string, unknown>;
    const part = record.part as Part | undefined;
    const delta = typeof record.delta === "string" ? record.delta : "";
    if (!part || part.sessionID !== sessionId) return;

    ensureAssistantStart(controller, state, part.messageID);
    state.partKinds.set(part.id, part.type);
    state.partSessions.set(part.id, part.sessionID);

    if (part.type === "text") {
      if (!state.textStarted.has(part.id)) {
        state.textStarted.add(part.id);
        controller.enqueue({ type: "text-start", id: part.id });
        const initial = delta || getTextPartValue(part);
        if (initial) controller.enqueue({ type: "text-delta", id: part.id, delta: initial });
      }
      return;
    }

    if (part.type === "reasoning") {
      if (!state.reasoningStarted.has(part.id)) {
        state.reasoningStarted.add(part.id);
        controller.enqueue({ type: "reasoning-start", id: part.id });
        const initial = delta || getTextPartValue(part);
        if (initial) controller.enqueue({ type: "reasoning-delta", id: part.id, delta: initial });
      }
      return;
    }

    if (part.type === "tool") {
      handleToolPart(controller, state, part);
      return;
    }

    if (part.type === "file") {
      const file = part as Part & { url?: string; mime?: string };
      if (file.url && file.mime) {
        controller.enqueue({ type: "file", url: file.url, mediaType: file.mime });
      }
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

    ensureAssistantStart(controller, state, messageID);

    const kind = state.partKinds.get(partID);
    if (field === "text" && kind === "reasoning") {
      if (!state.reasoningStarted.has(partID)) {
        state.reasoningStarted.add(partID);
        controller.enqueue({ type: "reasoning-start", id: partID });
      }
      controller.enqueue({ type: "reasoning-delta", id: partID, delta });
      return;
    }

    if (field === "text") {
      if (!state.textStarted.has(partID)) {
        state.textStarted.add(partID);
        controller.enqueue({ type: "text-start", id: partID });
      }
      controller.enqueue({ type: "text-delta", id: partID, delta });
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
