import { setTimeout as delay } from "node:timers/promises";

import type { Logger } from "pino";

import type { Config, ChannelName } from "./config.js";
import { normalizeWhatsAppId } from "./config.js";
import { BridgeStore } from "./db.js";
import { normalizeEvent } from "./events.js";
import { startHealthServer, type HealthSnapshot } from "./health.js";
import { buildPermissionRules, createClient } from "./opencode.js";
import { chunkText, formatInputSummary, truncateText } from "./text.js";
import { createTelegramAdapter } from "./telegram.js";
import { createWhatsAppAdapter } from "./whatsapp.js";

   type Adapter = {
  name: ChannelName;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(peerId: string, text: string): Promise<void>;
  sendFile?: (peerId: string, filePath: string, caption?: string) => Promise<void>;
  sendTyping?: (peerId: string) => Promise<void>;
};

type OutboundKind = "reply" | "system" | "tool";

export type BridgeReporter = {
  onStatus?: (message: string) => void;
  onInbound?: (message: { channel: ChannelName; peerId: string; text: string; fromMe?: boolean }) => void;
  onOutbound?: (message: { channel: ChannelName; peerId: string; text: string; kind: OutboundKind }) => void;
};

type InboundMessage = {
  channel: ChannelName;
  peerId: string;
  text: string;
  raw: unknown;
  fromMe?: boolean;
};

type ModelRef = {
  providerID: string;
  modelID: string;
};

