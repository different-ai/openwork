import { setTimeout as delay } from "node:timers/promises";

import type { Logger } from "pino";

import type { Config, ChannelName, OwpenbotConfigFile } from "./config.js";
import { normalizeWhatsAppId, readConfigFile, writeConfigFile } from "./config.js";
import { BridgeStore } from "./db.js";
import { normalizeEvent } from "./events.js";
import { startHealthServer, type HealthSnapshot } from "./health.js";
import { buildPermissionRules, createClient } from "./opencode.js";
import { chunkText, formatInputSummary, truncateText } from "./text.js";
import { createSlackAdapter } from "./slack.js";
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

type BridgeDeps = {
  client?: ReturnType<typeof createClient>;
  clientFactory?: (directory: string) => ReturnType<typeof createClient>;
  store?: BridgeStore;
  adapters?: Map<ChannelName, Adapter>;
  disableEventStream?: boolean;
  disableHealthServer?: boolean;
};

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
  key: string;
  directory: string;
  sessionID: string;
  channel: ChannelName;
  peerId: string;
  peerKey: string;
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
  slack: "Slack",
};

const TYPING_INTERVAL_MS = 6000;

// Model presets for quick switching
const MODEL_PRESETS: Record<string, ModelRef> = {
  opus: { providerID: "anthropic", modelID: "claude-opus-4-5-20251101" },
  codex: { providerID: "openai", modelID: "gpt-5.2-codex" },
};

// Per-user model overrides (channel:peerId -> ModelRef)
const userModelOverrides = new Map<string, ModelRef>();

function getUserModelKey(channel: ChannelName, peerId: string): string {
  return `${channel}:${peerId}`;
}

function getUserModel(channel: ChannelName, peerId: string, defaultModel?: ModelRef): ModelRef | undefined {
  const key = getUserModelKey(channel, peerId);
  return userModelOverrides.get(key) ?? defaultModel;
}

function setUserModel(channel: ChannelName, peerId: string, model: ModelRef | undefined): void {
  const key = getUserModelKey(channel, peerId);
  if (model) {
    userModelOverrides.set(key, model);
  } else {
    userModelOverrides.delete(key);
  }
}

