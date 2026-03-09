import { Bot, InputFile, type BotError, type Context } from "grammy";
import type { Logger } from "pino";

import type { Config, TelegramIdentity } from "./config.js";
import { classifyDeliveryError, withDeliveryRetry } from "./delivery.js";
import type { InboundMessagePart, MediaKind, MessageDeliveryResult, OutboundMessagePart } from "./media.js";
import type { MediaStore } from "./media-store.js";
import { chunkText } from "./text.js";

export type InboundMessage = {
  channel: "telegram";
  identityId: string;
  peerId: string;
  text: string;
  parts?: InboundMessagePart[];
  raw: unknown;
  fromMe?: boolean;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type TelegramAdapter = {
  name: "telegram";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(peerId: string, message: { parts: OutboundMessagePart[] }): Promise<MessageDeliveryResult>;
  sendText(peerId: string, text: string): Promise<void>;
};

const MAX_TEXT_LENGTH = 4096;

const TELEGRAM_CHAT_ID_PATTERN = /^-?\d+$/;

export function isTelegramPeerId(peerId: string): boolean {
  return TELEGRAM_CHAT_ID_PATTERN.test(peerId.trim());
}

export function parseTelegramPeerId(peerId: string): number | null {
  const trimmed = peerId.trim();
  if (!isTelegramPeerId(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function invalidTelegramPeerIdError(): Error & { status?: number } {
  const error = new Error(
    "Telegram peerId must be a numeric chat_id. Usernames like @name are not valid direct targets.",
  ) as Error & { status?: number };
  error.status = 400;
  return error;
}

export function createTelegramAdapter(
  identity: TelegramIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  mediaStore?: MediaStore,
  deps: { Bot?: typeof Bot } = {},
): TelegramAdapter {
  const token = identity.token?.trim() ?? "";
  if (!token) {
    throw new Error("Telegram token is required for Telegram adapter");
  }

  const log = logger.child({ channel: "telegram", identityId: identity.id });
  log.debug({ tokenPresent: true }, "telegram adapter init");
  const BotImpl = deps.Bot ?? Bot;
  const bot = new BotImpl(token);

  type TelegramMediaCandidate = {
    kind: MediaKind;
    fileId: string;
    fileUniqueId?: string;
    filename?: string;
    mimeType?: string;
    sizeBytes?: number;
  };

  const truncateCaption = (value: string | undefined) => {
    const text = (value ?? "").trim();
    if (!text) return undefined;
    return text.length <= 1024 ? text : text.slice(0, 1024);
  };

  const extractMediaCandidates = (message: any): TelegramMediaCandidate[] => {
    const candidates: TelegramMediaCandidate[] = [];

    if (Array.isArray(message?.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      if (largest?.file_id) {
        candidates.push({
          kind: "image",
          fileId: String(largest.file_id),
          fileUniqueId: typeof largest.file_unique_id === "string" ? largest.file_unique_id : undefined,
          filename:
            typeof largest.file_unique_id === "string"
              ? `photo-${largest.file_unique_id}.jpg`
              : `photo-${String(largest.file_id)}.jpg`,
          mimeType: "image/jpeg",
          sizeBytes: typeof largest.file_size === "number" ? largest.file_size : undefined,
        });
      }
    }

    if (message?.document?.file_id) {
      const document = message.document;
      const mimeType = typeof document.mime_type === "string" ? document.mime_type : undefined;
      const normalizedKind: MediaKind =
        typeof mimeType === "string" && mimeType.startsWith("image/")
          ? "image"
          : typeof mimeType === "string" && mimeType.startsWith("audio/")
            ? "audio"
            : "file";
      candidates.push({
        kind: normalizedKind,
        fileId: String(document.file_id),
        fileUniqueId: typeof document.file_unique_id === "string" ? document.file_unique_id : undefined,
        filename: typeof document.file_name === "string" ? document.file_name : undefined,
        mimeType,
        sizeBytes: typeof document.file_size === "number" ? document.file_size : undefined,
      });
    }

    if (message?.audio?.file_id) {
      const audio = message.audio;
      candidates.push({
        kind: "audio",
        fileId: String(audio.file_id),
        fileUniqueId: typeof audio.file_unique_id === "string" ? audio.file_unique_id : undefined,
        filename: typeof audio.file_name === "string" ? audio.file_name : undefined,
        mimeType: typeof audio.mime_type === "string" ? audio.mime_type : undefined,
        sizeBytes: typeof audio.file_size === "number" ? audio.file_size : undefined,
      });
    }

    if (message?.voice?.file_id) {
      const voice = message.voice;
      candidates.push({
        kind: "audio",
        fileId: String(voice.file_id),
        fileUniqueId: typeof voice.file_unique_id === "string" ? voice.file_unique_id : undefined,
        filename:
          typeof voice.file_unique_id === "string"
            ? `voice-${voice.file_unique_id}.ogg`
            : `voice-${String(voice.file_id)}.ogg`,
        mimeType: "audio/ogg",
        sizeBytes: typeof voice.file_size === "number" ? voice.file_size : undefined,
      });
    }

    return candidates;
  };

  const downloadCandidate = async (
    chatId: string,
    candidate: TelegramMediaCandidate,
  ): Promise<InboundMessagePart> => {
    if (!mediaStore) {
      return {
        type: "media",
        media: {
          id: candidate.fileUniqueId || candidate.fileId,
          kind: candidate.kind,
          source: "telegram",
          status: "failed",
          providerFileId: candidate.fileId,
          ...(candidate.fileUniqueId ? { providerFileUniqueId: candidate.fileUniqueId } : {}),
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(typeof candidate.sizeBytes === "number" ? { sizeBytes: candidate.sizeBytes } : {}),
          error: "media store unavailable",
        },
      };
    }

    try {
      const file = await withDeliveryRetry(
        "telegram.getFile",
        () => bot.api.getFile(candidate.fileId),
        { logger: log },
      );
      const filePath = typeof (file as any)?.file_path === "string" ? String((file as any).file_path) : "";
      if (!filePath) {
        throw new Error(`Telegram file path missing for file_id ${candidate.fileId}`);
      }

      const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
      const stored = await withDeliveryRetry(
        "telegram.download",
        () =>
          mediaStore.downloadInbound({
            channel: "telegram",
            identityId: identity.id,
            peerId: chatId,
            kind: candidate.kind,
            url,
            ...(candidate.filename ? { filename: candidate.filename } : {}),
            ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          }),
        { logger: log },
      );

      return {
        type: "media",
        media: {
          id: candidate.fileUniqueId || candidate.fileId,
          kind: candidate.kind,
          source: "telegram",
          status: "ready",
          filePath: stored.filePath,
          filename: stored.filename,
          ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
          sizeBytes: stored.sizeBytes,
          providerFileId: candidate.fileId,
          ...(candidate.fileUniqueId ? { providerFileUniqueId: candidate.fileUniqueId } : {}),
          providerUrl: url,
        },
      };
    } catch (error) {
      const classified = classifyDeliveryError(error);
      return {
        type: "media",
        media: {
          id: candidate.fileUniqueId || candidate.fileId,
          kind: candidate.kind,
          source: "telegram",
          status: "failed",
          providerFileId: candidate.fileId,
          ...(candidate.fileUniqueId ? { providerFileUniqueId: candidate.fileUniqueId } : {}),
          ...(candidate.filename ? { filename: candidate.filename } : {}),
          ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
          ...(typeof candidate.sizeBytes === "number" ? { sizeBytes: candidate.sizeBytes } : {}),
          error: `${classified.code}: ${classified.message}`,
        },
      };
    }
  };

  bot.catch((err: BotError<Context>) => {
    log.error({ error: err.error }, "telegram bot error");
  });

  bot.on("message", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg?.chat) return;

    const fromId = typeof msg.from?.id === "number" ? msg.from.id : null;
    const selfId = typeof ctx.me?.id === "number" ? ctx.me.id : null;
    const fromMe = fromId !== null && selfId !== null && fromId === selfId;
    const fromBot = msg.from?.is_bot === true;
    if (fromMe || fromBot) {
      log.debug({ chatId: msg.chat.id, fromId, selfId }, "telegram message ignored (bot-originated)");
      return;
    }

    const mediaCandidates = extractMediaCandidates(msg as any);
    const hasMedia = mediaCandidates.length > 0;

    const chatType = msg.chat.type as string;
    const isGroup = chatType === "group" || chatType === "supergroup" || chatType === "channel";
    
    // In groups, check if groups are enabled
    if (isGroup && !config.groupsEnabled) {
      log.debug({ chatId: msg.chat.id, chatType }, "telegram message ignored (groups disabled)");
      return;
    }

    let text = msg.text ?? msg.caption ?? "";

    // In groups, only respond if the bot is @mentioned
    if (isGroup) {
      const botUsername = ctx.me?.username;
      if (!botUsername) {
        log.debug({ chatId: msg.chat.id }, "telegram message ignored (bot username unknown)");
        return;
      }
      
      const mentionPattern = new RegExp(`@${botUsername}\\b`, "i");
      if (!mentionPattern.test(text)) {
        log.debug({ chatId: msg.chat.id, botUsername }, "telegram message ignored (not mentioned)");
        return;
      }
      
      // Strip the @mention from the message
      text = text.replace(mentionPattern, "").trim();
      if (!text && !hasMedia) {
        log.debug({ chatId: msg.chat.id }, "telegram message ignored (empty after removing mention)");
        return;
      }
    }

    if (!text.trim() && !hasMedia) {
      return;
    }

    const parts: InboundMessagePart[] = [];
    if (text.trim()) {
      parts.push({ type: "text", text: text.trim() });
    }

    for (const candidate of mediaCandidates) {
      const part = await downloadCandidate(String(msg.chat.id), candidate);
      if ((msg.caption ?? "").trim() && part.type === "media") {
        parts.push({ ...part, caption: msg.caption?.trim() });
      } else {
        parts.push(part);
      }
    }

    const textForPrompt = parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const preview = textForPrompt || `${parts.filter((part) => part.type === "media").length} media attachment(s)`;

    log.debug(
      { chatId: msg.chat.id, chatType, isGroup, length: textForPrompt.length, preview: preview.slice(0, 120) },
      "telegram message received",
    );

    try {
      await onMessage({
        channel: "telegram",
        identityId: identity.id,
        peerId: String(msg.chat.id),
        text: textForPrompt,
        parts,
        raw: msg,
        fromMe,
      });
    } catch (error) {
      log.error({ error, peerId: msg.chat.id }, "telegram inbound handler failed");
    }
  });

  const sendMessageInternal = async (
    peerId: string,
    message: { parts: OutboundMessagePart[] },
  ): Promise<MessageDeliveryResult> => {
    const chatId = parseTelegramPeerId(peerId);
    if (chatId === null) {
      throw invalidTelegramPeerIdError();
    }

    const partResults: MessageDeliveryResult["partResults"] = [];
    let sentParts = 0;

    for (let index = 0; index < message.parts.length; index += 1) {
      const part = message.parts[index];
      try {
        if (part.type === "text") {
          const chunks = chunkText(part.text, MAX_TEXT_LENGTH);
          for (const chunk of chunks) {
            await withDeliveryRetry("telegram.sendMessage", () => bot.api.sendMessage(chatId, chunk), {
              logger: log,
            });
          }
        } else if (part.type === "image") {
          await withDeliveryRetry(
            "telegram.sendPhoto",
            () =>
              bot.api.sendPhoto(chatId, new InputFile(part.filePath, part.filename), {
                ...(truncateCaption(part.caption) ? { caption: truncateCaption(part.caption) } : {}),
              }),
            { logger: log },
          );
        } else if (part.type === "audio") {
          await withDeliveryRetry(
            "telegram.sendAudio",
            () =>
              bot.api.sendAudio(chatId, new InputFile(part.filePath, part.filename), {
                ...(truncateCaption(part.caption) ? { caption: truncateCaption(part.caption) } : {}),
              }),
            { logger: log },
          );
        } else {
          await withDeliveryRetry(
            "telegram.sendDocument",
            () =>
              bot.api.sendDocument(chatId, new InputFile(part.filePath, part.filename), {
                ...(truncateCaption(part.caption) ? { caption: truncateCaption(part.caption) } : {}),
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
    name: "telegram",
    identityId: identity.id,
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      log.debug("telegram adapter starting");
      await bot.start();
      log.info("telegram adapter started");
    },
    async stop() {
      bot.stop();
      log.info("telegram adapter stopped");
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
        throw new Error(firstError || "Failed to deliver Telegram text message");
      }
    },
  };
}
