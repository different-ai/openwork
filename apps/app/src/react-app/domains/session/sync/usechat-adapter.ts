/** @jsxImportSource react */
import type { UIMessage } from "ai";
import type { FilePart, Part, ToolPart } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionSnapshot } from "../../../../app/lib/openwork-server";
import { safeStringify } from "../../../../app/utils";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../../../app/types";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
  STRUCTURED_OUTPUT_TOOL,
} from "./parse-tool-parts";

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

function defaultErrorMessage(name: string | null, fallback: string) {
  if (name === "ProviderAuthError") return "Provider authentication failed";
  if (name === "MessageOutputLengthError") return "The model reached its output limit before finishing";
  if (name === "StructuredOutputError") return "The model could not produce valid structured output";
  if (name === "ContextOverflowError") return "The conversation is too large for the model context window";
  if (name === "MessageAbortedError") return "The message was interrupted";
  return fallback;
}

/**
 * Unsupported file parts live in server-side session history, so the same
 * provider error replays on every later prompt. Tell the user how to escape.
 */
function withAttachmentRecoveryHint(text: string) {
  if (!text.includes("file part media type") || !text.includes("not supported")) return text;
  return `${text}\nAn attached file in this conversation uses a format the model can't read. Revert the conversation to before the attachment was sent, or start a new session.`;
}

export function describeOpencodeSessionError(error: unknown, fallback = "Session failed") {
  if (error instanceof Error) return withAttachmentRecoveryHint(error.message || fallback);
  if (typeof error === "string") return withAttachmentRecoveryHint(error.trim() || fallback);
  if (!error || typeof error !== "object") return fallback;

  const data = recordValue(error, "data");
  const cause = recordValue(error, "cause");
  const causeData = recordValue(cause, "data");
  const records = [error, data, cause, causeData].filter(Boolean);
  const name = firstStringValue(records, ["name", "type"]);
  const message = firstStringValue(records, ["message", "detail", "reason", "error"]);
  const status = firstNumberValue(records, ["statusCode", "status"]);
  const provider = firstStringValue(records, ["providerID", "providerId", "provider"]);
  const code = firstStringValue(records, ["code", "errorCode"]);
  const retries = firstNumberValue(records, ["retries", "retryCount"]);
  const responseBody = firstStringValue(records, ["responseBody", "body", "response"]);

  const lines = [message ?? defaultErrorMessage(name, fallback)];
  if (status && !lines[0]?.includes(String(status))) lines.push(`Status: ${status}`);
  if (provider && !lines[0]?.includes(provider)) lines.push(`Provider: ${provider}`);
  if (code) lines.push(`Code: ${code}`);
  if (retries !== null) lines.push(`Retries: ${retries}`);
  if (responseBody && responseBody !== message) lines.push(`Response: ${responseBody}`);
  if (lines.some((line) => line !== fallback)) return withAttachmentRecoveryHint(lines.join("\n"));

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
