import type { Logger } from "pino";

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

import type { Config, SlackIdentity } from "./config.js";

export type InboundMessage = {
  channel: "slack";
  identityId: string;
  peerId: string;
  text: string;
  raw: unknown;
};

export type MessageHandler = (message: InboundMessage) => Promise<void> | void;

export type SlackAdapter = {
  name: "slack";
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
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
};

export function createSlackAdapter(
  identity: SlackIdentity,
  config: Config,
  logger: Logger,
  onMessage: MessageHandler,
  deps: SlackDeps = { WebClient, SocketModeClient },
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

  const safeAck = async (ack: unknown) => {
    if (typeof ack !== "function") return;
    try {
      await ack();
    } catch (error) {
      log.warn({ error }, "slack ack failed");
    }
  };

  const shouldIgnore = (event: SlackEvent): { ok: true } | { ok: false; channelId: string; textRaw: string; userId: string | null } => {
    const channelId = typeof event.channel === "string" ? event.channel : "";
    const textRaw = typeof event.text === "string" ? event.text : "";
    const userId = typeof event.user === "string" ? event.user : null;
    const botId = typeof event.bot_id === "string" ? event.bot_id : null;
    const subtype = typeof event.subtype === "string" ? event.subtype : null;

    // Avoid loops / non-user messages.
    if (botId) return { ok: true };
    if (subtype && subtype !== "") return { ok: true };
    if (userId && botUserId && userId === botUserId) return { ok: true };
    if (!channelId || !textRaw.trim()) return { ok: true };

    return { ok: false, channelId, textRaw, userId };
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

    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
    const peerId = formatSlackPeerId({ channelId: filtered.channelId, ...(threadTs ? { threadTs } : {}) });

    try {
      await onMessage({
        channel: "slack",
        identityId: identity.id,
        peerId,
        text: filtered.textRaw.trim(),
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

    const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
    const ts = typeof event.ts === "string" ? event.ts : null;
    const rootThread = threadTs || ts;
    const peerId = formatSlackPeerId({ channelId: filtered.channelId, ...(rootThread ? { threadTs: rootThread } : {}) });
    const text = stripSlackMention(filtered.textRaw, botUserId);
    if (!text) return;

    try {
      await onMessage({
        channel: "slack",
        identityId: identity.id,
        peerId,
        text,
        raw: event,
      });
    } catch (error) {
      log.error({ error, peerId }, "slack inbound handler failed");
    }
  });

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
    async sendText(peerId: string, text: string) {
      const peer = parseSlackPeerId(peerId);
      if (!peer.channelId) throw new Error("Invalid Slack peerId");

      const payload: Record<string, unknown> = {
        channel: peer.channelId,
        text,
      };
      if (peer.threadTs) payload.thread_ts = peer.threadTs;
      await web.chat.postMessage(payload as any);
    },
  };
}
