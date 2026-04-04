import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  ArrowRight,
  ChevronRight,
  Copy,
  Link,
  RefreshCcw,
  Shield,
} from "lucide-solid";

import { t } from "../../i18n";

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
  const defaultRoutingDirectory = createMemo(() => props.selectedWorkspaceRoot.trim() || t("identities.not_set"));

  let lastResetKey = "";

  const statusLabel = createMemo(() => {
    if (healthError()) return t("identities.health_unavailable");
    const snapshot = health();
    if (!snapshot) return t("identities.health_unknown");
    return snapshot.ok ? t("identities.health_running") : t("identities.health_offline");
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
    if (elapsedMs < 60_000) return t("identities.just_now");
    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 60) return t("identities.minutes_ago", undefined, { minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("identities.hours_ago", undefined, { hours });
    const days = Math.floor(hours / 24);
    return t("identities.days_ago", undefined, { days });
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
      setAgentError(t("identities.agent_worker_scope_unavailable"));
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
      setAgentStatus(t("identities.agent_created"));
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
      setAgentStatus(t("identities.agent_saved"));
    } catch (error) {
      if (error instanceof OpenworkServerError && error.status === 409) {
        setAgentError(t("identities.agent_file_changed"));
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
      const base = t("identities.dispatched_messages", undefined, { sent: result.sent, attempted: result.attempted });
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
        setHealthError(t("identities.worker_scope_unavailable_detail"));
        setTelegramIdentitiesError(t("identities.worker_scope_unavailable"));
        setSlackIdentitiesError(t("identities.worker_scope_unavailable"));
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
              : t("identities.health_unavailable_status", undefined, { status: healthRes.status });
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
        setTelegramIdentitiesError(t("identities.telegram_unavailable"));
      }

      if (isOpenCodeRouterIdentities(slackRes)) {
        setSlackIdentities(slackRes.items ?? []);
      } else {
        setSlackIdentities([]);
        setSlackIdentitiesError(t("identities.slack_unavailable"));
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
      setReconnectError(t("identities.reconnect_failed"));
      return;
    }

    setReconnectStatus(t("identities.reconnected_refreshing"));
    await refreshAll({ force: true });
    setReconnectStatus(t("identities.reconnected"));
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
      setMessagingStatus(t("identities.messaging_enabled_restart"));
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
      setMessagingStatus(t("identities.messaging_disabled_restart"));
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
      setMessagingError(t("identities.restart_failed"));
      return;
    }
      setMessagingRestartPromptOpen(false);
      setMessagingRestartRequired(false);
      setMessagingStatus(t("identities.worker_restarted_refreshing"));
      await refreshAll({ force: true });
      setMessagingStatus(t("identities.worker_restarted"));
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
          setTelegramStatus(t("identities.telegram_private_saved_pair", undefined, { code: pairingCode }));
        } else {
          setTelegramPairingCode(null);
        }
        const username = (result.telegram as any)?.bot?.username;
        if (username) {
          const normalized = String(username).trim().replace(/^@+/, "");
          setTelegramBotUsername(normalized || null);
          if (access !== "private" || !pairingCode) {
            setTelegramStatus(t("identities.telegram_saved_username", undefined, { username: normalized || String(username) }));
          }
        } else {
          if (access !== "private" || !pairingCode) {
            setTelegramStatus(result.applied === false ? t("identities.telegram_saved_pending") : t("identities.telegram_saved"));
          }
        }
      } else {
        setTelegramError(t("identities.telegram_save_failed"));
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
        setTelegramStatus(result.applied === false ? t("identities.telegram_deleted_pending") : t("identities.telegram_deleted"));
      } else {
        setTelegramError(t("identities.telegram_delete_failed"));
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
      setTelegramStatus(t("identities.pairing_code_copied"));
    } catch {
      setTelegramError(t("identities.pairing_code_copy_failed"));
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
        setSlackStatus(result.applied === false ? t("identities.telegram_saved_pending") : t("identities.telegram_saved"));
      } else {
        setSlackError(t("identities.telegram_save_failed"));
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
        setSlackStatus(result.applied === false ? t("identities.telegram_deleted_pending") : t("identities.telegram_deleted"));
      } else {
        setSlackError(t("identities.telegram_delete_failed"));
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
            <h1 class="text-lg font-bold text-gray-12 tracking-tight">{t("identities.title")}</h1>
          </Show>
          <div class="flex items-center gap-2">
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              onClick={() => void repairAndReconnect()}
              disabled={props.busy || props.openworkReconnectBusy}
            >
              <RefreshCcw size={14} class={props.openworkReconnectBusy ? "animate-spin" : ""} />
              <span class="ml-1.5">{t("identities.repair_reconnect")}</span>
            </Button>
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              onClick={() => refreshAll({ force: true })}
              disabled={!serverReady() || refreshing()}
            >
              <RefreshCcw size={14} class={refreshing() ? "animate-spin" : ""} />
              <span class="ml-1.5">{t("common.refresh")}</span>
            </Button>
          </div>
        </div>
        <Show when={props.showHeader !== false}>
          <p class="text-sm text-gray-9 leading-relaxed">
            {t("identities.subtitle")}
          </p>
        </Show>
        <div class="mt-1.5 text-[11px] text-gray-8 font-mono break-all">
          {t("identities.workspace_scope_prefix")} {scopedOpenworkBaseUrl().trim() || props.openworkServerUrl.trim() || t("identities.not_set")}
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
          <div class="text-sm font-semibold text-gray-12">{t("identities.connect_server_title")}</div>
          <div class="mt-1 text-xs text-gray-10">
            {t("identities.connect_server_desc")}
          </div>
        </div>
      </Show>

      <Show when={serverReady()}>
        <Show when={!scopedWorkspaceReady()}>
          <div class="rounded-xl border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
            {t("identities.workspace_id_required")}
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
                {t("identities.tab_general")}
              </button>
              <button
                class={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                  activeTab() === "advanced"
                    ? "bg-gray-12 text-gray-1"
                    : "text-gray-10 hover:bg-gray-2"
                }`}
                onClick={() => setActiveTab("advanced")}
              >
                {t("settings.tab_advanced")}
              </button>
            </div>
            <Button
              variant="outline"
              class="h-8 px-3 text-xs"
              disabled={messagingSaving()}
              onClick={() => setMessagingDisableConfirmOpen(true)}
            >
              {t("identities.disable_messaging")}
            </Button>
          </div>
        </Show>

        <Show when={!messagingEnabled()}>
          <div class="rounded-xl border border-gray-4 bg-gray-1 px-4 py-4 space-y-3">
            <div class="text-sm font-semibold text-gray-12">{t("identities.messaging_disabled_title")}</div>
            <p class="text-xs text-gray-10 leading-relaxed">
              {t("identities.messaging_disabled_risk")}
            </p>
            <p class="text-xs text-gray-10 leading-relaxed">
              {t("identities.messaging_disabled_hint")}
            </p>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                class="h-8 px-3 text-xs"
                disabled={messagingSaving() || !workspaceId()}
                onClick={() => setMessagingRiskOpen(true)}
              >
                {messagingSaving() ? t("identities.enabling") : t("identities.enable_messaging")}
              </Button>
            </div>
          </div>
        </Show>

        <Show when={activeTab() === "general" && messagingEnabled()}>

        <Show when={messagingRestartRequired()}>
          <div class="rounded-xl border border-gray-4 bg-gray-1 px-4 py-3 text-xs text-gray-10 leading-relaxed">
            {t("identities.messaging_sidecar_not_running")}
            <div class="mt-3">
              <Button
                variant="primary"
                class="h-8 px-3 text-xs"
                disabled={messagingRestartBusy()}
                onClick={() => void restartMessagingWorker()}
              >
                {messagingRestartBusy() ? t("identities.restarting") : t("identities.restart_worker")}
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
                {isWorkerOnline() ? t("identities.worker_online") : healthError() ? t("identities.worker_unavailable") : t("identities.worker_offline")}
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
              label={t("identities.channels_label")}
              value={`${connectedChannelCount()} ${t("identities.channels_connected")}`}
              ok={connectedChannelCount() > 0}
            />
            <StatusPill
              label={t("identities.messages_today")}
              value={messagesToday() == null ? "\u2014" : String(messagesToday())}
              ok={(messagesToday() ?? 0) > 0}
            />
            <StatusPill
              label={t("identities.last_activity")}
              value={lastActivityLabel()}
              ok={Boolean(lastActivityAt())}
            />
          </div>
        </div>

        {/* ---- Available channels ---- */}
        <div>
          <div class="text-[11px] font-semibold text-gray-9 uppercase tracking-wider mb-3">
            {t("identities.available_channels")}
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
                        {t("identities.connected_badge")}
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    {t("identities.telegram_desc")}
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
                                {item.enabled ? t("identities.enabled_label") : t("identities.disabled_label")} · {item.running ? t("identities.running_label") : t("identities.stopped_label")} · {item.access === "private" ? t("identities.private_label") : t("identities.public_label")}
                              </div>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              <Button
                                variant="outline"
                                class="h-7 px-2.5 text-[11px]"
                                disabled={telegramSaving() || item.id === "env" || !workspaceId()}
                                onClick={() => void deleteTelegram(item.id)}
                              >
                                {t("identities.disconnect")}
                              </Button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>

                    {/* Connected stats summary */}
                    <div class="flex gap-2.5">
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{t("identities.status_label")}</div>
                        <div class="flex items-center gap-1.5">
                          <div class={`w-1.5 h-1.5 rounded-full ${
                            telegramIdentities().some((i) => i.running) ? "bg-emerald-9" : "bg-gray-8"
                          }`} />
                          <span class={`text-[13px] font-semibold ${
                            telegramIdentities().some((i) => i.running) ? "text-emerald-11" : "text-gray-10"
                          }`}>
                            {telegramIdentities().some((i) => i.running) ? t("identities.status_active") : t("identities.status_stopped")}
                          </span>
                        </div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{t("identities.identities_label")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">{telegramIdentities().length} {t("identities.configured_suffix")}</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{t("identities.channel_label")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.telegram ? t("common.on") : t("common.off")}
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
                        <div class="text-[12px] font-semibold text-gray-12">{t("identities.quick_setup")}</div>
                        <ol class="space-y-2 text-[12px] text-gray-10 leading-relaxed">
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">1</span>
                            <span>
                              {t("identities.botfather_step1_open")} <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" class="font-medium text-gray-12 underline">@BotFather</a> {t("identities.botfather_step1_run")} <code class="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/newbot</code>.
                            </span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">2</span>
                            <span>{t("identities.copy_bot_token_hint")}</span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">3</span>
                            <span>{t("identities.botfather_step3_choose")} <span class="font-medium text-gray-12">{t("identities.botfather_step3_public")}</span> {t("identities.botfather_step3_or_private")} <span class="font-medium text-gray-12">{t("identities.botfather_step3_private")}</span> {t("identities.botfather_step3_to_require")} <code class="rounded bg-gray-3 px-1 py-0.5 font-mono text-[11px]">/pair &lt;code&gt;</code>.</span>
                          </li>
                        </ol>
                      </div>
                    </Show>

                    <div>
                      <label class="text-[12px] text-gray-9 block mb-1">{t("identities.bot_token_label")}</label>
                      <input
                        class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                        placeholder={t("identities.bot_token_placeholder")}
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
                      {t("identities.enabled_label")}
                    </label>

                    <div class="rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[11px] text-gray-10 leading-relaxed">
                      {t("identities.telegram_bot_access_desc")}
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
                        {telegramSaving() ? t("identities.connecting") : t("identities.create_public_bot")}
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
                        {telegramSaving() ? t("identities.connecting") : t("identities.create_private_bot")}
                      </button>
                    </div>

                    <Show when={telegramPairingCode()}>
                      {(code) => (
                        <div class="rounded-xl border border-sky-7/25 bg-sky-1/40 px-3.5 py-3 space-y-2">
                          <div class="text-[12px] font-semibold text-sky-11">{t("identities.private_pairing_code")}</div>
                          <div class="rounded-md border border-sky-7/20 bg-sky-2/80 px-3 py-2 font-mono text-[13px] tracking-[0.08em] text-sky-12">
                            {code()}
                          </div>
                          <div class="text-[11px] text-sky-11/90 leading-relaxed">
                            {t("identities.pairing_code_instruction_prefix")} <code class="rounded bg-sky-3/60 px-1 py-0.5 font-mono text-[10px]">/pair {code()}</code>.
                          </div>
                          <div class="flex items-center gap-2">
                            <Button variant="outline" class="h-7 px-2.5 text-[11px]" onClick={() => void copyTelegramPairingCode()}>
                              <Copy size={12} />
                              <span class="ml-1">{t("identities.copy_code")}</span>
                            </Button>
                            <Button variant="outline" class="h-7 px-2.5 text-[11px]" onClick={() => setTelegramPairingCode(null)}>
                              {t("common.hide")}
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
                          {t("identities.open_bot_link", undefined, { username: telegramBotUsername() ?? "" })}
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
                        {t("identities.connected_badge")}
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    {t("identities.slack_desc")}
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
                                {item.enabled ? t("identities.enabled_label") : t("identities.disabled_label")} · {item.running ? t("identities.running_label") : t("identities.stopped_label")}
                              </div>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                              <Button
                                variant="outline"
                                class="h-7 px-2.5 text-[11px]"
                                disabled={slackSaving() || item.id === "env" || !workspaceId()}
                                onClick={() => void deleteSlack(item.id)}
                              >
                                {t("identities.disconnect")}
                              </Button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>

                    {/* Connected stats summary */}
                    <div class="flex gap-2.5">
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{t("identities.status_label")}</div>
                        <div class="flex items-center gap-1.5">
                          <div class={`w-1.5 h-1.5 rounded-full ${
                            slackIdentities().some((i) => i.running) ? "bg-emerald-9" : "bg-gray-8"
                          }`} />
                          <span class={`text-[13px] font-semibold ${
                            slackIdentities().some((i) => i.running) ? "text-emerald-11" : "text-gray-10"
                          }`}>
                            {slackIdentities().some((i) => i.running) ? t("identities.status_active") : t("identities.status_stopped")}
                          </span>
                        </div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{t("identities.identities_label")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">{slackIdentities().length} {t("identities.configured_suffix")}</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{t("identities.channel_label")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.slack ? t("common.on") : t("common.off")}
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
                        {t("identities.slack_intro")}
                      </p>
                    </Show>

                    <div class="space-y-2">
                      <div>
                        <label class="text-[12px] text-gray-9 block mb-1">{t("identities.bot_token_label")}</label>
                        <input
                          class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                          placeholder="xoxb-..."
                          type="password"
                          value={slackBotToken()}
                          onInput={(e) => setSlackBotToken(e.currentTarget.value)}
                        />
                      </div>
                      <div>
                        <label class="text-[12px] text-gray-9 block mb-1">{t("identities.app_token_label")}</label>
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
                      {t("identities.enabled_label")}
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
                      {slackSaving() ? t("identities.connecting") : t("identities.connect_slack")}
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
            {t("identities.message_routing_title")}
          </div>
          <p class="text-[13px] text-gray-9 leading-relaxed mb-3">
            {t("identities.message_routing_desc")}
          </p>

          <div class="rounded-xl border border-gray-4 bg-gray-2/50 px-4 py-3.5 space-y-3">
            <div class="flex items-center gap-2">
              <Shield size={16} class="text-gray-9" />
              <span class="text-[13px] font-medium text-gray-11">{t("identities.default_routing")}</span>
            </div>
            <div class="flex items-center gap-2 pl-6">
              <span class="rounded-md bg-gray-4 px-2.5 py-1 text-[12px] font-medium text-gray-11">
                {t("identities.all_channels")}
              </span>
              <ArrowRight size={14} class="text-gray-8" />
              <span class="rounded-md bg-dls-accent/10 px-2.5 py-1 text-[12px] font-medium text-dls-accent">
                {defaultRoutingDirectory()}
              </span>
            </div>
          </div>

          <div class="text-xs text-gray-10 mt-2.5">
            {t("identities.routing_override_prefix")} <code class="text-[11px] font-mono bg-gray-3 px-1 py-0.5 rounded">/dir &lt;path&gt;</code> {t("identities.routing_override_suffix")}
          </div>
        </div>

        {/* ---- Messaging agent behavior ---- */}
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-4 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-[13px] font-semibold text-gray-12">{t("identities.agent_behavior_title")}</div>
              <div class="text-[12px] text-gray-9 mt-0.5">
                {t("identities.agent_behavior_desc")}
              </div>
            </div>
            <span class="rounded-md border border-gray-4 bg-gray-2/50 px-2 py-1 text-[11px] font-mono text-gray-10">
              {OPENCODE_ROUTER_AGENT_FILE_PATH}
            </span>
          </div>

          <Show when={workspaceAgentStatus()}>
            {(value) => (
              <div class="rounded-lg border border-gray-4 bg-gray-2/40 px-3 py-2 text-[11px] text-gray-10">
                {t("identities.agent_scope_status", undefined, { status: value().loaded ? t("identities.agent_status_loaded") : t("identities.agent_status_missing"), agent: value().selected || t("identities.agent_none") })}
              </div>
            )}
          </Show>

          <Show when={agentLoading()}>
            <div class="text-[11px] text-gray-9">{t("identities.agent_loading")}</div>
          </Show>

          <Show when={!agentExists() && !agentLoading()}>
            <div class="rounded-lg border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12">
              {t("identities.agent_not_found")}
            </div>
          </Show>

          <textarea
            class="min-h-[220px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-[13px] font-mono text-gray-12 placeholder:text-gray-8"
            placeholder={t("identities.agent_placeholder")}
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
              {t("identities.reload")}
            </Button>
            <Show when={!agentExists()}>
              <Button
                variant="outline"
                class="h-8 px-3 text-xs"
                onClick={() => void createDefaultAgentFile()}
                disabled={agentSaving() || !workspaceId()}
              >
                {t("identities.create_default_file")}
              </Button>
            </Show>
            <Button
              variant="secondary"
              class="h-8 px-3 text-xs"
              onClick={() => void saveAgentFile()}
              disabled={agentSaving() || !workspaceId() || !agentDirty()}
            >
              {agentSaving() ? t("identities.saving") : t("identities.save_behavior")}
            </Button>
            <Show when={agentDirty() && !agentSaving()}>
              <span class="text-[11px] text-gray-9">{t("identities.unsaved_changes")}</span>
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
            <div class="text-[13px] font-semibold text-gray-12">{t("identities.send_test_title")}</div>
            <div class="text-[12px] text-gray-9 mt-0.5">
              {t("identities.send_test_desc")}
            </div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">{t("identities.channel_label")}</label>
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
              <label class="text-[12px] text-gray-9 block mb-1">{t("identities.peer_id_label")}</label>
              <input
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                placeholder={sendChannel() === "telegram" ? t("identities.peer_id_placeholder_telegram") : t("identities.peer_id_placeholder_slack")}
                value={sendPeerId()}
                onInput={(e) => setSendPeerId(e.currentTarget.value)}
              />
            </div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">{t("identities.directory_label")}</label>
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
                {t("identities.auto_bind_label")}
              </label>
            </div>
          </div>

          <div>
            <label class="text-[12px] text-gray-9 block mb-1">{t("identities.message_label")}</label>
            <textarea
              class="min-h-[90px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
              placeholder={t("identities.send_test_button")}
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
              {sendBusy() ? t("identities.sending") : t("identities.send_test_button")}
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
          title={t("identities.enable_messaging_title")}
          message={t("identities.enable_messaging_risk")}
          confirmLabel={messagingSaving() ? t("identities.enabling") : t("identities.enable_messaging")}
          cancelLabel={t("common.cancel")}
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
          title={t("identities.restart_worker_title")}
          message={
            messagingRestartAction() === "enable"
              ? t("identities.restart_to_enable_messaging")
              : t("identities.restart_to_disable_messaging")
          }
          confirmLabel={messagingRestartBusy() ? t("identities.restarting") : t("identities.restart_worker")}
          cancelLabel={t("identities.later")}
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
          title={t("identities.disable_messaging_title")}
          message={t("identities.disable_messaging_message")}
          confirmLabel={messagingSaving() ? t("identities.disabling") : t("identities.disable_messaging")}
          cancelLabel={t("common.cancel")}
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
          title={t("identities.public_bot_warning_title")}
          message={t("identities.public_bot_warning_message")}
          confirmLabel={t("identities.public_bot_confirm")}
          cancelLabel={t("common.cancel")}
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
