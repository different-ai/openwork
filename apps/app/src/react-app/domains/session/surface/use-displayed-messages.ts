import { useMemo } from "react";
import type { UIMessage } from "ai";
import type { ComposerAttachment } from "../../../../app/types";
import { resolveAttachmentFileMetadata } from "../sync/attachment-file-part";
import type { ComposerSessionState } from "./composer-state-store";
import { resolvePastedTextPlaceholders } from "./composer/pasted-text";

export function pendingMessageParts(text: string, attachments: ComposerAttachment[], serverParts: UIMessage["parts"] = []) {
  const parts = [...serverParts];
  if (text && !parts.some((part) => part.type === "text" && part.text)) parts.unshift({ type: "text", text });
  const matched = new Set<number>();
  let attachmentsReady = true;
  for (const attachment of attachments) {
    const filename = resolveAttachmentFileMetadata(attachment.file).filename;
    // Compression can change an image's extension, but never its submitted bytes here.
    const compressedFilename = attachment.kind === "image"
      ? resolveAttachmentFileMetadata({ name: `${attachment.file.name.replace(/\.[^.]+$/, "") || "image"}.jpg`, type: "image/jpeg" }).filename
      : filename;
    const index = serverParts.findIndex((part, index) => !matched.has(index) && part.type === "file"
      && (part.filename === filename || part.filename === compressedFilename));
    if (index >= 0) matched.add(index);
    const part = serverParts[index];
    const usable = part?.type === "file" && (attachment.kind === "image"
      ? part.mediaType.startsWith("image/") && /^(data:image\/|https?:\/\/)/.test(part.url)
      : /^(data:|file:\/\/|https?:\/\/)/.test(part.url));
    if (usable) continue;
    attachmentsReady = false;
    const preview = { type: "file", filename: attachment.name, mediaType: attachment.mimeType, url: attachment.previewUrl ?? "" } satisfies UIMessage["parts"][number];
    if (part) parts[parts.indexOf(part)] = preview;
    else parts.push(preview);
  }
  return { parts, attachmentsReady };
}

type DisplayComposer = Pick<ComposerSessionState, "draft" | "attachments" | "pasteParts">;

export function useDisplayedMessages(input: {
  messages: UIMessage[];
  extraMessages: UIMessage[];
  sessionId: string;
  autoSending: boolean;
  composer: DisplayComposer;
  autoSendComposer?: DisplayComposer;
}) {
  const { messages, extraMessages, sessionId } = input;
  // Ordinary composer edits are not transcript inputs. A captured autosend
  // likewise stays independent of the next draft being typed.
  const composer = input.autoSending ? input.autoSendComposer ?? input.composer : undefined;
  const draft = composer?.draft;
  const attachments = composer?.attachments;
  const pasteParts = composer?.pasteParts;
  return useMemo(() => {
    const pending: UIMessage[] = [];
    if (draft !== undefined && attachments && pasteParts && (draft.trim() || attachments.length)) {
      pending.push({
        id: `${sessionId}:first-send`,
        role: "user",
        parts: pendingMessageParts(resolvePastedTextPlaceholders(draft, pasteParts).replace(/\[attachment [^\]]+\]/g, ""), attachments).parts,
      });
    }
    if (!pending.length && !extraMessages.length) return messages;
    return [...messages, ...pending, ...extraMessages];
  }, [messages, extraMessages, sessionId, draft, attachments, pasteParts]);
}
