import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCX_MIME,
  MAX_COMPRESSED_BYTES,
  PPTX_MIME,
  XLSX_MIME,
  extractOfficeText,
  officeKindFromMimeOrFilename,
  type OfficeKind,
} from "@openwork/workbook";
import { openWorkspaceFileForReading, openWorkspaceFileForWriting } from "./workspace-file-identity.js";

const MATERIALIZED_DIR = join(".opencode", "openwork", "inbox", "chat-attachments");

type RuntimeContext = {
  directory?: string;
};

type OfficeFilePart = {
  filename: string;
  mime: string;
  url: string;
  kind: OfficeKind;
  part: Record<string, unknown>;
};

type MaterializedAttachment = {
  sha256: string;
  relativePath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property : undefined;
}

function normalizeOpenCodeContext(value: unknown): RuntimeContext {
  const directory = optionalStringProperty(value, "directory");
  return {
    ...(directory ? { directory } : {}),
  };
}

function workspaceRoot(factoryContext: RuntimeContext): string | null {
  return factoryContext.directory ? resolve(factoryContext.directory) : null;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function normalizedMime(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().split(";")[0]?.trim() ?? "" : "";
}

function extensionFromFilename(filename: string): string {
  const name = basename(filename).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function canonicalMime(kind: OfficeKind): string {
  if (kind === "docx") return DOCX_MIME;
  if (kind === "pptx") return PPTX_MIME;
  return XLSX_MIME;
}

function officeFilePart(value: unknown): OfficeFilePart | null {
  if (!isRecord(value) || value.type !== "file") return null;
  const url = optionalStringProperty(value, "url");
  if (!url) return null;
  const filename = optionalStringProperty(value, "filename") ?? optionalStringProperty(value, "name") ?? "attachment";
  const mime = normalizedMime(value.mediaType ?? value.mime ?? value.mimeType);
  const kind = officeKindFromMimeOrFilename(mime, filename);
  if (!kind) return null;
  return { filename, mime: canonicalMime(kind), url, kind, part: value };
}

function safeFilename(filename: string, kind: OfficeKind): string {
  const extension = kind;
  const clean = basename(filename)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  const base = clean || `attachment.${extension}`;
  const currentExtension = extensionFromFilename(base);
  const rawStem = currentExtension ? base.slice(0, -(currentExtension.length + 1)) : base;
  const stem = rawStem.replace(/\.+$/, "").trim() || "attachment";
  return `${stem.slice(0, 120 - extension.length - 1)}.${extension}`;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toWorkerRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;

  let padding = 0;
  if (value.endsWith("==")) padding = 2;
  else if (value.endsWith("=")) padding = 1;

  const dataEnd = value.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (base64Value(value.charCodeAt(index)) < 0) return false;
  }
  for (let index = dataEnd; index < value.length; index += 1) {
    if (value[index] !== "=") return false;
  }

  if (padding === 1) return (base64Value(value.charCodeAt(value.length - 2)) & 0b11) === 0;
  if (padding === 2) return (base64Value(value.charCodeAt(value.length - 3)) & 0b1111) === 0;
  return true;
}

function decodeDataUrl(url: string): Buffer {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!match) throw new Error("Only base64 data URLs are supported for Office attachments.");
  const encoded = match[2].replace(/\s+/g, "");
  if (encoded.length > Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4 + 8) throw new Error("Office attachment data URL exceeds the compressed byte limit.");
  if (!isValidBase64(encoded)) throw new Error("Office attachment data URL is not valid base64.");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.byteLength > MAX_COMPRESSED_BYTES) throw new Error("Office attachment exceeds the compressed byte limit.");
  return buffer;
}

/**
 * Read a regular file at exactly this path inside the real workspace root with
 * open-then-verify ordering (see workspace-file-identity.ts): the handle is
 * obtained first and proven to be the file at this path, with no link in any
 * component, before it is read.
 */
