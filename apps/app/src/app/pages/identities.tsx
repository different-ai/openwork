import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  ArrowRight,
  ChevronRight,
  Copy,
  Link,
  RefreshCcw,
  Shield,
} from "lucide-solid";

import { t, td } from "../../i18n";

import Button from "../components/button";
import ConfirmModal from "../components/confirm-modal";
import {
  buildOpenworkWorkspaceBaseUrl,
  OpenworkServerError,
  parseOpenworkWorkspaceIdFromUrl,
} from "../lib/openwork-server";
import type {
  OpenworkServerClient,
  OpenworkOpenCodeRouterHealthSnapshot,
  OpenworkOpenCodeRouterIdentityItem,
  OpenworkOpenCodeRouterSendResult,
  OpenworkServerStatus,
  OpenworkWorkspaceFileContent,
} from "../lib/openwork-server";

export type IdentitiesViewProps = {
  busy: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerClient: OpenworkServerClient | null;
  openworkReconnectBusy: boolean;
  reconnectOpenworkServer: () => Promise<boolean>;
  restartLocalServer: () => Promise<boolean>;
  runtimeWorkspaceId: string | null;
  selectedWorkspaceRoot: string;
  developerMode: boolean;
  showHeader?: boolean;
};

const OPENCODE_ROUTER_AGENT_FILE_PATH = ".opencode/agents/opencode-router.md";
const OPENCODE_ROUTER_AGENT_FILE_TEMPLATE = `# OpenCodeRouter Messaging Agent

Use this file to define how the assistant responds in Slack/Telegram for this workspace.

Examples:
- Keep responses concise and action-oriented.
- Use tools directly; never ask end users to run router commands.
- Never expose raw peer IDs or Telegram chat IDs unless the user explicitly asks for debug output.
- Never ask end users for peer IDs or identity IDs.
- For outbound delivery, call opencode_router_status and opencode_router_send yourself.
- If Telegram says chat not found, tell the user the recipient must message the bot first (for example /start), then retry.
`;

