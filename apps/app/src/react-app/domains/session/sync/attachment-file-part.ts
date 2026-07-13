import type { FilePartInput } from "@opencode-ai/sdk/v2/client";

import type { ComposerAttachment } from "../../../../app/types";

type AttachmentKind = "image" | "file";

type AttachmentFile = Pick<File, "arrayBuffer" | "name" | "type">;

type AttachmentFileMetadata = {
  filename: string;
  mime: string;
  kind: AttachmentKind;
  readable: boolean;
};

const EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
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
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  log: "text/plain",
};

const MIME_FILENAME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
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
  return mime === "" || mime === "application/octet-stream";
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
  return mimeFromFilename(file.name) ?? "text/plain";
}

export function isResolvedAttachmentMimeReadable(mimeType: string) {
  const mime = normalizedMime(mimeType);
  if (mime.startsWith("image/") || mime.startsWith("text/")) return true;
  if (mime === "application/pdf" || mime === "application/json") return true;
  return mime.endsWith("+json") || mime.endsWith("+xml") || mime === "application/xml" || mime === "application/javascript";
}

function normalizeFilenameExtension(filename: string, mime: string) {
  const original = filename.trim() || "attachment";
  const preferredExtension = MIME_FILENAME_EXTENSIONS[mime];
  if (!preferredExtension) return original;

  const extension = extensionFromFilename(original);
  const extensionMime = extension ? EXTENSION_MIME_TYPES[extension] : undefined;
  if (extensionMime === mime) return original;

  const strictMime = mime.startsWith("image/") || mime === "application/pdf" || mime === "application/json";
  if (!strictMime && extensionMime === undefined) return original;

  const stem = extension ? original.slice(0, -(extension.length + 1)) : original;
  return `${stem.trim() || "attachment"}.${preferredExtension}`;
}

export function resolveAttachmentFileMetadata(file: Pick<File, "name" | "type">): AttachmentFileMetadata {
  const mime = resolveAttachmentMime(file);
  return {
    filename: normalizeFilenameExtension(file.name, mime),
    mime,
    kind: mime.startsWith("image/") ? "image" : "file",
    readable: isResolvedAttachmentMimeReadable(mime),
  };
}

export function isAttachmentFileReadable(file: Pick<File, "name" | "type">) {
  return resolveAttachmentFileMetadata(file).readable;
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

export async function composerAttachmentToFilePart(attachment: ComposerAttachment): Promise<FilePartInput> {
  const metadata = resolveAttachmentFileMetadata(attachment.file);
  return {
    type: "file",
    url: await fileToDataUrl(attachment.file, metadata.mime),
    filename: metadata.filename,
    mime: metadata.mime,
  };
}