async function readWorkspaceFile(realRoot: string, path: string, label: string): Promise<Buffer> {
  if (!isWithin(realRoot, path)) throw new Error(`${label} points outside the active workspace.`);
  const { handle, info } = await openWorkspaceFileForReading(realRoot, path, label);
  try {
    if (info.size > MAX_COMPRESSED_BYTES) throw new Error("Office attachment exceeds the compressed byte limit.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function bytesFromPart(part: OfficeFilePart, root: string | null): Promise<Buffer> {
  if (part.url.startsWith("data:")) return decodeDataUrl(part.url);
  const url = new URL(part.url);
  if (url.protocol !== "file:") throw new Error("Office attachment URL was not a supported data: or workspace file: URL.");
  if (!root) throw new Error("Workspace root is unavailable for file: Office attachment URLs.");
  const realRoot = await realpath(root);
  const filePath = resolve(realRoot, relative(root, resolve(fileURLToPath(url))));
  return await readWorkspaceFile(realRoot, filePath, "Office attachment file URL");
}

/**
 * Ensure the materialization folder exists one component at a time, refusing
 * a link at any level, so the folder can only ever be the real directory
 * directly under the real workspace root. Creating a missing component is the
 * only pathname-dependent mutation here, and it can only ever produce an
 * empty directory.
 */
async function ensureMaterializedDirectory(realRoot: string): Promise<string> {
  let current = realRoot;
  for (const segment of MATERIALIZED_DIR.split(sep)) {
    current = join(current, segment);
    let info = await lstat(current).catch(() => null);
    if (info === null) {
      await mkdir(current).catch(() => undefined);
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) throw new Error(`Office attachment folder ${toWorkerRelativePath(realRoot, current)} is a symbolic link, which is not allowed.`);
    if (!info.isDirectory()) throw new Error(`Office attachment folder ${toWorkerRelativePath(realRoot, current)} is not a directory.`);
  }
  const real = await realpath(current);
  if (real !== current) throw new Error("Office attachment folder passes through a symbolic link, which is not allowed.");
  return current;
}

async function existingDigest(realRoot: string, path: string): Promise<string | null> {
  try {
    return sha256(await readWorkspaceFile(realRoot, path, "Materialized Office attachment"));
  } catch {
    return null;
  }
}

/**
 * Create the file exclusively (never replacing anything), prove the new inode
 * is in place, then write through the handle. Bytes never travel through a
 * pathname after validation.
 */
async function writeMaterializedFile(realRoot: string, target: string, bytes: Buffer): Promise<void> {
  const { handle } = await openWorkspaceFileForWriting(realRoot, target, null, "Materialized Office attachment");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function materializeAttachment(root: string | null, filename: string, kind: OfficeKind, bytes: Buffer): Promise<MaterializedAttachment | null> {
  if (!root) return null;
  const digest = sha256(bytes);
  const realRoot = await realpath(root);
  const directory = await ensureMaterializedDirectory(realRoot);
  const names = [`${digest.slice(0, 16)}-${safeFilename(filename, kind)}`, `${digest}-${safeFilename(filename, kind)}`];
  for (const name of names) {
    const target = join(directory, name);
    const current = await existingDigest(realRoot, target);
    if (current === digest) return { sha256: digest, relativePath: toWorkerRelativePath(realRoot, target) };
    if (current !== null) continue;
    try {
      await writeMaterializedFile(realRoot, target, bytes);
      return { sha256: digest, relativePath: toWorkerRelativePath(realRoot, target) };
    } catch (cause) {
      const afterRace = await existingDigest(realRoot, target);
      if (afterRace === digest) return { sha256: digest, relativePath: toWorkerRelativePath(realRoot, target) };
      if (afterRace !== null) continue;
      throw cause;
    }
  }
  throw new Error("A different Office attachment already exists at the materialized path.");
}

function basePartIds(part: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["id", "sessionID", "messageID", "sessionId", "messageId"]) {
    const value = part[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value;
  }
  return result;
}

function normalizedText(part: OfficeFilePart, materialized: MaterializedAttachment | null, extractedText: string, error?: string): string {
  return [
    "OpenWork normalized an Office attachment before sending this request to the model.",
    `filename: ${safeFilename(part.filename, part.kind)}`,
    `canonical_mime: ${part.mime}`,
    `sha256: ${materialized?.sha256 ?? "unavailable"}`,
    `worker_relative_path: ${materialized?.relativePath ?? "unavailable"}`,
    ...(error ? [`extraction_error: ${error}`] : []),
    ...(part.kind === "xlsx" && materialized
      ? [`next_step: the read tool cannot open .xlsx; use spreadsheet_inspect and spreadsheet_read with path ${JSON.stringify(materialized.relativePath)} for every sheet, range, and row beyond this preview.`]
      : []),
    "extracted_text:",
    extractedText,
  ].join("\n");
}

function textPartFrom(part: OfficeFilePart, text: string): Record<string, unknown> {
  return { ...basePartIds(part.part), type: "text", text };
}

async function normalizeOfficePart(part: OfficeFilePart, root: string | null): Promise<Record<string, unknown>> {
  try {
    const bytes = await bytesFromPart(part, root);
    const materialized = await materializeAttachment(root, part.filename, part.kind, bytes);
    try {
      const extractedText = await extractOfficeText(part.kind, bytes, { spreadsheetReadTool: "spreadsheet_read" });
      return textPartFrom(part, normalizedText(part, materialized, extractedText));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return textPartFrom(part, normalizedText(part, materialized, "No text could be safely extracted from this Office attachment.", message));
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return textPartFrom(part, normalizedText(part, null, "The original Office attachment was not forwarded to the provider.", message));
  }
}

async function transformPart(value: unknown, root: string | null): Promise<unknown> {
  const part = officeFilePart(value);
  return part ? await normalizeOfficePart(part, root) : value;
}

async function transformMessage(value: unknown, root: string | null): Promise<unknown> {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.parts)) return { ...value, parts: await Promise.all(value.parts.map((part) => transformPart(part, root))) };
  if (Array.isArray(value.content)) return { ...value, content: await Promise.all(value.content.map((part) => transformPart(part, root))) };
  return value;
}

// Single export: the OpenCode plugin loader treats every export of a plugin
// module as a plugin factory, so helpers must stay module-private.
export const OpenWorkOfficeAttachments = async (factoryInput?: unknown) => {
  const factoryContext = normalizeOpenCodeContext(factoryInput);
  return {
    "experimental.chat.messages.transform": async (input: unknown, output: { messages: unknown[] }) => {
      void input;
      const root = workspaceRoot(factoryContext);
      const messages = await Promise.all(output.messages.map((message) => transformMessage(message, root)));
      output.messages.splice(0, output.messages.length, ...messages);
    },
  };
};
