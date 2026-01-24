import fs from "node:fs";
import path from "node:path";

import { DisconnectReason, isJidGroup, type WAMessage } from "@whiskeysockets/baileys";
import type { Logger } from "pino";

import type { Config } from "./config.js";
import {
  closeWhatsAppSocket,
  createWhatsAppSocket,
  getStatusCode,
  hasWhatsAppCreds,
  waitForWhatsAppConnection,
  type WhatsAppSocket,
} from "./whatsapp-session.js";

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
const SENT_MESSAGE_TTL_MS = 10 * 60_000;

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

export function createWhatsAppAdapter(
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  opts: { printQr?: boolean; onStatus?: (message: string) => void } = {},
): WhatsAppAdapter {
  let socket: WhatsAppSocket | null = null;
  let stopped = false;
  let connecting = false;
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const sentMessageIds = new Map<string, number>();

  const log = logger.child({ channel: "whatsapp" });
  const authDir = path.resolve(config.whatsappAuthDir);

  const reconnectPolicy = {
    initialMs: 1500,
    maxMs: 30_000,
    factor: 1.6,
    jitter: 0.25,
    maxAttempts: 10,
  };

  const computeDelay = (attempt: number) => {
    const base = reconnectPolicy.initialMs * Math.pow(reconnectPolicy.factor, Math.max(0, attempt - 1));
    const capped = Math.min(base, reconnectPolicy.maxMs);
    const jitter = capped * reconnectPolicy.jitter * (Math.random() * 2 - 1);
    return Math.max(250, Math.round(capped + jitter));
  };

  const resetReconnect = () => {
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = (statusCode?: number) => {
    if (stopped || reconnectTimer) return;
    reconnectAttempts += 1;
    if (reconnectAttempts > reconnectPolicy.maxAttempts) {
      log.warn({ attempts: reconnectAttempts }, "whatsapp reconnect attempts exhausted");
      opts.onStatus?.("WhatsApp reconnect attempts exhausted. Run: owpenwork whatsapp login.");
      return;
    }
    const delayMs = statusCode === 515 ? 1000 : computeDelay(reconnectAttempts);
    log.warn({ delayMs, statusCode }, "whatsapp reconnect scheduled");
    opts.onStatus?.(`WhatsApp reconnecting in ${Math.round(delayMs / 1000)}s...`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect({ printQr: false });
    }, delayMs);
  };

  const recordSentMessage = (messageId?: string | null) => {
    if (!messageId) return;
    sentMessageIds.set(messageId, Date.now());
  };

  const pruneSentMessages = () => {
    const now = Date.now();
    for (const [id, timestamp] of sentMessageIds) {
      if (now - timestamp > SENT_MESSAGE_TTL_MS) {
        sentMessageIds.delete(id);
      }
    }
  };

  async function connect(options: { printQr?: boolean } = {}) {
    if (stopped || connecting) return;
    connecting = true;
    try {
      if (socket) {
        closeWhatsAppSocket(socket);
        socket = null;
      }
      const sock = await createWhatsAppSocket({
        authDir,
        logger: log,
        printQr: options.printQr ?? opts.printQr,
        onStatus: opts.onStatus,
      });

      sock.ev.on(
        "connection.update",
        (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
          if (update.connection === "open") {
            resetReconnect();
          }
          if (update.connection === "close") {
            const statusCode = getStatusCode(
              (update.lastDisconnect as { error?: unknown } | undefined)?.error ?? update.lastDisconnect,
            );
            if (statusCode === DisconnectReason.loggedOut) {
              log.warn("whatsapp logged out, run 'owpenbot whatsapp login'");
              opts.onStatus?.("WhatsApp logged out. Run: owpenwork whatsapp login.");
              return;
            }
            if (statusCode === 515) {
              opts.onStatus?.("WhatsApp asked for a restart; reconnecting.");
            }
            scheduleReconnect(statusCode);
          }
        },
      );

      sock.ev.on("messages.upsert", async ({ messages }: { messages: WAMessage[] }) => {
        pruneSentMessages();
        for (const msg of messages) {
          if (!msg.message) continue;
          const fromMe = Boolean(msg.key.fromMe);
          const messageId = msg.key.id;
          if (fromMe && messageId && sentMessageIds.has(messageId)) {
            sentMessageIds.delete(messageId);
            continue;
          }
          if (fromMe && !config.whatsappSelfChatMode) continue;
          const peerId = msg.key.remoteJid;
          if (!peerId) continue;
          if (isJidGroup(peerId) && !config.groupsEnabled) {
            continue;
          }
          const text = extractText(msg);
          if (!text.trim()) continue;

          try {
            await onMessage({
              channel: "whatsapp",
              peerId,
              text,
              raw: msg,
              fromMe,
            });
          } catch (error) {
            log.error({ error, peerId }, "whatsapp inbound handler failed");
          }
        }
      });

      socket = sock;
    } finally {
      connecting = false;
    }
  }

  return {
    name: "whatsapp",
    maxTextLength: MAX_TEXT_LENGTH,
    async start() {
      await connect();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        closeWhatsAppSocket(socket);
        socket = null;
      }
    },
    async sendText(peerId: string, text: string) {
      if (!socket) throw new Error("WhatsApp socket not initialized");
      const sent = await socket.sendMessage(peerId, { text });
      recordSentMessage(sent?.key?.id);
    },
  };
}

export async function loginWhatsApp(
  config: Config,
  logger: Logger,
  options: { onStatus?: (message: string) => void; timeoutMs?: number } = {},
) {
  const authDir = path.resolve(config.whatsappAuthDir);
  const log = logger.child({ channel: "whatsapp" });
  const timeoutMs = options.timeoutMs ?? 120_000;

  const attemptLogin = async (phase: "initial" | "restart", printQr: boolean) => {
    const sock = await createWhatsAppSocket({
      authDir,
      logger: log,
      printQr,
      onStatus: options.onStatus,
    });
    try {
      if (phase === "initial") {
        options.onStatus?.("Waiting for WhatsApp scan...");
      } else {
        options.onStatus?.("Reconnecting WhatsApp session...");
      }
      await waitForWhatsAppConnection(sock, { timeoutMs });
      options.onStatus?.("WhatsApp linked.");
      return { ok: true } as const;
    } catch (error) {
      const statusCode = getStatusCode(error);
      return { ok: false, error, statusCode } as const;
    } finally {
      setTimeout(() => closeWhatsAppSocket(sock), 500);
    }
  };

  const initial = await attemptLogin("initial", true);
  if (initial.ok) return;

  if (initial.statusCode === DisconnectReason.loggedOut) {
    options.onStatus?.("WhatsApp logged out. Run: owpenwork whatsapp login.");
    throw new Error("WhatsApp logged out");
  }

  const shouldRetry =
    initial.statusCode === 515 || (initial.statusCode === undefined && hasWhatsAppCreds(authDir));

  if (shouldRetry) {
    options.onStatus?.("WhatsApp asked for a restart; retrying connection...");
    const retry = await attemptLogin("restart", false);
    if (retry.ok) return;
    if (retry.statusCode === DisconnectReason.loggedOut) {
      options.onStatus?.("WhatsApp logged out. Run: owpenwork whatsapp login.");
    }
    throw new Error(`WhatsApp login failed after restart: ${String(retry.error)}`);
  }

  if (!initial.statusCode && !hasWhatsAppCreds(authDir)) {
    options.onStatus?.("Timed out waiting for QR scan. Run login again for a fresh QR.");
  }

  throw new Error(`WhatsApp login failed: ${String(initial.error)}`);
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
