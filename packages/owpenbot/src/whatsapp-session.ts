import fs from "node:fs";
import path from "node:path";

import {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import type { Logger } from "pino";

const CREDS_FILE = "creds.json";
const CREDS_BACKUP = "creds.json.bak";
const DEFAULT_TIMEOUT_MS = 120_000;

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

let credsSaveQueue: Promise<void> = Promise.resolve();

function readCredsRaw(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function isValidJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function backupCreds(authDir: string, logger: Logger) {
  try {
    const credsPath = path.join(authDir, CREDS_FILE);
    const backupPath = path.join(authDir, CREDS_BACKUP);
    const raw = readCredsRaw(credsPath);
    if (!raw || !isValidJson(raw)) return;
    fs.copyFileSync(credsPath, backupPath);
  } catch (error) {
    logger.warn({ error }, "whatsapp creds backup failed");
  }
}

function maybeRestoreCreds(authDir: string, logger: Logger) {
  try {
    const credsPath = path.join(authDir, CREDS_FILE);
    const backupPath = path.join(authDir, CREDS_BACKUP);
    const raw = readCredsRaw(credsPath);
    if (raw && isValidJson(raw)) return;
    const backupRaw = readCredsRaw(backupPath);
    if (!backupRaw || !isValidJson(backupRaw)) return;
    fs.copyFileSync(backupPath, credsPath);
    logger.warn({ credsPath }, "restored whatsapp creds from backup");
  } catch (error) {
    logger.warn({ error }, "whatsapp creds restore failed");
  }
}

function enqueueSaveCreds(authDir: string, saveCreds: () => Promise<void> | void, logger: Logger) {
  credsSaveQueue = credsSaveQueue
    .then(async () => {
      backupCreds(authDir, logger);
      await Promise.resolve(saveCreds());
    })
    .catch((error) => {
      logger.warn({ error }, "whatsapp creds save failed");
    });
}

export function hasWhatsAppCreds(authDir: string): boolean {
  const raw = readCredsRaw(path.join(authDir, CREDS_FILE));
  if (!raw) return false;
  return isValidJson(raw);
}

export function getStatusCode(error: unknown): number | undefined {
  return (
    (error as { output?: { statusCode?: number } })?.output?.statusCode ??
    (error as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode ??
    (error as { status?: number })?.status
  );
}

export async function createWhatsAppSocket(options: {
  authDir: string;
  logger: Logger;
  printQr?: boolean;
  onStatus?: (message: string) => void;
  onQr?: (qr: string) => void;
}): Promise<WhatsAppSocket> {
  const { authDir, logger, printQr, onStatus, onQr } = options;
  ensureDir(authDir);
  maybeRestoreCreds(authDir, logger);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    browser: ["owpenbot", "cli", "0.1.0"],
  });

  sock.ev.on("creds.update", () => enqueueSaveCreds(authDir, saveCreds, logger));
  sock.ev.on(
    "connection.update",
    (update: Partial<import("@whiskeysockets/baileys").ConnectionState>) => {
      if (update.qr) {
        onQr?.(update.qr);
        if (printQr) {
          qrcode.generate(update.qr, { small: true });
          onStatus?.("Scan the QR code to connect WhatsApp.");
        }
      }
      if (update.connection === "open") {
        onStatus?.("WhatsApp connected.");
      }
    },
  );

  sock.ws?.on?.("error", (error: Error) => {
    logger.error({ error }, "whatsapp websocket error");
  });

  return sock;
}

export function closeWhatsAppSocket(sock: WhatsAppSocket) {
  try {
    sock.ws?.close();
  } catch {
    // ignore
  }
  try {
    sock.end?.(undefined);
  } catch {
    // ignore
  }
}

export function waitForWhatsAppConnection(
  sock: WhatsAppSocket,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const ev = sock.ev as unknown as {
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    };

    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      ev.off?.("connection.update", handler);
      ev.removeListener?.("connection.update", handler);
      if (timer) clearTimeout(timer);
    };

    const handler = (...args: unknown[]) => {
      const update = (args[0] ?? {}) as Partial<import("@whiskeysockets/baileys").ConnectionState>;
      if (update.connection === "open") {
        cleanup();
        resolve();
        return;
      }
      if (update.connection === "close") {
        cleanup();
        reject(update.lastDisconnect ?? new Error("Connection closed"));
      }
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for WhatsApp connection"));
      }, timeoutMs);
    }

    sock.ev.on("connection.update", handler);
  });
}
