import type {
  AgentPartInput,
  FilePartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import type { Client, ComposerDraft, ComposerPart, ModelRef } from "@/app/types";
import { unwrap } from "@/app/lib/opencode";
import { isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import {
  composerAttachmentsToWorkspaceFileParts,
  resolveAttachmentMime,
  type ChatAttachmentWorkspaceEndpoint,
} from "./attachment-file-part";
import {
  firstLineLocalFileParts,
  isReadInlineablePath,
  joinWorkspaceRelativePath,
  toFileUrl,
} from "./prompt-file-parts";
import { mentionPromptParts } from "./mention-parts";
import { parseConnectSkillToken } from "../surface/composer/connect-skill-token";
import { decodeComposerMentionValue } from "../surface/composer/mention-encoding";

const VIDEO_INPUT_MIMES = new Set([
  "video/mp4", "video/x-m4v", "video/mpeg", "video/quicktime", "video/webm",
  "video/x-msvideo", "video/x-flv", "video/mpg", "video/wmv", "video/3gpp",
]);

/** Run before uploads, edits, or command dispatch; use the same captured model when sending. */
export async function validateVideoDraft(
  draft: ComposerDraft,
  context: { client: Pick<Client, "provider">; model: ModelRef | null | undefined; baseUrl: string },
): Promise<boolean> {
  const videos = draft.attachments.filter((attachment) => resolveAttachmentMime(attachment.file).startsWith("video/"));
  if (!videos.length) return false;
  if (draft.mode === "shell" || draft.command) {
    throw new Error("Send videos as a chat message, not a shell or slash command. Your draft has been kept.");
  }
  if (isOpencodeV2BaseUrl(context.baseUrl)) {
    throw new Error("Video input is not available in the experimental engine. Switch to the standard engine before sending.");
  }
  const selection = context.model;
  if (!selection) throw new Error("Choose a video-capable model before sending this attachment.");
  // Query this workspace's runtime rather than trusting names, image support,
  // a different pane's catalog, or the model that was selected at attach time.
  const catalog = unwrap(await context.client.provider.list());
  const provider = catalog.all.find((item) => item.id === selection.providerID && catalog.connected.includes(item.id));
  const model = provider?.models[selection.modelID];
  if (model?.capabilities.input.video !== true
    || !["@ai-sdk/google", "@ai-sdk/google-vertex"].includes(model.api.npm)) {
    throw new Error("This model connection does not support video input. Choose a video-capable Google or Vertex model, or remove the video. Your draft has been kept.");
  }
  for (const attachment of videos) {
    if (!VIDEO_INPUT_MIMES.has(resolveAttachmentMime(attachment.file))) {
      throw new Error(`Video format for "${attachment.file.name}" is not supported by this connection. Convert it to MP4 or WebM before sending.`);
    }
    if (attachment.file.size === 0) throw new Error(`Video "${attachment.file.name}" is empty. Choose a playable file before sending.`);
  }
  return true;
}

// All workspace-scoped server URLs/clients/tokens come from
// `resolveWorkspaceEndpoint` in apps/app/src/app/lib/workspace-endpoint.ts.
// Don't compose `<baseUrl>/workspace/<id>` here.
export async function draftToParts(
  draft: ComposerDraft,
  workspaceRoot: string,
  sessionId: string,
  endpoint: ChatAttachmentWorkspaceEndpoint | null,
  video = false,
) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();

  const toAbsolutePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) return trimmed;
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
    if (!root) return "";
    return joinWorkspaceRelativePath(root, trimmed);
  };

  const filenameFromPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "file";
  };

  const attachmentFileById = new Map<string, FilePartInput>();
  if (draft.attachments.length > 0) {
    if (!endpoint) {
      throw new Error("Workspace endpoint is unavailable; attachments could not be copied for tool access.");
    }
    const uploaded = await composerAttachmentsToWorkspaceFileParts({
      attachments: draft.attachments,
      endpoint,
      sessionId,
      workspaceRoot: root,
      video,
    });
    if (uploaded) {
      parts.push(uploaded.note);
      for (const [index, attachment] of draft.attachments.entries()) {
        const filePart = uploaded.files[index];
        if (filePart) attachmentFileById.set(attachment.id, filePart);
      }
    }
  }

  // Prefer draft.text token order so attachment chips stay inline with surrounding text
  // (same positions as the composer), instead of dumping every file part at the end.
  const hasAttachmentTokens = /\[attachment [^\]]+\]/.test(draft.text);
  if (hasAttachmentTokens || attachmentFileById.size > 0) {
    const pasteByLabel = new Map(
      draft.parts
        .filter((part): part is Extract<ComposerPart, { type: "paste" }> => part.type === "paste")
        .map((part) => [part.label, part.text] as const),
    );
    const segments = draft.text.split(/(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/);
    for (const [index, segment] of segments.entries()) {
      if (!segment) continue;
      const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
      if (attachmentMatch?.[1]) {
        const filePart = attachmentFileById.get(attachmentMatch[1]);
        if (filePart) {
          parts.push(filePart);
          attachmentFileById.delete(attachmentMatch[1]);
        }
        continue;
      }
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch?.[1]) {
        const pasted = pasteByLabel.get(pasteMatch[1]);
        if (pasted) parts.push({ type: "text", text: pasted });
        continue;
      }
      const connectSkill = parseConnectSkillToken(segment);
      if (connectSkill) {
        parts.push(...mentionPromptParts({ type: "connect-skill", ...connectSkill }));
        continue;
      }
      const skillMatch = segment.match(/^\[skill (.+)\]$/);
      if (skillMatch?.[1]) {
        parts.push(...mentionPromptParts({ type: "skill", name: skillMatch[1] }));
        continue;
      }
      if (segment.startsWith("@")) {
        const value = decodeComposerMentionValue(segment.slice(1));
        const mentionPart = draft.parts.find((part) =>
          (part.type === "agent" && part.name === value)
          || (part.type === "app" && part.name === value)
          || (part.type === "computer" && part.target === value
            && (index <= 1 && !segments[0] || /\s$/.test(segments[index - 1] ?? "")))
          || (part.type === "file" && part.path === value),
        );
        if (mentionPart?.type === "agent") {
          parts.push({ type: "agent", name: mentionPart.name });
          continue;
        }
        if (mentionPart?.type === "computer" || mentionPart?.type === "app") {
          parts.push(...mentionPromptParts(mentionPart));
          continue;
        }
        if (mentionPart?.type === "file") {
          const absolute = toAbsolutePath(mentionPart.path);
          if (!absolute) continue;
          if (!isReadInlineablePath(absolute)) {
            parts.push({ type: "text", text: absolute });
            continue;
          }
          parts.push({
            type: "file",
            mime: "text/plain",
            url: toFileUrl(absolute),
            filename: filenameFromPath(mentionPart.path),
          });
          continue;
        }
      }
      parts.push({ type: "text", text: segment });
    }
    for (const filePart of attachmentFileById.values()) {
      parts.push(filePart);
    }
  } else {
    for (const part of draft.parts) {
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "paste") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name });
        continue;
      }
      if (part.type === "skill" || part.type === "connect-skill" || part.type === "computer" || part.type === "app") {
        parts.push(...mentionPromptParts(part));
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        if (!isReadInlineablePath(absolute)) {
          parts.push({ type: "text", text: absolute });
          continue;
        }
        parts.push({
          type: "file",
          mime: "text/plain",
          url: toFileUrl(absolute),
          filename: filenameFromPath(part.path),
        });
      }
    }
  }

  parts.push(...firstLineLocalFileParts(draft.resolvedText ?? draft.text, root));

  return parts;
}