export async function startBridge(config: Config, logger: Logger, reporter?: BridgeReporter, deps: BridgeDeps = {}) {
  const reportStatus = reporter?.onStatus;
  const clients = new Map<string, ReturnType<typeof createClient>>();
  const defaultDirectory = config.opencodeDirectory;

  const getClient = (directory?: string | null) => {
    const resolved = (directory ?? "").trim() || defaultDirectory;
    if (deps.client && resolved === defaultDirectory) {
      return deps.client;
    }
    const existing = clients.get(resolved);
    if (existing) return existing;
    const next = deps.clientFactory ? deps.clientFactory(resolved) : createClient(config, resolved);
    clients.set(resolved, next);
    return next;
  };

  const rootClient = getClient(defaultDirectory);
  const store = deps.store ?? new BridgeStore(config.dbPath);
  store.seedAllowlist("telegram", config.allowlist.telegram);
  store.seedAllowlist("slack", config.allowlist.slack);
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
      slackEnabled: config.slackEnabled,
      slackBotTokenPresent: Boolean(config.slackBotToken),
      slackAppTokenPresent: Boolean(config.slackAppToken),
      whatsappEnabled: config.whatsappEnabled,
      groupsEnabled: config.groupsEnabled,
      permissionMode: config.permissionMode,
      toolUpdatesEnabled: config.toolUpdatesEnabled,
    },
    "bridge config",
  );

  const adapters = deps.adapters ?? new Map<ChannelName, Adapter>();
  const usingInjectedAdapters = Boolean(deps.adapters);

  if (!usingInjectedAdapters) {
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

    if (config.slackEnabled && config.slackBotToken && config.slackAppToken) {
      logger.debug("slack adapter enabled");
      adapters.set("slack", createSlackAdapter(config, logger, handleInbound));
    } else {
      logger.info("slack adapter disabled");
      reportStatus?.("Slack adapter disabled.");
    }
  }

  const keyForSession = (directory: string, sessionID: string) => `${directory}::${sessionID}`;

  const sessionQueue = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, RunState>();
  const sessionModels = new Map<string, ModelRef>();
  const typingLoops = new Map<string, NodeJS.Timeout>();

  const formatPeer = (channel: ChannelName, peerId: string) =>
    channel === "whatsapp" ? normalizeWhatsAppId(peerId) : peerId;

  const normalizeDirectory = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return "";
    const unified = trimmed.replace(/\\/g, "/");
    const withoutTrailing = unified.replace(/\/+$/, "");
    const normalized = withoutTrailing || "/";
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

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
    const modelLabel = formatModelLabel(sessionModels.get(run.key));
    const nextLabel = modelLabel ? `Thinking (${modelLabel})` : "Thinking...";
    if (run.thinkingLabel === nextLabel && run.thinkingActive) return;
    run.thinkingLabel = nextLabel;
    run.thinkingActive = true;
    reportStatus(`[${CHANNEL_LABELS[run.channel]}] ${formatPeer(run.channel, run.peerId)} ${nextLabel}`);
  };

  const reportDone = (run: RunState) => {
    if (!reportStatus || !run.thinkingActive) return;
    const modelLabel = formatModelLabel(sessionModels.get(run.key));
    const suffix = modelLabel ? ` (${modelLabel})` : "";
    reportStatus(`[${CHANNEL_LABELS[run.channel]}] ${formatPeer(run.channel, run.peerId)} Done${suffix}`);
    run.thinkingActive = false;
  };

  const startTyping = (run: RunState) => {
    const adapter = adapters.get(run.channel);
    if (!adapter?.sendTyping) return;
    if (typingLoops.has(run.key)) return;
    const sendTyping = async () => {
      try {
        await adapter.sendTyping?.(run.peerId);
      } catch (error) {
        logger.warn({ error, channel: run.channel }, "typing update failed");
      }
    };
    void sendTyping();
    const timer = setInterval(sendTyping, TYPING_INTERVAL_MS);
    typingLoops.set(run.key, timer);
  };

  const stopTyping = (key: string) => {
    const timer = typingLoops.get(key);
    if (!timer) return;
    clearInterval(timer);
    typingLoops.delete(key);
  };

  let opencodeHealthy = false;
  let opencodeVersion: string | undefined;

  async function refreshHealth() {
    try {
      const health = await rootClient.global.health();
      opencodeHealthy = Boolean((health as { healthy?: boolean }).healthy);
      opencodeVersion = (health as { version?: string }).version;
    } catch (error) {
      logger.warn({ error }, "failed to reach opencode health");
      opencodeHealthy = false;
    }
  }

  await refreshHealth();
  const healthTimer = setInterval(refreshHealth, 30_000);

  // Mutable runtime state for groups (persisted to config file)
  let groupsEnabled = config.groupsEnabled;

  let stopHealthServer: (() => void) | null = null;
  if (!deps.disableHealthServer && config.healthPort) {
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
          slack: adapters.has("slack"),
        },
        config: {
          groupsEnabled,
        },
      }),
      logger,
      {
        getGroupsEnabled: () => groupsEnabled,
        setGroupsEnabled: async (enabled: boolean) => {
          groupsEnabled = enabled;
          // Also update config so adapters see the change
          (config as any).groupsEnabled = enabled;
          
          // Persist to config file
          const { config: current } = readConfigFile(config.configPath);
          const next: OwpenbotConfigFile = {
            ...current,
            groupsEnabled: enabled,
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;
          
          logger.info({ groupsEnabled: enabled }, "groups config updated");
          return { groupsEnabled: enabled };
        },
        setTelegramToken: async (token: string) => {
          const trimmed = token.trim();
          if (!trimmed) {
            throw new Error("Telegram token is required");
          }

          const { config: current } = readConfigFile(config.configPath);
          const next: OwpenbotConfigFile = {
            ...current,
            channels: {
              ...current.channels,
              telegram: {
                ...current.channels?.telegram,
                token: trimmed,
                enabled: true,
              },
            },
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;
          config.telegramToken = trimmed;
          config.telegramEnabled = true;

          const existing = adapters.get("telegram");
          if (existing) {
            try {
              await existing.stop();
            } catch (error) {
              logger.warn({ error }, "failed to stop existing telegram adapter");
            }
            adapters.delete("telegram");
          }

          const adapter = createTelegramAdapter(config, logger, handleInbound);
          adapters.set("telegram", adapter);
          await adapter.start();

          return {
            configured: true,
            enabled: true,
          };
        },
        setSlackTokens: async (tokens: { botToken: string; appToken: string }) => {
          const botToken = tokens.botToken.trim();
          const appToken = tokens.appToken.trim();
          if (!botToken || !appToken) {
            throw new Error("Slack bot token and app token are required");
          }

          const { config: current } = readConfigFile(config.configPath);
          const next: OwpenbotConfigFile = {
            ...current,
            channels: {
              ...current.channels,
              slack: {
                ...current.channels?.slack,
                botToken,
                appToken,
                enabled: true,
              },
            },
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;
          config.slackBotToken = botToken;
          config.slackAppToken = appToken;
          config.slackEnabled = true;

          const existing = adapters.get("slack");
          if (existing) {
            try {
              await existing.stop();
            } catch (error) {
              logger.warn({ error }, "failed to stop existing slack adapter");
            }
            adapters.delete("slack");
          }

          const adapter = createSlackAdapter(config, logger, handleInbound);
          adapters.set("slack", adapter);
          await adapter.start();

          return {
            configured: true,
            enabled: true,
          };
        },
        listBindings: async () => {
          const bindings = store.listBindings();
          return {
            items: bindings.map((entry) => ({
              channel: entry.channel,
              peerId: entry.peer_id,
              directory: entry.directory,
              updatedAt: entry.updated_at,
            })),
          };
        },
        setBinding: async (input: { channel: string; peerId: string; directory: string }) => {
          const channel = input.channel.trim().toLowerCase();
          if (channel !== "whatsapp" && channel !== "telegram" && channel !== "slack") {
            throw new Error("Invalid channel");
          }
          const peerKey = channel === "whatsapp" ? normalizeWhatsAppId(input.peerId) : input.peerId.trim();
          const directory = input.directory.trim();
          if (!peerKey || !directory) {
            throw new Error("peerId and directory are required");
          }
          const normalizedDir = normalizeDirectory(directory);
          store.upsertBinding(channel as ChannelName, peerKey, normalizedDir);
          store.deleteSession(channel as ChannelName, peerKey);
          ensureEventSubscription(normalizedDir);
        },
        clearBinding: async (input: { channel: string; peerId: string }) => {
          const channel = input.channel.trim().toLowerCase();
          if (channel !== "whatsapp" && channel !== "telegram" && channel !== "slack") {
            throw new Error("Invalid channel");
          }
          const peerKey = channel === "whatsapp" ? normalizeWhatsAppId(input.peerId) : input.peerId.trim();
          if (!peerKey) {
            throw new Error("peerId is required");
          }
          store.deleteBinding(channel as ChannelName, peerKey);
          store.deleteSession(channel as ChannelName, peerKey);
        },
      },
    );
  }

  const eventSubscriptions = new Map<string, AbortController>();

  const ensureEventSubscription = (directory: string) => {
    if (deps.disableEventStream) return;
    const resolved = directory.trim() || defaultDirectory;
    if (!resolved) return;
    if (eventSubscriptions.has(resolved)) return;

    const abort = new AbortController();
    eventSubscriptions.set(resolved, abort);
    const client = getClient(resolved);

    void (async () => {
      const subscription = await client.event.subscribe(undefined, { signal: abort.signal });
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
              const key = keyForSession(resolved, sessionID);
              sessionModels.set(key, model);
              const run = activeRuns.get(key);
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
              const run = activeRuns.get(keyForSession(resolved, sessionID));
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
              const key = keyForSession(resolved, sessionID);
              stopTyping(key);
              const run = activeRuns.get(key);
              if (run) reportDone(run);
            }
          }
        }

        if (event.type === "message.part.updated") {
          const part = (event.properties as { part?: any })?.part;
          if (!part?.sessionID) continue;
          const run = activeRuns.get(keyForSession(resolved, part.sessionID));
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
            const run = activeRuns.get(keyForSession(resolved, permission.sessionID));
            if (run) {
              await sendText(run.channel, run.peerId, "Permission denied. Update configuration to allow tools.", {
                kind: "system",
              });
            }
          }
        }
      }
    })().catch((error) => {
      if (abort.signal.aborted) return;
      logger.error({ error, directory: resolved }, "event stream closed");
    });
  };

  ensureEventSubscription(defaultDirectory);

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

    // Handle bot commands
    const trimmedText = inbound.text.trim();
    if (trimmedText.startsWith("/")) {
      const commandHandled = await handleCommand(inbound.channel, peerKey, inbound.peerId, trimmedText);
      if (commandHandled) return;
    }

    reporter?.onInbound?.({
      channel: inbound.channel,
      peerId: inbound.peerId,
      text: inbound.text,
      fromMe: inbound.fromMe,
    });

    const binding = store.getBinding(inbound.channel, peerKey);
    const session = store.getSession(inbound.channel, peerKey);

    const boundDirectory =
      binding?.directory?.trim() || session?.directory?.trim() || defaultDirectory;

    if (!boundDirectory) {
      await sendText(inbound.channel, inbound.peerId, "No workspace directory configured.", { kind: "system" });
      return;
    }

    if (!binding?.directory?.trim()) {
      store.upsertBinding(inbound.channel, peerKey, boundDirectory);
    }

    ensureEventSubscription(boundDirectory);

    const sessionID =
      session?.session_id && normalizeDirectory(session?.directory ?? "") === normalizeDirectory(boundDirectory)
        ? session.session_id
        : await createSession({
            channel: inbound.channel,
            peerId: inbound.peerId,
            peerKey,
            directory: boundDirectory,
          });
    const key = keyForSession(boundDirectory, sessionID);
    logger.debug(
      {
        sessionID,
        channel: inbound.channel,
        peerId: inbound.peerId,
        reused: Boolean(session?.session_id),
      },
      "session resolved",
    );

    enqueue(key, async () => {
      const runState: RunState = {
        key,
        directory: boundDirectory,
        sessionID,
        channel: inbound.channel,
        peerId: inbound.peerId,
        peerKey,
        toolUpdatesEnabled: config.toolUpdatesEnabled,
        seenToolStates: new Map(),
      };
      activeRuns.set(key, runState);
      reportThinking(runState);
      startTyping(runState);
      try {
        const effectiveModel = getUserModel(inbound.channel, peerKey, config.model);
        logger.debug({ sessionID, length: inbound.text.length, model: effectiveModel }, "prompt start");
        const response = await getClient(boundDirectory).session.prompt({
          sessionID,
          parts: [{ type: "text", text: inbound.text }],
          ...(effectiveModel ? { model: effectiveModel } : {}),
        });
        const parts = (response as { parts?: Array<{ type?: string; text?: string; ignored?: boolean }> }).parts ?? [];
        const textParts = parts.filter((part) => part.type === "text" && !part.ignored);
        logger.debug(
          {
            sessionID,
            partCount: parts.length,
            textCount: textParts.length,
            partTypes: parts.map((p) => p.type),
            ignoredCount: parts.filter((p) => p.ignored).length,
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
        // Log full error details for debugging
        const errorDetails = {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack?.split("\n").slice(0, 3).join("\n") : undefined,
          cause: error instanceof Error ? (error as any).cause : undefined,
          status: (error as any)?.status ?? (error as any)?.statusCode ?? undefined,
        };
        logger.error({ error: errorDetails, sessionID }, "prompt failed");
        
        // Extract meaningful error details
        let errorMessage = "Error: failed to reach OpenCode.";
        if (error instanceof Error) {
          const msg = error.message || "";
          // Check for common error patterns
          if (msg.includes("401") || msg.includes("Unauthorized")) {
            errorMessage = "Error: OpenCode authentication failed (401). Check credentials.";
          } else if (msg.includes("403") || msg.includes("Forbidden")) {
            errorMessage = "Error: OpenCode access forbidden (403).";
          } else if (msg.includes("404") || msg.includes("Not Found")) {
            errorMessage = "Error: OpenCode endpoint not found (404).";
          } else if (msg.includes("429") || msg.includes("rate limit")) {
            errorMessage = "Error: Rate limited. Please wait and try again.";
          } else if (msg.includes("500") || msg.includes("Internal Server")) {
            errorMessage = "Error: OpenCode server error (500).";
          } else if (msg.includes("model") || msg.includes("provider")) {
            errorMessage = `Error: Model/provider issue - ${msg.slice(0, 100)}`;
          } else if (msg.includes("ECONNREFUSED") || msg.includes("connection")) {
            errorMessage = "Error: Cannot connect to OpenCode. Is it running?";
          } else if (msg.trim()) {
            // Include the actual error message (truncated)
            errorMessage = `Error: ${msg.slice(0, 150)}`;
          }
        }
        
        await sendText(inbound.channel, inbound.peerId, errorMessage, {
          kind: "system",
        });
      } finally {
        stopTyping(key);
        reportDone(runState);
        activeRuns.delete(key);
      }
    });
  }

  async function handleCommand(channel: ChannelName, peerKey: string, peerId: string, text: string): Promise<boolean> {
    const parts = text.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    // Model switching commands
    if (command && MODEL_PRESETS[command]) {
      const model = MODEL_PRESETS[command];
      setUserModel(channel, peerKey, model);
      await sendText(channel, peerId, `Model switched to ${model.providerID}/${model.modelID}`, { kind: "system" });
      logger.info({ channel, peerId: peerKey, model }, "model switched via command");
      return true;
    }

    // /model command - show current model
    if (command === "model") {
      const current = getUserModel(channel, peerKey, config.model);
      const modelStr = current ? `${current.providerID}/${current.modelID}` : "default";
      await sendText(channel, peerId, `Current model: ${modelStr}`, { kind: "system" });
      return true;
    }

    // /reset command - clear model override and session
    if (command === "reset") {
      setUserModel(channel, peerKey, undefined);
      store.deleteSession(channel, peerKey);
      await sendText(channel, peerId, "Session and model reset. Send a message to start fresh.", { kind: "system" });
      logger.info({ channel, peerId: peerKey }, "session and model reset");
      return true;
    }

    if (command === "dir" || command === "cd") {
      const next = args.join(" ").trim();
      if (!next) {
        const binding = store.getBinding(channel, peerKey);
        const current = binding?.directory?.trim() || store.getSession(channel, peerKey)?.directory?.trim() || defaultDirectory;
        await sendText(channel, peerId, `Current directory: ${current || "(none)"}`, { kind: "system" });
        return true;
      }
      const normalized = normalizeDirectory(next);
      store.upsertBinding(channel, peerKey, normalized);
      store.deleteSession(channel, peerKey);
      ensureEventSubscription(normalized);
      await sendText(channel, peerId, `Directory set to: ${normalized}`, { kind: "system" });
      return true;
    }

    // /help command
    if (command === "help") {
      const helpText = `/opus - Claude Opus 4.5\n/codex - GPT 5.2 Codex\n/dir <path> - bind this chat to a directory\n/dir - show current directory\n/model - show current\n/reset - start fresh\n/help - this`;
      await sendText(channel, peerId, helpText, { kind: "system" });
      return true;
    }

    // Unknown command - don't handle, let it pass through as a message
    return false;
  }

  async function createSession(input: {
    channel: ChannelName;
    peerId: string;
    peerKey: string;
    directory: string;
  }): Promise<string> {
    const title = `owpenbot ${input.channel} ${input.peerId}`;
    const session = await getClient(input.directory).session.create({
      title,
      permission: buildPermissionRules(config.permissionMode),
    });
    const sessionID = (session as { id?: string }).id;
    if (!sessionID) throw new Error("Failed to create session");
    store.upsertSession(input.channel, input.peerKey, sessionID, input.directory);
    logger.info({ sessionID, channel: input.channel, peerId: input.peerKey, directory: input.directory }, "session created");
    reportStatus?.(
      `${CHANNEL_LABELS[input.channel]} session created for ${formatPeer(input.channel, input.peerId)} (ID: ${sessionID}).`,
    );
    await sendText(input.channel, input.peerId, "🧭 Session started.", { kind: "system" });
    return sessionID;
  }

  function enqueue(key: string, task: () => Promise<void>) {
    const previous = sessionQueue.get(key) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error) => {
        logger.error({ error }, "session task failed");
      })
      .finally(() => {
        if (sessionQueue.get(key) === next) {
          sessionQueue.delete(key);
        }
      });
    sessionQueue.set(key, next);
  }

  for (const adapter of adapters.values()) {
    await adapter.start();
    reportStatus?.(`${CHANNEL_LABELS[adapter.name]} adapter started.`);
  }

  logger.info({ channels: Array.from(adapters.keys()) }, "bridge started");
  reportStatus?.(`Bridge running. Logs: ${config.logFile}`);

  return {
    async stop() {
      clearInterval(healthTimer);
      if (stopHealthServer) stopHealthServer();
      for (const abort of eventSubscriptions.values()) {
        abort.abort();
      }
      eventSubscriptions.clear();
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
    async dispatchInbound(message: { channel: ChannelName; peerId: string; text: string; raw?: unknown; fromMe?: boolean }) {
      await handleInbound({
        channel: message.channel,
        peerId: message.peerId,
        text: message.text,
        raw: message.raw ?? null,
        fromMe: message.fromMe,
      });

      // For tests and programmatic callers: wait for the session queue to drain.
      const peerKey = message.channel === "whatsapp" ? normalizeWhatsAppId(message.peerId) : message.peerId;
      const session = store.getSession(message.channel, peerKey);
      const sessionID = session?.session_id;
      const directory = session?.directory?.trim() || store.getBinding(message.channel, peerKey)?.directory?.trim() || defaultDirectory;
      const pending = sessionID && directory ? sessionQueue.get(keyForSession(directory, sessionID)) : null;
      if (pending) {
        await pending;
      }
    },
  };
}
