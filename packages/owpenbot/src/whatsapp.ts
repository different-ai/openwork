import fs from "node:fs";
import path from "node:path";

import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import type { Logger } from "pino";

import type { Config } from "./config.js";

export type InboundMessage = {
  channel: "whatsapp";
  peerId: string;
  text: string;
  raw: unknown;
  fromMe?: boolean;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type WhatsAppAdapter = {
  name: "whatsapp";
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(peerId: string, text: string): Promise<void>;
};

const MAX_TEXT_LENGTH = 3800;

function extractText(message: WAMessage): string {
  const content = message.message;
  if (!content) return "";
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ""
  );
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function createWhatsAppAdapter(
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  opts: { printQr?: boolean } = {},
): WhatsAppAdapter {
  let socket: ReturnType<typeof makeWASocket> | null = null;
  let stopped = false;

  const log = logger.child({ channel: "whatsapp" });
  const authDir = path.resolve(config.whatsappAuthDir);
  ensureDir(authDir);

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log),
      },
      version,
      logger: log,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      browser: ["owpenbot", "cli", "0.1.0"],
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update: { connection?: string; lastDisconnect?: unknown; qr?: string }) => {
      if (update.qr && opts.printQr) {
        qrcode.generate(update.qr, { small: true });
        log.info("scan the QR code to connect WhatsApp");
      }

      if (update.connection === "open") {
        log.info("whatsapp connected");
      }

      if (update.connection === "close") {
        const lastDisconnect = update.lastDisconnect as
          | { error?: { output?: { statusCode?: number } } }
          | undefined;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect && !stopped) {
          log.warn("whatsapp connection closed, reconnecting");
          void connect();
        } else if (!shouldReconnect) {
          log.warn("whatsapp logged out, run 'owpenbot whatsapp login'");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }: { messages: WAMessage[] }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const fromMe = Boolean(msg.key.fromMe);
        if (fromMe && !config.whatsappSelfChatMode) continue;
        const peerId = msg.key.remoteJid;
        if (!peerId) continue;
        if (isJidGroup(peerId) && !config.groupsEnabled) {
          continue;
        }
        const text = extractText(msg);
        if (!text.trim()) continue;

        await onMessage({
          channel: "whatsapp",
          peerId,
          text,
          raw: msg,
          fromMe,
        });
      }
    });

    socket = sock;
  }

  return {
    name: "whatsapp",
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      await connect();
    },
    async stop() {
      stopped = true;
      if (socket) {
        socket.end(undefined);
        socket = null;
      }
    },
    async sendText(peerId: string, text: string) {
      if (!socket) throw new Error("WhatsApp socket not initialized");
      await socket.sendMessage(peerId, { text });
    },
  };
}

export async function loginWhatsApp(config: Config, logger: Logger) {
  const authDir = path.resolve(config.whatsappAuthDir);
  ensureDir(authDir);
  const log = logger.child({ channel: "whatsapp" });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  await new Promise<void>((resolve) => {
    let finished = false;
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log),
      },
      version,
      logger: log,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      browser: ["owpenbot", "cli", "0.1.0"],
    });

    const finish = (reason: string) => {
      if (finished) return;
      finished = true;
      log.info({ reason }, "whatsapp login finished");
      sock.end(undefined);
      resolve();
    };

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      if (state.creds?.registered) {
        finish("creds.registered");
      }
    });
    sock.ev.on("connection.update", (update: { connection?: string; qr?: string }) => {
      if (update.qr) {
        qrcode.generate(update.qr, { small: true });
        log.info("scan the QR code to connect WhatsApp");
      }

      if (update.connection === "open") {
        finish("connection.open");
      }

      if (update.connection === "close" && state.creds?.registered) {
        finish("connection.close.registered");
      }
    });
  });
}

export function unpairWhatsApp(config: Config, logger: Logger) {
  const authDir = path.resolve(config.whatsappAuthDir);
  if (!fs.existsSync(authDir)) {
    logger.info({ authDir }, "whatsapp auth directory not found");
    return;
  }
  fs.rmSync(authDir, { recursive: true, force: true });
  logger.info({ authDir }, "whatsapp auth cleared; run owpenbot to re-pair");
}
