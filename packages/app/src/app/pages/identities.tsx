import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  ArrowRight,
  ChevronRight,
  Link,
  RefreshCcw,
  Shield,
} from "lucide-solid";

import { t } from "../../i18n";
import Button from "../components/button";
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
  openworkServerWorkspaceId: string | null;
  activeWorkspaceRoot: string;
  developerMode: boolean;
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

  const [slackBotToken, setSlackBotToken] = createSignal("");
  const [slackAppToken, setSlackAppToken] = createSignal("");
  const [slackEnabled, setSlackEnabled] = createSignal(true);
  const [slackSaving, setSlackSaving] = createSignal(false);
  const [slackStatus, setSlackStatus] = createSignal<string | null>(null);
  const [slackError, setSlackError] = createSignal<string | null>(null);

  const [expandedChannel, setExpandedChannel] = createSignal<string | null>(null);
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

  const workspaceId = createMemo(() => {
    const explicitId = props.openworkServerWorkspaceId?.trim() ?? "";
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
  const defaultRoutingDirectory = createMemo(() => props.activeWorkspaceRoot.trim() || t("identities.not_set"));

  let lastResetKey = "";

  const statusLabel = createMemo(() => {
    if (healthError()) return t("identities.status_unavailable");
    const snapshot = health();
    if (!snapshot) return t("identities.status_unknown");
    return snapshot.ok ? t("identities.status_running") : t("identities.status_offline");
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
    if (elapsedMs < 60_000) return t("identities.time_just_now");
    const minutes = Math.floor(elapsedMs / 60_000);
    if (minutes < 60) return t("identities.time_minutes_ago").replace("{minutes}", String(minutes));
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("identities.time_hours_ago").replace("{hours}", String(hours));
    const days = Math.floor(hours / 24);
    return t("identities.time_days_ago").replace("{days}", String(days));
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
      setAgentError("Worker scope unavailable.");
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
      setAgentStatus(t("identities.msg_agent_created"));
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
      setAgentStatus(t("identities.msg_agent_saved"));
    } catch (error) {
      if (error instanceof OpenworkServerError && error.status === 409) {
        setAgentError(t("identities.error_file_changed"));
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
      const base = t("identities.msg_dispatched").replace("{sent}", String(result.sent)).replace("{attempted}", String(result.attempted));
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

      if (!id) {
        setHealth(null);
        setTelegramIdentities([]);
        setTelegramBotUsername(null);
        setSlackIdentities([]);
        setHealthError(t("identities.error_worker_scope_unavailable_long"));
        setTelegramIdentitiesError(t("identities.error_worker_scope_unavailable"));
        setSlackIdentitiesError(t("identities.error_worker_scope_unavailable"));
        resetAgentState();
        setSendStatus(null);
        setSendError(null);
        setSendResult(null);
        return;
      }

      const [healthRes, tgRes, slackRes, telegramInfo] = await Promise.all([
        client.opencodeRouterHealth(),
        client.getOpenCodeRouterTelegramIdentities(id),
        client.getOpenCodeRouterSlackIdentities(id),
        client.getOpenCodeRouterTelegram(id).catch(() => null),
      ]);

      setTelegramBotUsername(getTelegramUsernameFromResult(telegramInfo));

      if (isOpenCodeRouterSnapshot(healthRes.json)) {
        setHealth(healthRes.json);
      } else {
        setHealth(null);
        if (!healthRes.ok) {
          const message =
            (healthRes.json && typeof (healthRes.json as any).message === "string")
              ? String((healthRes.json as any).message)
              : t("identities.error_health_unavailable").replace("{status}", String(healthRes.status));
          setHealthError(message);
        }
      }

      if (isOpenCodeRouterIdentities(tgRes)) {
        setTelegramIdentities(tgRes.items ?? []);
      } else {
        setTelegramIdentities([]);
        setTelegramIdentitiesError(t("identities.error_telegram_unavailable"));
      }

      if (isOpenCodeRouterIdentities(slackRes)) {
        setSlackIdentities(slackRes.items ?? []);
      } else {
        setSlackIdentities([]);
        setSlackIdentitiesError(t("identities.error_slack_unavailable"));
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
      setReconnectError(t("identities.error_reconnect_failed"));
      return;
    }

    setReconnectStatus(t("identities.msg_reconnected_refreshing"));
    await refreshAll({ force: true });
    setReconnectStatus(t("identities.msg_reconnected"));
  };

  const upsertTelegram = async () => {
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
      const result = await client.upsertOpenCodeRouterTelegramIdentity(id, { token, enabled: telegramEnabled() });
      if (result.ok) {
        const username = (result.telegram as any)?.bot?.username;
        if (username) {
          const normalized = String(username).trim().replace(/^@+/, "");
          setTelegramBotUsername(normalized || null);
          setTelegramStatus(t("identities.msg_saved_username").replace("{username}", normalized || String(username)));
        } else {
          setTelegramStatus(result.applied === false ? t("identities.msg_saved_pending") : t("identities.msg_saved"));
        }
      } else {
        setTelegramError(t("identities.error_save_failed"));
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
        setTelegramStatus(result.applied === false ? t("identities.msg_deleted_pending") : t("identities.msg_deleted"));
      } else {
        setTelegramError(t("identities.error_delete_failed"));
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
        setSlackStatus(result.applied === false ? t("identities.msg_saved_pending") : t("identities.msg_saved"));
      } else {
        setSlackError(t("identities.error_save_failed"));
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
        setSlackStatus(result.applied === false ? t("identities.msg_deleted_pending") : t("identities.msg_deleted"));
      } else {
        setSlackError(t("identities.error_delete_failed"));
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
    setSlackIdentities([]);
    setSlackIdentitiesError(null);
    resetAgentState();
    setSendStatus(null);
    setSendError(null);
    setSendResult(null);
    setReconnectStatus(null);
    setReconnectError(null);
    setActiveTab("general");
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
    <div class="space-y-6 max-w-[680px]">

      {/* ---- Header ---- */}
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <h1 class="text-lg font-bold text-gray-12 tracking-tight">{t("identities.title")}</h1>
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
              <span class="ml-1.5">{t("identities.refresh")}</span>
            </Button>
          </div>
        </div>
        <p class="text-sm text-gray-9 leading-relaxed">
          {t("identities.description")}
        </p>
        <div class="mt-1.5 text-[11px] text-gray-8 font-mono truncate">
          {t("identities.workspace_scope").replace("{url}", scopedOpenworkBaseUrl().trim() || props.openworkServerUrl.trim() || t("identities.not_set"))}
        </div>
        <Show when={reconnectStatus()}>
          {(value) => <div class="mt-1 text-[11px] text-gray-9">{value()}</div>}
        </Show>
        <Show when={reconnectError()}>
          {(value) => <div class="mt-1 text-[11px] text-red-12">{value()}</div>}
        </Show>
      </div>

      {/* ---- Not connected to server ---- */}
      <Show when={!serverReady()}>
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-5">
          <div class="text-sm font-semibold text-gray-12">{t("identities.connect_host")}</div>
          <div class="mt-1 text-xs text-gray-10" innerHTML={t("identities.connect_host_hint")} />
        </div>
      </Show>

      <Show when={serverReady()}>
        <Show when={!scopedWorkspaceReady()}>
          <div class="rounded-xl border border-amber-7/20 bg-amber-1/30 px-3 py-2 text-xs text-amber-12" innerHTML={t("identities.workspace_id_required")} />
        </Show>

        <div class="flex items-center gap-2 rounded-xl border border-gray-4 bg-gray-1 p-1">
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
            {t("identities.tab_advanced")}
          </button>
        </div>

        <Show when={activeTab() === "general"}>

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
              label={t("identities.status_channels")}
              value={t("identities.connected_count").replace("{count}", String(connectedChannelCount()))}
              ok={connectedChannelCount() > 0}
            />
            <StatusPill
              label={t("identities.status_messages_today")}
              value={messagesToday() == null ? "\u2014" : String(messagesToday())}
              ok={(messagesToday() ?? 0) > 0}
            />
            <StatusPill
              label={t("identities.status_last_activity")}
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
                    <span class="text-[15px] font-semibold text-gray-12">{t("identities.telegram")}</span>
                    <Show when={hasTelegramConnected()}>
                      <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-1/40 text-emerald-11">
                        {t("identities.connected")}
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    {t("identities.telegram_description")}
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
                                {item.enabled ? t("identities.enabled") : t("mcp.disabled")} · {item.running ? t("status.running") : t("status.stopped")}
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
                        <div class="text-[13px] font-semibold text-gray-12">{telegramIdentities().length} {t("identities.configured")}</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{t("identities.status_channels")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.telegram ? t("identities.channel_on") : t("identities.channel_off")}
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
                            <span innerHTML={t("identities.telegram_step1")} />
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">2</span>
                            <span>{t("identities.telegram_step2")}</span>
                          </li>
                          <li class="flex items-start gap-2">
                            <span class="mt-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-4 text-[10px] font-semibold text-gray-11">3</span>
                            <span innerHTML={t("identities.telegram_step3")} />
                          </li>
                        </ol>
                      </div>
                    </Show>

                    <div>
                      <label class="text-[12px] text-gray-9 block mb-1">{t("identities.bot_token")}</label>
                      <input
                        class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                        placeholder={t("identities.telegram_token_placeholder")}
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
                      {t("identities.enabled")}
                    </label>

                    <button
                      onClick={() => void upsertTelegram()}
                      disabled={telegramSaving() || !workspaceId() || !telegramToken().trim()}
                      class={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white border-none transition-opacity ${
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
                        <Link size={15} />
                      </Show>
                      {telegramSaving() ? t("identities.connecting") : t("identities.connect_telegram")}
                    </button>

                    <Show when={telegramBotLink()}>
                      {(value) => (
                        <a
                          href={value()}
                          target="_blank"
                          rel="noreferrer"
                          class="inline-flex items-center gap-2 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2 text-[12px] font-medium text-gray-11 hover:bg-gray-2"
                        >
                          <Link size={14} />
                          {t("identities.open_telegram_bot").replace("{username}", telegramBotUsername() || "")}
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
                    <span class="text-[15px] font-semibold text-gray-12">{t("identities.slack")}</span>
                    <Show when={hasSlackConnected()}>
                      <span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-1/40 text-emerald-11">
                        {t("identities.connected")}
                      </span>
                    </Show>
                  </div>
                  <div class="text-[13px] text-gray-9 mt-0.5 leading-snug">
                    {t("identities.slack_description")}
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
                                {item.enabled ? t("identities.enabled") : t("mcp.disabled")} · {item.running ? t("status.running") : t("status.stopped")}
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
                        <div class="text-[13px] font-semibold text-gray-12">{slackIdentities().length} {t("identities.configured")}</div>
                      </div>
                      <div class="flex-1 rounded-lg border border-gray-4 bg-gray-2/50 px-3 py-2.5">
                        <div class="text-[11px] text-gray-9 mb-0.5">{t("identities.status_channels")}</div>
                        <div class="text-[13px] font-semibold text-gray-12">
                          {health()?.channels.slack ? t("identities.channel_on") : t("identities.channel_off")}
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
                        {t("identities.slack_hint")}
                      </p>
                    </Show>

                    <div class="space-y-2">
                      <div>
                        <label class="text-[12px] text-gray-9 block mb-1">{t("identities.bot_token")}</label>
                        <input
                          class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2.5 text-sm text-gray-12 placeholder:text-gray-8"
                          placeholder="xoxb-..."
                          type="password"
                          value={slackBotToken()}
                          onInput={(e) => setSlackBotToken(e.currentTarget.value)}
                        />
                      </div>
                      <div>
                        <label class="text-[12px] text-gray-9 block mb-1">{t("identities.app_token")}</label>
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
                      {t("identities.enabled")}
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

        <Show when={activeTab() === "advanced"}>

        {/* ---- Message routing ---- */}
        <div>
          <div class="text-[11px] font-semibold text-gray-9 uppercase tracking-wider mb-2">
            {t("identities.message_routing")}
          </div>
          <p class="text-[13px] text-gray-9 leading-relaxed mb-3">
            {t("identities.message_routing_description")}
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

          <div class="text-xs text-gray-10 mt-2.5" innerHTML={t("identities.routing_advanced_hint")} />
        </div>

        {/* ---- Messaging agent behavior ---- */}
        <div class="rounded-xl border border-gray-4 bg-gray-1 p-4 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-[13px] font-semibold text-gray-12">{t("identities.agent_behavior")}</div>
              <div class="text-[12px] text-gray-9 mt-0.5" innerHTML={t("identities.agent_behavior_hint")} />
            </div>
            <span class="rounded-md border border-gray-4 bg-gray-2/50 px-2 py-1 text-[11px] font-mono text-gray-10">
              {OPENCODE_ROUTER_AGENT_FILE_PATH}
            </span>
          </div>

          <Show when={workspaceAgentStatus()}>
            {(value) => (
              <div class="rounded-lg border border-gray-4 bg-gray-2/40 px-3 py-2 text-[11px] text-gray-10">
                {t("identities.active_scope").replace("{loaded}", value().loaded ? "loaded" : "missing").replace("{selected}", value().selected || "(none)")}
              </div>
            )}
          </Show>

          <Show when={agentLoading()}>
            <div class="text-[11px] text-gray-9">{t("identities.loading_agent")}</div>
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
            <div class="text-[13px] font-semibold text-gray-12">{t("identities.send_test_message")}</div>
            <div class="text-[12px] text-gray-9 mt-0.5">
              {t("identities.send_test_hint")}
            </div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">{t("identities.status_channels")}</label>
              <select
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12"
                value={sendChannel()}
                onChange={(e) => setSendChannel(e.currentTarget.value === "slack" ? "slack" : "telegram")}
              >
                <option value="telegram">{t("identities.telegram")}</option>
                <option value="slack">{t("identities.slack")}</option>
              </select>
            </div>
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">{t("identities.peer_id")}</label>
              <input
                class="w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
                placeholder={sendChannel() === "telegram" ? t("identities.telegram_peer_placeholder") : t("identities.slack_peer_placeholder")}
                value={sendPeerId()}
                onInput={(e) => setSendPeerId(e.currentTarget.value)}
              />
            </div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <div>
              <label class="text-[12px] text-gray-9 block mb-1">{t("identities.directory")}</label>
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
                {t("identities.auto_bind")}
              </label>
            </div>
          </div>

          <div>
            <label class="text-[12px] text-gray-9 block mb-1">{t("identities.message")}</label>
            <textarea
              class="min-h-[90px] w-full rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-8"
              placeholder={t("identities.test_message_placeholder")}
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
              {sendBusy() ? t("identities.sending") : t("identities.send_test_message")}
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

      </Show>
    </div>
  );
}
