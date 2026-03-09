import { basename } from "node:path";

export type MediaKind = "image" | "audio" | "file";

export type InboundMediaAttachment = {
  id: string;
  kind: MediaKind;
  source: "telegram" | "slack";
  status: "ready" | "failed";
  filePath?: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  providerFileId?: string;
  providerFileUniqueId?: string;
  providerUrl?: string;
  error?: string;
};

export type InboundMessagePart =
  | { type: "text"; text: string }
  | { type: "media"; media: InboundMediaAttachment; caption?: string };

export type OutboundMessagePart =
  | { type: "text"; text: string }
  | {
      type: MediaKind;
      filePath: string;
      caption?: string;
      filename?: string;
      mimeType?: string;
    };

export type PartDeliveryResult = {
  index: number;
  type: "text" | MediaKind;
  sent: boolean;
  error?: string;
  code?: string;
  retryable?: boolean;
};

export type MessageDeliveryResult = {
  attemptedParts: number;
  sentParts: number;
  partResults: PartDeliveryResult[];
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTextPart(value: unknown): OutboundMessagePart | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { type?: unknown; text?: unknown };
  if (record.type !== "text") return null;
  const text = typeof record.text === "string" ? record.text : "";
  if (!text.trim()) return null;
  return { type: "text", text };
}

function parseMediaPart(value: unknown): OutboundMessagePart | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    type?: unknown;
    filePath?: unknown;
    caption?: unknown;
    filename?: unknown;
    mimeType?: unknown;
  };
  if (record.type !== "image" && record.type !== "audio" && record.type !== "file") return null;
  const filePath = asTrimmedString(record.filePath);
  if (!filePath) return null;

  const caption = typeof record.caption === "string" ? record.caption : undefined;
  const filename = asTrimmedString(record.filename) || undefined;
  const mimeType = asTrimmedString(record.mimeType) || undefined;

  return {
    type: record.type,
    filePath,
    ...(caption ? { caption } : {}),
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mimeType } : {}),
  };
}

export function normalizeOutboundParts(input: { text?: string; parts?: unknown }): OutboundMessagePart[] {
  const normalized: OutboundMessagePart[] = [];
  const text = typeof input.text === "string" ? input.text : "";

  if (text.trim()) {
    normalized.push({ type: "text", text });
  }

  if (Array.isArray(input.parts)) {
    for (const item of input.parts) {
      const textPart = parseTextPart(item);
      if (textPart) {
        normalized.push(textPart);
        continue;
      }

      const mediaPart = parseMediaPart(item);
      if (mediaPart) {
        normalized.push(mediaPart);
      }
    }
  }

  return normalized;
}

export function textFromInboundParts(parts: InboundMessagePart[] | undefined, fallbackText = ""): string {
  if (!Array.isArray(parts) || parts.length === 0) return fallbackText;
  const texts = parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .filter((value) => value.trim().length > 0);
  if (texts.length === 0) return fallbackText;
  return texts.join("\n");
}

function formatBytes(sizeBytes: number | undefined): string {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) return "";
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function summarizeInboundPartsForPrompt(parts: InboundMessagePart[] | undefined): string[] {
  if (!Array.isArray(parts) || parts.length === 0) return [];

  const mediaParts = parts.filter((part): part is { type: "media"; media: InboundMediaAttachment; caption?: string } => part.type === "media");
  if (mediaParts.length === 0) return [];

  return mediaParts.map((part, index) => {
    const media = part.media;
    const label = `[${media.kind}]`;
    const filename = media.filename || (media.filePath ? basename(media.filePath) : "(unnamed)");
    const details: string[] = [];
    if (media.mimeType) details.push(media.mimeType);
    const prettySize = formatBytes(media.sizeBytes);
    if (prettySize) details.push(prettySize);

    if (media.status === "ready") {
      const pathLabel = media.filePath ? `path=${media.filePath}` : "path=(missing)";
      if (part.caption?.trim()) details.push(`caption=${JSON.stringify(part.caption.trim())}`);
      details.push(pathLabel);
      return `${index + 1}. ${label} ${filename}${details.length ? ` (${details.join(", ")})` : ""}`;
    }

    const reason = media.error?.trim() || "download failed";
    return `${index + 1}. ${label} ${filename} (failed: ${reason})`;
  });
}

export function summarizeInboundPartsForReporter(parts: InboundMessagePart[] | undefined): string {
  if (!Array.isArray(parts) || parts.length === 0) return "";
  const mediaCount = parts.filter((part) => part.type === "media").length;
  if (!mediaCount) return "";
  return mediaCount === 1 ? "[1 media attachment]" : `[${mediaCount} media attachments]`;
}
