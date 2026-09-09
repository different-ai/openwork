/** @jsxImportSource react */
import type { UIMessage } from "ai";
import type { FilePart, Part, TextPart, ToolPart } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionSnapshot } from "../../../../app/lib/openwork-server";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../../../app/types";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
  STRUCTURED_OUTPUT_TOOL,
} from "./parse-tool-parts";
import {
  presentOpencodeSessionError,
  type OpencodeSessionErrorPresentation,
} from "./session-error";

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
export function createSessionErrorUIMessage(
  turnKey: string,
  presentation: OpencodeSessionErrorPresentation,
  options?: { created?: number },
): UIMessage {
  const id = sessionErrorMessageId(turnKey);
  const created = options?.created;
  return {
    id,
    role: "assistant",
    ...(typeof created === "number" ? { metadata: { opencode: { created } } } : {}),
    parts: [{
      type: "text",
      text: presentation.title,
      state: "done",
      providerMetadata: { opencode: { partId: `${id}:text`, sessionError: presentation } },
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

/** Recover display-only attachments without sending unsupported binary parts to the model. */
export function attachmentNoteToUIParts(part: TextPart): UIMessage["parts"] {
  if (!part.synthetic || part.ignored) return [];
  const attachments = part.metadata?.openworkAttachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap<UIMessage["parts"][number]>((attachment: unknown, index) => {
    if (!attachment || typeof attachment !== "object"
      || !("filename" in attachment) || typeof attachment.filename !== "string"
      || !("mime" in attachment) || typeof attachment.mime !== "string"
      || !("url" in attachment) || typeof attachment.url !== "string"
      || !attachment.url.startsWith("file://")) return [];
    return [{
      type: "file",
      filename: attachment.filename,
      mediaType: attachment.mime,
      url: attachment.url,
      providerMetadata: { opencode: { partId: `${part.id}:attachment:${index}` } },
    }];
  });
}

export function snapshotToUIMessages(snapshot: OpenworkSessionSnapshot): UIMessage[] {
  return snapshot.messages.flatMap((message) => {
    const created = message.info.time?.created;
    const time = message.info.time;
    const completed = time && "completed" in time ? time.completed : undefined;
    const uiMessage = {
      id: message.info.id,
      role: message.info.role,
      ...(typeof created === "number"
        ? { metadata: { opencode: { created, ...(typeof completed === "number" ? { completed } : {}) } } }
        : {}),
      parts: message.parts.flatMap<UIMessage["parts"][number]>((part) => {
        if (part.type === "text") {
          if (part.synthetic || part.ignored) return attachmentNoteToUIParts(part);
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

    const errorMessage = createSessionErrorUIMessage(message.info.id, presentOpencodeSessionError(error), { created });
    return uiMessage.parts.length > 0 ? [uiMessage, errorMessage] : [errorMessage];
  });
}
