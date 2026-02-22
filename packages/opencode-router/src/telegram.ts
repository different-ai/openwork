import { Bot, type BotError, type Context } from "grammy";
import type { Logger } from "pino";

import type { Config, TelegramIdentity } from "./config.js";

export type InboundMessage = {
  channel: "telegram";
  identityId: string;
  peerId: string;
  text: string;
  raw: unknown;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type TelegramAdapter = {
  name: "telegram";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
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

export function createTelegramAdapter(
  identity: TelegramIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
): TelegramAdapter {
  const token = identity.token?.trim() ?? "";
  if (!token) {
    throw new Error("Telegram token is required for Telegram adapter");
  }

  const log = logger.child({ channel: "telegram", identityId: identity.id });
  log.debug({ tokenPresent: true }, "telegram adapter init");
  const bot = new Bot(token);

  bot.catch((err: BotError<Context>) => {
    log.error({ error: err.error }, "telegram bot error");
  });

  bot.on("message", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg?.chat) return;

    const chatType = msg.chat.type as string;
    const isGroup = chatType === "group" || chatType === "supergroup" || chatType === "channel";
    
    // In groups, check if groups are enabled
    if (isGroup && !config.groupsEnabled) {
      log.debug({ chatId: msg.chat.id, chatType }, "telegram message ignored (groups disabled)");
      return;
    }

    let text = msg.text ?? msg.caption ?? "";
    if (!text.trim()) return;

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
      if (!text) {
        log.debug({ chatId: msg.chat.id }, "telegram message ignored (empty after removing mention)");
        return;
      }
    }

    log.debug(
      { chatId: msg.chat.id, chatType, isGroup, length: text.length, preview: text.slice(0, 120) },
      "telegram message received",
    );

    try {
      await onMessage({
        channel: "telegram",
        identityId: identity.id,
        peerId: String(msg.chat.id),
        text,
        raw: msg,
      });
    } catch (error) {
      log.error({ error, peerId: msg.chat.id }, "telegram inbound handler failed");
    }
  });

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
    async sendText(peerId: string, text: string) {
      const chatId = parseTelegramPeerId(peerId);
      if (chatId === null) {
        const error = new Error(
          "Telegram peerId must be a numeric chat_id. Usernames like @name are not valid direct targets.",
        ) as Error & { status?: number };
        error.status = 400;
        throw error;
      }
      await bot.api.sendMessage(chatId, text);
    },
  };
}
