import { Bot, type BotError, type Context } from "grammy";
import type { Logger } from "pino";

import type { Config } from "./config.js";

export type InboundMessage = {
  channel: "telegram";
  peerId: string;
  text: string;
  raw: unknown;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type TelegramAdapter = {
  name: "telegram";
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(peerId: string, text: string): Promise<void>;
};

const MAX_TEXT_LENGTH = 4096;

export function createTelegramAdapter(
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
): TelegramAdapter {
  if (!config.telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for Telegram adapter");
  }

  logger.debug({ tokenPresent: true }, "telegram adapter init");
  const bot = new Bot(config.telegramToken);

  bot.catch((err: BotError<Context>) => {
    logger.error({ error: err.error }, "telegram bot error");
  });

  bot.on("message", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg?.chat) return;

    const chatType = msg.chat.type as string;
    const isGroup = chatType === "group" || chatType === "supergroup" || chatType === "channel";
    
    // In groups, check if groups are enabled
    if (isGroup && !config.groupsEnabled) {
      logger.debug({ chatId: msg.chat.id, chatType }, "telegram message ignored (groups disabled)");
      return;
    }

    let text = msg.text ?? msg.caption ?? "";
    if (!text.trim()) return;

    // In groups, only respond if the bot is @mentioned
    if (isGroup) {
      const botUsername = ctx.me?.username;
      if (!botUsername) {
        logger.debug({ chatId: msg.chat.id }, "telegram message ignored (bot username unknown)");
        return;
      }
      
      const mentionPattern = new RegExp(`@${botUsername}\\b`, "i");
      if (!mentionPattern.test(text)) {
        logger.debug({ chatId: msg.chat.id, botUsername }, "telegram message ignored (not mentioned)");
        return;
      }
      
      // Strip the @mention from the message
      text = text.replace(mentionPattern, "").trim();
      if (!text) {
        logger.debug({ chatId: msg.chat.id }, "telegram message ignored (empty after removing mention)");
        return;
      }
    }

    logger.debug(
      { chatId: msg.chat.id, chatType, isGroup, length: text.length, preview: text.slice(0, 120) },
      "telegram message received",
    );

    try {
      await onMessage({
        channel: "telegram",
        peerId: String(msg.chat.id),
        text,
        raw: msg,
      });
    } catch (error) {
      logger.error({ error, peerId: msg.chat.id }, "telegram inbound handler failed");
    }
  });

  return {
    name: "telegram",
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      logger.debug("telegram adapter starting");
      await bot.start();
      logger.info("telegram adapter started");
    },
    async stop() {
      bot.stop();
      logger.info("telegram adapter stopped");
    },
    async sendText(peerId: string, text: string) {
      await bot.api.sendMessage(Number(peerId), text);
    },
  };
}
