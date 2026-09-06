import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2/client";

import type { ComposerAttachment } from "../../../../app/types";
import { compressImageFile } from "./image-compression";
import { joinWorkspaceRelativePath, toFileUrl } from "./prompt-file-parts";

type AttachmentKind = "image" | "file";

type AttachmentFile = Pick<File, "arrayBuffer" | "name" | "type">;

type AttachmentFileMetadata = {
  filename: string;
  mime: string;
  kind: AttachmentKind;
};

const GENERIC_BINARY_MIME = "application/octet-stream";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type InboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

type ChatAttachmentUploadClient = {
  uploadInbox: (workspaceId: string, file: File, options?: { path?: string }) => Promise<InboxUploadResult>;
  /**
   * True when the upload transport streams the original file from disk (for
   * example the Electron main-process transfer used for remote workspaces).
   * Re-encoding such a file would strip its local path and corrupt the upload
   * route, so callers must send it unmodified.
   */
  uploadInboxPrefersOriginalFile?: (file: File) => boolean;
};

export type ChatAttachmentWorkspaceEndpoint = {
  client: ChatAttachmentUploadClient;
  workspaceId: string;
};

type UploadedChatAttachment = {
  filename: string;
  mime: string;
  bytes: number;
  workspacePath: string;
  url: string;
  file: AttachmentFile;
};

const WORKSPACE_INBOX_ROOT = ".opencode/openwork/inbox";
const MAX_PATH_COMPONENT_BYTES = 255;
const UTF8_ENCODER = new TextEncoder();

const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  pdf: "application/pdf",
  docx: DOCX_MIME,
  pptx: PPTX_MIME,
  xlsx: XLSX_MIME,
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/json",
  js: "application/javascript",
  jsx: "application/javascript",
  mjs: "application/javascript",
  cjs: "application/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  css: "text/css",
  html: "text/html",
  htm: "text/html",
  xml: "application/xml",
  svg: "image/svg+xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  log: "text/plain",
  py: "text/plain",
  rb: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  java: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  cs: "text/plain",
  php: "text/plain",
  sh: "text/plain",
  sql: "text/plain",
  ini: "text/plain",
  conf: "text/plain",
};

const MIME_FILENAME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  [DOCX_MIME]: "docx",
  [PPTX_MIME]: "pptx",
  [XLSX_MIME]: "xlsx",
  "application/json": "json",
  "application/javascript": "js",
  "application/xml": "xml",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/css": "css",
  "text/html": "html",
  "text/yaml": "yaml",
  "text/plain": "txt",
};

function normalizedMime(mimeType: string) {
  return mimeType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
}

function isGenericMime(mime: string) {
  return mime === "" || mime === GENERIC_BINARY_MIME;
}

function isOfficeMime(mime: string) {
  return mime === DOCX_MIME || mime === PPTX_MIME || mime === XLSX_MIME;
}

function extensionFromFilename(filename: string) {
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const basename = filename.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return "";
  return basename.slice(dot + 1).toLowerCase();
}

function mimeFromFilename(filename: string) {
  const extension = extensionFromFilename(filename);
  return extension ? EXTENSION_MIME_TYPES[extension] : undefined;
}

export function resolveAttachmentMime(file: Pick<File, "name" | "type">) {
  const mime = normalizedMime(file.type);
  if (!isGenericMime(mime)) return mime;
  return mimeFromFilename(file.name) ?? GENERIC_BINARY_MIME;
}

function isTextLikeAttachmentMime(mime: string) {
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime === "application/xml" || mime === "application/javascript") return true;
  return mime.endsWith("+json") || mime.endsWith("+xml");
}

/**
 * AI SDK provider adapters only accept `image/*`, `application/pdf`, and
 * `text/plain` file parts; anything else throws UnsupportedFunctionalityError
 * server-side and poisons the session history. So model-facing file parts are
 * routed by one rule:
 * - text-like mimes are re-mimed to `text/plain` so opencode inlines their
 *   content via the Read tool (the proven `@file` mention mechanism);
 * - images, PDFs, and Office mimes pass through (Office parts are rewritten
 *   to text by the OpenWorkOfficeAttachments plugin before the provider);
 * - everything else returns `null`: workspace (`file://`) attachments fall
 *   back to a `text/plain` part that opencode mediates through the Read tool,
 *   while data-URL attachments are dropped (inlining binary bytes as text is
 *   garbage); the synthetic workspace-path note gives tools the bytes.
 */
