import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import type { MediaKind } from "./media.js";

export type StoredMediaFile = {
  filePath: string;
  filename: string;
  sizeBytes: number;
  mimeType?: string;
};

function sanitizeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown";
}

function extensionFromMime(mimeType: string | undefined, kind: MediaKind): string {
  const value = (mimeType ?? "").toLowerCase();
  if (value === "image/jpeg") return ".jpg";
  if (value === "image/png") return ".png";
  if (value === "image/webp") return ".webp";
  if (value === "audio/ogg") return ".ogg";
  if (value === "audio/mpeg") return ".mp3";
  if (value === "audio/mp4") return ".m4a";
  if (value === "application/pdf") return ".pdf";
  if (kind === "image") return ".jpg";
  if (kind === "audio") return ".ogg";
  return ".bin";
}

function sanitizeFilename(filename: string, fallbackPrefix: string, fallbackExt: string): string {
  const trimmed = filename.trim();
  if (!trimmed) return `${fallbackPrefix}${fallbackExt}`;

  const base = basename(trimmed)
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!base) return `${fallbackPrefix}${fallbackExt}`;
  if (extname(base)) return base;
  return `${base}${fallbackExt}`;
}

export class MediaStore {
  constructor(private readonly rootDir: string) {}

  async ensureReady(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  private inboundDir(channel: string, identityId: string, peerId: string): string {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    return join(
      this.rootDir,
      "inbound",
      day,
      sanitizeSegment(channel),
      sanitizeSegment(identityId),
      sanitizeSegment(peerId),
    );
  }

  async saveInboundBuffer(input: {
    channel: string;
    identityId: string;
    peerId: string;
    kind: MediaKind;
    buffer: Uint8Array;
    filename?: string;
    mimeType?: string;
  }): Promise<StoredMediaFile> {
    const dir = this.inboundDir(input.channel, input.identityId, input.peerId);
    await mkdir(dir, { recursive: true });

    const defaultExt = extensionFromMime(input.mimeType, input.kind);
    const safeFilename = sanitizeFilename(
      input.filename ?? "",
      `${input.kind}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      defaultExt,
    );
    const filePath = join(dir, safeFilename);

    await writeFile(filePath, input.buffer);

    return {
      filePath,
      filename: safeFilename,
      sizeBytes: input.buffer.byteLength,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    };
  }

  async downloadInbound(input: {
    channel: string;
    identityId: string;
    peerId: string;
    kind: MediaKind;
    url: string;
    headers?: Record<string, string>;
    filename?: string;
    mimeType?: string;
  }): Promise<StoredMediaFile> {
    const response = await fetch(input.url, {
      headers: input.headers,
    });

    if (!response.ok) {
      const error = new Error(`Failed to download media (${response.status})`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    const mimeType = input.mimeType || response.headers.get("content-type") || undefined;
    const arrayBuffer = await response.arrayBuffer();
    return this.saveInboundBuffer({
      channel: input.channel,
      identityId: input.identityId,
      peerId: input.peerId,
      kind: input.kind,
      buffer: new Uint8Array(arrayBuffer),
      ...(input.filename ? { filename: input.filename } : {}),
      ...(mimeType ? { mimeType } : {}),
    });
  }

  async resolveOutboundFile(input: {
    filePath: string;
    baseDirectory: string;
    maxBytes?: number;
  }): Promise<StoredMediaFile> {
    const raw = input.filePath.trim();
    if (!raw) {
      const error = new Error("filePath is required") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const resolved = isAbsolute(raw) ? resolve(raw) : resolve(input.baseDirectory, raw);
    let info;
    try {
      info = await stat(resolved);
    } catch (error) {
      const wrapped = new Error(`File not found: ${resolved}`) as Error & { status?: number };
      wrapped.status = 404;
      (wrapped as any).cause = error;
      throw wrapped;
    }

    if (!info.isFile()) {
      const error = new Error(`Not a file: ${resolved}`) as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    if (typeof input.maxBytes === "number" && Number.isFinite(input.maxBytes) && info.size > input.maxBytes) {
      const error = new Error(
        `File exceeds maximum allowed size (${info.size} > ${Math.floor(input.maxBytes)} bytes): ${resolved}`,
      ) as Error & { status?: number };
      error.status = 413;
      throw error;
    }

    return {
      filePath: resolved,
      filename: basename(resolved),
      sizeBytes: info.size,
    };
  }
}
