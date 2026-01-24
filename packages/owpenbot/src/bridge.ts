import { setTimeout as delay } from "node:timers/promises";

import type { Logger } from "pino";

import type { Config, ChannelName } from "./config.js";
import { BridgeStore } from "./db.js";
import { normalizeEvent } from "./events.js";
import { startHealthServer, type HealthSnapshot } from "./health.js";
import { buildPermissionRules, createClient } from "./opencode.js";
import { resolvePairingCode } from "./pairing.js";
import { chunkText, formatInputSummary, truncateText } from "./text.js";
import { createTelegramAdapter } from "./telegram.js";
import { createWhatsAppAdapter } from "./whatsapp.js";

type Adapter = {
  name: ChannelName;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(peerId: string, text: string): Promise<void>;
};

type InboundMessage = {
  channel: ChannelName;
  peerId: string;
  text: string;
  raw: unknown;
};

type RunState = {
  sessionID: string;
  channel: ChannelName;
  peerId: string;
  toolUpdatesEnabled: boolean;
  seenToolStates: Map<string, string>;
};

const TOOL_LABELS: Record<string, string> = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  patch: "patch",
  multiedit: "edit",
  grep: "grep",
  glob: "glob",
  task: "agent",
  webfetch: "webfetch",
};

export async function startBridge(config: Config, logger: Logger) {
  const client = createClient(config);
  const store = new BridgeStore(config.dbPath);
  store.seedAllowlist("telegram", config.allowlist.telegram);
  store.seedAllowlist("whatsapp", config.allowlist.whatsapp);

  const pairingCode = resolvePairingCode(store, config.pairingCode);
  logger.info({ pairingCode }, "pairing code ready");

  const adapters = new Map<ChannelName, Adapter>();
  if (config.telegramEnabled && config.telegramToken) {
    adapters.set("telegram", createTelegramAdapter(config, logger, handleInbound));
  } else {
    logger.info("telegram adapter disabled");
  }

  if (config.whatsappEnabled) {
    adapters.set("whatsapp", createWhatsAppAdapter(config, logger, handleInbound, { printQr: true }));
  } else {
    logger.info("whatsapp adapter disabled");
  }

  const sessionQueue = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, RunState>();

  // Simple in-memory rate limiting for pairing attempts per peer.
  const pairingAttempts = new Map<
    string,
    { windowStart: number; count: number; blockedUntil?: number }
  >();
  const PAIRING_WINDOW_MS = 60_000;
  const PAIRING_MAX_ATTEMPTS = 20;
  const PAIRING_BLOCK_MS = 5 * 60_000;

  let opencodeHealthy = false;
  let opencodeVersion: string | undefined;

  async function refreshHealth() {
    try {
      const health = await client.global.health();
      opencodeHealthy = Boolean((health as { healthy?: boolean }).healthy);
      opencodeVersion = (health as { version?: string }).version;
    } catch (error) {
      logger.warn({ error }, "failed to reach opencode health");
      opencodeHealthy = false;
    }
  }

  await refreshHealth();
  const healthTimer = setInterval(refreshHealth, 30_000);

  let stopHealthServer: (() => void) | null = null;
  if (config.healthPort) {
    stopHealthServer = startHealthServer(
      config.healthPort,
      (): HealthSnapshot => ({
        ok: opencodeHealthy,
        opencode: {
          url: config.opencodeUrl,
          healthy: opencodeHealthy,
          version: opencodeVersion,
        },
        channels: {
          telegram: adapters.has("telegram"),
          whatsapp: adapters.has("whatsapp"),
        },
      }),
      logger,
    );
  }

  const eventAbort = new AbortController();
  void (async () => {
    const subscription = await client.event.subscribe(undefined, { signal: eventAbort.signal });
    for await (const raw of subscription.stream as AsyncIterable<unknown>) {
      const event = normalizeEvent(raw as any);
      if (!event) continue;

      if (event.type === "message.part.updated") {
        const part = (event.properties as { part?: any })?.part;
        if (!part?.sessionID) continue;
        const run = activeRuns.get(part.sessionID);
        if (!run || !run.toolUpdatesEnabled) continue;
        if (part.type !== "tool") continue;

        const callId = part.callID as string | undefined;
        if (!callId) continue;
        const state = part.state as { status?: string; input?: Record<string, unknown>; output?: string; title?: string };
        const status = state?.status ?? "unknown";
        if (run.seenToolStates.get(callId) === status) continue;
        run.seenToolStates.set(callId, status);

        const label = TOOL_LABELS[part.tool] ?? part.tool;
        const title = state.title || truncateText(formatInputSummary(state.input ?? {}), 120) || "running";
        let message = `[tool] ${label} ${status}: ${title}`;

        if (status === "completed" && state.output) {
          const output = truncateText(state.output.trim(), config.toolOutputLimit);
          if (output) message += `\n${output}`;
        }

        await sendText(run.channel, run.peerId, message);
      }

      if (event.type === "permission.asked") {
        const permission = event.properties as { id?: string; sessionID?: string };
        if (!permission?.id || !permission.sessionID) continue;

        // In conservative modes (deny, readonly), automatically reject permission
        // requests so tools cannot elevate beyond the configured ruleset.
        const response = config.permissionMode === "allow" ? "always" : "reject";

        await client.permission.respond({
          sessionID: permission.sessionID,
          permissionID: permission.id,
          response,
        });

        if (response === "reject") {
          const run = activeRuns.get(permission.sessionID);
          if (run) {
            await sendText(
              run.channel,
              run.peerId,
              "Permission denied. Update configuration to allow tools.",
            );
          }
        }
      }
    }
  })().catch((error) => {
    logger.error({ error }, "event stream closed");
  });

  async function sendText(channel: ChannelName, peerId: string, text: string) {
    const adapter = adapters.get(channel);
    if (!adapter) return;
    const chunks = chunkText(text, adapter.maxTextLength);
    for (const chunk of chunks) {
      logger.info({ channel, peerId, length: chunk.length }, "sending message");
      await adapter.sendText(peerId, chunk);
    }
  }

  async function handleInbound(message: InboundMessage) {
    const adapter = adapters.get(message.channel);
    if (!adapter) return;
    let inbound = message;
    logger.info(
      { channel: inbound.channel, peerId: inbound.peerId, length: inbound.text.length },
      "received message",
    );

    const allowed = store.isAllowed(inbound.channel, inbound.peerId);
    if (!allowed) {
      const key = `${inbound.channel}:${inbound.peerId}`;
      const now = Date.now();
      const current = pairingAttempts.get(key);

      if (current?.blockedUntil && now < current.blockedUntil) {
        const remainingSeconds = Math.ceil((current.blockedUntil - now) / 1000);
        await sendText(
          inbound.channel,
          inbound.peerId,
          `Too many pairing attempts. Try again in ${remainingSeconds} seconds.`,
        );
        return;
      }

      const withinWindow = current && now - current.windowStart < PAIRING_WINDOW_MS;
      const count = withinWindow ? current.count + 1 : 1;
      const updated: { windowStart: number; count: number; blockedUntil?: number } = {
        windowStart: withinWindow ? current!.windowStart : now,
        count,
      };

      if (count > PAIRING_MAX_ATTEMPTS) {
        updated.blockedUntil = now + PAIRING_BLOCK_MS;
      }

      pairingAttempts.set(key, updated);

      if (updated.blockedUntil && now < updated.blockedUntil) {
        const remainingSeconds = Math.ceil((updated.blockedUntil - now) / 1000);
        await sendText(
          inbound.channel,
          inbound.peerId,
          `Too many pairing attempts. Try again in ${remainingSeconds} seconds.`,
        );
        return;
      }

      const trimmed = inbound.text.trim();
      if (trimmed.includes(pairingCode)) {
        store.allowPeer(inbound.channel, inbound.peerId);
        const remaining = trimmed.replace(pairingCode, "").trim();
        if (remaining) {
          await sendText(inbound.channel, inbound.peerId, "Paired. Processing your message.");
        } else {
          await sendText(inbound.channel, inbound.peerId, "Paired. Send your message again.");
          return;
        }
        inbound = { ...inbound, text: remaining };
      } else {
        await sendText(
          inbound.channel,
          inbound.peerId,
          "Pairing required. Reply with your pairing code.",
        );
        return;
      }
    }

    const session = store.getSession(inbound.channel, inbound.peerId);
    const sessionID = session?.session_id ?? (await createSession(inbound));

    enqueue(sessionID, async () => {
      const runState: RunState = {
        sessionID,
        channel: inbound.channel,
        peerId: inbound.peerId,
        toolUpdatesEnabled: config.toolUpdatesEnabled,
        seenToolStates: new Map(),
      };
      activeRuns.set(sessionID, runState);
      try {
        const response = await client.session.prompt({
          sessionID,
          parts: [{ type: "text", text: inbound.text }],
        });
        const parts = (response as { parts?: Array<{ type?: string; text?: string; ignored?: boolean }> }).parts ?? [];
        const reply = parts
          .filter((part) => part.type === "text" && !part.ignored)
          .map((part) => part.text ?? "")
          .join("\n")
          .trim();

        if (reply) {
          await sendText(inbound.channel, inbound.peerId, reply);
        } else {
          await sendText(inbound.channel, inbound.peerId, "No response generated. Try again.");
        }
      } catch (error) {
        logger.error({ error }, "prompt failed");
        await sendText(inbound.channel, inbound.peerId, "Error: failed to reach OpenCode.");
      } finally {
        activeRuns.delete(sessionID);
      }
    });
  }

  async function createSession(message: InboundMessage): Promise<string> {
    const title = `owpenbot ${message.channel} ${message.peerId}`;
    const session = await client.session.create({
      title,
      permission: buildPermissionRules(config.permissionMode),
    });
    const sessionID = (session as { id?: string }).id;
    if (!sessionID) throw new Error("Failed to create session");
    store.upsertSession(message.channel, message.peerId, sessionID);
    logger.info({ sessionID, channel: message.channel, peerId: message.peerId }, "session created");
    return sessionID;
  }

  function enqueue(sessionID: string, task: () => Promise<void>) {
    const previous = sessionQueue.get(sessionID) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error) => {
        logger.error({ error }, "session task failed");
      })
      .finally(() => {
        if (sessionQueue.get(sessionID) === next) {
          sessionQueue.delete(sessionID);
        }
      });
    sessionQueue.set(sessionID, next);
  }

  for (const adapter of adapters.values()) {
    await adapter.start();
  }

  logger.info({ channels: Array.from(adapters.keys()) }, "bridge started");

  return {
    async stop() {
      eventAbort.abort();
      clearInterval(healthTimer);
      if (stopHealthServer) stopHealthServer();
      for (const adapter of adapters.values()) {
        await adapter.stop();
      }
      store.close();
      await delay(50);
    },
  };
}