export function modelFacingAttachmentMime(mimeType: string): string | null {
  const mime = normalizedMime(mimeType);
  if (isTextLikeAttachmentMime(mime)) return "text/plain";
  if (mime.startsWith("image/") || mime === "application/pdf" || isOfficeMime(mime)) return mime;
  return null;
}

function normalizeFilenameExtension(filename: string, mime: string) {
  const original = filename.trim() || "attachment";
  const preferredExtension = MIME_FILENAME_EXTENSIONS[mime];
  if (!preferredExtension) return original;

  const extension = extensionFromFilename(original);
  const extensionMime = extension ? EXTENSION_MIME_TYPES[extension] : undefined;
  if (extensionMime === mime) return original;

  const strictMime = mime.startsWith("image/") || mime === "application/pdf" || mime === "application/json" || isOfficeMime(mime);
  if (!strictMime && extensionMime === undefined) return original;

  const stem = extension ? original.slice(0, -(extension.length + 1)) : original;
  return `${stem.trim() || "attachment"}.${preferredExtension}`;
}

function utf8ByteLength(value: string) {
  return UTF8_ENCODER.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number) {
  let result = "";
  let resultBytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (resultBytes + characterBytes > maxBytes) break;
    result += character;
    resultBytes += characterBytes;
  }
  return result;
}

function byteBoundedFilename(filename: string, maxBytes: number) {
  if (utf8ByteLength(filename) <= maxBytes) return filename;

  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 && dot < filename.length - 1 ? filename.slice(dot) : "";
  const extensionBytes = utf8ByteLength(extension);
  if (!extension || extensionBytes >= maxBytes) return truncateUtf8(filename, maxBytes);

  const stem = filename.slice(0, -extension.length);
  return `${truncateUtf8(stem, maxBytes - extensionBytes)}${extension}`;
}

export function safeAttachmentFilename(filename: string, maxBytes = MAX_PATH_COMPONENT_BYTES) {
  const normalized = filename.replace(/\\/g, "/");
  const basename = normalized.split("/").filter(Boolean).pop()?.trim() ?? "";
  const safe = basename.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim();
  const resolved = safe && safe !== "." && safe !== ".." ? safe : "attachment";
  return byteBoundedFilename(resolved, maxBytes);
}

function safePathSegment(value: string, fallback: string) {
  const safe = safeAttachmentFilename(value).replace(/\.+/g, ".");
  return safe && safe !== "." ? safe : fallback;
}

