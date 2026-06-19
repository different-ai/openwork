/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildOpenworkWorkspaceBaseUrl,
  OpenworkServerError,
  type OpenworkOpenCodeRouterHealthSnapshot,
  type OpenworkOpenCodeRouterIdentityItem,
  type OpenworkOpenCodeRouterSendResult,
  type OpenworkServerClient,
  type OpenworkServerStatus,
  type OpenworkWorkspaceFileContent,
} from "../../../../app/lib/openwork-server";
import { t } from "../../../../i18n";
import type {
  MessagingChannel,
  MessagingViewExpandedChannel,
  MessagingViewProps,
  MessagingViewTab,
} from "../pages/messaging-view";

const OPENCODE_ROUTER_AGENT_FILE_PATH = ".opencode/agents/opencode-router.md";
const OPENCODE_ROUTER_AGENT_FILE_TEMPLATE = `# OpenCodeRouter Messaging Agent

Use this file to define how the assistant responds in Telegram for this workspace.

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

function isOpenCodeRouterSnapshot(
  value: unknown,
): value is OpenworkOpenCodeRouterHealthSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    typeof record.opencode === "object" &&
    typeof record.channels === "object" &&
    typeof record.config === "object"
  );
}

function isOpenCodeRouterIdentities(
  value: unknown,
): value is { ok: boolean; items: OpenworkOpenCodeRouterIdentityItem[] } {
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
  if (!messaging || typeof messaging !== "object" || Array.isArray(messaging)) {
    return false;
  }
  return (messaging as Record<string, unknown>).enabled === true;
}

type UseMessagingViewPropsOptions = {
  busy: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerClient: OpenworkServerClient | null;
  openworkReconnectBusy: boolean;
  reconnectOpenworkServer: () => Promise<boolean>;
  restartMessagingWorker: () => Promise<boolean>;
  workspaceId: string | null;
  selectedWorkspaceRoot: string;
};

export function useMessagingViewProps(
  options: UseMessagingViewPropsOptions,
): MessagingViewProps {
  const [refreshing, setRefreshing] = useState(false);
  const [health, setHealth] = useState<OpenworkOpenCodeRouterHealthSnapshot | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [telegramIdentities, setTelegramIdentities] = useState<OpenworkOpenCodeRouterIdentityItem[]>([]);
  const [telegramIdentitiesError, setTelegramIdentitiesError] = useState<string | null>(null);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramEnabled, setTelegramEnabled] = useState(true);
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [telegramBotUsername, setTelegramBotUsername] = useState<string | null>(null);
  const [telegramPairingCode, setTelegramPairingCode] = useState<string | null>(null);
  const [publicTelegramWarningOpen, setPublicTelegramWarningOpen] = useState(false);

  const [activeTab, setActiveTab] = useState<MessagingViewTab>("general");
  const [expandedChannel, setExpandedChannel] =
    useState<MessagingViewExpandedChannel>("telegram");

  const [agentLoading, setAgentLoading] = useState(false);
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentExists, setAgentExists] = useState(false);
  const [agentContent, setAgentContent] = useState("");
  const [agentDraft, setAgentDraft] = useState("");
  const [agentBaseUpdatedAt, setAgentBaseUpdatedAt] = useState<number | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentAutoHealAttempted, setAgentAutoHealAttempted] = useState(false);

  const [sendChannel, setSendChannel] = useState<MessagingChannel>("telegram");
  const [sendDirectory, setSendDirectory] = useState("");
  const [sendPeerId, setSendPeerId] = useState("");
  const [sendAutoBind, setSendAutoBind] = useState(true);
  const [sendText, setSendText] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendResult, setSendResult] =
    useState<OpenworkOpenCodeRouterSendResult | null>(null);

  const [reconnectStatus, setReconnectStatus] = useState<string | null>(null);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [messagingEnabled, setMessagingEnabled] = useState(false);
  const [messagingSaving, setMessagingSaving] = useState(false);
  const [messagingStatus, setMessagingStatus] = useState<string | null>(null);
  const [messagingError, setMessagingError] = useState<string | null>(null);
  const [messagingRiskOpen, setMessagingRiskOpen] = useState(false);
  const [messagingRestartRequired, setMessagingRestartRequired] = useState(false);
  const [messagingRestartPromptOpen, setMessagingRestartPromptOpen] =
    useState(false);
  const [messagingRestartBusy, setMessagingRestartBusy] = useState(false);
  const [messagingDisableConfirmOpen, setMessagingDisableConfirmOpen] =
    useState(false);
  const [messagingRestartAction, setMessagingRestartAction] = useState<
    "enable" | "disable"
  >("enable");

  const workspaceId = options.workspaceId?.trim() || null;
  const scopedOpenworkBaseUrl = useMemo(() => {
    const baseUrl = options.openworkServerUrl.trim();
    if (!baseUrl) return "";
    return buildOpenworkWorkspaceBaseUrl(baseUrl, workspaceId) ?? baseUrl;
  }, [options.openworkServerUrl, workspaceId]);
  const serverReady =
    options.openworkServerStatus === "connected" &&
    Boolean(options.openworkServerClient);
  const agentDirty = agentDraft !== agentContent;

  const resetAgentState = useCallback(() => {
    setAgentLoading(false);
    setAgentSaving(false);
    setAgentExists(false);
    setAgentContent("");
    setAgentDraft("");
    setAgentBaseUpdatedAt(null);
    setAgentStatus(null);
    setAgentError(null);
    setAgentAutoHealAttempted(false);
  }, []);

  const loadAgentFile = useCallback(async () => {
    if (agentLoading) return;
    if (!serverReady) return;
    const id = workspaceId;
    if (!id) {
      resetAgentState();
      setAgentError(t("identities.agent_worker_scope_unavailable"));
      return;
    }
    const client = options.openworkServerClient;
    if (!client) return;

    setAgentLoading(true);
    setAgentError(null);
    try {
      // Stat first: avoids a console-visible 404 when the agent file does
      // not exist yet (e.g. a fresh worktree); stat returns 200 + exists:false.
      const stat = await client.statWorkspaceFile(
        id,
        OPENCODE_ROUTER_AGENT_FILE_PATH,
      );
      if (!stat.exists) {
        setAgentExists(false);
        setAgentContent("");
        setAgentDraft("");
        setAgentBaseUpdatedAt(null);
        return;
      }
      const result = (await client.readWorkspaceFile(
        id,
        OPENCODE_ROUTER_AGENT_FILE_PATH,
      )) as OpenworkWorkspaceFileContent;
      const nextContent = result.content ?? "";
      setAgentExists(true);
      setAgentContent(nextContent);
      setAgentDraft(nextContent);
      setAgentBaseUpdatedAt(
        typeof result.updatedAt === "number" ? result.updatedAt : null,
      );
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
  }, [agentLoading, options.openworkServerClient, resetAgentState, serverReady, workspaceId]);

  const createDefaultAgentFile = useCallback(async () => {
    if (agentSaving) return;
    if (!serverReady) return;
    const id = workspaceId;
    if (!id) return;
    const client = options.openworkServerClient;
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
      setAgentBaseUpdatedAt(
        typeof result.updatedAt === "number" ? result.updatedAt : null,
      );
      setAgentStatus(t("identities.agent_created"));
    } catch (error) {
      setAgentError(formatRequestError(error));
    } finally {
      setAgentSaving(false);
    }
  }, [agentSaving, options.openworkServerClient, serverReady, workspaceId]);

  useEffect(() => {
    if (!messagingEnabled) return;
    if (agentLoading || agentSaving || agentDirty) return;
    if (agentExists) return;
    if (agentAutoHealAttempted) return;
    if (!workspaceId) return;

    setAgentAutoHealAttempted(true);
    void createDefaultAgentFile();
  }, [
    agentAutoHealAttempted,
    agentDirty,
    agentExists,
    agentLoading,
    agentSaving,
    createDefaultAgentFile,
    messagingEnabled,
    workspaceId,
  ]);

  const saveAgentFile = useCallback(async () => {
    if (agentSaving) return;
    if (!serverReady) return;
    const id = workspaceId;
    if (!id) return;
    const client = options.openworkServerClient;
    if (!client) return;

    setAgentSaving(true);
    setAgentStatus(null);
    setAgentError(null);
    try {
      const result = await client.writeWorkspaceFile(id, {
        path: OPENCODE_ROUTER_AGENT_FILE_PATH,
        content: agentDraft,
        baseUpdatedAt: agentBaseUpdatedAt,
      });
      setAgentExists(true);
      setAgentContent(agentDraft);
      setAgentBaseUpdatedAt(
        typeof result.updatedAt === "number" ? result.updatedAt : null,
      );
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
  }, [agentBaseUpdatedAt, agentDraft, agentSaving, options.openworkServerClient, serverReady, workspaceId]);

  const sendTestMessage = useCallback(async () => {
    if (sendBusy) return;
    if (!serverReady) return;
    const id = workspaceId;
    if (!id) return;
    const client = options.openworkServerClient;
    if (!client) return;
    const text = sendText.trim();
    if (!text) return;

    setSendBusy(true);
    setSendStatus(null);
    setSendError(null);
    setSendResult(null);
    try {
      const result = (await (client as any).sendOpenCodeRouterMessage(id, {
        channel: sendChannel,
        text,
        ...(sendDirectory.trim() ? { directory: sendDirectory.trim() } : {}),
        ...(sendPeerId.trim() ? { peerId: sendPeerId.trim() } : {}),
        ...(sendAutoBind ? { autoBind: true } : {}),
      })) as OpenworkOpenCodeRouterSendResult;
      setSendResult(result);
      const base = t("identities.dispatched_messages", undefined, {
        sent: result.sent,
        attempted: result.attempted,
      });
      setSendStatus(
        result.reason?.trim() ? `${base} ${result.reason.trim()}` : base,
      );
    } catch (error) {
      setSendError(formatRequestError(error));
    } finally {
      setSendBusy(false);
    }
  }, [
    options.openworkServerClient,
    sendAutoBind,
    sendBusy,
    sendChannel,
    sendDirectory,
    sendPeerId,
    sendText,
    serverReady,
    workspaceId,
  ]);

  const refreshAll = useCallback(async (nextOptions?: { force?: boolean }) => {
    if (refreshing && !nextOptions?.force) return;
    if (!serverReady) return;
    const client = options.openworkServerClient;
    if (!client) return;
    const id = workspaceId;

    setRefreshing(true);
    try {
      setHealthError(null);
      setTelegramIdentitiesError(null);
      setMessagingError(null);

      if (!id) {
        setHealth(null);
        setTelegramIdentities([]);
        setTelegramBotUsername(null);
        setTelegramPairingCode(null);
        setHealthError(t("identities.worker_scope_unavailable_detail"));
        setTelegramIdentitiesError(t("identities.worker_scope_unavailable"));
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
        if (!agentDirty && !agentSaving) {
          void loadAgentFile();
        }
        return;
      }

      const [healthRes, tgRes, telegramInfo] = await Promise.all([
        (client as any).getOpenCodeRouterHealth(id),
        (client as any).getOpenCodeRouterTelegramIdentities(id),
        (client as any).getOpenCodeRouterTelegram(id).catch(() => null),
      ]);

      setTelegramBotUsername(getTelegramUsernameFromResult(telegramInfo));

      if (isOpenCodeRouterSnapshot(healthRes.json)) {
        setHealth(healthRes.json);
        setMessagingRestartRequired(false);
      } else {
        setHealth(null);
        if (!healthRes.ok) {
          const message =
            healthRes.json && typeof (healthRes.json as any).message === "string"
              ? String((healthRes.json as any).message)
              : t("identities.health_unavailable_status", undefined, {
                  status: healthRes.status,
                });
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

      if (!agentDirty && !agentSaving) {
        void loadAgentFile();
      }
    } catch (error) {
      const message = formatRequestError(error);
      setHealth(null);
      setTelegramIdentities([]);
      setTelegramBotUsername(null);
      setHealthError(message);
      setTelegramIdentitiesError(message);
      if (messagingEnabled) {
        setMessagingRestartRequired(true);
      }
    } finally {
      setRefreshing(false);
    }
  }, [
    agentDirty,
    agentSaving,
    loadAgentFile,
    messagingEnabled,
    options.openworkServerClient,
    refreshing,
    resetAgentState,
    serverReady,
    workspaceId,
  ]);

  const refreshAllRef = useRef(refreshAll);

  useEffect(() => {
    refreshAllRef.current = refreshAll;
  }, [refreshAll]);

  const repairAndReconnect = useCallback(async () => {
    if (options.openworkReconnectBusy) return;
    setReconnectStatus(null);
    setReconnectError(null);

    const ok = await options.reconnectOpenworkServer();
    if (!ok) {
      setReconnectError(t("identities.reconnect_failed"));
      return;
    }

    setReconnectStatus(t("identities.reconnected_refreshing"));
    await refreshAll({ force: true });
    setReconnectStatus(t("identities.reconnected"));
  }, [options, refreshAll]);

  const enableMessagingModule = useCallback(async () => {
    if (messagingSaving) return;
    if (!serverReady) return;
    const id = workspaceId;
    if (!id) return;
    const client = options.openworkServerClient;
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
  }, [messagingSaving, options.openworkServerClient, refreshAll, serverReady, workspaceId]);

  const disableMessagingModule = useCallback(async () => {
    if (messagingSaving) return;
    if (!serverReady) return;
    const id = workspaceId;
    if (!id) return;
    const client = options.openworkServerClient;
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
  }, [messagingSaving, options.openworkServerClient, refreshAll, serverReady, workspaceId]);

  const restartMessagingWorker = useCallback(async () => {
    if (messagingRestartBusy) return;
    setMessagingRestartBusy(true);
    setMessagingError(null);
    setMessagingStatus(null);
    try {
      const ok = await options.restartMessagingWorker();
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
  }, [messagingRestartBusy, options.restartMessagingWorker, refreshAll]);

  const upsertTelegram = useCallback(async (access: "public" | "private") => {
    if (telegramSaving) return;
    if (!serverReady) return;
    const id = workspaceId;
    if (!id) return;
    const client = options.openworkServerClient;
    if (!client) return;

    const token = telegramToken.trim();
    if (!token) return;

    setTelegramSaving(true);
    setTelegramStatus(null);
    setTelegramError(null);
    try {
      const result = await (client as any).upsertOpenCodeRouterTelegramIdentity(id, {
        token,
        enabled: telegramEnabled,
        access,
      });
      if (result.ok) {
        const pairingCode =
          typeof result.telegram?.pairingCode === "string"
            ? result.telegram.pairingCode.trim()
            : "";
        if (access === "private" && pairingCode) {
          setTelegramPairingCode(pairingCode);
          setTelegramStatus(
            t("identities.telegram_private_saved_pair", undefined, {
              code: pairingCode,
            }),
          );
        } else {
          setTelegramPairingCode(null);
        }
        const username = (result.telegram as any)?.bot?.username;
        if (username) {
          const normalized = String(username).trim().replace(/^@+/, "");
          setTelegramBotUsername(normalized || null);
          if (access !== "private" || !pairingCode) {
            setTelegramStatus(
              t("identities.telegram_saved_username", undefined, {
                username: normalized || String(username),
              }),
            );
          }
        } else if (access !== "private" || !pairingCode) {
          setTelegramStatus(
            result.applied === false
              ? t("identities.telegram_saved_pending")
              : t("identities.telegram_saved"),
          );
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
  }, [
    options.openworkServerClient,
    refreshAll,
    serverReady,
    telegramEnabled,
    telegramSaving,
    telegramToken,
    workspaceId,
  ]);

  const deleteTelegram = useCallback(async (identityId: string) => {
    if (telegramSaving) return;
    if (!serverReady) return;
    const id = workspaceId;
    if (!id) return;
    const client = options.openworkServerClient;
    if (!client) return;
    if (!identityId.trim()) return;

    setTelegramSaving(true);
    setTelegramStatus(null);
    setTelegramError(null);
    try {
      const result = await (client as any).deleteOpenCodeRouterTelegramIdentity(id, identityId);
      if (result.ok) {
        setTelegramBotUsername(null);
        setTelegramPairingCode(null);
        setTelegramStatus(
          result.applied === false
            ? t("identities.telegram_deleted_pending")
            : t("identities.telegram_deleted"),
        );
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
  }, [options.openworkServerClient, refreshAll, serverReady, telegramSaving, workspaceId]);

  const copyTelegramPairingCode = useCallback(async () => {
    if (!telegramPairingCode) return;
    try {
      await navigator.clipboard.writeText(telegramPairingCode);
      setTelegramStatus(t("identities.pairing_code_copied"));
    } catch {
      setTelegramError(t("identities.pairing_code_copy_failed"));
    }
  }, [telegramPairingCode]);

  useEffect(() => {
    setHealth(null);
    setHealthError(null);
    setTelegramIdentities([]);
    setTelegramIdentitiesError(null);
    setTelegramBotUsername(null);
    setTelegramPairingCode(null);
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
  }, [resetAgentState, scopedOpenworkBaseUrl, workspaceId]);

  useEffect(() => {
    void refreshAllRef.current({ force: true });
    const interval = window.setInterval(() => {
      void refreshAllRef.current();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [scopedOpenworkBaseUrl, serverReady, workspaceId]);

  return {
    busy: options.busy,
    showHeader: false,
    openworkServerStatus: options.openworkServerStatus,
    openworkServerUrl: options.openworkServerUrl,
    scopedOpenworkBaseUrl,
    workspaceId,
    selectedWorkspaceRoot: options.selectedWorkspaceRoot,
    refreshing,
    openworkReconnectBusy: options.openworkReconnectBusy,
    reconnectStatus,
    reconnectError,
    health,
    healthError,
    messagingEnabled,
    messagingSaving,
    messagingStatus,
    messagingError,
    messagingRestartRequired,
    messagingRestartBusy,
    activeTab,
    expandedChannel,
    telegram: {
      identities: telegramIdentities,
      identitiesError: telegramIdentitiesError,
      token: telegramToken,
      enabled: telegramEnabled,
      saving: telegramSaving,
      status: telegramStatus,
      error: telegramError,
      botUsername: telegramBotUsername,
      pairingCode: telegramPairingCode,
    },
    agent: {
      loading: agentLoading,
      saving: agentSaving,
      exists: agentExists,
      content: agentContent,
      draft: agentDraft,
      status: agentStatus,
      error: agentError,
    },
    sendTest: {
      channel: sendChannel,
      directory: sendDirectory,
      peerId: sendPeerId,
      autoBind: sendAutoBind,
      text: sendText,
      busy: sendBusy,
      status: sendStatus,
      error: sendError,
      result: sendResult,
    },
    modals: {
      messagingRiskOpen,
      messagingRestartPromptOpen,
      messagingRestartAction,
      messagingDisableConfirmOpen,
      publicTelegramWarningOpen,
    },
    onRepairAndReconnect: repairAndReconnect,
    onRefresh: () => refreshAll({ force: true }),
    onSelectTab: setActiveTab,
    onToggleExpandedChannel: (channel) =>
      setExpandedChannel((prev) => (prev === channel ? null : channel)),
    onOpenMessagingRisk: () => setMessagingRiskOpen(true),
    onCancelMessagingRisk: () => {
      if (messagingSaving) return;
      setMessagingRiskOpen(false);
    },
    onConfirmEnableMessaging: enableMessagingModule,
    onOpenDisableMessagingConfirm: () => setMessagingDisableConfirmOpen(true),
    onCancelDisableMessagingConfirm: () => {
      if (messagingSaving) return;
      setMessagingDisableConfirmOpen(false);
    },
    onConfirmDisableMessaging: disableMessagingModule,
    onCancelRestartPrompt: () => {
      if (messagingRestartBusy) return;
      setMessagingRestartPromptOpen(false);
    },
    onConfirmRestartMessagingWorker: restartMessagingWorker,
    onTelegramTokenChange: setTelegramToken,
    onTelegramEnabledChange: setTelegramEnabled,
    onOpenPublicTelegramWarning: () => setPublicTelegramWarningOpen(true),
    onCancelPublicTelegramWarning: () => setPublicTelegramWarningOpen(false),
    onConfirmPublicTelegram: async () => {
      setPublicTelegramWarningOpen(false);
      await upsertTelegram("public");
    },
    onConnectPrivateTelegram: async () => {
      await upsertTelegram("private");
    },
    onDeleteTelegram: deleteTelegram,
    onCopyTelegramPairingCode: copyTelegramPairingCode,
    onHideTelegramPairingCode: () => setTelegramPairingCode(null),
    onLoadAgentFile: loadAgentFile,
    onCreateDefaultAgentFile: createDefaultAgentFile,
    onChangeAgentDraft: setAgentDraft,
    onSaveAgentFile: saveAgentFile,
    onChangeSendChannel: setSendChannel,
    onChangeSendPeerId: setSendPeerId,
    onChangeSendDirectory: setSendDirectory,
    onChangeSendAutoBind: setSendAutoBind,
    onChangeSendText: setSendText,
    onSendTestMessage: sendTestMessage,
  } satisfies MessagingViewProps;
}