type RunState = {
  sessionID: string;
  channel: ChannelName;
  peerId: string;
  toolUpdatesEnabled: boolean;
  seenToolStates: Map<string, string>;
  thinkingLabel?: string;
  thinkingActive?: boolean;
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

const CHANNEL_LABELS: Record<ChannelName, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

const TYPING_INTERVAL_MS = 6000;

export async function startBridge(config: Config, logger: Logger, reporter?: BridgeReporter) {
  const reportStatus = reporter?.onStatus;
  const client = createClient(config);
  const store = new BridgeStore(config.dbPath);
  store.seedAllowlist("telegram", config.allowlist.telegram);
  store.seedAllowlist(
    "whatsapp",
    [...config.whatsappAllowFrom].filter((entry) => entry !== "*"),
  );
  store.prunePairingRequests();

  logger.debug(
    {
      configPath: config.configPath,
      opencodeUrl: config.opencodeUrl,
      opencodeDirectory: config.opencodeDirectory,
      telegramEnabled: config.telegramEnabled,
      telegramTokenPresent: Boolean(config.telegramToken),
      whatsappEnabled: config.whatsappEnabled,
      groupsEnabled: config.groupsEnabled,
      permissionMode: config.permissionMode,
      toolUpdatesEnabled: config.toolUpdatesEnabled,
    },
    "bridge config",
  );

  const adapters = new Map<ChannelName, Adapter>();
  if (config.telegramEnabled && config.telegramToken) {
    logger.debug("telegram adapter enabled");
    adapters.set("telegram", createTelegramAdapter(config, logger, handleInbound));
  } else {
    logger.info("telegram adapter disabled");
    reportStatus?.("Telegram adapter disabled.");
  }

  if (config.whatsappEnabled) {
    logger.debug("whatsapp adapter enabled");
    adapters.set(
      "whatsapp",
      createWhatsAppAdapter(config, logger, handleInbound, { printQr: true, onStatus: reportStatus }),
    );
  } else {
    logger.info("whatsapp adapter disabled");
    reportStatus?.("WhatsApp adapter disabled.");
  }

  const sessionQueue = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, RunState>();
  const sessionModels = new Map<string, ModelRef>();
  const typingLoops = new Map<string, NodeJS.Timeout>();

  const formatPeer = (channel: ChannelName, peerId: string) =>
    channel === "whatsapp" ? normalizeWhatsAppId(peerId) : peerId;

  const formatModelLabel = (model?: ModelRef) =>
    model ? `${model.providerID}/${model.modelID}` : null;

  const extractModelRef = (info: unknown): ModelRef | null => {
    if (!info || typeof info !== "object") return null;
    const record = info as { role?: unknown; model?: unknown };
    if (record.role !== "user") return null;
    if (!record.model || typeof record.model !== "object") return null;
    const model = record.model as { providerID?: unknown; modelID?: unknown };
    if (typeof model.providerID !== "string" || typeof model.modelID !== "string") return null;
    return { providerID: model.providerID, modelID: model.modelID };
  };

  const reportThinking = (run: RunState) => {
    if (!reportStatus) return;
    const modelLabel = formatModelLabel(sessionModels.get(run.sessionID));
    const nextLabel = modelLabel ? `Thinking (${modelLabel})` : "Thinking...";
    if (run.thinkingLabel === nextLabel && run.thinkingActive) return;
    run.thinkingLabel = nextLabel;
    run.thinkingActive = true;
    reportStatus(`[${CHANNEL_LABELS[run.channel]}] ${formatPeer(run.channel, run.peerId)} ${nextLabel}`);
  };

  const reportDone = (run: RunState) => {
    if (!reportStatus || !run.thinkingActive) return;
    const modelLabel = formatModelLabel(sessionModels.get(run.sessionID));
    const suffix = modelLabel ? ` (${modelLabel})` : "";
    reportStatus(`[${CHANNEL_LABELS[run.channel]}] ${formatPeer(run.channel, run.peerId)} Done${suffix}`);
    run.thinkingActive = false;
  };

  const startTyping = (run: RunState) => {
    const adapter = adapters.get(run.channel);
    if (!adapter?.sendTyping) return;
    if (typingLoops.has(run.sessionID)) return;
    const sendTyping = async () => {
      try {
        await adapter.sendTyping?.(run.peerId);
      } catch (error) {
        logger.warn({ error, channel: run.channel }, "typing update failed");
      }
    };
    void sendTyping();
    const timer = setInterval(sendTyping, TYPING_INTERVAL_MS);
    typingLoops.set(run.sessionID, timer);
  };

  const stopTyping = (sessionID: string) => {
    const timer = typingLoops.get(sessionID);
    if (!timer) return;
    clearInterval(timer);
    typingLoops.delete(sessionID);
  };

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

      if (event.type === "message.updated") {
        if (event.properties && typeof event.properties === "object") {
          const record = event.properties as Record<string, unknown>;
          const info = record.info as Record<string, unknown> | undefined;
          const sessionID = typeof info?.sessionID === "string" ? (info.sessionID as string) : null;
          const model = extractModelRef(info);
          if (sessionID && model) {
            sessionModels.set(sessionID, model);
            const run = activeRuns.get(sessionID);
            if (run) reportThinking(run);
          }
        }
      }

      if (event.type === "session.status") {
        if (event.properties && typeof event.properties === "object") {
          const record = event.properties as Record<string, unknown>;
          const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
          const status = record.status as { type?: unknown } | undefined;
          if (sessionID && (status?.type === "busy" || status?.type === "retry")) {
            const run = activeRuns.get(sessionID);
            if (run) {
              reportThinking(run);
              startTyping(run);
            }
          }
        }
      }

      if (event.type === "session.idle") {
        if (event.properties && typeof event.properties === "object") {
          const record = event.properties as Record<string, unknown>;
          const sessionID = typeof record.sessionID === "string" ? record.sessionID : null;
          if (sessionID) {
            stopTyping(sessionID);
            const run = activeRuns.get(sessionID);
            if (run) reportDone(run);
          }
        }
      }

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

        await sendText(run.channel, run.peerId, message, { kind: "tool" });
      }

      if (event.type === "permission.asked") {
        const permission = event.properties as { id?: string; sessionID?: string };
        if (!permission?.id || !permission.sessionID) continue;
        const response = config.permissionMode === "deny" ? "reject" : "always";
        await client.permission.respond({
          sessionID: permission.sessionID,
          permissionID: permission.id,
          response,
        });
        if (response === "reject") {
          const run = activeRuns.get(permission.sessionID);
          if (run) {
            await sendText(run.channel, run.peerId, "Permission denied. Update configuration to allow tools.", {
              kind: "system",
            });
          }
        }
      }
    }
  })().catch((error) => {
    logger.error({ error }, "event stream closed");
  });

  async function sendText(
    channel: ChannelName,
    peerId: string,
    text: string,
    options: { kind?: OutboundKind; display?: boolean } = {},
  ) {
    const adapter = adapters.get(channel);
    if (!adapter) return;
    const kind = options.kind ?? "system";
    logger.debug({ channel, peerId, kind, length: text.length }, "sendText requested");
    if (options.display !== false) {
      reporter?.onOutbound?.({ channel, peerId, text, kind });
    }

    // CHECK IF IT'S A FILE COMMAND
    if (text.startsWith("FILE:")) {
      const filePath = text.substring(5).trim();
      if (adapter.sendFile) {
        await adapter.sendFile(peerId, filePath);
        return; // Stop here, don't send text
      }
    }

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
    logger.debug(
      {
        channel: inbound.channel,
        peerId: inbound.peerId,
        fromMe: inbound.fromMe,
        length: inbound.text.length,
        preview: truncateText(inbound.text.trim(), 120),
      },
      "inbound received",
    );
    logger.info(
      { channel: inbound.channel, peerId: inbound.peerId, length: inbound.text.length },
      "received message",
    );
    const peerKey = inbound.channel === "whatsapp" ? normalizeWhatsAppId(inbound.peerId) : inbound.peerId;
    if (inbound.channel === "whatsapp") {
      if (config.whatsappDmPolicy === "disabled") {
        return;
      }

      const allowAll = config.whatsappDmPolicy === "open" || config.whatsappAllowFrom.has("*");
      const isSelf = Boolean(inbound.fromMe && config.whatsappSelfChatMode);
      const allowed = allowAll || isSelf || store.isAllowed("whatsapp", peerKey);
      logger.debug(
        { allowAll, isSelf, allowed, dmPolicy: config.whatsappDmPolicy, peerKey },
        "whatsapp allowlist check",
      );
      if (!allowed) {
        if (config.whatsappDmPolicy === "allowlist") {
          await sendText(
            inbound.channel,
            inbound.peerId,
            "Access denied. Ask the owner to allowlist your number.",
            { kind: "system" },
          );
          return;
        }

        store.prunePairingRequests();
        const active = store.getPairingRequest("whatsapp", peerKey);
        const pending = store.listPairingRequests("whatsapp");
        if (!active && pending.length >= 3) {
          await sendText(
            inbound.channel,
            inbound.peerId,
            "Pairing queue full. Ask the owner to approve pending requests.",
            { kind: "system" },
          );
          return;
        }

        const code = active?.code ?? String(Math.floor(100000 + Math.random() * 900000));
        if (!active) {
          store.createPairingRequest("whatsapp", peerKey, code, 60 * 60_000);
        }
        await sendText(
          inbound.channel,
          inbound.peerId,
          `Pairing required. Ask the owner to approve code: ${code}`,
          { kind: "system" },
        );
        return;
      }
    } else if (config.allowlist[inbound.channel].size > 0) {
      if (!store.isAllowed(inbound.channel, peerKey)) {
        logger.debug({ channel: inbound.channel, peerKey }, "telegram allowlist denied");
        await sendText(inbound.channel, inbound.peerId, "Access denied.", { kind: "system" });
        return;
      }
    }

    reporter?.onInbound?.({
      channel: inbound.channel,
      peerId: inbound.peerId,
      text: inbound.text,
      fromMe: inbound.fromMe,
    });

    const session = store.getSession(inbound.channel, peerKey);
    const sessionID = session?.session_id ?? (await createSession({ ...inbound, peerId: peerKey }));
    logger.debug(
      {
        sessionID,
        channel: inbound.channel,
        peerId: inbound.peerId,
        reused: Boolean(session?.session_id),
      },
      "session resolved",
    );

    enqueue(sessionID, async () => {
      const runState: RunState = {
        sessionID,
        channel: inbound.channel,
        peerId: inbound.peerId,
        toolUpdatesEnabled: config.toolUpdatesEnabled,
        seenToolStates: new Map(),
      };
      activeRuns.set(sessionID, runState);
      reportThinking(runState);
      startTyping(runState);
      try {
        logger.debug({ sessionID, length: inbound.text.length }, "prompt start");
        const response = await client.session.prompt({
          sessionID,
          parts: [{ type: "text", text: inbound.text }],
        });
        const parts = (response as { parts?: Array<{ type?: string; text?: string; ignored?: boolean }> }).parts ?? [];
        const textParts = parts.filter((part) => part.type === "text" && !part.ignored);
        logger.debug(
          {
            sessionID,
            partCount: parts.length,
            textCount: textParts.length,
          },
          "prompt response",
        );
        const reply = parts
          .filter((part) => part.type === "text" && !part.ignored)
          .map((part) => part.text ?? "")
          .join("\n")
          .trim();

        if (reply) {
          logger.debug({ sessionID, replyLength: reply.length }, "reply built");
          await sendText(inbound.channel, inbound.peerId, reply, { kind: "reply" });
        } else {
          logger.debug({ sessionID }, "reply empty");
          await sendText(inbound.channel, inbound.peerId, "No response generated. Try again.", {
            kind: "system",
          });
        }
      } catch (error) {
        logger.error({ error }, "prompt failed");
        await sendText(inbound.channel, inbound.peerId, "Error: failed to reach OpenCode.", {
          kind: "system",
        });
      } finally {
        stopTyping(sessionID);
        reportDone(runState);
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
    reportStatus?.(
      `${CHANNEL_LABELS[message.channel]} session created for ${formatPeer(message.channel, message.peerId)} (ID: ${sessionID}).`,
    );
    await sendText(message.channel, message.peerId, "🧭 Session started.", { kind: "system" });
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
    reportStatus?.(`${adapter.name === "whatsapp" ? "WhatsApp" : "Telegram"} adapter started.`);
  }

  logger.info({ channels: Array.from(adapters.keys()) }, "bridge started");
  reportStatus?.(`Bridge running. Logs: ${config.logFile}`);

  return {
    async stop() {
      eventAbort.abort();
      clearInterval(healthTimer);
      if (stopHealthServer) stopHealthServer();
      for (const timer of typingLoops.values()) {
        clearInterval(timer);
      }
      typingLoops.clear();
      for (const adapter of adapters.values()) {
        await adapter.stop();
      }
      store.close();
      await delay(50);
    },
  };
}