export function resolveAttachmentFileMetadata(file: Pick<File, "name" | "type">): AttachmentFileMetadata {
  const mime = resolveAttachmentMime(file);
  return {
    filename: safeAttachmentFilename(normalizeFilenameExtension(file.name, mime)),
    mime,
    kind: mime.startsWith("image/") ? "image" : "file",
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fileToDataUrl(file: AttachmentFile, mime: string) {
  return `data:${mime};base64,${arrayBufferToBase64(await file.arrayBuffer())}`;
}

function randomAttachmentId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  cryptoApi?.getRandomValues(bytes);
  if (bytes.some((byte) => byte !== 0)) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function buildChatAttachmentInboxPath(input: { sessionId: string; filename: string; id: string }) {
  const session = safePathSegment(input.sessionId, "session");
  const id = safePathSegment(input.id, "attachment");
  const prefix = `${id}-`;
  const filename = safeAttachmentFilename(input.filename, MAX_PATH_COMPONENT_BYTES - utf8ByteLength(prefix));
  return `chat-attachments/${session}/${prefix}${filename}`;
}

export function workspaceInboxPath(inboxRelativePath: string) {
  return joinWorkspaceRelativePath(WORKSPACE_INBOX_ROOT, inboxRelativePath);
}

function uploadErrorMessage(filename: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error || "Unknown upload error");
  return `Failed to copy attachment "${filename}" into this worker workspace: ${detail}`;
}

function attachmentPathNotePart(uploaded: UploadedChatAttachment[]): TextPartInput {
  // Synthetic: model/tools still see workspace paths, but the chat UI renders
  // file parts as compact badges instead of this wall of path text.
  return {
    type: "text",
    synthetic: true,
    metadata: {
      openworkAttachments: uploaded
        .filter((item) => modelFacingAttachmentMime(item.mime) === null)
        .map((item) => ({ filename: item.filename, mime: item.mime, url: item.url })),
    },
    text: [
      "Attached files were copied into this worker workspace for tool access:",
      ...uploaded.map((item) => `- ${item.filename}: ${item.workspacePath} (${item.url})`),
      "Use these paths with Read/Bash/MCP/Docling when a tool needs the file bytes.",
    ].join("\n"),
  };
}

async function uploadedAttachmentFilePart(item: UploadedChatAttachment): Promise<FilePartInput | null> {
  // Binary/unknown mimes get no model-facing file part. A `text/plain`
  // `file://` part would make opencode run the Read tool on the bytes, which
  // refuses with "Cannot read binary file" as a session error and drops the
  // part anyway; the synthetic workspace-path note already gives tools the file.
  const modelMime = modelFacingAttachmentMime(item.mime);
  if (!modelMime) return null;

  // Images need a browser-displayable URL so the transcript can show the same
  // expandable miniature preview as paste/composer attachments. Workspace
  // `file://` paths stay in the synthetic note for tool access.
  if (modelMime.startsWith("image/")) {
    return {
      type: "file",
      url: await fileToDataUrl(item.file, modelMime),
      filename: item.filename,
      mime: modelMime,
    };
  }

  return {
    type: "file",
    url: item.url,
    filename: item.filename,
    mime: modelMime,
  };
}

export type WorkspaceAttachmentParts = {
  /** Synthetic note listing every uploaded workspace path for tools. */
  note: TextPartInput;
  /** One entry per attachment, in order; `null` when the model gets no file part. */
  files: Array<FilePartInput | null>;
};

export async function composerAttachmentsToWorkspaceFileParts(input: {
  attachments: ComposerAttachment[];
  endpoint: ChatAttachmentWorkspaceEndpoint;
  sessionId: string;
  workspaceRoot: string;
  createId?: () => string;
}): Promise<WorkspaceAttachmentParts | null> {
  if (input.attachments.length === 0) return null;

  const workspaceRoot = input.workspaceRoot.trim();
  if (!workspaceRoot) {
    throw new Error("Workspace path is unavailable; attachments could not be copied for tool access.");
  }

  const workspaceId = input.endpoint.workspaceId.trim();
  if (!workspaceId) {
    throw new Error("Workspace endpoint is unavailable; attachments could not be copied for tool access.");
  }

  const uploaded: UploadedChatAttachment[] = [];
  for (const attachment of input.attachments) {
    // Oversized images are re-encoded here, at send time, so the composer chip
    // appears instantly at attach time and the canvas work happens while the
    // chip already shows its uploading state. When the transport uploads the
    // original file from its local path, re-encoding would detach that path,
    // so the original bytes are sent instead.
    const file = input.endpoint.client.uploadInboxPrefersOriginalFile?.(attachment.file)
      ? attachment.file
      : await compressImageFile(attachment.file);
    const metadata = resolveAttachmentFileMetadata(file);
    const id = input.createId ? input.createId() : randomAttachmentId();
    const inboxPath = buildChatAttachmentInboxPath({
      sessionId: input.sessionId,
      filename: metadata.filename,
      id,
    });

    let result: InboxUploadResult;
    try {
      result = await input.endpoint.client.uploadInbox(workspaceId, file, { path: inboxPath });
    } catch (error) {
      throw new Error(uploadErrorMessage(metadata.filename, error));
    }

    if (result.ok === false) {
      throw new Error(`Failed to copy attachment "${metadata.filename}" into this worker workspace: upload was rejected`);
    }
    if (!result.path.trim()) {
      throw new Error(`Failed to copy attachment "${metadata.filename}" into this worker workspace: upload did not return a path`);
    }
    if (result.bytes !== file.size) {
      throw new Error(`Failed to copy attachment "${metadata.filename}" into this worker workspace: expected ${file.size} bytes, wrote ${result.bytes}`);
    }

    const workspacePath = workspaceInboxPath(result.path);
    const absolutePath = joinWorkspaceRelativePath(workspaceRoot, workspacePath);
    uploaded.push({
      filename: metadata.filename,
      mime: metadata.mime,
      bytes: result.bytes,
      workspacePath,
      url: toFileUrl(absolutePath),
      file,
    });
  }

  return {
    note: attachmentPathNotePart(uploaded),
    files: await Promise.all(uploaded.map(uploadedAttachmentFilePart)),
  };
}

export async function composerAttachmentToFilePart(attachment: ComposerAttachment): Promise<FilePartInput | null> {
  const file = await compressImageFile(attachment.file);
  const metadata = resolveAttachmentFileMetadata(file);
  const modelMime = modelFacingAttachmentMime(metadata.mime);
  if (!modelMime) return null;
  return {
    type: "file",
    url: await fileToDataUrl(file, modelMime),
    filename: metadata.filename,
    mime: modelMime,
  };
}
