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

  const bot = new Bot(config.telegramToken);

  bot.catch((err: BotError<Context>) => {
    logger.error({ error: err.error }, "telegram bot error");
  });

  bot.on("message", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg?.chat) return;

    const chatType = msg.chat.type as string;
    const isGroup = chatType === "group" || chatType === "supergroup" || chatType === "channel";
    if (isGroup && !config.groupsEnabled) {
      return;
    }

    const text = msg.text ?? msg.caption ?? "";
    if (!text.trim()) return;

    await onMessage({
      channel: "telegram",
      peerId: String(msg.chat.id),
      text,
      raw: msg,
    });
  });

  return {
    name: "telegram",
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
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
