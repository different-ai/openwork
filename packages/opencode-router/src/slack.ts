import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { Logger } from "pino";

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { Config, SlackIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type { InboundMessagePart, MediaKind, MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import type { MediaStore } from "./media-store.js";

export type InboundMessage = {
  channel: "slack";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type SlackAdapter = {
  name: "slack";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
};

export type SlackDeps = {
  WebClient: typeof WebClient;
  SocketModeClient: typeof SocketModeClient;
};

export type SlackPeer = {
  channelId: string;
  threadTs?: string;
};

// `peerId` encoding:
// - DMs:   D12345678
// - Threads in channels: C12345678|1700000000.000100
// Using `|` avoids clashing with ALLOW_FROM's channel:peer parsing.
export function formatSlackPeerId(peer: SlackPeer): string {
  if (!peer.threadTs) return peer.channelId;
  return `${peer.channelId}|${peer.threadTs}`;
}

export function parseSlackPeerId(peerId: string): SlackPeer {
  const trimmed = peerId.trim();
  if (!trimmed) return { channelId: "" };
  const [channelId, threadTs] = trimmed.split("|");
  if (channelId && threadTs) return { channelId, threadTs };
  return { channelId: channelId || trimmed };
}

export function stripSlackMention(text: string, botUserId: string | null): string {
  let next = text ?? "";
  if (botUserId) {
    const token = `<@${botUserId}>`;
    next = next.split(token).join(" ");
  }
  next = next.replace(/^\s*[:,-]+\s*/, "");
  return next.trim();
}

const MAX_TEXT_LENGTH = 39_000;

type SlackEvent = {
  type?: unknown;
  channel?: unknown;
  text?: unknown;
  user?: unknown;
  bot_id?: unknown;
  subtype?: unknown;
  thread_ts?: unknown;
  ts?: unknown;
  files?: unknown;
};

type SlackFileCandidate = {
  id: string;
  url: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind: MediaKind;
};

export function createSlackAdapter(
  identity: SlackIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  deps: SlackDeps = { WebClient, SocketModeClient },
  mediaStore?: MediaStore,
): SlackAdapter {
  const botToken = identity.botToken?.trim() ?? "";
  const appToken = identity.appToken?.trim() ?? "";
  if (!botToken) {
    throw new Error("Slack bot token is required for Slack adapter");
  }
  if (!appToken) {
    throw new Error("Slack app token is required for Slack adapter");
  }

  const log = logger.child({ channel: "slack", identityId: identity.id });
  const web = new deps.WebClient(botToken);
  const socket = new deps.SocketModeClient({ appToken });

  let botUserId: string | null = null;
  let started = false;

  const parseSlackFiles = (value: unknown): SlackFileCandidate[] => {
    if (!Array.isArray(value)) return [];
    const files: SlackFileCandidate[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const record = item as {
        id?: unknown;
        url_private_download?: unknown;
        url_private?: unknown;
        name?: unknown;
        mimetype?: unknown;
        size?: unknown;
      };
      const id = typeof record.id === "string" ? record.id : "";
      const url =
        typeof record.url_private_download === "string"
          ? record.url_private_download
          : typeof record.url_private === "string"
            ? record.url_private
            : "";
      if (!id || !url) continue;
      const mimeType = typeof record.mimetype === "string" ? record.mimetype : undefined;
      const kind: MediaKind =
        typeof mimeType === "string" && mimeType.startsWith("image/")
          ? "image"
          : typeof mimeType === "string" && mimeType.startsWith("audio/")
            ? "audio"
            : "file";
      files.push({
        id,
        url,
        kind,
        ...(typeof record.name === "string" ? { filename: record.name } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(typeof record.size === "number" ? { sizeBytes: record.size } : {}),
      });
    }
    return files;
  };

  const downloadSlackFile = async (peerId: string, candidate: SlackFileCandidate): Promise<InboundMessagePart> => {
    if (!mediaStore) {
      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "slack",
          status: "failed",
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(typeof candidate.sizeBytes === "number" ? { sizeBytes: candidate.sizeBytes } : {}),
          providerFileId: candidate.id,
          providerUrl: candidate.url,
          error: "media store unavailable",
        },
      };
    }

    try {
      const stored = await withDeliveryRetry(
        "slack.download",
        () =>
          mediaStore.downloadInbound({
            channel: "slack",
            identityId: identity.id,
            peerId,
            kind: candidate.kind,
            url: candidate.url,
            headers: {
              Authorization: `Bearer ${botToken}`,
            },
            ...(candidate.filename ? { filename: candidate.filename } : {}),
            ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          }),
        { logger: log },
      );

      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "slack",
          status: "ready",
          filePath: stored.filePath,
          filename: stored.filename,
          ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
          sizeBytes: stored.sizeBytes,
          providerFileId: candidate.id,
          providerUrl: candidate.url,
        },
      };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      return {
        type: "media",
        media: {
          id: candidate.id,
          kind: candidate.kind,
          source: "slack",
          status: "failed",
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(typeof candidate.sizeBytes === "number" ? { sizeBytes: candidate.sizeBytes } : {}),
          providerFileId: candidate.id,
          providerUrl: candidate.url,
          error: `${classified.code}: ${classified.message}`,
        },
      };
    }
  };

  const safeAck = async (ack: unknown) => {
    if (typeof ack !== "function") return;
    try {
      await ack();
    } catch (error) {
      log.warn({ error }, "slack ack failed");
    }
  };

  const shouldIgnore = (
    event: SlackEvent,
  ):
    | { ok: true }
    | {
        ok: false;
        channelId: string;
        textRaw: string;
        userId: string | null;
        files: SlackFileCandidate[];
        threadTs: string | null;
        ts: string | null;
      } => {
    const channelId = typeof event.channel === "string" ? event.channel : "";
    const textRaw = typeof event.text === "string" ? event.text : "";
    const userId = typeof event.user === "string" ? event.user : null;
    const botId = typeof event.bot_id === "string" ? event.bot_id : null;
    const subtype = typeof event.subtype === "string" ? event.subtype : null;
    const files = parseSlackFiles(event.files);
    const hasFiles = files.length > 0;
    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
    const ts = typeof event.ts === "string" ? event.ts : null;

    // Avoid loops / non-user messages.
    if (botId) return { ok: true };
    if (subtype && subtype !== "" && subtype !== "file_share") return { ok: true };
    if (userId && botUserId && userId === botUserId) return { ok: true };
    if (!channelId || (!textRaw.trim() && !hasFiles)) return { ok: true };

    return { ok: false, channelId, textRaw, userId, files, threadTs, ts };
  };

  socket.on("message", async (args: unknown) => {
    const ack = (args as { ack?: unknown })?.ack;
    await safeAck(ack);

    const event = (args as { event?: unknown })?.event as SlackEvent | undefined;
    if (!event || typeof event !== "object") return;
    const filtered = shouldIgnore(event);
    if (filtered.ok) return;

    // Only respond to direct messages by default.
    const isDm = filtered.channelId.startsWith("D");
    if (!isDm) return;

    const peerId = formatSlackPeerId({ channelId: filtered.channelId, ...(filtered.threadTs ? { threadTs: filtered.threadTs } : {}) });
    const parts: InboundMessagePart[] = [];
    if (filtered.textRaw.trim()) {
      parts.push({ type: "text", text: filtered.textRaw.trim() });
    }
    for (const file of filtered.files) {
      parts.push(await downloadSlackFile(peerId, file));
    }
    if (parts.length === 0) return;
    const text = parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    try {
      await onMessage({
        channel: "slack",
        identityId: identity.id,
        peerId,
        text,
        parts,
        raw: event,
      });
    } catch (error) {
      log.error({ error, peerId }, "slack inbound handler failed");
    }
  });

  socket.on("app_mention", async (args: unknown) => {
    const ack = (args as { ack?: unknown })?.ack;
    await safeAck(ack);

    const event = (args as { event?: unknown })?.event as SlackEvent | undefined;
    if (!event || typeof event !== "object") return;
    const filtered = shouldIgnore(event);
    if (filtered.ok) return;

    const rootThread = filtered.threadTs || filtered.ts;
    const peerId = formatSlackPeerId({ channelId: filtered.channelId, ...(rootThread ? { threadTs: rootThread } : {}) });
    const text = stripSlackMention(filtered.textRaw, botUserId);
    const parts: InboundMessagePart[] = [];
    if (text) {
      parts.push({ type: "text", text });
    }
    for (const file of filtered.files) {
      parts.push(await downloadSlackFile(peerId, file));
    }
    if (parts.length === 0) return;
    const promptText = parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    try {
      await onMessage({
        channel: "slack",
        identityId: identity.id,
        peerId,
        text: promptText,
        parts,
        raw: event,
      });
    } catch (error) {
      log.error({ error, peerId }, "slack inbound handler failed");
    }
  });

  const sendMessageInternal = async (
    peerId: string,
    message: { parts: OutboundMessagePart[] },
  ): Promise<MessageDeliveryResult> => {
    const peer = parseSlackPeerId(peerId);
    if (!peer.channelId) {
      const error = new Error("Invalid Slack peerId") as Error & { status?: number };
      error.status = 400;
      throw error;
    }

    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          await withDeliveryRetry(
            "slack.postMessage",
            () =>
              web.chat.postMessage({
                channel: peer.channelId,
                text: part.text,
                ...(peer.threadTs ? { thread_ts: peer.threadTs } : {}),
              } as any),
            { logger: log },
          );
        } else {
          const fileData = await readFile(part.filePath);
          const filename = part.filename || basename(part.filePath);
          await withDeliveryRetry(
            "slack.uploadFile",
            () =>
              (web as any).files.uploadV2({
                channel_id: peer.channelId,
                file: fileData,
                filename,
                ...(peer.threadTs ? { thread_ts: peer.threadTs } : {}),
                ...(part.caption?.trim() ? { initial_comment: part.caption.trim() } : {}),
              }),
            { logger: log },
          );
        }

        sentParts += 1;
        partResults.push({ index, type: part.type, sent: true });
      } catch (error) {
        const classified = classifyDeliveryError(error);
        partResults.push({
          index,
          type: part.type,
          sent: false,
          error: classified.message,
          code: classified.code,
          retryable: classified.retryable,
        });
      }
    }

    return {
      attemptedParts: message.parts.length,
      sentParts,
      partResults,
    };
  };

  return {
    name: "slack",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      if (started) return;
      log.debug("slack adapter starting");
      const auth = await web.auth.test();
      botUserId = typeof (auth as any)?.user_id === "string" ? (auth as any).user_id : null;
      await socket.start();
      started = true;
      log.info({ botUserId }, "slack adapter started");
    },
    async stop() {
      if (!started) return;
      started = false;
      try {
        // socket-mode client uses a websocket; disconnect when stopping.
        await socket.disconnect();
      } catch (error) {
        log.warn({ error }, "slack adapter stop failed");
      }
      log.info("slack adapter stopped");
    },
    async sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }) {
      return sendMessageInternal(peerId, message);
    },
    async sendText(peerId: string, text: string) {
      const result = await sendMessageInternal(peerId, {
        parts: [{ type: "text", text }],
      });
      if (result.sentParts === 0) {
        const firstError = result.partResults.find((part) => !part.sent)?.error;
        throw new Error(firstError || "Failed to deliver Slack text message");
      }
    },
  };
}