function formatRequestError(error: unknown): string {
  if (error instanceof OpenworkServerError) {
    return `${error.message} (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isOpenCodeRouterSnapshot(value: unknown): value is OpenworkOpenCodeRouterHealthSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    typeof record.opencode === "object" &&
    typeof record.channels === "object" &&
    typeof record.config === "object"
  );
}

function isOpenCodeRouterIdentities(value: unknown): value is { ok: boolean; items: OpenworkOpenCodeRouterIdentityItem[] } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.ok === "boolean" && Array.isArray(record.items);
}

function getTelegramUsernameFromResult(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const bot = record.bot;
  if (!bot || typeof bot !== "object") return null;
  const username = (bot as Record<string, unknown>).username;
  if (typeof username !== "string") return null;
  const normalized = username.trim().replace(/^@+/, "");
  return normalized || null;
}

function readMessagingEnabledFromOpenworkConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const messaging = record.messaging;
  if (!messaging || typeof messaging !== "object" || Array.isArray(messaging)) return false;
  return (messaging as Record<string, unknown>).enabled === true;
}

/* ---- Brand channel icons ---- */

function TelegramIcon(props: { size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" fill="#229ED9" />
      <path d="M7 12.5l2.5 2L16 8.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M9.5 14.5l-.5 3 2-1.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function SlackIcon(props: { size?: number }) {
  const s = () => props.size ?? 20;
  return (
    <svg width={s()} height={s()} viewBox="0 0 24 24" fill="none">
      <path d="M14.5 2a2 2 0 012 2v4.5h-2a2 2 0 010-4h0V2z" fill="#E01E5A" />
      <path d="M2 9.5a2 2 0 012-2h4.5v2a2 2 0 01-4 0V9.5z" fill="#36C5F0" />
      <path d="M9.5 22a2 2 0 01-2-2v-4.5h2a2 2 0 010 4v2.5z" fill="#2EB67D" />
      <path d="M22 14.5a2 2 0 01-2 2h-4.5v-2a2 2 0 014 0h2.5z" fill="#ECB22E" />
      <path d="M8.5 9.5h2v2h-2z" fill="#36C5F0" />
      <path d="M13.5 9.5h2v2h-2z" fill="#ECB22E" />
      <path d="M8.5 14.5h2v-2h-2z" fill="#2EB67D" />
      <path d="M13.5 14.5h2v-2h-2z" fill="#E01E5A" />
    </svg>
  );
}

/* ---- Status pill sub-component ---- */

function StatusPill(props: { label: string; value: string; ok: boolean }) {
  return (
    <div class="flex-1 rounded-lg border border-gray-4 bg-gray-1 px-3.5 py-2.5">
      <div class="text-[11px] text-gray-9 mb-0.5">{props.label}</div>
      <div class={`text-[13px] font-semibold ${props.ok ? "text-gray-12" : "text-gray-8"}`}>{props.value}</div>
    </div>
  );
}

/* ---- Main ---- */

export default function IdentitiesView(props: IdentitiesViewProps) {
  const [refreshing, setRefreshing] = createSignal(false);

  const [health, setHealth] = createSignal<OpenworkOpenCodeRouterHealthSnapshot | null>(null);
  const [healthError, setHealthError] = createSignal<string | null>(null);

  const [telegramIdentities, setTelegramIdentities] = createSignal<OpenworkOpenCodeRouterIdentityItem[]>([]);
  const [telegramIdentitiesError, setTelegramIdentitiesError] = createSignal<string | null>(null);

  const [slackIdentities, setSlackIdentities] = createSignal<OpenworkOpenCodeRouterIdentityItem[]>([]);
  const [slackIdentitiesError, setSlackIdentitiesError] = createSignal<string | null>(null);

  const [telegramToken, setTelegramToken] = createSignal("");
  const [telegramEnabled, setTelegramEnabled] = createSignal(true);
  const [telegramSaving, setTelegramSaving] = createSignal(false);
  const [telegramStatus, setTelegramStatus] = createSignal<string | null>(null);
  const [telegramError, setTelegramError] = createSignal<string | null>(null);
  const [telegramBotUsername, setTelegramBotUsername] = createSignal<string | null>(null);
  const [telegramPairingCode, setTelegramPairingCode] = createSignal<string | null>(null);
  const [publicTelegramWarningOpen, setPublicTelegramWarningOpen] = createSignal(false);

  const [slackBotToken, setSlackBotToken] = createSignal("");
  const [slackAppToken, setSlackAppToken] = createSignal("");
  const [slackEnabled, setSlackEnabled] = createSignal(true);
  const [slackSaving, setSlackSaving] = createSignal(false);
  const [slackStatus, setSlackStatus] = createSignal<string | null>(null);
  const [slackError, setSlackError] = createSignal<string | null>(null);

  const [expandedChannel, setExpandedChannel] = createSignal<string | null>("telegram");
  const [activeTab, setActiveTab] = createSignal<"general" | "advanced">("general");

  const [agentLoading, setAgentLoading] = createSignal(false);
  const [agentSaving, setAgentSaving] = createSignal(false);
  const [agentExists, setAgentExists] = createSignal(false);
  const [agentContent, setAgentContent] = createSignal("");
  const [agentDraft, setAgentDraft] = createSignal("");
  const [agentBaseUpdatedAt, setAgentBaseUpdatedAt] = createSignal<number | null>(null);
  const [agentStatus, setAgentStatus] = createSignal<string | null>(null);
  const [agentError, setAgentError] = createSignal<string | null>(null);

  const [sendChannel, setSendChannel] = createSignal<"telegram" | "slack">("telegram");
  const [sendDirectory, setSendDirectory] = createSignal("");
  const [sendPeerId, setSendPeerId] = createSignal("");
  const [sendAutoBind, setSendAutoBind] = createSignal(true);
  const [sendText, setSendText] = createSignal("");
  const [sendBusy, setSendBusy] = createSignal(false);
  const [sendStatus, setSendStatus] = createSignal<string | null>(null);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [sendResult, setSendResult] = createSignal<OpenworkOpenCodeRouterSendResult | null>(null);

  const [reconnectStatus, setReconnectStatus] = createSignal<string | null>(null);
  const [reconnectError, setReconnectError] = createSignal<string | null>(null);
  const [messagingEnabled, setMessagingEnabled] = createSignal(false);
  const [messagingSaving, setMessagingSaving] = createSignal(false);
  const [messagingStatus, setMessagingStatus] = createSignal<string | null>(null);
  const [messagingError, setMessagingError] = createSignal<string | null>(null);
  const [messagingRiskOpen, setMessagingRiskOpen] = createSignal(false);
  const [messagingRestartRequired, setMessagingRestartRequired] = createSignal(false);
  const [messagingRestartPromptOpen, setMessagingRestartPromptOpen] = createSignal(false);
  const [messagingRestartBusy, setMessagingRestartBusy] = createSignal(false);
  const [messagingDisableConfirmOpen, setMessagingDisableConfirmOpen] = createSignal(false);
  const [messagingRestartAction, setMessagingRestartAction] = createSignal<"enable" | "disable">("enable");

  const workspaceId = createMemo(() => {
    const explicitId = props.runtimeWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseOpenworkWorkspaceIdFromUrl(props.openworkServerUrl) ?? "";
  });

  const scopedOpenworkBaseUrl = createMemo(() => {
    const baseUrl = props.openworkServerUrl.trim();
    if (!baseUrl) return "";
    return buildOpenworkWorkspaceBaseUrl(baseUrl, workspaceId()) ?? baseUrl;
  });

  const openworkServerClient = createMemo(() => props.openworkServerClient);

  const serverReady = createMemo(() => props.openworkServerStatus === "connected" && Boolean(openworkServerClient()));
  const scopedWorkspaceReady = createMemo(() => Boolean(workspaceId()));
  const defaultRoutingDirectory = createMemo(() => props.selectedWorkspaceRoot.trim() || td("identities.not_set", "Not set"));

  let lastResetKey = "";

  const statusLabel = createMemo(() => {
    if (healthError()) return td("identities.health_unavailable", "Unavailable");
    const snapshot = health();
    if (!snapshot) return td("identities.health_unknown", "Unknown");
    return snapshot.ok ? td("identities.health_running", "Running") : td("identities.health_offline", "Offline");
  });

  const isWorkerOnline = createMemo(() => {
    const snapshot = health();
    return snapshot?.ok === true;
  });

  const connectedChannelCount = createMemo(() => {
    let count = 0;
    if (telegramIdentities().some((i) => i.enabled && i.running)) count++;
    if (slackIdentities().some((i) => i.enabled && i.running)) count++;
    return count;
  });

  const hasTelegramConnected = createMemo(() => telegramIdentities().some((i) => i.enabled));
  const hasSlackConnected = createMemo(() => slackIdentities().some((i) => i.enabled));
  const telegramBotLink = createMemo(() => {
    const username = telegramBotUsername();
    if (!username) return null;
    return `https://t.me/${username}`;
  });
  const agentDirty = createMemo(() => agentDraft() !== agentContent());

  const messagesToday = createMemo(() => {
    const activity = health()?.activity;
    if (!activity) return null;
    const inbound = typeof activity.inboundToday === "number" ? activity.inboundToday : 0;
    const outbound = typeof activity.outboundToday === "number" ? activity.outboundToday : 0;
    return inbound + outbound;
  });

  const lastActivityAt = createMemo(() => {
    const ts = health()?.activity?.lastMessageAt;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
  });

  const lastActivityLabel = createMemo(() => {
    const ts = lastActivityAt();
    if (!ts) return "\u2014";
    const elapsedMs = Math.max(0, Date.now() - ts);
    if (elapsedMs < 60_000) return td("identities.just_now", "Just now");
    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 60) return td("identities.minutes_ago", "{minutes}m ago", { minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return td("identities.hours_ago", "{hours}h ago", { hours });
    const days = Math.floor(hours / 24);
    return td("identities.days_ago", "{days}d ago", { days });
  });

  const workspaceAgentStatus = createMemo(() => {
    const agent = health()?.agent;
    if (!agent) return null;
    return {
      path: agent.path,
      loaded: agent.loaded,
      selected: agent.selected ?? "",
    };
  });

  const resetAgentState = () => {
    setAgentLoading(false);
    setAgentSaving(false);
    setAgentExists(false);
    setAgentContent("");
    setAgentDraft("");
    setAgentBaseUpdatedAt(null);
    setAgentStatus(null);
    setAgentError(null);
  };

  const loadAgentFile = async () => {
    if (agentLoading()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) {
      resetAgentState();
      setAgentError(td("identities.agent_worker_scope_unavailable", "Worker scope unavailable."));
      return;
    }
    const client = openworkServerClient();
    if (!client) return;

    setAgentLoading(true);
    setAgentError(null);
    try {
      const result = (await client.readWorkspaceFile(id, OPENCODE_ROUTER_AGENT_FILE_PATH)) as OpenworkWorkspaceFileContent;
      const nextContent = result.content ?? "";
      setAgentExists(true);
      setAgentContent(nextContent);
      setAgentDraft(nextContent);
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
    } catch (error) {
      if (error instanceof OpenworkServerError && error.status === 404) {
        setAgentExists(false);
        setAgentContent("");
        setAgentDraft("");
        setAgentBaseUpdatedAt(null);
        return;
      }
      setAgentError(formatRequestError(error));
    } finally {
      setAgentLoading(false);
    }
  };

  const createDefaultAgentFile = async () => {
    if (agentSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    setAgentSaving(true);
    setAgentStatus(null);
    setAgentError(null);
    try {
      const result = await client.writeWorkspaceFile(id, {
        path: OPENCODE_ROUTER_AGENT_FILE_PATH,
        content: OPENCODE_ROUTER_AGENT_FILE_TEMPLATE,
      });
      setAgentExists(true);
      setAgentContent(OPENCODE_ROUTER_AGENT_FILE_TEMPLATE);
      setAgentDraft(OPENCODE_ROUTER_AGENT_FILE_TEMPLATE);
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      setAgentStatus(td("identities.agent_created", "Created default messaging agent file."));
    } catch (error) {
      setAgentError(formatRequestError(error));
    } finally {
      setAgentSaving(false);
    }
  };

  const saveAgentFile = async () => {
    if (agentSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    setAgentSaving(true);
    setAgentStatus(null);
    setAgentError(null);
    try {
      const result = await client.writeWorkspaceFile(id, {
        path: OPENCODE_ROUTER_AGENT_FILE_PATH,
        content: agentDraft(),
        baseUpdatedAt: agentBaseUpdatedAt(),
      });
      setAgentExists(true);
      setAgentContent(agentDraft());
      setAgentBaseUpdatedAt(typeof result.updatedAt === "number" ? result.updatedAt : null);
      setAgentStatus(td("identities.agent_saved", "Saved messaging behavior."));
    } catch (error) {
      if (error instanceof OpenworkServerError && error.status === 409) {
        setAgentError(td("identities.agent_file_changed", "File changed remotely. Reload and save again."));
      } else {
        setAgentError(formatRequestError(error));
      }
    } finally {
      setAgentSaving(false);
    }
  };

  const sendTestMessage = async () => {
    if (sendBusy()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;
    const text = sendText().trim();
    if (!text) return;

    setSendBusy(true);
    setSendStatus(null);
    setSendError(null);
    setSendResult(null);
    try {
      const result = await client.sendOpenCodeRouterMessage(id, {
        channel: sendChannel(),
        text,
        ...(sendDirectory().trim() ? { directory: sendDirectory().trim() } : {}),
        ...(sendPeerId().trim() ? { peerId: sendPeerId().trim() } : {}),
        ...(sendAutoBind() ? { autoBind: true } : {}),
      });
      setSendResult(result);
      const base = td("identities.dispatched_messages", "Dispatched {sent}/{attempted} messages.", { sent: result.sent, attempted: result.attempted });
      setSendStatus(result.reason?.trim() ? `${base} ${result.reason.trim()}` : base);
    } catch (error) {
      setSendError(formatRequestError(error));
    } finally {
      setSendBusy(false);
    }
  };

  const refreshAll = async (options?: { force?: boolean }) => {
    if (refreshing() && !options?.force) return;
    if (!serverReady()) return;
    const client = openworkServerClient();
    if (!client) return;
    const id = workspaceId();

    setRefreshing(true);
    try {
      setHealthError(null);
      setTelegramIdentitiesError(null);
      setSlackIdentitiesError(null);
      setMessagingError(null);

      if (!id) {
        setHealth(null);
        setTelegramIdentities([]);
        setTelegramBotUsername(null);
        setTelegramPairingCode(null);
        setSlackIdentities([]);
        setHealthError(td("identities.worker_scope_unavailable_detail", "Worker scope unavailable. Reconnect using a worker URL or switch to a known worker."));
        setTelegramIdentitiesError(td("identities.worker_scope_unavailable", "Worker scope unavailable."));
        setSlackIdentitiesError(td("identities.worker_scope_unavailable", "Worker scope unavailable."));
        resetAgentState();
        setSendStatus(null);
        setSendError(null);
        setSendResult(null);
        return;
      }

      const config = await client.getConfig(id).catch(() => null);
      const isModuleEnabled = readMessagingEnabledFromOpenworkConfig(config?.openwork);
      setMessagingEnabled(isModuleEnabled);

      if (!isModuleEnabled) {
        setMessagingRestartRequired(false);
        setHealth(null);
        setHealthError(null);
        setTelegramIdentities([]);
        setTelegramIdentitiesError(null);
        setTelegramBotUsername(null);
        setTelegramPairingCode(null);
        setSlackIdentities([]);
        setSlackIdentitiesError(null);
        if (!agentDirty() && !agentSaving()) {
          void loadAgentFile();
        }
        return;
      }

      const [healthRes, tgRes, slackRes, telegramInfo] = await Promise.all([
        client.getOpenCodeRouterHealth(id),
        client.getOpenCodeRouterTelegramIdentities(id),
        client.getOpenCodeRouterSlackIdentities(id),
        client.getOpenCodeRouterTelegram(id).catch(() => null),
      ]);

      setTelegramBotUsername(getTelegramUsernameFromResult(telegramInfo));

      if (isOpenCodeRouterSnapshot(healthRes.json)) {
        setHealth(healthRes.json);
        setMessagingRestartRequired(false);
      } else {
        setHealth(null);
        if (!healthRes.ok) {
          const message =
            (healthRes.json && typeof (healthRes.json as any).message === "string")
              ? String((healthRes.json as any).message)
              : td("identities.health_unavailable_status", "OpenCodeRouter health unavailable ({status})", { status: healthRes.status });
          setHealthError(message);
        }
        setMessagingRestartRequired(true);
      }

      if (isOpenCodeRouterIdentities(tgRes)) {
        setTelegramIdentities(tgRes.items ?? []);
        if (!tgRes.items?.length) {
          setTelegramPairingCode(null);
        }
      } else {
        setTelegramIdentities([]);
        setTelegramPairingCode(null);
        setTelegramIdentitiesError(td("identities.telegram_unavailable", "Telegram identities unavailable."));
      }

      if (isOpenCodeRouterIdentities(slackRes)) {
        setSlackIdentities(slackRes.items ?? []);
      } else {
        setSlackIdentities([]);
        setSlackIdentitiesError(td("identities.slack_unavailable", "Slack identities unavailable."));
      }

      if (!agentDirty() && !agentSaving()) {
        void loadAgentFile();
      }
    } catch (error) {
      const message = formatRequestError(error);
      setHealth(null);
      setTelegramIdentities([]);
      setTelegramBotUsername(null);
      setSlackIdentities([]);
      setHealthError(message);
      setTelegramIdentitiesError(message);
      setSlackIdentitiesError(message);
      if (messagingEnabled()) {
        setMessagingRestartRequired(true);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const repairAndReconnect = async () => {
    if (props.openworkReconnectBusy) return;
    setReconnectStatus(null);
    setReconnectError(null);

    const ok = await props.reconnectOpenworkServer();
    if (!ok) {
      setReconnectError(td("identities.reconnect_failed", "Reconnect failed. Check OpenWork URL/token and try again."));
      return;
    }

    setReconnectStatus(td("identities.reconnected_refreshing", "Reconnected. Refreshing worker state..."));
    await refreshAll({ force: true });
    setReconnectStatus(td("identities.reconnected", "Reconnected."));
  };

  const enableMessagingModule = async () => {
    if (messagingSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    setMessagingSaving(true);
    setMessagingStatus(null);
    setMessagingError(null);
    try {
      await client.patchConfig(id, {
        openwork: {
          messaging: {
            enabled: true,
          },
        },
      });
      setMessagingEnabled(true);
      setMessagingRestartRequired(true);
      setMessagingRiskOpen(false);
      setMessagingRestartAction("enable");
      setMessagingRestartPromptOpen(true);
      setMessagingStatus(td("identities.messaging_enabled_restart", "Messaging enabled. Restart this worker to apply before configuring channels."));
      await refreshAll({ force: true });
    } catch (error) {
      setMessagingError(formatRequestError(error));
    } finally {
      setMessagingSaving(false);
    }
  };

  const disableMessagingModule = async () => {
    if (messagingSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    setMessagingSaving(true);
    setMessagingStatus(null);
    setMessagingError(null);
    try {
      await client.patchConfig(id, {
        openwork: {
          messaging: {
            enabled: false,
          },
        },
      });
      setMessagingEnabled(false);
      setMessagingDisableConfirmOpen(false);
      setMessagingRestartRequired(true);
      setMessagingRestartAction("disable");
      setMessagingRestartPromptOpen(true);
      setMessagingStatus(td("identities.messaging_disabled_restart", "Messaging disabled. Restart this worker to stop the messaging sidecar."));
      await refreshAll({ force: true });
    } catch (error) {
      setMessagingError(formatRequestError(error));
    } finally {
      setMessagingSaving(false);
    }
  };

  const restartMessagingWorker = async () => {
    if (messagingRestartBusy()) return;
    setMessagingRestartBusy(true);
    setMessagingError(null);
    setMessagingStatus(null);
    try {
      const ok = await props.restartLocalServer();
      if (!ok) {
      setMessagingError(td("identities.restart_failed", "Restart failed. Please restart the worker from Settings and try again."));
      return;
    }
      setMessagingRestartPromptOpen(false);
      setMessagingRestartRequired(false);
      setMessagingStatus(td("identities.worker_restarted_refreshing", "Worker restarted. Refreshing messaging status..."));
      await refreshAll({ force: true });
      setMessagingStatus(td("identities.worker_restarted", "Worker restarted."));
    } catch (error) {
      setMessagingError(formatRequestError(error));
    } finally {
      setMessagingRestartBusy(false);
    }
  };

  const upsertTelegram = async (access: "public" | "private") => {
    if (telegramSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    const token = telegramToken().trim();
    if (!token) return;

    setTelegramSaving(true);
    setTelegramStatus(null);
    setTelegramError(null);
    try {
      const result = await client.upsertOpenCodeRouterTelegramIdentity(id, {
        token,
        enabled: telegramEnabled(),
        access,
      });
      if (result.ok) {
        const pairingCode = typeof result.telegram?.pairingCode === "string" ? result.telegram.pairingCode.trim() : "";
        if (access === "private" && pairingCode) {
          setTelegramPairingCode(pairingCode);
          setTelegramStatus(td("identities.telegram_private_saved_pair", "Private bot saved. Pair via /pair {code}", { code: pairingCode }));
        } else {
          setTelegramPairingCode(null);
        }
        const username = (result.telegram as any)?.bot?.username;
        if (username) {
          const normalized = String(username).trim().replace(/^@+/, "");
          setTelegramBotUsername(normalized || null);
          if (access !== "private" || !pairingCode) {
            setTelegramStatus(td("identities.telegram_saved_username", "Saved (@{username})", { username: normalized || String(username) }));
          }
        } else {
          if (access !== "private" || !pairingCode) {
            setTelegramStatus(result.applied === false ? td("identities.telegram_saved_pending", "Saved (pending apply).") : td("identities.telegram_saved", "Saved."));
          }
        }
      } else {
        setTelegramError(td("identities.telegram_save_failed", "Failed to save."));
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setTelegramError(result.applyError.trim());
      }
      setTelegramToken("");
      void refreshAll({ force: true });
    } catch (error) {
      setTelegramError(formatRequestError(error));
    } finally {
      setTelegramSaving(false);
    }
  };

  const deleteTelegram = async (identityId: string) => {
    if (telegramSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;
    if (!identityId.trim()) return;

    setTelegramSaving(true);
    setTelegramStatus(null);
    setTelegramError(null);
    try {
      const result = await client.deleteOpenCodeRouterTelegramIdentity(id, identityId);
      if (result.ok) {
        setTelegramBotUsername(null);
        setTelegramPairingCode(null);
        setTelegramStatus(result.applied === false ? td("identities.telegram_deleted_pending", "Deleted (pending apply).") : td("identities.telegram_deleted", "Deleted."));
      } else {
        setTelegramError(td("identities.telegram_delete_failed", "Failed to delete."));
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setTelegramError(result.applyError.trim());
      }
      void refreshAll({ force: true });
    } catch (error) {
      setTelegramError(formatRequestError(error));
    } finally {
      setTelegramSaving(false);
    }
  };

  const copyTelegramPairingCode = async () => {
    const code = telegramPairingCode();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setTelegramStatus(td("identities.pairing_code_copied", "Pairing code copied."));
    } catch {
      setTelegramError(td("identities.pairing_code_copy_failed", "Could not copy pairing code. Copy it manually."));
    }
  };

  const upsertSlack = async () => {
    if (slackSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;

    const botToken = slackBotToken().trim();
    const appToken = slackAppToken().trim();
    if (!botToken || !appToken) return;

    setSlackSaving(true);
    setSlackStatus(null);
    setSlackError(null);
    try {
      const result = await client.upsertOpenCodeRouterSlackIdentity(id, { botToken, appToken, enabled: slackEnabled() });
      if (result.ok) {
        setSlackStatus(result.applied === false ? td("identities.telegram_saved_pending", "Saved (pending apply).") : td("identities.telegram_saved", "Saved."));
      } else {
        setSlackError(td("identities.telegram_save_failed", "Failed to save."));
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setSlackError(result.applyError.trim());
      }
      setSlackBotToken("");
      setSlackAppToken("");
      void refreshAll({ force: true });
    } catch (error) {
      setSlackError(formatRequestError(error));
    } finally {
      setSlackSaving(false);
    }
  };

  const deleteSlack = async (identityId: string) => {
    if (slackSaving()) return;
    if (!serverReady()) return;
    const id = workspaceId();
    if (!id) return;
    const client = openworkServerClient();
    if (!client) return;
    if (!identityId.trim()) return;

    setSlackSaving(true);
    setSlackStatus(null);
    setSlackError(null);
    try {
      const result = await client.deleteOpenCodeRouterSlackIdentity(id, identityId);
      if (result.ok) {
        setSlackStatus(result.applied === false ? td("identities.telegram_deleted_pending", "Deleted (pending apply).") : td("identities.telegram_deleted", "Deleted."));
      } else {
        setSlackError(td("identities.telegram_delete_failed", "Failed to delete."));
      }
      if (typeof result.applyError === "string" && result.applyError.trim()) {
        setSlackError(result.applyError.trim());
      }
      void refreshAll({ force: true });
    } catch (error) {
      setSlackError(formatRequestError(error));
    } finally {
      setSlackSaving(false);
    }
  };

  createEffect(() => {
    const baseUrl = scopedOpenworkBaseUrl().trim();
    const id = workspaceId();
    const nextKey = `${baseUrl}|${id}`;
    if (nextKey === lastResetKey) return;
    lastResetKey = nextKey;

    setHealth(null);
    setHealthError(null);
    setTelegramIdentities([]);
    setTelegramIdentitiesError(null);
    setTelegramBotUsername(null);
    setTelegramPairingCode(null);
    setSlackIdentities([]);
    setSlackIdentitiesError(null);
    resetAgentState();
    setSendStatus(null);
    setSendError(null);
    setSendResult(null);
    setReconnectStatus(null);
    setReconnectError(null);
    setMessagingEnabled(false);
    setMessagingSaving(false);
    setMessagingStatus(null);
    setMessagingError(null);
    setMessagingRiskOpen(false);
    setMessagingRestartRequired(false);
    setMessagingRestartPromptOpen(false);
    setMessagingRestartBusy(false);
    setMessagingDisableConfirmOpen(false);
    setMessagingRestartAction("enable");
    setActiveTab("general");
    setExpandedChannel("telegram");
  });

  onMount(() => {
    void refreshAll({ force: true });
    const interval = window.setInterval(() => void refreshAll(), 10_000);
    onCleanup(() => window.clearInterval(interval));
  });

  const toggleExpand = (channel: string) => {
    setExpandedChannel((prev) => (prev === channel ? null : channel));
  };

  return (
    <div class="w-full space-y-6">

      {/* ---- Header ---- */}
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <Show when={props.showHeader !== false}>
            <h1 class="text-lg font-bold text-gray-12 tracking-tight">{td("identities.title", "Messaging channels")}</h1>
          </Show>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              onClick={() => void repairAndReconnect()}
              disabled={props.busy || props.openworkReconnectBusy}
            >
              <RefreshCcw size={14} class={props.openworkReconnectBusy ? "animate-spin" : ""} />
              <span class="ml-1.5">{td("identities.repair_reconnect", "Repair & reconnect")}</span>
            </Button>
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              onClick={() => refreshAll({ force: true })}
              disabled={!serverReady() || refreshing()}
            >
              <RefreshCcw size={14} class={refreshing() ? "animate-spin" : ""} />
              <span class="ml-1.5">{td("common.refresh", "Refresh")}</span>
            </Button>
          </div>
        </div>
        <Show when={props.showHeader !== false}>
          <p class="text-sm text-gray-9 leading-relaxed">
            {td("identities.subtitle", "Let people reach your worker through messaging apps. Connect a channel and your worker will automatically read and respond to messages.")}
          </p>
        </Show>
        <div class="mt-1.5 text-[11px] text-gray-8 font-mono break-all">
          {td("identities.workspace_scope_prefix", "Workspace scope:")} {scopedOpenworkBaseUrl().trim() || props.openworkServerUrl.trim() || td("identities.not_set", "Not set")}
        </div>
        <Show when={reconnectStatus()}>
          {(value) => <div class="mt-1 text-[11px] text-gray-9">{value()}</div>}
        </Show>
        <Show when={reconnectError()}>
          {(value) => <div class="mt-1 text-[11px] text-red-12">{value()}</div>}
        </Show>
        <Show when={messagingStatus()}>
          {(value) => <div class="mt-1 text-[11px] text-gray-9">{value()}</div>}
        </Show>
        <Show when={messagingError()}>
          {(value) => <div class="mt-1 text-[11px] text-red-12">{value()}</div>}
        </Show>
      </div>

      {/* ---- Not connected to server ---- */}
      <Show when={!serverReady()}>
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-5">
          <div class="text-sm font-semibold text-gray-12">{td("identities.connect_server_title", "Connect to an OpenWork server")}</div>
          <div class="mt-1 text-xs text-gray-10">
            {td("identities.connect_server_desc", "Identities are available when you are connected to an OpenWork host.")}
          </div>
        </div>
      </Show>

      <Show when={serverReady()}>
        <Show when={!scopedWorkspaceReady()}>
          <div class="rounded-xl border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
            {td("identities.workspace_id_required", "Workspace ID is required to manage identities. Reconnect with a workspace URL or select a workspace mapped on this host.")}
          </div>
        </Show>

        <Show when={messagingEnabled()}>
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div class="flex items-center gap-2 rounded-xl border border-gray-4 bg-gray-1 p-1 flex-1">
              <button
                class={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                  activeTab() === "general"
                    ? "bg-gray-12 text-gray-1"
                    : "text-gray-10 hover:bg-gray-2"
                }`}
                onClick={() => setActiveTab("general")}
              >
                {td("identities.tab_general", "General")}
              </button>
              <button
                class={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                  activeTab() === "advanced"
                    ? "bg-gray-12 text-gray-1"
                    : "text-gray-10 hover:bg-gray-2"
                }`}
                onClick={() => setActiveTab("advanced")}
              >
                {td("settings.tab_advanced", "Advanced")}
              </button>
            </div>
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              disabled={messagingSaving()}
              onClick={() => setMessagingDisableConfirmOpen(true)}
            >
              {td("identities.disable_messaging", "Disable messaging")}
            </Button>
          </div>
        </Show>

        <Show when={!messagingEnabled()}>
          <div class="rounded-xl border border-gray-4 bg-gray-1 px-4 py-4 space-y-3">
            <div class="text-sm font-semibold text-gray-12">{td("identities.messaging_disabled_title", "Messaging is disabled by default")}</div>
            <p class="text-xs text-gray-10 leading-relaxed">
              {td("identities.messaging_disabled_risk", "Messaging bots can execute actions against your local worker. If exposed publicly, they may allow access to files, credentials, and API keys available to this worker.")}
            </p>
            <p class="text-xs text-gray-10 leading-relaxed">
              {td("identities.messaging_disabled_hint", "Enable messaging only if you understand the risk and plan to secure access (for example, private Telegram pairing).")}
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                class="h-8 px-3 text-xs"
                disabled={messagingSaving() || !workspaceId()}
                onClick={() => setMessagingRiskOpen(true)}
              >
                {messagingSaving() ? td("identities.enabling", "Enabling...") : td("identities.enable_messaging", "Enable messaging")}
              </Button>
            </div>
          </div>
        </Show>

        <Show when={activeTab() === "general" && messagingEnabled()}>

        <Show when={messagingRestartRequired()}>
          <div class="rounded-xl border border-gray-4 bg-gray-1 px-4 py-3 text-xs text-gray-10 leading-relaxed">
            {td("identities.messaging_sidecar_not_running", "Messaging is enabled in this workspace, but the messaging sidecar is not running yet. Restart this worker, then return to Messaging settings to connect Telegram or Slack.")}
            <div class="mt-3">
              <Button
                variant="primary"
                class="h-8 px-3 text-xs"
                disabled={messagingRestartBusy()}
                onClick={() => void restartMessagingWorker()}
              >
                {messagingRestartBusy() ? td("identities.restarting", "Restarting...") : td("identities.restart_worker", "Restart worker")}
              </Button>
            </div>
          </div>
        </Show>

        {/* ---- Worker status card ---- */}
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-4 space-y-3.5">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <Show
                when={isWorkerOnline()}
                fallback={
                  <div class="w-2.5 h-2.5 rounded-full bg-gray-8" />
                }
              >
                <div class="w-2.5 h-2.5 rounded-full bg-emerald-9 animate-pulse" />
              </Show>
              <span class="text-[15px] font-semibold text-gray-12">
                {isWorkerOnline() ? td("identities.worker_online", "Worker online") : healthError() ? td("identities.worker_unavailable", "Worker unavailable") : td("identities.worker_offline", "Worker offline")}
              </span>
            </div>
            <span
              class={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                isWorkerOnline()
                  ? "border-emerald-7/25 bg-emerald-1/40 text-emerald-11"
                  : healthError()
                    ? "border-red-7/20 bg-red-1/40 text-red-12"
                    : "border-amber-7/25 bg-amber-1/40 text-amber-12"
              }`}
            >
              {statusLabel()}
            </span>
          </div>

          <Show when={healthError()}>
            {(value) => (
              <div class="rounded-lg border border-red-7/20 bg-red-1/30 px-3 py-2 text-xs text-red-12">{value()}</div>
            )}
          </Show>

          <div class="flex gap-3">
            <StatusPill
              label={td("identities.channels_label", "Channels")}
              value={`${connectedChannelCount()} ${td("identities.channels_connected", "connected")}`}
              ok={connectedChannelCount() > 0}
            />
            <StatusPill
              label={td("identities.messages_today", "Messages today")}
              value={messagesToday() == null ? "\u2014" : String(messagesToday())}
              ok={(messagesToday() ?? 0) > 0}
            />
            <StatusPill
              label={td("identities.last_activity", "Last activity")}
              value={lastActivityLabel()}
              ok={Boolean(lastActivityAt())}
            />
          </div>
        </div>

        {/* ---- Available channels ---- */}
        <div>
          <div class="text-[11px] font-semibold text-gray-9 uppercase tracking-wider mb-3">
            {td("identities.available_channels", "Available channels")}
          </div>

          <div class="flex flex-col gap-2.5">

            {/* ---- Telegram channel card ---- */}
            <div
              class={`rounded-xl border overflow-hidden transition-colors ${
                hasTelegramConnected()
                  ? "border-emerald-7/30 bg-emerald-1/20"
                  : "border-gray-4 bg-gray-1"
              }`}
            >
              {/* Channel header (clickable) */}
              <button
                class="w-full flex items-center gap-3.5 px-4 py-3.5 text-left hover:bg-gray-2/50 transition-colors"
                onClick={() => toggleExpand("telegram")}
              >
                <TelegramIcon size={28} />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-[15px] font-semibold text-gray-12">Telegram</span>
                    <Show when={hasTelegramConnected()}>
                      <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-1/40 text-emerald-11">
                        {td("identities.connected_badge", "Connected")}
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    {td("identities.telegram_desc", "Connect a Telegram bot in public mode (open inbox) or private mode (pairing code required).")}
                  </div>
                </div>
                <ChevronRight
                  size={16}
                  class={`text-gray-8 transition-transform flex-shrink-0 ${
                    expandedChannel() === "telegram" ? "rotate-90" : ""
                  }`}
                />
              </button>

              {/* Expanded section */}
              <Show when={expandedChannel() === "telegram"}>
                <div class="border-t border-gray-4 px-4 py-4 space-y-3 animate-[fadeUp_0.2s_ease-out]">
                  <Show when={telegramIdentitiesError()}>
                    {(value) => (
                      <div class="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">{value()}</div>
                    )}
                  </Show>

                  {/* Existing identities */}
                  <Show when={telegramIdentities().length > 0}>
                    <div class="space-y-2">
                      <For each={telegramIdentities()}>
                        {(item) => (
                          <div class="flex items-center justify-between gap-3 rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5">
                            <div class="min-w-0">
                              <div class="flex items-center gap-2">
                                <div class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.running ? "bg-emerald-9" : "bg-gray-8"}`} />
                                <span class="text-[13px] font-semibold text-gray-12 truncate">
                                  <span class="font-mono text-[12px]">{item.id}</span>
                                </span>
                              </div>
                              <div class="text-[11px] text-gray-9 mt-0.5 pl-3.5">
                                {item.enabled ? td("identities.enabled_label", "Enabled") : td("identities.disabled_label", "Disabled")} · {item.running ? td("identities.running_label", "Running") : td("identities.stopped_label", "Stopped")} · {item.access === "private" ? td("identities.private_label", "Private") : td("identities.public_label", "Public")}
                              </div>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              <Button
                                variant="outline"
                                class="h-7 px-2.5 text-[11px]"
                                disabled={telegramSaving() || item.id === "env" || !workspaceId()}
                                onClick={() => void deleteTelegram(item.id)}
                              >
                                {td("identities.disconnect", "Disconnect")}
                              </Button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>

                    {/* Connected stats summary */}
                    <div class="flex gap-2.5">
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{td("identities.status_label", "Status")}</div>
                        <div class="flex items-center gap-1.5">
                          <div class={`w-1.5 h-1.5 rounded-full ${
                            telegramIdentities().some((i) => i.running) ? "bg-emerald-9" : "bg-gray-8"
                          }`} />
                          <span class={`text-[13px] font-semibold ${
                            telegramIdentities().some((i) => i.running) ? "text-emerald-11" : "text-gray-10"
                          }`}>
                            {telegramIdentities().some((i) => i.running) ? td("identities.status_active", "Active") : td("identities.status_stopped", "Stopped")}
                          </span>
                        </div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{td("identities.identities_label", "Identities")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">{telegramIdentities().length} {td("identities.configured_suffix", "configured")}</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{td("identities.channel_label", "Channel")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.telegram ? td("common.on", "On") : td("common.off", "Off")}
                        </div>
                      </div>
                    </div>

                    <Show when={telegramStatus()}>
                      {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                    </Show>
                    <Show when={telegramError()}>
                      {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                    </Show>
                  </Show>

                  {/* Add new identity form */}
                  <div class="space-y-2.5">
                    <Show when={telegramIdentities().length === 0}>
                      <div class="rounded-xl border border-gray-4 bg-gray-2/60 px-3.5 py-3 space-y-2.5">
                        <div class="text-[12px] font-semibold text-gray-12">{td("identities.quick_setup", "Quick setup")}</div>
                        <ol class="space-y-2 text-[12px] text-gray-10 leading-relaxed">
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">1</span>
                            <span>
                              {td("identities.botfather_step1_open", "1. Open @BotFather in Telegram")} <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" class="font-medium text-gray-12 underline">@BotFather</a> {td("identities.botfather_step1_run", "and run /newbot")} <code class="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/newbot</code>.
                            </span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">2</span>
                            <span>{td("identities.copy_bot_token_hint", "Copy the bot token and paste it below.")}</span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">3</span>
                            <span>{td("identities.botfather_step3_choose", "3. Choose a name and username for your bot")} <span class="font-medium text-gray-12">{td("identities.botfather_step3_public", "Public")}</span> {td("identities.botfather_step3_or_private", "for open inbox or")} <span class="font-medium text-gray-12">{td("identities.botfather_step3_private", "Private")}</span> {td("identities.botfather_step3_to_require", "to require")} <code class="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/pair &lt;code&gt;</code>.</span>
                          </li>
                        </ol>
                      </div>
                    </Show>

                    <div>
                      <label class="text-[12px] text-gray-9 block mb-1">{td("identities.bot_token_label", "Bot token")}</label>
                      <input
                        class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                        placeholder={td("identities.bot_token_placeholder", "Paste Telegram bot token from @BotFather")}
                        type="password"
                        value={telegramToken()}
                        onInput={(e) => setTelegramToken(e.currentTarget.value)}
                      />
                    </div>

                    <label class="flex items-center gap-2 text-xs text-gray-11">
                      <input
                        type="checkbox"
                        checked={telegramEnabled()}
                        onChange={(e) => setTelegramEnabled(e.currentTarget.checked)}
                      />
                      {td("identities.enabled_label", "Enabled")}
                    </label>

                    <div class="rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[11px] text-gray-10 leading-relaxed">
                      {td("identities.telegram_bot_access_desc", "Public bot: first Telegram chat auto-links. Private bot: requires a pairing code before any messages run tools.")}
                    </div>

                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <button
                        onClick={() => setPublicTelegramWarningOpen(true)}
                        disabled={telegramSaving() || !workspaceId() || !telegramToken().trim()}
                        class={`flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition-colors ${
                          telegramSaving() || !workspaceId() || !telegramToken().trim()
                            ? "cursor-not-allowed border-gray-5 bg-gray-3 text-gray-8"
                            : "cursor-pointer border-gray-6 bg-gray-12 text-gray-1 hover:bg-gray-11"
                        }`}
                      >
                        <Show
                          when={!telegramSaving()}
                          fallback={
                            <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          }
                        >
                          <Link size={15} />
                        </Show>
                        {telegramSaving() ? td("identities.connecting", "Connecting...") : td("identities.create_public_bot", "Create public bot")}
                      </button>

                      <button
                        onClick={() => void upsertTelegram("private")}
                        disabled={telegramSaving() || !workspaceId() || !telegramToken().trim()}
                        class={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white border-none transition-opacity ${
                          telegramSaving() || !workspaceId() || !telegramToken().trim()
                            ? "opacity-50 cursor-not-allowed"
                            : "opacity-100 cursor-pointer hover:opacity-90"
                        }`}
                        style={{ background: "#229ED9" }}
                      >
                        <Show
                          when={!telegramSaving()}
                          fallback={
                            <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          }
                        >
                          <Shield size={15} />
                        </Show>
                        {telegramSaving() ? td("identities.connecting", "Connecting...") : td("identities.create_private_bot", "Create private bot")}
                      </button>
                    </div>

                    <Show when={telegramPairingCode()}>
                      {(code) => (
                        <div class="rounded-xl border border-sky-7/25 bg-sky-1/40 px-3.5 py-3 space-y-2">
                          <div class="text-[12px] font-semibold text-sky-11">{td("identities.private_pairing_code", "Private pairing code")}</div>
                          <div class="rounded-md border border-sky-7/20 bg-sky-2/80 px-3 py-2 font-mono text-[13px] tracking-[0.08em] text-sky-12">
                            {code()}
                          </div>
                          <div class="text-[11px] text-sky-11/90 leading-relaxed">
                            {td("identities.pairing_code_instruction_prefix", "Send")} <code class="rounded bg-sky-3/60 px-1 py-0.5 font-mono text-[10px]">/pair {code()}</code>.
                          </div>
                          <div class="flex items-center gap-2">
                            <Button variant="outline" class="h-7 px-2.5 text-[11px]" onClick={() => void copyTelegramPairingCode()}>
                              <Copy size={12} />
                              <span class="ml-1">{td("identities.copy_code", "Copy code")}</span>
                            </Button>
                            <Button variant="outline" class="h-7 px-2.5 text-[11px]" onClick={() => setTelegramPairingCode(null)}>
                              {td("common.hide", "Hide")}
                            </Button>
                          </div>
                        </div>
                      )}
                    </Show>

                    <Show when={telegramBotLink()}>
                      {(value) => (
                        <a
                          href={value()}
                          target="_blank"
                          rel="noreferrer"
                          class="inline-flex items-center gap-2 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[12px] font-medium text-gray-11 hover:bg-gray-2"
                        >
                          <Link size={14} />
                          {td("identities.open_bot_link", "Open @{username} in Telegram", { username: telegramBotUsername() ?? "" })}
                        </a>
                      )}
                    </Show>

                    <Show when={telegramIdentities().length === 0}>
                      <Show when={telegramStatus()}>
                        {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                      </Show>
                      <Show when={telegramError()}>
                        {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>

            {/* ---- Slack channel card ---- */}
            <div
              class={`rounded-xl border overflow-hidden transition-colors ${
                hasSlackConnected()
                  ? "border-emerald-7/30 bg-emerald-1/20"
                  : "border-gray-4 bg-gray-1"
              }`}
            >
              {/* Channel header (clickable) */}
              <button
                class="w-full flex items-center gap-3.5 px-4 py-3.5 text-left hover:bg-gray-2/50 transition-colors"
                onClick={() => toggleExpand("slack")}
              >
                <SlackIcon size={28} />
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="text-[15px] font-semibold text-gray-12">Slack</span>
                    <Show when={hasSlackConnected()}>
                      <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-1/40 text-emerald-11">
                        {td("identities.connected_badge", "Connected")}
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    {td("identities.slack_desc", "Your worker appears as a bot in Slack channels. Team members can message it directly or mention it in threads.")}
                  </div>
                </div>
                <ChevronRight
                  size={16}
                  class={`text-gray-8 transition-transform flex-shrink-0 ${
                    expandedChannel() === "slack" ? "rotate-90" : ""
                  }`}
                />
              </button>

              {/* Expanded section */}
              <Show when={expandedChannel() === "slack"}>
                <div class="border-t border-gray-4 px-4 py-4 space-y-3 animate-[fadeUp_0.2s_ease-out]">
                  <Show when={slackIdentitiesError()}>
                    {(value) => (
                      <div class="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">{value()}</div>
                    )}
                  </Show>

                  {/* Existing identities */}
                  <Show when={slackIdentities().length > 0}>
                    <div class="space-y-2">
                      <For each={slackIdentities()}>
                        {(item) => (
                          <div class="flex items-center justify-between gap-3 rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5">
                            <div class="min-w-0">
                              <div class="flex items-center gap-2">
                                <div class={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.running ? "bg-emerald-9" : "bg-gray-8"}`} />
                                <span class="text-[13px] font-semibold text-gray-12 truncate">
                                  <span class="font-mono text-[12px]">{item.id}</span>
                                </span>
                              </div>
                              <div class="text-[11px] text-gray-9 mt-0.5 pl-3.5">
                                {item.enabled ? td("identities.enabled_label", "Enabled") : td("identities.disabled_label", "Disabled")} · {item.running ? td("identities.running_label", "Running") : td("identities.stopped_label", "Stopped")}
                              </div>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              <Button
                                variant="outline"
                                class="h-7 px-2.5 text-[11px]"
                                disabled={slackSaving() || item.id === "env" || !workspaceId()}
                                onClick={() => void deleteSlack(item.id)}
                              >
                                {td("identities.disconnect", "Disconnect")}
                              </Button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>

                    {/* Connected stats summary */}
                    <div class="flex gap-2.5">
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{td("identities.status_label", "Status")}</div>
                        <div class="flex items-center gap-1.5">
                          <div class={`w-1.5 h-1.5 rounded-full ${
                            slackIdentities().some((i) => i.running) ? "bg-emerald-9" : "bg-gray-8"
                          }`} />
                          <span class={`text-[13px] font-semibold ${
                            slackIdentities().some((i) => i.running) ? "text-emerald-11" : "text-gray-10"
                          }`}>
                            {slackIdentities().some((i) => i.running) ? td("identities.status_active", "Active") : td("identities.status_stopped", "Stopped")}
                          </span>
                        </div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{td("identities.identities_label", "Identities")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">{slackIdentities().length} {td("identities.configured_suffix", "configured")}</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{td("identities.channel_label", "Channel")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.slack ? td("common.on", "On") : td("common.off", "Off")}
                        </div>
                      </div>
                    </div>

                    <Show when={slackStatus()}>
                      {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                    </Show>
                    <Show when={slackError()}>
                      {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                    </Show>
                  </Show>

                  {/* Add new identity form */}
                  <div class="space-y-2.5">
                    <Show when={slackIdentities().length === 0}>
                      <p class="text-[13px] text-gray-10 leading-relaxed">
                        {td("identities.slack_intro", "Connect your Slack workspace to let team members interact with this worker in channels and DMs.")}
                      </p>
                    </Show>

                    <div class="space-y-2">
                      <div>
                        <label class="text-[12px] text-gray-9 block mb-1">{td("identities.bot_token_label", "Bot token")}</label>
                        <input
                          class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                          placeholder="xoxb-..."
                          type="password"
                          value={slackBotToken()}
                          onInput={(e) => setSlackBotToken(e.currentTarget.value)}
                        />
                      </div>
                      <div>
                        <label class="text-[12px] text-gray-9 block mb-1">{td("identities.app_token_label", "App token")}</label>
                        <input
                          class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                          placeholder="xapp-..."
                          type="password"
                          value={slackAppToken()}
                          onInput={(e) => setSlackAppToken(e.currentTarget.value)}
                        />
                      </div>
                    </div>

                    <label class="flex items-center gap-2 text-xs text-gray-11">
                      <input
                        type="checkbox"
                        checked={slackEnabled()}
                        onChange={(e) => setSlackEnabled(e.currentTarget.checked)}
                      />
                      {td("identities.enabled_label", "Enabled")}
                    </label>

                    <button
                      onClick={() => void upsertSlack()}
                      disabled={slackSaving() || !workspaceId() || !slackBotToken().trim() || !slackAppToken().trim()}
                      class={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white border-none transition-opacity ${
                        slackSaving() || !workspaceId() || !slackBotToken().trim() || !slackAppToken().trim()
                          ? "opacity-50 cursor-not-allowed"
                          : "opacity-100 cursor-pointer hover:opacity-90"
                      }`}
                      style={{ background: "#4A154B" }}
                    >
                      <Show
                        when={!slackSaving()}
                        fallback={
                          <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        }
                      >
                        <Link size={15} />
                      </Show>
                      {slackSaving() ? td("identities.connecting", "Connecting...") : td("identities.connect_slack", "Connect Slack")}
                    </button>

                    <Show when={slackIdentities().length === 0}>
                      <Show when={slackStatus()}>
                        {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
                      </Show>
                      <Show when={slackError()}>
                        {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
                      </Show>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </div>

        </Show>

        <Show when={activeTab() === "advanced" && messagingEnabled()}>

        {/* ---- Message routing ---- */}
        <div>
          <div class="text-[11px] font-semibold text-gray-9 uppercase tracking-wider mb-2">
            {td("identities.message_routing_title", "Message routing")}
          </div>
          <p class="text-[13px] text-gray-9 leading-relaxed mb-3">
            {td("identities.message_routing_desc", "Control which conversations go to which workspace folder. Messages are routed to the worker's default folder unless you set up rules here.")}
          </p>

          <div class="rounded-xl border border-gray-4 bg-gray-2/50 px-4 py-3.5 space-y-3">
            <div class="flex items-center gap-2">
              <Shield size={16} class="text-gray-9" />
              <span class="text-[13px] font-medium text-gray-11">{td("identities.default_routing", "Default routing")}</span>
            </div>
            <div class="flex items-center gap-2 pl-6">
              <span class="rounded-md bg-gray-4 px-2.5 py-1 text-[12px] font-medium text-gray-11">
                {td("identities.all_channels", "All channels")}
              </span>
              <ArrowRight size={14} class="text-gray-8" />
              <span class="rounded-md bg-dls-accent/10 px-2.5 py-1 text-[12px] font-medium text-dls-accent">
                {defaultRoutingDirectory()}
              </span>
            </div>
          </div>

          <div class="text-xs text-gray-10 mt-2.5">
            {td("identities.routing_override_prefix", "All messages routed to")} <code class="text-[11px] font-mono bg-gray-3 px-1 py-0.5 rounded">/dir &lt;path&gt;</code> {td("identities.routing_override_suffix", "(override active)")}
          </div>
        </div>

        {/* ---- Messaging agent behavior ---- */}
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-4 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-[13px] font-semibold text-gray-12">{td("identities.agent_behavior_title", "Messaging agent behavior")}</div>
              <div class="text-[12px] text-gray-9 mt-0.5">
                {td("identities.agent_behavior_desc", "One file per workspace. Add optional first line @agent <id> to route via a specific OpenCode agent.")}
              </div>
            </div>
            <span class="rounded-md border border-gray-4 bg-gray-2/50 px-2 py-1 text-[11px] font-mono text-gray-10">
              {OPENCODE_ROUTER_AGENT_FILE_PATH}
            </span>
          </div>

          <Show when={workspaceAgentStatus()}>
            {(value) => (
              <div class="rounded-lg border border-gray-4 bg-gray-2/40 px-3 py-2 text-[11px] text-gray-10">
                {td("identities.agent_scope_status", "Active scope: workspace · status: {status} · selected agent: {agent}", { status: value().loaded ? td("identities.agent_status_loaded", "loaded") : td("identities.agent_status_missing", "missing"), agent: value().selected || td("identities.agent_none", "none") })}
              </div>
            )}
          </Show>

          <Show when={agentLoading()}>
            <div class="text-[11px] text-gray-9">{td("identities.agent_loading", "Loading agent file…")}</div>
          </Show>

          <Show when={!agentExists() && !agentLoading()}>
            <div class="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
              {td("identities.agent_not_found", "Agent file not found in this workspace yet.")}
            </div>
          </Show>

          <textarea
            class="min-h-[220px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-[13px] font-mono text-gray-12 placeholder:text-gray-8"
            placeholder={td("identities.agent_placeholder", "Add messaging behavior instructions for opencodeRouter here...")}
            value={agentDraft()}
            onInput={(e) => setAgentDraft(e.currentTarget.value)}
          />

          <div class="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              onClick={() => void loadAgentFile()}
              disabled={agentLoading() || !workspaceId()}
            >
              {td("identities.reload", "Reload")}
            </Button>
            <Show when={!agentExists()}>
              <Button
                variant="outline"
                class="h-8 px-3 text-xs"
                onClick={() => void createDefaultAgentFile()}
                disabled={agentSaving() || !workspaceId()}
              >
                {td("identities.create_default_file", "Create default file")}
              </Button>
            </Show>
            <Button
              variant="secondary"
              class="h-8 px-3 text-xs"
              onClick={() => void saveAgentFile()}
              disabled={agentSaving() || !workspaceId() || !agentDirty()}
            >
              {agentSaving() ? td("identities.saving", "Saving...") : td("identities.save_behavior", "Save behavior")}
            </Button>
            <Show when={agentDirty() && !agentSaving()}>
              <span class="text-[11px] text-gray-9">{td("identities.unsaved_changes", "Unsaved changes")}</span>
            </Show>
          </div>

          <Show when={agentStatus()}>
            {(value) => <div class="text-[11px] text-gray-9">{value()}</div>}
          </Show>
          <Show when={agentError()}>
            {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
          </Show>
        </div>

        {/* ---- Outbound send test ---- */}
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-4 space-y-3">
          <div>
            <div class="text-[13px] font-semibold text-gray-12">{td("identities.send_test_title", "Send test message")}</div>
            <div class="text-[12px] text-gray-9 mt-0.5">
              {td("identities.send_test_desc", "Validate outbound wiring. Use a peer ID for direct send, or leave peer ID empty to fan out by bindings in a directory.")}
            </div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">{td("identities.channel_label", "Channel")}</label>
              <select
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12"
                value={sendChannel()}
                onChange={(e) => setSendChannel(e.currentTarget.value === "slack" ? "slack" : "telegram")}
              >
                <option value="telegram">Telegram</option>
                <option value="slack">Slack</option>
              </select>
            </div>
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">{td("identities.peer_id_label", "Peer ID (optional)")}</label>
              <input
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                placeholder={sendChannel() === "telegram" ? td("identities.peer_id_placeholder_telegram", "e.g. telegram:123456789") : td("identities.peer_id_placeholder_slack", "e.g. slack:U12345678")}
                value={sendPeerId()}
                onInput={(e) => setSendPeerId(e.currentTarget.value)}
              />
            </div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">{td("identities.directory_label", "Directory (optional)")}</label>
              <input
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                placeholder={defaultRoutingDirectory()}
                value={sendDirectory()}
                onInput={(e) => setSendDirectory(e.currentTarget.value)}
              />
            </div>
            <div class="flex items-end pb-1">
              <label class="flex items-center gap-2 text-xs text-gray-11">
                <input
                  type="checkbox"
                  checked={sendAutoBind()}
                  onChange={(e) => setSendAutoBind(e.currentTarget.checked)}
                />
                {td("identities.auto_bind_label", "Auto-bind peer to directory on direct send")}
              </label>
            </div>
          </div>

          <div>
            <label class="text-[12px] text-gray-9 block mb-1">{td("identities.message_label", "Message")}</label>
            <textarea
              class="min-h-[90px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
              placeholder={td("identities.send_test_button", "Send test message")}
              value={sendText()}
              onInput={(e) => setSendText(e.currentTarget.value)}
            />
          </div>

          <div class="flex items-center gap-2">
            <Button
              variant="secondary"
              class="h-8 px-3 text-xs"
              onClick={() => void sendTestMessage()}
              disabled={sendBusy() || !workspaceId() || !sendText().trim()}
            >
              {sendBusy() ? td("identities.sending", "Sending...") : td("identities.send_test_button", "Send test message")}
            </Button>
            <Show when={sendStatus()}>
              {(value) => <span class="text-[11px] text-gray-9">{value()}</span>}
            </Show>
          </div>

          <Show when={sendError()}>
            {(value) => <div class="text-[11px] text-red-12">{value()}</div>}
          </Show>
          <Show when={sendResult()}>
            {(value) => (
              <div class="rounded-lg border border-gray-4 bg-gray-2/40 px-3 py-2 text-[11px] text-gray-10 font-mono space-y-1">
                <div>
                  sent={value().sent} attempted={value().attempted}
                  <Show when={value().failures?.length}>
                    {(failures) => ` failures=${failures()}`}
                  </Show>
                  <Show when={value().reason?.trim()}>
                    {(reason) => ` reason=${reason()}`}
                  </Show>
                </div>
                <Show when={value().failures?.length}>
                  <For each={value().failures ?? []}>
                    {(failure) => (
                      <div class="text-red-11">
                        {failure.identityId}/{failure.peerId}: {failure.error}
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            )}
          </Show>
        </div>

        </Show>

        <ConfirmModal
          open={messagingRiskOpen()}
          title={td("identities.enable_messaging_title", "Enable messaging for this worker?")}
          message={td("identities.enable_messaging_risk", "Messaging can expose this worker to remote commands. If a bot is public or compromised, it can access files, credentials, and API keys available to this worker.")}
          confirmLabel={messagingSaving() ? td("identities.enabling", "Enabling...") : td("identities.enable_messaging", "Enable messaging")}
          cancelLabel={td("common.cancel", "Cancel")}
          variant="danger"
          onCancel={() => {
            if (messagingSaving()) return;
            setMessagingRiskOpen(false);
          }}
          onConfirm={() => {
            void enableMessagingModule();
          }}
        />

        <ConfirmModal
          open={messagingRestartPromptOpen()}
          title={td("identities.restart_worker_title", "Restart worker now?")}
          message={
            messagingRestartAction() === "enable"
              ? td("identities.restart_to_enable_messaging", "Messaging was enabled for this workspace. Restart the worker now to start the messaging sidecar and unlock Telegram and Slack setup.")
              : td("identities.restart_to_disable_messaging", "Messaging was disabled for this workspace. Restart the worker now to stop the messaging sidecar.")
          }
          confirmLabel={messagingRestartBusy() ? td("identities.restarting", "Restarting...") : td("identities.restart_worker", "Restart worker")}
          cancelLabel={td("identities.later", "Later")}
          onCancel={() => {
            if (messagingRestartBusy()) return;
            setMessagingRestartPromptOpen(false);
          }}
          onConfirm={() => {
            void restartMessagingWorker();
          }}
        />

        <ConfirmModal
          open={messagingDisableConfirmOpen()}
          title={td("identities.disable_messaging_title", "Disable messaging for this worker?")}
          message={td("identities.disable_messaging_message", "This will turn off messaging for this workspace. Telegram and Slack setup will be hidden until messaging is enabled again, and you will need to restart the worker to fully stop the messaging sidecar.")}
          confirmLabel={messagingSaving() ? td("identities.disabling", "Disabling...") : td("identities.disable_messaging", "Disable messaging")}
          cancelLabel={td("common.cancel", "Cancel")}
          onCancel={() => {
            if (messagingSaving()) return;
            setMessagingDisableConfirmOpen(false);
          }}
          onConfirm={() => {
            void disableMessagingModule();
          }}
        />

        <ConfirmModal
          open={publicTelegramWarningOpen()}
          title={td("identities.public_bot_warning_title", "Make this bot public?")}
          message={td("identities.public_bot_warning_message", "Your bot will be accessible to the public and anyone who gets access to your bot will be able to have full access to your local worker including any files or API keys that you've given it. If you create a private bot, you can limit who can access it by requiring a pairing token. Are you sure you want to make your bot public?")}
          confirmLabel={td("identities.public_bot_confirm", "Yes I understand the risk")}
          cancelLabel={td("common.cancel", "Cancel")}
          variant="danger"
          confirmButtonVariant="danger"
          cancelButtonVariant="primary"
          onCancel={() => setPublicTelegramWarningOpen(false)}
          onConfirm={() => {
            setPublicTelegramWarningOpen(false);
            void upsertTelegram("public");
          }}
        />

      </Show>
    </div>
  );
}
