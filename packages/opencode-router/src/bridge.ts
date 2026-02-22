import { setTimeout as delay } from "node:timers/promises";

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Logger } from "pino";

import type { Config, ChannelName, OpenCodeRouterConfigFile } from "./config.js";
import { readConfigFile, writeConfigFile } from "./config.js";
import { BridgeStore } from "./db.js";
import { normalizeEvent } from "./events.js";
import { startHealthServer, type HealthSnapshot } from "./health.js";
import { buildPermissionRules, createClient } from "./opencode.js";
import { chunkText, formatInputSummary, truncateText } from "./text.js";
import { createSlackAdapter } from "./slack.js";
import { createTelegramAdapter, isTelegramPeerId } from "./telegram.js";

type Adapter = {
  key: string;
  name: ChannelName;
  identityId: string;
  maxTextLength: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(peerId: string, text: string): Promise<void>;
  sendFile?: (peerId: string, filePath: string, caption?: string) => Promise<void>;
  sendTyping?: (peerId: string) => Promise<void>;
};

type AdapterStartResult =
  | { status: "started" }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

async function startAdapterBounded(
  adapter: Adapter,
  options: { timeoutMs: number; onError?: (error: unknown) => void },
): Promise<AdapterStartResult> {
  const outcome = adapter
    .start()
    .then(() => ({ ok: true as const }))
    .catch((error) => ({ ok: false as const, error }));

  if (options.onError) {
    void outcome.then((result) => {
      if (!result.ok) {
        options.onError?.(result.error);
      }
    });
  }

  const winner = await Promise.race([
    outcome.then((result) => ({ kind: "outcome" as const, result })),
    delay(options.timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);

  if (winner.kind === "timeout") return { status: "timeout" };
  if (winner.result.ok) return { status: "started" };
  return { status: "error", error: winner.result.error };
}

type OutboundKind = "reply" | "system" | "tool";

type BridgeDeps = {
  client?: ReturnType<typeof createClient>;
  clientFactory?: (directory: string) => ReturnType<typeof createClient>;
  store?: BridgeStore;
  adapters?: Map<string, Adapter>;
  disableEventStream?: boolean;
  disableHealthServer?: boolean;
};

export type BridgeReporter = {
  onStatus?: (message: string) => void;
  onInbound?: (message: {
    channel: ChannelName;
    identityId: string;
    peerId: string;
    text: string;
    fromMe?: boolean;
  }) => void;
  onOutbound?: (message: {
    channel: ChannelName;
    identityId: string;
    peerId: string;
    text: string;
    kind: OutboundKind;
  }) => void;
};

type InboundMessage = {
  channel: ChannelName;
  identityId: string;
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
  identityId: string;
  adapterKey: string;
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
  telegram: "Telegram",
  slack: "Slack",
};

const TYPING_INTERVAL_MS = 6000;
const OPENCODE_ROUTER_AGENT_FILE_RELATIVE_PATH = ".opencode/agents/opencode-router.md";
const OPENCODE_ROUTER_AGENT_MAX_CHARS = 16_000;
const DEFAULT_MESSAGING_AGENT_INSTRUCTIONS = [
  "Respond for non-technical users first.",
  "Do not tell users to run router commands; use tools on their behalf.",
  "Never expose raw peer IDs or Telegram chat IDs unless the user explicitly asks for debug details.",
  "Do not ask end users for peer IDs or identity IDs.",
  "For Telegram send requests, try delivery immediately using existing bindings or direct tool calls.",
  "If Telegram returns 'chat not found', explain that the recipient must message the bot first (for example with /start), then ask the user to retry.",
  "Keep status updates concise and action-oriented.",
].join("\n");

type MessagingAgentConfig = {
  filePath: string;
  loaded: boolean;
  selectedAgent?: string;
  instructions: string;
};

// Model presets for quick switching
const MODEL_PRESETS: Record<string, ModelRef> = {
  opus: { providerID: "anthropic", modelID: "claude-opus-4-5-20251101" },
  codex: { providerID: "openai", modelID: "gpt-5.2-codex" },
};

// Per-user model overrides (channel:peerId -> ModelRef)
const userModelOverrides = new Map<string, ModelRef>();

function getUserModelKey(channel: ChannelName, identityId: string, peerId: string): string {
  return `${channel}:${identityId}:${peerId}`;
}

function getUserModel(channel: ChannelName, identityId: string, peerId: string, defaultModel?: ModelRef): ModelRef | undefined {
  const key = getUserModelKey(channel, identityId, peerId);
  return userModelOverrides.get(key) ?? defaultModel;
}

function setUserModel(channel: ChannelName, identityId: string, peerId: string, model: ModelRef | undefined): void {
  const key = getUserModelKey(channel, identityId, peerId);
  if (model) {
    userModelOverrides.set(key, model);
  } else {
    userModelOverrides.delete(key);
  }
}

function adapterKey(channel: ChannelName, identityId: string): string {
  return `${channel}:${identityId}`;
}

function invalidTelegramPeerIdError(): Error & { status?: number } {
  const error = new Error(
    "Telegram requires a numeric chat_id for direct targets. Usernames like @name cannot be used as peerId.",
  ) as Error & { status?: number };
  error.status = 400;
  return error;
}

const PAIRING_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;

function normalizeTelegramAccess(value: unknown): "public" | "private" {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return raw === "private" ? "private" : "public";
}

function normalizePairingCodeHash(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PAIRING_CODE_HASH_PATTERN.test(raw)) return "";
  return raw;
}

function normalizePairingCodeValue(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashPairingCode(value: string): string {
  return createHash("sha256").update(normalizePairingCodeValue(value)).digest("hex");
}

function extractPairingCodeFromCommand(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/pair(?:@[A-Za-z0-9_]+)?\s+(.+)$/i);
  if (!match?.[1]) return "";
  return normalizePairingCodeValue(match[1]);
}

function normalizeIdentityId(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "default";
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const cleaned = safe.replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "default";
}

export async function startBridge(config: Config, logger: Logger, reporter?: BridgeReporter, deps: BridgeDeps = {}) {
  const reportStatus = reporter?.onStatus;
  const clients = new Map<string, ReturnType<typeof createClient>>();
  const defaultDirectory = config.opencodeDirectory;
  const workspaceRoot = resolve(defaultDirectory || process.cwd());
  const workspaceAgentFilePath = join(workspaceRoot, OPENCODE_ROUTER_AGENT_FILE_RELATIVE_PATH);
  const agentPromptCache = new Map<string, { mtimeMs: number; config: MessagingAgentConfig }>();
  let latestAgentConfig: MessagingAgentConfig = {
    filePath: workspaceAgentFilePath,
    loaded: false,
    instructions: "",
  };

  const parseMessagingAgentFile = (content: string): { selectedAgent?: string; instructions: string } => {
    const lines = content.split(/\r?\n/);
    let start = 0;
    while (start < lines.length && !lines[start]?.trim()) {
      start += 1;
    }

    let selectedAgent: string | undefined;
    if (start < lines.length) {
      const first = lines[start]?.trim() ?? "";
      const match = first.match(/^@agent\s+([A-Za-z0-9_.:/-]+)$/);
      if (match?.[1]) {
        selectedAgent = match[1];
        lines.splice(start, 1);
      }
    }

    const instructions = lines.join("\n").trim();
    return { ...(selectedAgent ? { selectedAgent } : {}), instructions };
  };

  const loadMessagingAgentConfig = async (): Promise<MessagingAgentConfig> => {
    const filePath = workspaceAgentFilePath;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        agentPromptCache.delete(filePath);
        latestAgentConfig = { filePath, loaded: false, instructions: "" };
        return latestAgentConfig;
      }

      const cached = agentPromptCache.get(filePath);
      if (cached && cached.mtimeMs === info.mtimeMs) {
        latestAgentConfig = cached.config;
        return latestAgentConfig;
      }

      const raw = (await readFile(filePath, "utf8")).trim();
      if (!raw) {
        const next: MessagingAgentConfig = { filePath, loaded: false, instructions: "" };
        agentPromptCache.set(filePath, { mtimeMs: info.mtimeMs, config: next });
        latestAgentConfig = next;
        return next;
      }

      const truncated = raw.length > OPENCODE_ROUTER_AGENT_MAX_CHARS ? raw.slice(0, OPENCODE_ROUTER_AGENT_MAX_CHARS) : raw;
      const parsed = parseMessagingAgentFile(truncated);
      const next: MessagingAgentConfig = {
        filePath,
        loaded: Boolean(parsed.instructions || parsed.selectedAgent),
        ...(parsed.selectedAgent ? { selectedAgent: parsed.selectedAgent } : {}),
        instructions: parsed.instructions,
      };
      agentPromptCache.set(filePath, { mtimeMs: info.mtimeMs, config: next });
      latestAgentConfig = next;
      return next;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        agentPromptCache.delete(filePath);
        latestAgentConfig = { filePath, loaded: false, instructions: "" };
        return latestAgentConfig;
      }
      logger.warn({ error, filePath }, "failed to load opencode-router agent file");
      latestAgentConfig = { filePath, loaded: false, instructions: "" };
      return latestAgentConfig;
    }
  };

  const isDangerousRootDirectory = (dir: string) => {
    const normalized = dir.trim();
    if (!normalized) return true;
    if (process.platform !== "win32") {
      return normalized === "/";
    }
    // Windows roots like C:, C:/, C:\
    return /^[a-zA-Z]:\/?$/.test(normalized.replace(/\\/g, "/"));
  };

  const resolveIdentityDirectory = (channel: ChannelName, identityId: string): string => {
    const id = identityId.trim();
    if (!id) return "";
    if (channel === "telegram") {
      const bot = config.telegramBots.find((entry) => entry.id === id);
      return typeof (bot as any)?.directory === "string" ? String((bot as any).directory).trim() : "";
    }
    const app = config.slackApps.find((entry) => entry.id === id);
    return typeof (app as any)?.directory === "string" ? String((app as any).directory).trim() : "";
  };

  const resolveTelegramIdentityAccess = (
    identityId: string,
  ): { access: "public" | "private"; pairingCodeHash: string } => {
    const id = identityId.trim();
    if (!id) {
      return { access: "public", pairingCodeHash: "" };
    }
    const bot = config.telegramBots.find((entry) => entry.id === id);
    if (!bot) {
      return { access: "public", pairingCodeHash: "" };
    }
    const access = normalizeTelegramAccess((bot as any).access);
    const pairingCodeHash = normalizePairingCodeHash((bot as any).pairingCodeHash);
    if (access !== "private") {
      return { access: "public", pairingCodeHash: "" };
    }
    return { access: "private", pairingCodeHash };
  };

  const listIdentityConfigs = (channel: ChannelName): Array<{ id: string; directory: string }> => {
    if (channel === "telegram") {
      return config.telegramBots.map((bot) => ({ id: bot.id, directory: (bot.directory ?? "").trim() }));
    }
    return config.slackApps.map((app) => ({ id: app.id, directory: (app.directory ?? "").trim() }));
  };

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

  logger.debug(
    {
      configPath: config.configPath,
      opencodeUrl: config.opencodeUrl,
      opencodeDirectory: config.opencodeDirectory,
      telegramBots: config.telegramBots.map((bot) => ({ id: bot.id, enabled: bot.enabled !== false })),
      slackApps: config.slackApps.map((app) => ({ id: app.id, enabled: app.enabled !== false })),
      groupsEnabled: config.groupsEnabled,
      permissionMode: config.permissionMode,
      toolUpdatesEnabled: config.toolUpdatesEnabled,
    },
    "bridge config",
  );

  const adapters = deps.adapters ?? new Map<string, Adapter>();
  const usingInjectedAdapters = Boolean(deps.adapters);

  if (!usingInjectedAdapters) {
    const enabledTelegram = config.telegramBots.filter((bot) => bot.enabled !== false);
    if (enabledTelegram.length === 0) {
      logger.info("telegram adapters disabled");
      reportStatus?.("Telegram adapters disabled.");
    }
    for (const bot of enabledTelegram) {
      const key = adapterKey("telegram", bot.id);
      logger.debug({ identityId: bot.id }, "telegram adapter enabled");
      const base = createTelegramAdapter(bot, config, logger, handleInbound);
      adapters.set(key, { ...base, key });
    }

    const enabledSlack = config.slackApps.filter((app) => app.enabled !== false);
    if (enabledSlack.length === 0) {
      logger.info("slack adapters disabled");
      reportStatus?.("Slack adapters disabled.");
    }
    for (const app of enabledSlack) {
      const key = adapterKey("slack", app.id);
      logger.debug({ identityId: app.id }, "slack adapter enabled");
      const base = createSlackAdapter(app, config, logger, handleInbound);
      adapters.set(key, { ...base, key });
    }
  }

  const keyForSession = (directory: string, sessionID: string) => `${directory}::${sessionID}`;

  const sessionQueue = new Map<string, Promise<void>>();
  const activeRuns = new Map<string, RunState>();
  const sessionModels = new Map<string, ModelRef>();
  const typingLoops = new Map<string, NodeJS.Timeout>();

  const formatPeer = (_channel: ChannelName, peerId: string) => peerId;

  const normalizeDirectory = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return "";
    const unified = trimmed.replace(/\\/g, "/");
    const withoutTrailing = unified.replace(/\/+$/, "");
    const normalized = withoutTrailing || "/";
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  const workspaceRootNormalized = normalizeDirectory(workspaceRoot);

  const isWithinWorkspaceRoot = (candidate: string) => {
    const resolved = resolve(candidate || workspaceRoot);
    const relativePath = relative(workspaceRoot, resolved);
    if (!relativePath) return true;
    if (relativePath === ".") return true;
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
    const boundary = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
    return resolved === workspaceRoot || resolved.startsWith(boundary);
  };

  const resolveScopedDirectory = (input: string): { ok: true; directory: string } | { ok: false; error: string } => {
    const trimmed = input.trim();
    if (!trimmed) return { ok: false, error: "Directory is required." };
    const resolved = resolve(isAbsolute(trimmed) ? trimmed : join(workspaceRoot, trimmed));
    if (!isWithinWorkspaceRoot(resolved)) {
      return {
        ok: false,
        error: `Directory must stay within workspace root: ${workspaceRootNormalized}`,
      };
    }
    return { ok: true, directory: normalizeDirectory(resolved) };
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
    reportStatus(
      `[${CHANNEL_LABELS[run.channel]}/${run.identityId}] ${formatPeer(run.channel, run.peerId)} ${nextLabel}`,
    );
  };

  const reportDone = (run: RunState) => {
    if (!reportStatus || !run.thinkingActive) return;
    const modelLabel = formatModelLabel(sessionModels.get(run.key));
    const suffix = modelLabel ? ` (${modelLabel})` : "";
    reportStatus(`[${CHANNEL_LABELS[run.channel]}/${run.identityId}] ${formatPeer(run.channel, run.peerId)} Done${suffix}`);
    run.thinkingActive = false;
  };

  const startTyping = (run: RunState) => {
    const adapter = adapters.get(run.adapterKey);
    if (!adapter?.sendTyping) return;
    if (typingLoops.has(run.key)) return;
    const sendTyping = async () => {
      try {
        await adapter.sendTyping?.(run.peerId);
      } catch (error) {
        logger.warn({ error, channel: run.channel, identityId: run.identityId }, "typing update failed");
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

  const HEALTH_SLOW_INTERVAL_MS = 30_000;
  const HEALTH_FAST_INTERVAL_MS = 1_000;
  let healthIntervalMs = HEALTH_FAST_INTERVAL_MS;
  let healthTimer: NodeJS.Timeout | null = null;

  async function refreshHealth() {
    try {
      const health = await rootClient.global.health();
      opencodeHealthy = Boolean((health as { healthy?: boolean }).healthy);
      opencodeVersion = (health as { version?: string }).version;
    } catch (error) {
      logger.warn({ error }, "failed to reach opencode health");
      opencodeHealthy = false;
    }

    // After initial startup, switch to a slower poll once OpenCode is healthy.
    if (opencodeHealthy && healthIntervalMs !== HEALTH_SLOW_INTERVAL_MS) {
      healthIntervalMs = HEALTH_SLOW_INTERVAL_MS;
      if (healthTimer) {
        clearInterval(healthTimer);
      }
      healthTimer = setInterval(refreshHealth, healthIntervalMs);
    }
  }

  await refreshHealth();
  healthTimer = setInterval(refreshHealth, healthIntervalMs);

  // Mutable runtime state for groups (persisted to config file)
  let groupsEnabled = config.groupsEnabled;

  const startOfToday = (now: number) => {
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };

  let activityDayStart = startOfToday(Date.now());
  let inboundToday = 0;
  let outboundToday = 0;
  let lastInboundAt: number | undefined;
  let lastOutboundAt: number | undefined;

  const ensureActivityDay = (now: number) => {
    const nextDayStart = startOfToday(now);
    if (nextDayStart === activityDayStart) return;
    activityDayStart = nextDayStart;
    inboundToday = 0;
    outboundToday = 0;
  };

  const recordInboundActivity = (now: number) => {
    ensureActivityDay(now);
    inboundToday += 1;
    lastInboundAt = now;
  };

  const recordOutboundActivity = (now: number) => {
    ensureActivityDay(now);
    outboundToday += 1;
    lastOutboundAt = now;
  };

  await loadMessagingAgentConfig();

  let stopHealthServer: (() => void) | null = null;
  if (!deps.disableHealthServer && config.healthPort) {
    stopHealthServer = await startHealthServer(
      config.healthPort,
      (): HealthSnapshot => ({
        ok: opencodeHealthy,
        opencode: {
          url: config.opencodeUrl,
          healthy: opencodeHealthy,
          version: opencodeVersion,
        },
        channels: {
          telegram: Array.from(adapters.keys()).some((key) => key.startsWith("telegram:")),
          // WhatsApp removed; keep field for backward compatibility.
          whatsapp: false,
          slack: Array.from(adapters.keys()).some((key) => key.startsWith("slack:")),
        },
        config: {
          groupsEnabled,
        },
        activity: {
          dayStart: activityDayStart,
          inboundToday,
          outboundToday,
          ...(typeof lastInboundAt === "number" ? { lastInboundAt } : {}),
          ...(typeof lastOutboundAt === "number" ? { lastOutboundAt } : {}),
          ...(typeof lastInboundAt === "number" || typeof lastOutboundAt === "number"
            ? { lastMessageAt: Math.max(lastInboundAt ?? 0, lastOutboundAt ?? 0) }
            : {}),
        },
        agent: {
          scope: "workspace",
          path: latestAgentConfig.filePath,
          loaded: latestAgentConfig.loaded,
          ...(latestAgentConfig.selectedAgent ? { selected: latestAgentConfig.selectedAgent } : {}),
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
          const next: OpenCodeRouterConfigFile = {
            ...current,
            groupsEnabled: enabled,
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;
          
          logger.info({ groupsEnabled: enabled }, "groups config updated");
          return { groupsEnabled: enabled };
        },

        listTelegramIdentities: async () => {
          return {
            items: config.telegramBots.map((bot) => ({
              id: bot.id,
              enabled: bot.enabled !== false,
              running: adapters.has(adapterKey("telegram", bot.id)),
              access: normalizeTelegramAccess((bot as any).access),
              pairingRequired: normalizeTelegramAccess((bot as any).access) === "private",
            })),
          };
        },
        upsertTelegramIdentity: async (input: {
          id?: string;
          token: string;
          enabled?: boolean;
          directory?: string;
          access?: "public" | "private";
          pairingCodeHash?: string;
        }) => {
          const token = input.token?.trim() ?? "";
          if (!token) throw new Error("token is required");
          const id = normalizeIdentityId(input.id);
          if (id === "env") throw new Error("identity id 'env' is reserved");
          const enabled = input.enabled !== false;
          const directoryInput = typeof input.directory === "string" ? input.directory.trim() : "";
          const requestedAccess =
            typeof input.access === "string" && input.access.trim() ? normalizeTelegramAccess(input.access) : undefined;
          const requestedPairingCodeHash = normalizePairingCodeHash(input.pairingCodeHash);

          // Persist to config file.
          const { config: current } = readConfigFile(config.configPath);
          const telegram = current.channels?.telegram;
          const bots = Array.isArray((telegram as any)?.bots) ? (((telegram as any).bots as unknown[]) ?? []) : [];
          const nextBots: any[] = [];
          let found = false;
          for (const entry of bots) {
            if (!entry || typeof entry !== "object") continue;
            const record = entry as Record<string, unknown>;
            const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
            if (entryId !== id) {
              nextBots.push(entry);
              continue;
            }
            found = true;
            const existingDirectory = typeof record.directory === "string" ? record.directory.trim() : "";
            const directory = directoryInput || existingDirectory;
            const existingAccess = normalizeTelegramAccess(record.access);
            const existingPairingCodeHash = normalizePairingCodeHash(record.pairingCodeHash);
            const access = requestedAccess ?? existingAccess;
            const pairingCodeHash = access === "private" ? requestedPairingCodeHash || existingPairingCodeHash : "";
            if (access === "private" && !pairingCodeHash) {
              throw new Error("pairingCodeHash is required when Telegram access is private");
            }
            nextBots.push({
              id,
              token,
              enabled,
              ...(directory ? { directory } : {}),
              access,
              ...(access === "private" ? { pairingCodeHash } : {}),
            });
          }
          if (!found) {
            const access = requestedAccess ?? "public";
            const pairingCodeHash = access === "private" ? requestedPairingCodeHash : "";
            if (access === "private" && !pairingCodeHash) {
              throw new Error("pairingCodeHash is required when Telegram access is private");
            }
            nextBots.push({
              id,
              token,
              enabled,
              ...(directoryInput ? { directory: directoryInput } : {}),
              access,
              ...(access === "private" ? { pairingCodeHash } : {}),
            });
          }

          const next: OpenCodeRouterConfigFile = {
            ...current,
            channels: {
              ...current.channels,
              telegram: {
                ...(current.channels?.telegram ?? {}),
                enabled: true,
                bots: nextBots,
              },
            },
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;

          // Update runtime identity list.
          const existingIdx = config.telegramBots.findIndex((bot) => bot.id === id);
          let runtimeAccess: "public" | "private" = requestedAccess ?? "public";
          let runtimePairingCodeHash = requestedPairingCodeHash;
          if (existingIdx >= 0) {
            const prev = config.telegramBots[existingIdx];
            const nextDirectory = directoryInput || (prev as any)?.directory || undefined;
            const prevAccess = normalizeTelegramAccess((prev as any)?.access);
            const prevPairingCodeHash = normalizePairingCodeHash((prev as any)?.pairingCodeHash);
            runtimeAccess = requestedAccess ?? prevAccess;
            runtimePairingCodeHash = runtimeAccess === "private" ? requestedPairingCodeHash || prevPairingCodeHash : "";
            if (runtimeAccess === "private" && !runtimePairingCodeHash) {
              throw new Error("pairingCodeHash is required when Telegram access is private");
            }
            config.telegramBots[existingIdx] = {
              id,
              token,
              enabled,
              ...(nextDirectory ? { directory: String(nextDirectory).trim() } : {}),
              access: runtimeAccess,
              ...(runtimeAccess === "private" ? { pairingCodeHash: runtimePairingCodeHash } : {}),
            };
          } else {
            runtimeAccess = requestedAccess ?? "public";
            runtimePairingCodeHash = runtimeAccess === "private" ? requestedPairingCodeHash : "";
            if (runtimeAccess === "private" && !runtimePairingCodeHash) {
              throw new Error("pairingCodeHash is required when Telegram access is private");
            }
            config.telegramBots.push({
              id,
              token,
              enabled,
              ...(directoryInput ? { directory: directoryInput } : {}),
              access: runtimeAccess,
              ...(runtimeAccess === "private" ? { pairingCodeHash: runtimePairingCodeHash } : {}),
            });
          }

          // Start/stop adapter.
          const key = adapterKey("telegram", id);
          const existing = adapters.get(key);
          if (!enabled) {
            if (existing) {
              try {
                await existing.stop();
              } catch (error) {
                logger.warn({ error, channel: "telegram", identityId: id }, "failed to stop telegram adapter");
              }
              adapters.delete(key);
            }
            return {
              id,
              enabled: false,
              access: runtimeAccess,
              pairingRequired: runtimeAccess === "private",
              applied: true,
            };
          }

          if (existing) {
            try {
              await existing.stop();
            } catch (error) {
              logger.warn({ error, channel: "telegram", identityId: id }, "failed to stop existing telegram adapter");
            }
            adapters.delete(key);
          }
          const base = createTelegramAdapter(
            {
              id,
              token,
              enabled,
              ...(directoryInput ? { directory: directoryInput } : {}),
              access: runtimeAccess,
              ...(runtimeAccess === "private" && runtimePairingCodeHash
                ? { pairingCodeHash: runtimePairingCodeHash }
                : {}),
            },
            config,
            logger,
            handleInbound,
          );
          const adapter = { ...base, key };
          adapters.set(key, adapter);

          const startResult = await startAdapterBounded(adapter, {
            timeoutMs: 2_500,
            onError: (error) => {
              logger.error({ error, channel: "telegram", identityId: id }, "telegram adapter start failed");
              adapters.delete(key);
            },
          });

          if (startResult.status === "timeout") {
            return {
              id,
              enabled: true,
              access: runtimeAccess,
              pairingRequired: runtimeAccess === "private",
              applied: false,
              starting: true,
            };
          }
          if (startResult.status === "error") {
            return {
              id,
              enabled: true,
              access: runtimeAccess,
              pairingRequired: runtimeAccess === "private",
              applied: false,
              error: String(startResult.error),
            };
          }
          return {
            id,
            enabled: true,
            access: runtimeAccess,
            pairingRequired: runtimeAccess === "private",
            applied: true,
          };
        },
        deleteTelegramIdentity: async (rawId: string) => {
          const id = normalizeIdentityId(rawId);
          if (id === "env") throw new Error("env identity cannot be deleted");

          const { config: current } = readConfigFile(config.configPath);
          const telegram = current.channels?.telegram;
          const bots = Array.isArray((telegram as any)?.bots) ? (((telegram as any).bots as unknown[]) ?? []) : [];
          const nextBots: any[] = [];
          let deleted = false;
          for (const entry of bots) {
            if (!entry || typeof entry !== "object") continue;
            const record = entry as Record<string, unknown>;
            const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
            if (entryId === id) {
              deleted = true;
              continue;
            }
            nextBots.push(entry);
          }
          const next: OpenCodeRouterConfigFile = {
            ...current,
            channels: {
              ...current.channels,
              telegram: {
                ...(current.channels?.telegram ?? {}),
                bots: nextBots,
              },
            },
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;

          config.telegramBots.splice(
            0,
            config.telegramBots.length,
            ...config.telegramBots.filter((bot) => bot.id !== id),
          );

          const key = adapterKey("telegram", id);
          const existing = adapters.get(key);
          if (existing) {
            try {
              await existing.stop();
            } catch (error) {
              logger.warn({ error, channel: "telegram", identityId: id }, "failed to stop telegram adapter");
            }
            adapters.delete(key);
          }
          return { id, deleted };
        },

        listSlackIdentities: async () => {
          return {
            items: config.slackApps.map((app) => ({
              id: app.id,
              enabled: app.enabled !== false,
              running: adapters.has(adapterKey("slack", app.id)),
            })),
          };
        },
        upsertSlackIdentity: async (input: { id?: string; botToken: string; appToken: string; enabled?: boolean; directory?: string }) => {
          const botToken = input.botToken?.trim() ?? "";
          const appToken = input.appToken?.trim() ?? "";
          if (!botToken || !appToken) throw new Error("botToken and appToken are required");
          const id = normalizeIdentityId(input.id);
          if (id === "env") throw new Error("identity id 'env' is reserved");
          const enabled = input.enabled !== false;
          const directoryInput = typeof input.directory === "string" ? input.directory.trim() : "";

          const { config: current } = readConfigFile(config.configPath);
          const slack = current.channels?.slack;
          const apps = Array.isArray((slack as any)?.apps) ? (((slack as any).apps as unknown[]) ?? []) : [];
          const nextApps: any[] = [];
          let found = false;
          for (const entry of apps) {
            if (!entry || typeof entry !== "object") continue;
            const record = entry as Record<string, unknown>;
            const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
            if (entryId !== id) {
              nextApps.push(entry);
              continue;
            }
            found = true;
            const existingDirectory = typeof record.directory === "string" ? record.directory.trim() : "";
            const directory = directoryInput || existingDirectory;
            nextApps.push({ id, botToken, appToken, enabled, ...(directory ? { directory } : {}) });
          }
          if (!found) {
            nextApps.push({ id, botToken, appToken, enabled, ...(directoryInput ? { directory: directoryInput } : {}) });
          }

          const next: OpenCodeRouterConfigFile = {
            ...current,
            channels: {
              ...current.channels,
              slack: {
                ...(current.channels?.slack ?? {}),
                enabled: true,
                apps: nextApps,
              },
            },
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;

          const existingIdx = config.slackApps.findIndex((app) => app.id === id);
          if (existingIdx >= 0) {
            const prev = config.slackApps[existingIdx];
            const nextDirectory = directoryInput || (prev as any)?.directory || undefined;
            config.slackApps[existingIdx] = {
              id,
              botToken,
              appToken,
              enabled,
              ...(nextDirectory ? { directory: String(nextDirectory).trim() } : {}),
            };
          } else {
            config.slackApps.push({ id, botToken, appToken, enabled, ...(directoryInput ? { directory: directoryInput } : {}) });
          }

          const key = adapterKey("slack", id);
          const existing = adapters.get(key);
          if (!enabled) {
            if (existing) {
              try {
                await existing.stop();
              } catch (error) {
                logger.warn({ error, channel: "slack", identityId: id }, "failed to stop slack adapter");
              }
              adapters.delete(key);
            }
            return { id, enabled: false, applied: true };
          }

          if (existing) {
            try {
              await existing.stop();
            } catch (error) {
              logger.warn({ error, channel: "slack", identityId: id }, "failed to stop existing slack adapter");
            }
            adapters.delete(key);
          }
          const base = createSlackAdapter(
            { id, botToken, appToken, enabled, ...(directoryInput ? { directory: directoryInput } : {}) },
            config,
            logger,
            handleInbound,
          );
          const adapter = { ...base, key };
          adapters.set(key, adapter);

          const startResult = await startAdapterBounded(adapter, {
            timeoutMs: 2_500,
            onError: (error) => {
              logger.error({ error, channel: "slack", identityId: id }, "slack adapter start failed");
              adapters.delete(key);
            },
          });

          if (startResult.status === "timeout") {
            return { id, enabled: true, applied: false, starting: true };
          }
          if (startResult.status === "error") {
            return { id, enabled: true, applied: false, error: String(startResult.error) };
          }
          return { id, enabled: true, applied: true };
        },
        deleteSlackIdentity: async (rawId: string) => {
          const id = normalizeIdentityId(rawId);
          if (id === "env") throw new Error("env identity cannot be deleted");

          const { config: current } = readConfigFile(config.configPath);
          const slack = current.channels?.slack;
          const apps = Array.isArray((slack as any)?.apps) ? (((slack as any).apps as unknown[]) ?? []) : [];
          const nextApps: any[] = [];
          let deleted = false;
          for (const entry of apps) {
            if (!entry || typeof entry !== "object") continue;
            const record = entry as Record<string, unknown>;
            const entryId = normalizeIdentityId(typeof record.id === "string" ? record.id : "default");
            if (entryId === id) {
              deleted = true;
              continue;
            }
            nextApps.push(entry);
          }
          const next: OpenCodeRouterConfigFile = {
            ...current,
            channels: {
              ...current.channels,
              slack: {
                ...(current.channels?.slack ?? {}),
                apps: nextApps,
              },
            },
          };
          next.version = next.version ?? 1;
          writeConfigFile(config.configPath, next);
          config.configFile = next;

          config.slackApps.splice(0, config.slackApps.length, ...config.slackApps.filter((app) => app.id !== id));

          const key = adapterKey("slack", id);
          const existing = adapters.get(key);
          if (existing) {
            try {
              await existing.stop();
            } catch (error) {
              logger.warn({ error, channel: "slack", identityId: id }, "failed to stop slack adapter");
            }
            adapters.delete(key);
          }
          return { id, deleted };
        },

        listBindings: async (filters?: { channel?: string; identityId?: string }) => {
          const channelRaw = filters?.channel?.trim().toLowerCase();
          const identityIdRaw = filters?.identityId?.trim();
          let channel: ChannelName | undefined;
          if (channelRaw) {
            if (channelRaw === "telegram" || channelRaw === "slack") {
              channel = channelRaw as ChannelName;
            } else {
              throw new Error("Invalid channel");
            }
          }
          const identityId = identityIdRaw ? normalizeIdentityId(identityIdRaw) : undefined;
          const bindings = store.listBindings({ ...(channel ? { channel } : {}), ...(identityId ? { identityId } : {}) });
          return {
            items: bindings.map((entry) => ({
              channel: entry.channel,
              identityId: entry.identity_id,
              peerId: entry.peer_id,
              directory: entry.directory,
              updatedAt: entry.updated_at,
            })),
          };
        },
        setBinding: async (input: { channel: string; identityId?: string; peerId: string; directory: string }) => {
          const channel = input.channel.trim().toLowerCase();
          if (channel !== "telegram" && channel !== "slack") {
            throw new Error("Invalid channel");
          }
          const identityId = normalizeIdentityId(input.identityId);
          const peerKey = input.peerId.trim();
          const directory = input.directory.trim();
          if (!peerKey || !directory) {
            throw new Error("peerId and directory are required");
          }
          if (channel === "telegram" && !isTelegramPeerId(peerKey)) {
            throw invalidTelegramPeerIdError();
          }
          const scoped = resolveScopedDirectory(directory);
          if (!scoped.ok) {
            const error = new Error(scoped.error) as Error & { status?: number };
            error.status = 400;
            throw error;
          }
          const normalizedDir = scoped.directory;
          store.upsertBinding(channel as ChannelName, identityId, peerKey, normalizedDir);
          store.deleteSession(channel as ChannelName, identityId, peerKey);
          ensureEventSubscription(normalizedDir);
        },
        clearBinding: async (input: { channel: string; identityId?: string; peerId: string }) => {
          const channel = input.channel.trim().toLowerCase();
          if (channel !== "telegram" && channel !== "slack") {
            throw new Error("Invalid channel");
          }
          const identityId = normalizeIdentityId(input.identityId);
          const peerKey = input.peerId.trim();
          if (!peerKey) {
            throw new Error("peerId is required");
          }
          store.deleteBinding(channel as ChannelName, identityId, peerKey);
          store.deleteSession(channel as ChannelName, identityId, peerKey);
        },

        sendMessage: async (input: {
          channel: string;
          identityId?: string;
          directory?: string;
          peerId?: string;
          text: string;
          autoBind?: boolean;
        }) => {
          const channelRaw = input.channel.trim().toLowerCase();
          if (channelRaw !== "telegram" && channelRaw !== "slack") {
            throw new Error("Invalid channel");
          }
          const channel = channelRaw as ChannelName;
          const identityId = input.identityId?.trim() ? normalizeIdentityId(input.identityId) : undefined;
          const directoryInput = (input.directory ?? "").trim();
          const peerId = (input.peerId ?? "").trim();
          const autoBind = input.autoBind === true;
          const text = input.text ?? "";
          if (!text.trim()) {
            throw new Error("text is required");
          }

          if (!directoryInput && !peerId) {
            throw new Error("directory or peerId is required");
          }
          if (channel === "telegram" && peerId && !isTelegramPeerId(peerId)) {
            throw invalidTelegramPeerIdError();
          }

          const normalizedDir = directoryInput ? (() => {
            const scoped = resolveScopedDirectory(directoryInput);
            if (!scoped.ok) {
              const error = new Error(scoped.error) as Error & { status?: number };
              error.status = 400;
              throw error;
            }
            return scoped.directory;
          })() : "";

          const resolveSendIdentityId = () => {
            if (identityId) return identityId;
            if (normalizedDir) {
              const configured = listIdentityConfigs(channel).find((entry) => {
                if (!entry.directory) return false;
                if (!adapters.has(adapterKey(channel, entry.id))) return false;
                return normalizeDirectory(entry.directory) === normalizedDir;
              });
              if (configured?.id) return configured.id;
            }
            const active = Array.from(adapters.values()).find((adapter) => adapter.name === channel);
            return active?.identityId;
          };

          const targetIdentityId = resolveSendIdentityId();
          if (peerId && !targetIdentityId) {
            return {
              channel,
              directory: normalizedDir || workspaceRootNormalized,
              peerId,
              attempted: 0,
              sent: 0,
              reason: `No ${channel} adapter is running for direct send`,
            };
          }

          if (peerId && targetIdentityId) {
            const adapter = adapters.get(adapterKey(channel, targetIdentityId));
            if (!adapter) {
              return {
                channel,
                directory: normalizedDir || workspaceRootNormalized,
                identityId: targetIdentityId,
                peerId,
                attempted: 1,
                sent: 0,
                failures: [{ identityId: targetIdentityId, peerId, error: "Adapter not running" }],
              };
            }

            if (autoBind && normalizedDir) {
              store.upsertBinding(channel, targetIdentityId, peerId, normalizedDir);
              store.deleteSession(channel, targetIdentityId, peerId);
              ensureEventSubscription(normalizedDir);
            }

            try {
              await sendText(channel, targetIdentityId, peerId, text, { kind: "system", display: false });
              return {
                channel,
                directory: normalizedDir || workspaceRootNormalized,
                identityId: targetIdentityId,
                peerId,
                attempted: 1,
                sent: 1,
              };
            } catch (error) {
              return {
                channel,
                directory: normalizedDir || workspaceRootNormalized,
                identityId: targetIdentityId,
                peerId,
                attempted: 1,
                sent: 0,
                failures: [{
                  identityId: targetIdentityId,
                  peerId,
                  error: error instanceof Error ? error.message : String(error),
                }],
              };
            }
          }

          const bindings = store.listBindings({
            channel,
            ...(identityId ? { identityId } : {}),
            directory: normalizedDir,
          });
          if (bindings.length === 0) {
            return {
              channel,
              directory: normalizedDir,
              ...(identityId ? { identityId } : {}),
              attempted: 0,
              sent: 0,
              reason: `No bound conversations for ${channel}${identityId ? `/${identityId}` : ""} at directory ${normalizedDir}`,
            };
          }

          const failures: Array<{ identityId: string; peerId: string; error: string }> = [];
          let attempted = 0;
          let sent = 0;
          for (const binding of bindings) {
            attempted += 1;
            if (channel === "telegram" && !isTelegramPeerId(binding.peer_id)) {
              store.deleteBinding(channel, binding.identity_id, binding.peer_id);
              store.deleteSession(channel, binding.identity_id, binding.peer_id);
              failures.push({
                identityId: binding.identity_id,
                peerId: binding.peer_id,
                error: "Invalid Telegram peerId binding removed (expected numeric chat_id)",
              });
              continue;
            }
            const adapter = adapters.get(adapterKey(channel, binding.identity_id));
            if (!adapter) {
              failures.push({
                identityId: binding.identity_id,
                peerId: binding.peer_id,
                error: "Adapter not running",
              });
              continue;
            }
            try {
              await sendText(channel, binding.identity_id, binding.peer_id, text, { kind: "system", display: false });
              sent += 1;
            } catch (error) {
              failures.push({
                identityId: binding.identity_id,
                peerId: binding.peer_id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          return {
            channel,
            directory: normalizedDir,
            ...(identityId ? { identityId } : {}),
            attempted,
            sent,
            ...(failures.length ? { failures } : {}),
          };
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

          await sendText(run.channel, run.identityId, run.peerId, message, { kind: "tool" });
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
              await sendText(run.channel, run.identityId, run.peerId, "Permission denied. Update configuration to allow tools.", {
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
    identityId: string,
    peerId: string,
    text: string,
    options: { kind?: OutboundKind; display?: boolean } = {},
  ) {
    const adapter = adapters.get(adapterKey(channel, identityId));
    if (!adapter) return;
    recordOutboundActivity(Date.now());
    const kind = options.kind ?? "system";
    logger.debug({ channel, identityId, peerId, kind, length: text.length }, "sendText requested");
    if (options.display !== false) {
      reporter?.onOutbound?.({ channel, identityId, peerId, text, kind });
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

  async function handleTelegramPairingGate(input: {
    identityId: string;
    peerKey: string;
    peerId: string;
    text: string;
    bindingDirectory?: string;
    sessionDirectory?: string;
  }): Promise<"continue" | "handled"> {
    const access = resolveTelegramIdentityAccess(input.identityId);
    if (access.access !== "private") {
      return "continue";
    }

    const hasKnownBinding = Boolean(input.bindingDirectory?.trim() || input.sessionDirectory?.trim());
    if (hasKnownBinding) {
      return "continue";
    }

    const pairingCode = extractPairingCodeFromCommand(input.text);
    if (!pairingCode) {
      await sendText(
        "telegram",
        input.identityId,
        input.peerId,
        "This Telegram bot is private. Ask your OpenWork host for the pairing code, then send /pair <code>.",
        { kind: "system" },
      );
      return "handled";
    }

    if (!access.pairingCodeHash) {
      await sendText(
        "telegram",
        input.identityId,
        input.peerId,
        "This Telegram bot is private but missing a pairing code. Ask your OpenWork host to reconnect it.",
        { kind: "system" },
      );
      return "handled";
    }

    if (hashPairingCode(pairingCode) !== access.pairingCodeHash) {
      await sendText("telegram", input.identityId, input.peerId, "Invalid pairing code. Try again with /pair <code>.", {
        kind: "system",
      });
      return "handled";
    }

    const identityDirectory = resolveIdentityDirectory("telegram", input.identityId);
    const boundDirectoryCandidate = identityDirectory || defaultDirectory;
    const hasExplicitBinding = Boolean(identityDirectory);
    if (!boundDirectoryCandidate || (!hasExplicitBinding && isDangerousRootDirectory(boundDirectoryCandidate))) {
      await sendText(
        "telegram",
        input.identityId,
        input.peerId,
        "No workspace directory configured for this identity. Ask your OpenWork host to set it, or reply with /dir <path>.",
        { kind: "system" },
      );
      return "handled";
    }

    const scopedBound = resolveScopedDirectory(boundDirectoryCandidate);
    if (!scopedBound.ok) {
      await sendText("telegram", input.identityId, input.peerId, scopedBound.error, { kind: "system" });
      return "handled";
    }

    const boundDirectory = scopedBound.directory;
    store.upsertBinding("telegram", input.identityId, input.peerKey, boundDirectory);
    store.deleteSession("telegram", input.identityId, input.peerKey);
    ensureEventSubscription(boundDirectory);
    logger.info(
      { channel: "telegram", identityId: input.identityId, peerId: input.peerKey, directory: boundDirectory },
      "telegram private identity paired",
    );
    await sendText(
      "telegram",
      input.identityId,
      input.peerId,
      "Pairing successful. This chat is now linked to your worker.",
      { kind: "system" },
    );
    return "handled";
  }

  async function handleInbound(message: InboundMessage) {
    const adapter = adapters.get(adapterKey(message.channel, message.identityId));
    if (!adapter) return;
    recordInboundActivity(Date.now());
    let inbound = message;
    logger.debug(
      {
        channel: inbound.channel,
        identityId: inbound.identityId,
        peerId: inbound.peerId,
        fromMe: inbound.fromMe,
        length: inbound.text.length,
        preview: truncateText(inbound.text.trim(), 120),
      },
      "inbound received",
    );
    logger.info(
      { channel: inbound.channel, identityId: inbound.identityId, peerId: inbound.peerId, length: inbound.text.length },
      "received message",
    );
    const peerKey = inbound.peerId;
    const trimmedText = inbound.text.trim();
    let binding = store.getBinding(inbound.channel, inbound.identityId, peerKey);
    let session = store.getSession(inbound.channel, inbound.identityId, peerKey);

    if (inbound.channel === "telegram") {
      const pairingGate = await handleTelegramPairingGate({
        identityId: inbound.identityId,
        peerKey,
        peerId: inbound.peerId,
        text: trimmedText,
        ...(binding?.directory?.trim() ? { bindingDirectory: binding.directory } : {}),
        ...(session?.directory?.trim() ? { sessionDirectory: session.directory ?? undefined } : {}),
      });
      if (pairingGate === "handled") return;
      binding = store.getBinding(inbound.channel, inbound.identityId, peerKey);
      session = store.getSession(inbound.channel, inbound.identityId, peerKey);
    }

    // Handle bot commands
    if (trimmedText.startsWith("/")) {
      const commandHandled = await handleCommand(
        inbound.channel,
        inbound.identityId,
        peerKey,
        inbound.peerId,
        trimmedText,
      );
      if (commandHandled) return;
    }

    reporter?.onInbound?.({
      channel: inbound.channel,
      identityId: inbound.identityId,
      peerId: inbound.peerId,
      text: inbound.text,
      fromMe: inbound.fromMe,
    });

    const identityDirectory = resolveIdentityDirectory(inbound.channel, inbound.identityId);

    const boundDirectoryCandidate =
      binding?.directory?.trim() || session?.directory?.trim() || identityDirectory || defaultDirectory;

    const hasExplicitBinding = Boolean(binding?.directory?.trim() || session?.directory?.trim() || identityDirectory);
    if (!boundDirectoryCandidate || (!hasExplicitBinding && isDangerousRootDirectory(boundDirectoryCandidate))) {
      await sendText(
        inbound.channel,
        inbound.identityId,
        inbound.peerId,
        "No workspace directory configured for this identity. Ask your OpenWork host to set it, or reply with /dir <path>.",
        { kind: "system" },
      );
      return;
    }

    const scopedBound = resolveScopedDirectory(boundDirectoryCandidate);
    if (!scopedBound.ok) {
      await sendText(inbound.channel, inbound.identityId, inbound.peerId, scopedBound.error, { kind: "system" });
      return;
    }
    const boundDirectory = scopedBound.directory;

    const shouldAutoBind = !(
      inbound.channel === "telegram" && resolveTelegramIdentityAccess(inbound.identityId).access === "private"
    );
    if (shouldAutoBind && !binding?.directory?.trim()) {
      store.upsertBinding(inbound.channel, inbound.identityId, peerKey, boundDirectory);
    }

    ensureEventSubscription(boundDirectory);

    const sessionID =
      session?.session_id && normalizeDirectory(session?.directory ?? "") === normalizeDirectory(boundDirectory)
        ? session.session_id
        : await createSession({
            channel: inbound.channel,
            identityId: inbound.identityId,
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
        identityId: inbound.identityId,
        adapterKey: adapterKey(inbound.channel, inbound.identityId),
        peerId: inbound.peerId,
        peerKey,
        toolUpdatesEnabled: config.toolUpdatesEnabled,
        seenToolStates: new Map(),
      };
      activeRuns.set(key, runState);
      reportThinking(runState);
      startTyping(runState);
      try {
        const effectiveModel = getUserModel(inbound.channel, inbound.identityId, peerKey, config.model);
        const messagingAgent = await loadMessagingAgentConfig();
        const effectiveInstructions = [messagingAgent.instructions, DEFAULT_MESSAGING_AGENT_INSTRUCTIONS]
          .map((value) => value.trim())
          .filter(Boolean)
          .join("\n\n");
        const promptText = [
          "You are handling a Slack/Telegram message via OpenWork.",
          `Workspace agent file: ${messagingAgent.filePath}`,
          ...(messagingAgent.selectedAgent ? [`Selected OpenCode agent: ${messagingAgent.selectedAgent}`] : []),
          "Follow these workspace messaging instructions:",
          effectiveInstructions,
          "",
          "Incoming user message:",
          inbound.text,
        ].join("\n");
        logger.debug(
          {
            sessionID,
            length: inbound.text.length,
            model: effectiveModel,
            agent: messagingAgent.selectedAgent,
          },
          "prompt start",
        );

        type PromptPart = { type?: string; text?: string; ignored?: boolean };

        const extractReply = (parts: PromptPart[]) =>
          parts
            .filter((part) => part.type === "text" && !part.ignored)
            .map((part) => part.text ?? "")
            .join("\n")
            .trim();

        const logPromptResponse = (attempt: "initial" | "retry", parts: PromptPart[]) => {
          const textParts = parts.filter((part) => part.type === "text" && !part.ignored);
          logger.debug(
            {
              sessionID,
              attempt,
              partCount: parts.length,
              textCount: textParts.length,
              partTypes: parts.map((p) => p.type),
              ignoredCount: parts.filter((p) => p.ignored).length,
            },
            "prompt response",
          );
        };

        const runPrompt = async (): Promise<PromptPart[]> => {
          const response = await getClient(boundDirectory).session.prompt({
            sessionID,
            parts: [{ type: "text", text: promptText }],
            ...(effectiveModel ? { model: effectiveModel } : {}),
            ...(messagingAgent.selectedAgent ? { agent: messagingAgent.selectedAgent } : {}),
          });
          return (response as { parts?: PromptPart[] }).parts ?? [];
        };

        let parts = await runPrompt();
        logPromptResponse("initial", parts);
        let reply = extractReply(parts);

        if (!reply && !parts.some((part) => part.type === "tool")) {
          logger.warn({ sessionID }, "prompt returned no visible text; retrying once");
          parts = await runPrompt();
          logPromptResponse("retry", parts);
          reply = extractReply(parts);
        }

        if (reply) {
          logger.debug({ sessionID, replyLength: reply.length }, "reply built");
          await sendText(inbound.channel, inbound.identityId, inbound.peerId, reply, { kind: "reply" });
        } else {
          logger.warn(
            { sessionID, partTypes: parts.map((part) => part.type), ignoredCount: parts.filter((part) => part.ignored).length },
            "prompt returned no visible text; clearing session",
          );
          store.deleteSession(inbound.channel, inbound.identityId, peerKey);
          await sendText(
            inbound.channel,
            inbound.identityId,
            inbound.peerId,
            "No visible response was generated. I reset this chat session in case stale state was blocking replies. Send your message again.",
            {
              kind: "system",
            },
          );
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
        
        await sendText(inbound.channel, inbound.identityId, inbound.peerId, errorMessage, {
          kind: "system",
        });
      } finally {
        stopTyping(key);
        reportDone(runState);
        activeRuns.delete(key);
      }
    });
  }

  async function handleCommand(
    channel: ChannelName,
    identityId: string,
    peerKey: string,
    peerId: string,
    text: string,
  ): Promise<boolean> {
    const parts = text.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    // Model switching commands
    if (command && MODEL_PRESETS[command]) {
      const model = MODEL_PRESETS[command];
      setUserModel(channel, identityId, peerKey, model);
      await sendText(channel, identityId, peerId, `Model switched to ${model.providerID}/${model.modelID}`, {
        kind: "system",
      });
      logger.info({ channel, peerId: peerKey, model }, "model switched via command");
      return true;
    }

    // /model command - show current model
    if (command === "model") {
      const current = getUserModel(channel, identityId, peerKey, config.model);
      const modelStr = current ? `${current.providerID}/${current.modelID}` : "default";
      await sendText(channel, identityId, peerId, `Current model: ${modelStr}`, { kind: "system" });
      return true;
    }

    // /reset command - clear model override and session
    if (command === "reset") {
      setUserModel(channel, identityId, peerKey, undefined);
      store.deleteSession(channel, identityId, peerKey);
      await sendText(channel, identityId, peerId, "Session and model reset. Send a message to start fresh.", {
        kind: "system",
      });
      logger.info({ channel, peerId: peerKey }, "session and model reset");
      return true;
    }

    if (command === "pair") {
      if (channel !== "telegram") {
        await sendText(channel, identityId, peerId, "Pairing is only available for Telegram private bots.", {
          kind: "system",
        });
        return true;
      }
      const binding = store.getBinding(channel, identityId, peerKey);
      const session = store.getSession(channel, identityId, peerKey);
      const pairingGate = await handleTelegramPairingGate({
        identityId,
        peerKey,
        peerId,
        text,
        ...(binding?.directory?.trim() ? { bindingDirectory: binding.directory } : {}),
        ...(session?.directory?.trim() ? { sessionDirectory: session.directory ?? undefined } : {}),
      });
      if (pairingGate === "handled") return true;
      await sendText(channel, identityId, peerId, "This chat is already paired.", { kind: "system" });
      return true;
    }

    if (command === "dir" || command === "cd") {
      const next = args.join(" ").trim();
      if (!next) {
        const binding = store.getBinding(channel, identityId, peerKey);
        const current =
          binding?.directory?.trim() || store.getSession(channel, identityId, peerKey)?.directory?.trim() || defaultDirectory;
        await sendText(channel, identityId, peerId, `Current directory: ${current || "(none)"}`, { kind: "system" });
        return true;
      }
      const scoped = resolveScopedDirectory(next);
      if (!scoped.ok) {
        await sendText(channel, identityId, peerId, scoped.error, { kind: "system" });
        return true;
      }
      const normalized = scoped.directory;
      store.upsertBinding(channel, identityId, peerKey, normalized);
      store.deleteSession(channel, identityId, peerKey);
      ensureEventSubscription(normalized);
      await sendText(channel, identityId, peerId, `Directory set to: ${normalized}`, { kind: "system" });
      return true;
    }

    if (command === "agent") {
      const config = await loadMessagingAgentConfig();
      await sendText(
        channel,
        identityId,
        peerId,
        [
          `Scope: workspace`,
          `Agent file: ${config.filePath}`,
          `OpenCode agent: ${config.selectedAgent ?? "(none)"}`,
          `Status: ${config.loaded ? "loaded" : "missing or empty"}`,
        ].join("\n"),
        { kind: "system" },
      );
      return true;
    }

    // /help command
    if (command === "help") {
      const helpText = `/opus - Claude Opus 4.5\n/codex - GPT 5.2 Codex\n/pair <code> - pair this chat with a private Telegram bot\n/dir <path> - bind this chat to a workspace directory\n/dir - show current directory\n/agent - show workspace agent scope/path\n/model - show current\n/reset - start fresh\n/help - this`;
      await sendText(channel, identityId, peerId, helpText, { kind: "system" });
      return true;
    }

    // Unknown command - don't handle, let it pass through as a message
    return false;
  }

  async function createSession(input: {
    channel: ChannelName;
    identityId: string;
    peerId: string;
    peerKey: string;
    directory: string;
  }): Promise<string> {
    const title = `opencode-router ${input.channel}/${input.identityId} ${input.peerId}`;
    const session = await getClient(input.directory).session.create({
      title,
      permission: buildPermissionRules(config.permissionMode),
    });
    const sessionID = (session as { id?: string }).id;
    if (!sessionID) throw new Error("Failed to create session");
    store.upsertSession(input.channel, input.identityId, input.peerKey, sessionID, input.directory);
    logger.info(
      { sessionID, channel: input.channel, identityId: input.identityId, peerId: input.peerKey, directory: input.directory },
      "session created",
    );
    reportStatus?.(
      `${CHANNEL_LABELS[input.channel]}/${input.identityId} session created for ${formatPeer(input.channel, input.peerId)} (ID: ${sessionID}).`,
    );
    await sendText(input.channel, input.identityId, input.peerId, "🧭 Session started.", { kind: "system" });
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

  for (const adapter of Array.from(adapters.values())) {
    const startResult = await startAdapterBounded(adapter, {
      timeoutMs: 8_000,
      onError: (error) => {
        logger.error({ error, channel: adapter.name, identityId: adapter.identityId }, "adapter start failed");
        adapters.delete(adapter.key);
      },
    });

    if (startResult.status === "timeout") {
      logger.warn({ channel: adapter.name, identityId: adapter.identityId, timeoutMs: 8_000 }, "adapter start timed out");
      reportStatus?.(`${CHANNEL_LABELS[adapter.name]}/${adapter.identityId} adapter starting...`);
      continue;
    }

    if (startResult.status === "error") {
      reportStatus?.(`${CHANNEL_LABELS[adapter.name]}/${adapter.identityId} adapter failed to start.`);
      continue;
    }

    reportStatus?.(`${CHANNEL_LABELS[adapter.name]}/${adapter.identityId} adapter started.`);
  }

  logger.info({ channels: Array.from(adapters.keys()) }, "bridge started");
  reportStatus?.(`Bridge running. Logs: ${config.logFile}`);

  return {
    async stop() {
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
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
    async dispatchInbound(message: {
      channel: ChannelName;
      identityId?: string;
      peerId: string;
      text: string;
      raw?: unknown;
      fromMe?: boolean;
    }) {
      const identityId = (message.identityId ?? "default").trim() || "default";
      await handleInbound({
        channel: message.channel,
        identityId,
        peerId: message.peerId,
        text: message.text,
        raw: message.raw ?? null,
        fromMe: message.fromMe,
      });

      // For tests and programmatic callers: wait for the session queue to drain.
      const peerKey = message.peerId;
      const session = store.getSession(message.channel, identityId, peerKey);
      const sessionID = session?.session_id;
      const directory =
        session?.directory?.trim() || store.getBinding(message.channel, identityId, peerKey)?.directory?.trim() || defaultDirectory;
      const pending = sessionID && directory ? sessionQueue.get(keyForSession(directory, sessionID)) : null;
      if (pending) {
        await pending;
      }
    },
  };
}
