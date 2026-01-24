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
  opts: { printQr?: boolean; onStatus?: (message: string) => void } = {},
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
        opts.onStatus?.("Scan the QR code to connect WhatsApp.");
      }

      if (update.connection === "open") {
        log.info("whatsapp connected");
        opts.onStatus?.("WhatsApp connected.");
      }

      if (update.connection === "close") {
        const lastDisconnect = update.lastDisconnect as
          | { error?: { output?: { statusCode?: number } } }
          | undefined;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === 515 && !stopped) {
          log.warn("whatsapp stream error; restarting connection");
          opts.onStatus?.("WhatsApp stream error; reconnecting.");
          setTimeout(() => {
            void connect();
          }, 1000);
          return;
        }
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect && !stopped) {
          log.warn("whatsapp connection closed, reconnecting");
          opts.onStatus?.("WhatsApp connection closed; reconnecting.");
          void connect();
        } else if (!shouldReconnect) {
          log.warn("whatsapp logged out, run 'owpenbot whatsapp login'");
          opts.onStatus?.("WhatsApp logged out. Run: owpenwork whatsapp login.");
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

export async function loginWhatsApp(
  config: Config,
  logger: Logger,
  options: { onStatus?: (message: string) => void } = {},
) {
  const authDir = path.resolve(config.whatsappAuthDir);
  ensureDir(authDir);
  const log = logger.child({ channel: "whatsapp" });
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const credsPath = path.join(authDir, "creds.json");
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await new Promise<"linked" | "restart">((resolve) => {
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

      const finish = (reason: string, status: "linked" | "restart") => {
        if (finished) return;
        finished = true;
        log.info({ reason }, "whatsapp login finished");
        sock.end(undefined);
        resolve(status);
      };

      sock.ev.on("creds.update", async () => {
        await saveCreds();
        if (state.creds?.registered) {
          finish("creds.registered", "linked");
        }
      });
      sock.ev.on("connection.update", (update: { connection?: string; qr?: string; lastDisconnect?: unknown }) => {
        if (update.qr) {
          qrcode.generate(update.qr, { small: true });
          log.info("scan the QR code to connect WhatsApp");
          options.onStatus?.("Scan the QR code to connect WhatsApp.");
        }

        if (update.connection === "open") {
          options.onStatus?.("WhatsApp linked.");
          finish("connection.open", "linked");
        }

        if (update.connection === "close") {
          const lastDisconnect = update.lastDisconnect as
            | { error?: { output?: { statusCode?: number } } }
            | undefined;
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode === 515) {
            if (state.creds?.registered || fs.existsSync(credsPath)) {
              log.info("whatsapp login requires reconnect; completing login");
              options.onStatus?.("WhatsApp login requires reconnect; completing login.");
              finish("connection.restart.required", "linked");
            } else {
              log.warn("whatsapp restart requested before creds registered");
              options.onStatus?.("WhatsApp login needs another scan.");
              finish("connection.restart.required", "restart");
            }
            return;
          }
          if (state.creds?.registered) {
            options.onStatus?.("WhatsApp linked.");
            finish("connection.close.registered", "linked");
          }
        }
      });
    });

    if (result === "linked") {
      return;
    }

    if (attempt < maxAttempts) {
      log.warn("retrying whatsapp login after restart");
      options.onStatus?.("Retrying WhatsApp login...");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  throw new Error("WhatsApp login failed after restart");
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
