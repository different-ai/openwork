import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onMount,
} from "solid-js";

import {
  formatBytes,
  formatRelativeTime,
  isTauriRuntime,
  isWindowsPlatform,
} from "../utils";

import AuthorizedFoldersPanel from "../app-settings/authorized-folders-panel";
import Button from "../components/button";
import ProviderIcon from "../components/provider-icon";
import WebUnavailableSurface from "../components/web-unavailable-surface";
import DenSettingsPanel from "../components/den-settings-panel";
import TextInput from "../components/text-input";
import { useModelControls } from "../app-settings/model-controls-provider";
import { useSessionDisplayPreferences } from "../app-settings/session-display-preferences";
import { usePlatform } from "../context/platform";
import ConfigView from "./config";
import ExtensionsView from "./extensions";
import IdentitiesView from "./identities";
import AutomationsView from "./automations";
import SkillsView from "./skills";
import { buildFeedbackUrl } from "../lib/feedback";
import { clearDevLogs, formatDevLogText, readDevLogs } from "../lib/dev-log";
import { getOpenWorkDeployment } from "../lib/openwork-deployment";
import {
  ArrowUpRight,
  CircleAlert,
  Copy,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
  LifeBuoy,
  MessageCircle,
  PlugZap,
  RefreshCcw,
  Server,
  Smartphone,
  Zap,
} from "lucide-solid";
import type {
  OpencodeConnectStatus,
  ProviderListItem,
  SettingsTab,
  StartupPreference,
  SuggestedPlugin,
} from "../types";
import type {
  OpenworkAuditEntry,
  OpenworkServerClient,
  OpenworkServerCapabilities,
  OpenworkServerDiagnostics,
  OpenworkServerSettings,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import type { DenOrgLlmProvider } from "../lib/den";
import type {
  EngineInfo,
  OrchestratorBinaryInfo,
  OrchestratorStatus,
  OpenworkServerInfo,
  AppBuildInfo,
  OpenCodeRouterInfo,
  SandboxDebugProbeResult,
} from "../lib/tauri";
import type { CloudImportedProvider } from "../cloud/import-state";
import {
  appBuildInfo,
  engineRestart,
  nukeOpenworkAndOpencodeConfigAndExit,
  opencodeRouterRestart,
  opencodeRouterStop,
  openworkServerRestart,
  pickFile,
  sandboxDebugProbe,
} from "../lib/tauri";
import { currentLocale, LANGUAGE_OPTIONS, t, type Language } from "../../i18n";

export type SettingsViewProps = {
  startupPreference: StartupPreference | null;
  baseUrl: string;
  headerStatus: string;
  busy: boolean;
  clientConnected: boolean;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  providerAuthBusy: boolean;
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
  openProviderAuthModal: (options?: {
    returnFocusTarget?: "none" | "composer";
    preferredProviderId?: string;
  }) => Promise<void>;
  disconnectProvider: (providerId: string) => Promise<string | void>;
  removeCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  refreshCloudOrgProviders: (options?: { force?: boolean }) => Promise<DenOrgLlmProvider[]>;
  connectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerClient: OpenworkServerClient | null;
  openworkReconnectBusy: boolean;
  reconnectOpenworkServer: () => Promise<boolean>;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  resetOpenworkServerSettings: () => void;
  testOpenworkServerConnection: (next: OpenworkServerSettings) => Promise<boolean>;
  runtimeWorkspaceId: string | null;
  selectedWorkspaceRoot: string;
  activeWorkspaceType: "local" | "remote";
  openworkAuditEntries: OpenworkAuditEntry[];
  openworkAuditStatus: "idle" | "loading" | "error";
  openworkAuditError: string | null;
  opencodeConnectStatus: OpencodeConnectStatus | null;
  engineInfo: EngineInfo | null;
  orchestratorStatus: OrchestratorStatus | null;
  opencodeRouterInfo: OpenCodeRouterInfo | null;
  developerMode: boolean;
  toggleDeveloperMode: () => void;
  stopHost: () => void;
  restartLocalServer: () => Promise<boolean>;
  engineSource: "path" | "sidecar" | "custom";
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  engineCustomBinPath: string;
  setEngineCustomBinPath: (value: string) => void;
  engineRuntime: "direct" | "openwork-orchestrator";
  setEngineRuntime: (value: "direct" | "openwork-orchestrator") => void;
  opencodeEnableExa: boolean;
  toggleOpencodeEnableExa: () => void;
  isWindows: boolean;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
  language: Language;
  setLanguage: (value: Language) => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateAutoDownload: boolean;
  toggleUpdateAutoDownload: () => void;
  updateStatus: {
    state: string;
    lastCheckedAt?: number | null;
    version?: string;
    date?: string;
    notes?: string;
    totalBytes?: number | null;
    downloadedBytes?: number;
    message?: string;
  } | null;
  updateEnv: { supported?: boolean; reason?: string | null } | null;
  appVersion: string | null;
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdateAndRestart: () => void;
  anyActiveRuns: boolean;
  onResetStartupPreference: () => void;
  openResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  pendingPermissions: unknown;
  events: unknown;
  workspaceDebugEvents: unknown;
  sandboxCreateProgress: unknown;
  sandboxCreateProgressLast: unknown;
  clearWorkspaceDebugEvents: () => void;
  safeStringify: (value: unknown) => string;
  repairOpencodeCache: () => void;
  cacheRepairBusy: boolean;
  cacheRepairResult: string | null;
  cleanupOpenworkDockerContainers: () => void;
  dockerCleanupBusy: boolean;
  dockerCleanupResult: string | null;
  markOpencodeConfigReloadRequired: () => void;
  resetAppConfigDefaults: () => Promise<{ ok: boolean; message: string }>;
  engineDoctorVersion: string | null;
  openDebugDeepLink: (
    rawUrl: string,
  ) => Promise<{ ok: boolean; message: string }>;
  newTaskDisabled: boolean;
  schedulerPluginInstalled: boolean;
  skillsAccessHint?: string | null;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  pluginsAccessHint?: string | null;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
  suggestedPlugins: SuggestedPlugin[];
  addPlugin: (pluginNameOverride?: string) => void;
  createSessionAndOpen: (initialPrompt?: string) => Promise<string | undefined> | string | void;
  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  openTeamBundle: (input: {
    templateId: string;
    name: string;
    templateData: unknown;
    organizationName?: string | null;
  }) => Promise<void> | void;
};

const DISCORD_INVITE_URL = "https://discord.gg/VEhNQXxYMB";
const BUG_REPORT_URL =
  "https://github.com/different-ai/openwork/issues/new?template=bug.yml";

export default function SettingsView(props: SettingsViewProps) {
  const modelControls = useModelControls();
  const { showThinking, toggleShowThinking } = useSessionDisplayPreferences();
  const platform = usePlatform();
  const webDeployment = createMemo(() => getOpenWorkDeployment() === "web");
  const translate = (key: string) => t(key, currentLocale());
  const engineCustomBinPathLabel = () =>
    props.engineCustomBinPath.trim() || translate("settings.no_binary_selected");

  const openExternalLink = (url: string) => {
    const resolved = url.trim();
    if (!resolved) return;
    platform.openLink(resolved);
  };

  const handlePickEngineBinary = async () => {
    if (!isTauriRuntime()) return;
    try {
      const selected = await pickFile({ title: translate("settings.select_binary") });
      const path = Array.isArray(selected) ? selected[0] : selected;
      const trimmed = (path ?? "").trim();
      if (!trimmed) return;
      props.setEngineCustomBinPath(trimmed);
      props.setEngineSource("custom");
    } catch {
      // ignore
    }
  };
  const [buildInfo, setBuildInfo] = createSignal<AppBuildInfo | null>(null);
  const updateState = () => props.updateStatus?.state ?? "idle";
  const updateNotes = () => props.updateStatus?.notes ?? null;
  const updateVersion = () => props.updateStatus?.version ?? null;
  const updateDate = () => props.updateStatus?.date ?? null;
  const updateLastCheckedAt = () => props.updateStatus?.lastCheckedAt ?? null;
  const updateDownloadedBytes = () =>
    props.updateStatus?.downloadedBytes ?? null;
  const updateTotalBytes = () => props.updateStatus?.totalBytes ?? null;
  const updateErrorMessage = () => props.updateStatus?.message ?? null;

  const updateDownloadPercent = createMemo<number | null>(() => {
    const total = updateTotalBytes();
    if (total == null || total <= 0) return null;
    const downloaded = updateDownloadedBytes() ?? 0;
    const clamped = Math.max(0, Math.min(1, downloaded / total));
    return Math.floor(clamped * 100);
  });

  const isMacToolbar = createMemo(() => {
    if (props.isWindows) return false;
    if (typeof navigator === "undefined") return false;
    const platform =
      typeof (navigator as any).userAgentData?.platform === "string"
        ? (navigator as any).userAgentData.platform
        : typeof navigator.platform === "string"
          ? navigator.platform
          : "";
    const ua =
      typeof navigator.userAgent === "string" ? navigator.userAgent : "";
    return /mac/i.test(platform) || /mac/i.test(ua);
  });

  const showUpdateToolbar = createMemo(() => {
    if (!isTauriRuntime()) return false;
    if (props.updateEnv && props.updateEnv.supported === false) return false;
    return isMacToolbar();
  });

  const updateToolbarTone = createMemo(() => {
    switch (updateState()) {
      case "available":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      case "ready":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "error":
        return "bg-red-7/10 text-red-11 border-red-7/20";
      case "checking":
      case "downloading":
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  });

  const updateToolbarSpinning = createMemo(
    () => updateState() === "checking" || updateState() === "downloading",
  );

  const updateToolbarLabel = createMemo(() => {
    const state = updateState();
    const version = updateVersion();
    if (state === "available") {
      return `${translate("session.update_available")}${version ? ` · v${version}` : ""}`;
    }
    if (state === "ready") {
      return `${translate("settings.toolbar_ready_to_install")}${version ? ` · v${version}` : ""}`;
    }
    if (state === "downloading") {
      const downloaded = updateDownloadedBytes() ?? 0;
      const percent = updateDownloadPercent();
      if (percent != null) return `${translate("session.downloading")} ${percent}%`;
      return `${translate("session.downloading")} ${formatBytes(downloaded)}`;
    }
    if (state === "checking") {
      return translate("settings.checking_for_updates");
    }
    if (state === "error") {
      return translate("settings.update_error");
    }
    return translate("settings.update_uptodate");
  });

  const updateToolbarTitle = createMemo(() => {
    const state = updateState();
    const version = updateVersion();
    if (state !== "downloading") return updateToolbarLabel();

    const downloaded = updateDownloadedBytes() ?? 0;
    const total = updateTotalBytes();
    const percent = updateDownloadPercent();

    if (total != null && percent != null) {
      return t("settings.downloading_progress", undefined, { downloaded: formatBytes(downloaded), total: formatBytes(total), percent: String(percent) }) + (version ? ` · v${version}` : "");
    }

    return t("settings.downloading_bytes", undefined, { downloaded: formatBytes(downloaded) }) + (version ? ` · v${version}` : "");
  });

  const updateToolbarActionLabel = createMemo(() => {
    const state = updateState();
    if (state === "available") return translate("settings.action_download");
    if (state === "ready") return translate("settings.action_install");
    if (state === "error") return translate("common.retry");
    if (state === "idle") return translate("settings.check_update");
    return null;
  });

  const updateToolbarDisabled = createMemo(() => {
    const state = updateState();
    if (state === "checking" || state === "downloading") return true;
    if (state === "ready" && props.anyActiveRuns) return true;
    return props.busy;
  });

  const updateRestartBlockedMessage = createMemo(() => {
    if (updateState() !== "ready" || !props.anyActiveRuns) return null;
    return translate("settings.restart_blocked_message");
  });

  const handleUpdateToolbarAction = () => {
    if (updateToolbarDisabled()) return;
    const state = updateState();
    if (state === "available") {
      props.downloadUpdate();
      return;
    }
    if (state === "ready") {
      props.installUpdateAndRestart();
      return;
    }
    props.checkForUpdates();
  };

  const [providerConnectError, setProviderConnectError] = createSignal<
    string | null
  >(null);
  const [providerDisconnectStatus, setProviderDisconnectStatus] = createSignal<
    string | null
  >(null);
  const [providerDisconnectError, setProviderDisconnectError] = createSignal<
    string | null
  >(null);
  const [providerDisconnectingId, setProviderDisconnectingId] = createSignal<
    string | null
  >(null);
  const [openworkReconnectStatus, setOpenworkReconnectStatus] = createSignal<
    string | null
  >(null);
  const [openworkReconnectError, setOpenworkReconnectError] = createSignal<
    string | null
  >(null);
  const [openworkRestartBusy, setOpenworkRestartBusy] = createSignal(false);
  const [openworkRestartStatus, setOpenworkRestartStatus] = createSignal<
    string | null
  >(null);
  const [openworkRestartError, setOpenworkRestartError] = createSignal<
    string | null
  >(null);
  const providerAvailableCount = createMemo(
    () => (props.providers ?? []).length,
  );
  const connectedProviders = createMemo(() => {
    const connected = new Set(props.providerConnectedIds ?? []);
    return (props.providers ?? [])
      .filter((provider) => connected.has(provider.id))
      .map((provider) => ({
        id: provider.id,
        name: provider.name?.trim() || provider.id.trim() || provider.id,
        source: (provider as ProviderListItem & {
          source?: "env" | "api" | "config" | "custom";
        }).source,
      }))
      .filter((entry) => entry.id.trim());
  });
  const providerConnectedCount = createMemo(() => connectedProviders().length);
  const providerSourceLabel = (source?: "env" | "api" | "config" | "custom") => {
    if (source === "env") return translate("settings.provider_source_env");
    if (source === "api") return translate("providers.api_key_label");
    if (source === "config") return translate("settings.provider_source_config");
    if (source === "custom") return translate("settings.provider_source_custom");
    return null;
  };
  const canDisconnectProvider = (source?: "env" | "api" | "config" | "custom") =>
    source !== "env";
  const providerStatusLabel = createMemo(() => {
    if (!providerAvailableCount()) return translate("config.unavailable");
    if (!providerConnectedCount()) return translate("config.status_not_connected");
    return `${providerConnectedCount()} ${translate("settings.suffix_connected")}`;
  });
  const providerStatusStyle = createMemo(() => {
    if (!providerAvailableCount())
      return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    if (!providerConnectedCount())
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });
  const providerSummary = createMemo(() => {
    if (!providerAvailableCount())
      return translate("settings.connect_opencode_hint");
    const connected = providerConnectedCount();
    const available = providerAvailableCount();
    if (!connected) return `${available} ${translate("settings.suffix_available")}`;
    return `${connected} ${translate("settings.suffix_connected")} · ${available} ${translate("settings.suffix_available")}`;
  });

  const handleOpenProviderAuth = async () => {
    if (props.busy || props.providerAuthBusy) return;
    setProviderConnectError(null);
    setProviderDisconnectError(null);
    setProviderDisconnectStatus(null);
    try {
      await props.openProviderAuthModal();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : translate("settings.failed_open_providers");
      setProviderConnectError(message);
    }
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const resolved = providerId.trim();
    if (
      !resolved ||
      props.busy ||
      props.providerAuthBusy ||
      providerDisconnectingId()
    )
      return;
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            `Disconnect ${resolved}? ${translate("settings.disconnect_confirm_suffix")}`,
          );
    if (!confirmed) return;
    setProviderDisconnectError(null);
    setProviderDisconnectStatus(null);
    setProviderDisconnectingId(resolved);
    try {
      const result = await props.disconnectProvider(resolved);
      setProviderDisconnectStatus(result || `${translate("settings.disconnected_prefix")} ${resolved}.`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : translate("providers.disconnect_failed");
      setProviderDisconnectError(message);
    } finally {
      setProviderDisconnectingId(null);
    }
  };

  const handleReconnectOpenworkServer = async () => {
    if (props.busy || props.openworkReconnectBusy) return;
    if (!props.openworkServerUrl.trim()) return;
    setOpenworkReconnectStatus(null);
    setOpenworkReconnectError(null);
    try {
      const ok = await props.reconnectOpenworkServer();
      if (!ok) {
        setOpenworkReconnectError(translate("settings.reconnect_failed"));
        return;
      }
      setOpenworkReconnectStatus(translate("settings.reconnected"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenworkReconnectError(
        message || translate("settings.reconnect_server_failed"),
      );
    }
  };

  const handleRestartLocalServer = async () => {
    if (props.busy || openworkRestartBusy()) return;
    setOpenworkRestartStatus(null);
    setOpenworkRestartError(null);
    setOpenworkRestartBusy(true);
    try {
      const ok = await props.restartLocalServer();
      if (!ok) {
        setOpenworkRestartError(translate("settings.restart_failed"));
        return;
      }
      setOpenworkRestartStatus(translate("settings.restarted"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenworkRestartError(message || translate("settings.restart_server_failed"));
    } finally {
      setOpenworkRestartBusy(false);
    }
  };

  const openworkStatusLabel = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return translate("config.status_connected");
      case "limited":
        return translate("config.status_limited");
      default:
        return translate("config.status_not_connected");
    }
  });

  const openworkStatusStyle = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  });

  const openworkStatusDot = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "bg-green-9";
      case "limited":
        return "bg-amber-9";
      default:
        return "bg-gray-6";
    }
  });

  const clientStatusLabel = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return translate("status.connecting");
    if (status === "error") return translate("settings.connection_failed");
    return props.clientConnected ? translate("status.connected") : translate("config.status_not_connected");
  });

  const clientStatusStyle = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting")
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    if (status === "error") return "bg-red-7/10 text-red-11 border-red-7/20";
    return props.clientConnected
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const clientStatusDot = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return "bg-amber-9";
    if (status === "error") return "bg-red-9";
    return props.clientConnected ? "bg-green-9" : "bg-gray-6";
  });

  const engineStatusLabel = createMemo(() => {
    if (!isTauriRuntime()) return translate("config.unavailable");
    return props.engineInfo?.running ? translate("status.running") : translate("settings.offline");
  });

  const engineStatusStyle = createMemo(() => {
    if (!isTauriRuntime()) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.engineInfo?.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const opencodeConnectStatusLabel = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (!status) return translate("status.idle");
    if (status === "connected") return translate("status.connected");
    if (status === "connecting") return translate("status.connecting");
    return translate("settings.failed");
  });

  const opencodeConnectStatusStyle = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (!status) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    if (status === "connected")
      return "bg-green-7/10 text-green-11 border-green-7/20";
    if (status === "connecting")
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    return "bg-red-7/10 text-red-11 border-red-7/20";
  });

  const opencodeConnectTimestamp = createMemo(() => {
    const at = props.opencodeConnectStatus?.at;
    if (!at) return null;
    return formatRelativeTime(at);
  });

  const opencodeRouterStatusLabel = createMemo(() => {
    if (!isTauriRuntime()) return translate("config.unavailable");
    return props.opencodeRouterInfo?.running ? translate("status.running") : translate("settings.offline");
  });

  const opencodeRouterStatusStyle = createMemo(() => {
    if (!isTauriRuntime()) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.opencodeRouterInfo?.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const [opencodeRouterRestarting, setOpenCodeRouterRestarting] =
    createSignal(false);
  const [opencodeRouterRestartError, setOpenCodeRouterRestartError] =
    createSignal<string | null>(null);
  const [openworkServerRestarting, setOpenworkServerRestarting] =
    createSignal(false);
  const [openworkServerRestartError, setOpenworkServerRestartError] =
    createSignal<string | null>(null);
  const [opencodeRestarting, setOpencodeRestarting] = createSignal(false);
  const [opencodeRestartError, setOpencodeRestartError] = createSignal<
    string | null
  >(null);

  const handleOpenCodeRouterRestart = async () => {
    if (opencodeRouterRestarting()) return;
    const workspacePath =
      props.opencodeRouterInfo?.workspacePath?.trim() ||
      props.engineInfo?.projectDir?.trim();
    const opencodeUrl =
      props.opencodeRouterInfo?.opencodeUrl?.trim() ||
      props.engineInfo?.baseUrl?.trim();
    const opencodeUsername =
      props.engineInfo?.opencodeUsername?.trim() || undefined;
    const opencodePassword =
      props.engineInfo?.opencodePassword?.trim() || undefined;
    if (!workspacePath) {
      setOpenCodeRouterRestartError(translate("settings.no_worker_path"));
      return;
    }
    setOpenCodeRouterRestarting(true);
    setOpenCodeRouterRestartError(null);
    try {
      await opencodeRouterRestart({
        workspacePath,
        opencodeUrl: opencodeUrl || undefined,
        opencodeUsername,
        opencodePassword,
      });
    } catch (e) {
      setOpenCodeRouterRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpenCodeRouterRestarting(false);
    }
  };

  const handleOpenCodeRouterStop = async () => {
    if (opencodeRouterRestarting()) return;
    setOpenCodeRouterRestarting(true);
    setOpenCodeRouterRestartError(null);
    try {
      await opencodeRouterStop();
    } catch (e) {
      setOpenCodeRouterRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpenCodeRouterRestarting(false);
    }
  };

  const handleOpenworkServerRestart = async () => {
    if (openworkServerRestarting() || !isTauriRuntime()) return;
    setOpenworkServerRestarting(true);
    setOpenworkServerRestartError(null);
    try {
      await openworkServerRestart({
        remoteAccessEnabled:
          props.openworkServerSettings.remoteAccessEnabled === true,
      });
      await props.reconnectOpenworkServer();
    } catch (e) {
      setOpenworkServerRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpenworkServerRestarting(false);
    }
  };

  const handleOpenCodeRestart = async () => {
    if (opencodeRestarting() || !isTauriRuntime()) return;
    setOpencodeRestarting(true);
    setOpencodeRestartError(null);
    try {
      await engineRestart({
        opencodeEnableExa: props.opencodeEnableExa,
        openworkRemoteAccess:
          props.openworkServerSettings.remoteAccessEnabled === true,
      });
      await props.reconnectOpenworkServer();
    } catch (e) {
      setOpencodeRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpencodeRestarting(false);
    }
  };

  const orchestratorStatusLabel = createMemo(() => {
    if (!props.orchestratorStatus) return translate("config.unavailable");
    return props.orchestratorStatus.running ? translate("status.running") : translate("settings.offline");
  });

  const orchestratorStatusStyle = createMemo(() => {
    if (!props.orchestratorStatus)
      return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.orchestratorStatus.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const openworkAuditStatusLabel = createMemo(() => {
    if (!props.runtimeWorkspaceId) return translate("config.unavailable");
    if (props.openworkAuditStatus === "loading") return translate("settings.audit_loading");
    if (props.openworkAuditStatus === "error") return translate("settings.audit_error");
    return translate("settings.audit_ready");
  });

  const openworkAuditStatusStyle = createMemo(() => {
    if (!props.runtimeWorkspaceId)
      return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    if (props.openworkAuditStatus === "loading")
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    if (props.openworkAuditStatus === "error")
      return "bg-red-7/10 text-red-11 border-red-7/20";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });

  const isLocalEngineRunning = createMemo(() =>
    Boolean(props.engineInfo?.running),
  );
  const isLocalPreference = createMemo(
    () => props.startupPreference === "local",
  );
  const startupLabel = createMemo(() => {
    if (props.startupPreference === "local") return translate("settings.startup_local");
    if (props.startupPreference === "server") return translate("settings.startup_server");
    return translate("settings.startup_not_set");
  });

  const tabLabel = (tab: SettingsTab) => {
    switch (tab) {
      case "den":
        return translate("settings.tab_cloud");
      case "automations":
        return translate("settings.tab_automations");
      case "skills":
        return translate("settings.tab_skills");
      case "extensions":
        return translate("settings.tab_extensions");
      case "messaging":
        return translate("settings.tab_messaging");
      case "advanced":
        return translate("settings.tab_advanced");
      case "appearance":
        return translate("settings.tab_appearance");
      case "updates":
        return translate("settings.tab_updates");
      case "recovery":
        return translate("settings.tab_recovery");
      case "debug":
        return translate("settings.tab_debug");
      default:
        return translate("settings.tab_general");
    }
  };

  const workspaceTabs = createMemo<SettingsTab[]>(() => [
    "general",
    "automations",
    "skills",
    "extensions",
    "messaging",
    "advanced",
  ]);

  const globalTabs = createMemo<SettingsTab[]>(() => {
    const tabs: SettingsTab[] = ["den", "appearance", "updates", "recovery"];
    if (props.developerMode) tabs.push("debug");
    return tabs;
  });

  const availableTabs = createMemo<SettingsTab[]>(() => {
    return [...workspaceTabs(), ...globalTabs()];
  });

  const activeTab = createMemo<SettingsTab>(() => {
    const tabs = availableTabs();
    return tabs.includes(props.settingsTab) ? props.settingsTab : "general";
  });

  createEffect(() => {
    if (props.settingsTab !== activeTab()) {
      props.setSettingsTab(activeTab());
    }
  });

  const formatActor = (entry: OpenworkAuditEntry) => {
    const actor = entry.actor;
    if (!actor) return translate("settings.actor_unknown");
    if (actor.type === "host") return translate("settings.actor_host");
    if (actor.type === "remote") {
      return actor.clientId ? `${translate("settings.actor_remote")}:${actor.clientId}` : translate("settings.actor_remote");
    }
    return translate("settings.actor_unknown");
  };

  const formatCapability = (cap?: {
    read?: boolean;
    write?: boolean;
    source?: string;
  }) => {
    if (!cap) return translate("config.unavailable");
    const parts = [cap.read ? translate("settings.cap_read") : null, cap.write ? translate("settings.cap_write") : null]
      .filter(Boolean)
      .join(" / ");
    const label = parts || translate("settings.no_access");
    return cap.source ? `${label} · ${cap.source}` : label;
  };

  const engineStdout = () => {
    if (!isTauriRuntime()) return translate("settings.desktop_only_hint");
    return props.engineInfo?.lastStdout?.trim() || translate("settings.no_stdout");
  };

  const engineStderr = () => {
    if (!isTauriRuntime()) return translate("settings.desktop_only_hint");
    return props.engineInfo?.lastStderr?.trim() || translate("settings.no_stderr");
  };

  const openworkStdout = () => {
    if (!props.openworkServerHostInfo) return translate("settings.logs_on_host");
    return (
      props.openworkServerHostInfo.lastStdout?.trim() ||
      translate("settings.no_stdout")
    );
  };

  const openworkStderr = () => {
    if (!props.openworkServerHostInfo) return translate("settings.logs_on_host");
    return (
      props.openworkServerHostInfo.lastStderr?.trim() ||
      translate("settings.no_stderr")
    );
  };

  const opencodeRouterStdout = () => {
    if (!isTauriRuntime()) return translate("settings.desktop_only_hint");
    return (
      props.opencodeRouterInfo?.lastStdout?.trim() || translate("settings.no_stdout")
    );
  };

  const opencodeRouterStderr = () => {
    if (!isTauriRuntime()) return translate("settings.desktop_only_hint");
    return (
      props.opencodeRouterInfo?.lastStderr?.trim() || translate("settings.no_stderr")
    );
  };

  const formatOrchestratorBinary = (binary?: OrchestratorBinaryInfo | null) => {
    if (!binary) return translate("settings.binary_unavailable");
    const version = binary.actualVersion || binary.expectedVersion || "unknown";
    return `${binary.source} · ${version}`;
  };

  const formatOrchestratorBinaryVersion = (
    binary?: OrchestratorBinaryInfo | null,
  ) => {
    if (!binary) return "—";
    return binary.actualVersion || binary.expectedVersion || "—";
  };

  const orchestratorBinaryPath = () =>
    props.orchestratorStatus?.binaries?.opencode?.path ?? "—";
  const orchestratorSidecarSummary = () => {
    const info = props.orchestratorStatus?.sidecar;
    if (!info) return translate("settings.sidecar_config_unavailable");
    const source = info.source ?? "auto";
    const target = info.target ?? "unknown";
    return `${source} · ${target}`;
  };

  const appVersionLabel = () =>
    props.appVersion ? `v${props.appVersion}` : "—";
  const appCommitLabel = () => {
    const sha = buildInfo()?.gitSha?.trim();
    if (!sha) return "—";
    return sha.length > 12 ? sha.slice(0, 12) : sha;
  };
  const opencodeVersionLabel = () => {
    const binary = props.orchestratorStatus?.binaries?.opencode ?? null;
    if (binary) return formatOrchestratorBinary(binary);
    return props.engineDoctorVersion ?? "—";
  };
  const openworkServerVersionLabel = () =>
    props.openworkServerDiagnostics?.version ?? "—";
  const opencodeRouterVersionLabel = () =>
    props.opencodeRouterInfo?.version ?? "—";
  const orchestratorVersionLabel = () =>
    props.orchestratorStatus?.cliVersion ?? "—";

  onMount(() => {
    if (!isTauriRuntime()) return;
    void appBuildInfo()
      .then((info) => setBuildInfo(info))
      .catch(() => setBuildInfo(null));
  });

  const formatUptime = (uptimeMs?: number | null) => {
    if (!uptimeMs) return "—";
    return formatRelativeTime(Date.now() - uptimeMs);
  };

  const [debugReportStatus, setDebugReportStatus] = createSignal<string | null>(
    null,
  );
  const [devLogStatus, setDevLogStatus] = createSignal<string | null>(null);
  const [configActionStatus, setConfigActionStatus] = createSignal<
    string | null
  >(null);
  const [revealConfigBusy, setRevealConfigBusy] = createSignal(false);
  const [resetConfigBusy, setResetConfigBusy] = createSignal(false);
  const [sandboxProbeBusy, setSandboxProbeBusy] = createSignal(false);
  const [sandboxProbeStatus, setSandboxProbeStatus] = createSignal<
    string | null
  >(null);
  const [sandboxProbeResult, setSandboxProbeResult] =
    createSignal<SandboxDebugProbeResult | null>(null);
  const [nukeConfigBusy, setNukeConfigBusy] = createSignal(false);
  const [nukeConfigStatus, setNukeConfigStatus] = createSignal<
    string | null
  >(null);
  const [debugDeepLinkOpen, setDebugDeepLinkOpen] = createSignal(false);
  const [debugDeepLinkInput, setDebugDeepLinkInput] = createSignal("");
  const [debugDeepLinkBusy, setDebugDeepLinkBusy] = createSignal(false);
  const [debugDeepLinkStatus, setDebugDeepLinkStatus] = createSignal<
    string | null
  >(null);
  const opencodeDevModeEnabled = createMemo(() =>
    Boolean(buildInfo()?.openworkDevMode),
  );

  const sandboxCreateSummary = createMemo(() => {
    const raw = (props.sandboxCreateProgress ??
      props.sandboxCreateProgressLast) as
      | {
          runId?: string;
          stage?: string;
          error?: string | null;
          logs?: string[];
          startedAt?: number;
        }
      | null
      | undefined;
    if (!raw || typeof raw !== "object") {
      return {
        runId: null,
        stage: null,
        error: null,
        logs: [] as string[],
        startedAt: null,
      };
    }
    return {
      runId:
        typeof raw.runId === "string" && raw.runId.trim() ? raw.runId : null,
      stage:
        typeof raw.stage === "string" && raw.stage.trim() ? raw.stage : null,
      error:
        typeof raw.error === "string" && raw.error.trim() ? raw.error : null,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
      logs: Array.isArray(raw.logs)
        ? raw.logs
            .filter((line) => typeof line === "string" && line.trim())
            .slice(-400)
        : [],
    };
  });

  const workspaceConfigPath = createMemo(() => {
    const root = props.selectedWorkspaceRoot.trim();
    if (!root) return "";
    const normalized = root.replace(/[\\/]+$/, "");
    const separator = props.isWindows ? "\\" : "/";
    return `${normalized}${separator}.opencode${separator}openwork.json`;
  });

  const runtimeDebugReport = createMemo(() => ({
    developerLogs: {
      retainedEntries: props.developerMode ? readDevLogs(0).length : 0,
      recent: props.developerMode ? readDevLogs(250) : [],
    },
    generatedAt: new Date().toISOString(),
    app: {
      version: appVersionLabel(),
      commit: appCommitLabel(),
      startupPreference: props.startupPreference ?? "unset",
      workspaceRoot: props.selectedWorkspaceRoot.trim() || null,
      workspaceConfigPath: workspaceConfigPath() || null,
    },
    versions: {
      orchestrator: orchestratorVersionLabel(),
      opencode: opencodeVersionLabel(),
      openworkServer: openworkServerVersionLabel(),
      opencodeRouter: opencodeRouterVersionLabel(),
    },
    services: {
      engine: {
        scope: props.startupPreference === "server" ? "local-desktop" : "local-host",
        status: engineStatusLabel(),
        baseUrl: props.engineInfo?.baseUrl ?? null,
        pid: props.engineInfo?.pid ?? null,
        stdout: engineStdout(),
        stderr: engineStderr(),
      },
      orchestrator: {
        scope: props.startupPreference === "server" ? "local-desktop" : "local-host",
        status: orchestratorStatusLabel(),
        dataDir: props.orchestratorStatus?.dataDir ?? null,
        activeWorkspace: props.orchestratorStatus?.activeId ?? null,
        sidecar: orchestratorSidecarSummary(),
      },
      openworkServer: {
        scope: props.startupPreference === "server" ? "connected-worker" : "local-host",
        status: openworkStatusLabel(),
        baseUrl:
          (props.openworkServerHostInfo?.baseUrl ?? props.openworkServerUrl) ||
          null,
        pid: props.openworkServerHostInfo?.pid ?? null,
        stdout: openworkStdout(),
        stderr: openworkStderr(),
      },
      opencodeRouter: {
        scope: props.startupPreference === "server" ? "local-desktop" : "local-host",
        note:
          props.startupPreference === "server"
            ? "Local desktop router state. Remote worker router state is inferred through the connected OpenWork server."
            : null,
        status: opencodeRouterStatusLabel(),
        healthPort: props.opencodeRouterInfo?.healthPort ?? null,
        pid: props.opencodeRouterInfo?.pid ?? null,
        stdout: opencodeRouterStdout(),
        stderr: opencodeRouterStderr(),
      },
    },
    diagnostics: props.openworkServerDiagnostics,
    capabilities: props.openworkServerCapabilities,
    pendingPermissions: props.pendingPermissions,
    recentEvents: props.events,
    workspaceDebugEvents: props.workspaceDebugEvents,
    sandboxCreateProgress: {
      ...sandboxCreateSummary(),
      lastRunAt: sandboxCreateSummary().startedAt
        ? new Date(sandboxCreateSummary().startedAt!).toISOString()
        : null,
    },
    sandboxProbe: sandboxProbeResult(),
  }));

  const runtimeDebugReportJson = createMemo(
    () => `${JSON.stringify(runtimeDebugReport(), null, 2)}\n`,
  );

  const copyRuntimeDebugReport = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setDebugReportStatus(translate("settings.clipboard_unavailable"));
      return;
    }
    try {
      await navigator.clipboard.writeText(runtimeDebugReportJson());
      setDebugReportStatus(translate("settings.copied_debug_report"));
    } catch (error) {
      setDebugReportStatus(
        error instanceof Error
          ? error.message
          : translate("settings.copy_failed"),
      );
    }
  };

  const exportRuntimeDebugReport = () => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      setDebugReportStatus(translate("settings.export_unavailable"));
      return;
    }
    try {
      const stamp = new Date()
        .toISOString()
        .replace(/[:]/g, "-")
        .replace(/\..+$/, "");
      const blob = new Blob([runtimeDebugReportJson()], {
        type: "application/json",
      });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `openwork-debug-report-${stamp}.json`;
      anchor.click();
      window.URL.revokeObjectURL(url);
      setDebugReportStatus(translate("settings.exported_debug_report"));
    } catch (error) {
      setDebugReportStatus(
        error instanceof Error
          ? error.message
          : translate("settings.export_failed"),
      );
    }
  };

  const developerLogText = createMemo(() =>
    props.developerMode ? formatDevLogText(250) : "",
  );

  const copyDeveloperLog = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setDevLogStatus("Clipboard is unavailable in this environment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(developerLogText());
      setDevLogStatus("Copied developer log output.");
    } catch (error) {
      setDevLogStatus(
        error instanceof Error
          ? error.message
          : "Failed to copy developer log output.",
      );
    }
  };

  const exportDeveloperLog = () => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      setDevLogStatus("Export is unavailable in this environment.");
      return;
    }
    try {
      const stamp = new Date()
        .toISOString()
        .replace(/[:]/g, "-")
        .replace(/\..+$/, "");
      const blob = new Blob([developerLogText()], {
        type: "text/plain",
      });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `openwork-dev-log-${stamp}.log`;
      anchor.click();
      window.URL.revokeObjectURL(url);
      setDevLogStatus("Exported developer log output.");
    } catch (error) {
      setDevLogStatus(
        error instanceof Error
          ? error.message
          : "Failed to export developer log output.",
      );
    }
  };

  const clearDeveloperLog = () => {
    clearDevLogs();
    setDevLogStatus("Cleared developer log output.");
  };

  const revealWorkspaceConfig = async () => {
    if (!isTauriRuntime() || revealConfigBusy()) return;
    const path = workspaceConfigPath();
    if (!path) {
      setConfigActionStatus(translate("settings.select_workspace_first"));
      return;
    }
    setRevealConfigBusy(true);
    setConfigActionStatus(null);
    try {
      const { openPath, revealItemInDir } =
        await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(path);
      } else {
        await revealItemInDir(path);
      }
      setConfigActionStatus(translate("settings.revealed_workspace_config"));
    } catch (error) {
      setConfigActionStatus(
        error instanceof Error
          ? error.message
          : translate("settings.reveal_config_failed"),
      );
    } finally {
      setRevealConfigBusy(false);
    }
  };

  const resetAppConfigDefaults = async () => {
    if (resetConfigBusy()) return;
    setResetConfigBusy(true);
    setConfigActionStatus(null);
    try {
      const result = await props.resetAppConfigDefaults();
      setConfigActionStatus(result.message);
    } catch (error) {
      setConfigActionStatus(
        error instanceof Error ? error.message : translate("settings.reset_config_failed"),
      );
    } finally {
      setResetConfigBusy(false);
    }
  };

  const handleNukeOpenworkAndOpencodeConfig = async () => {
    if (!isTauriRuntime() || nukeConfigBusy()) return;
    const devMode = opencodeDevModeEnabled();
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            devMode
              ? translate("settings.nuke_confirm_dev")
              : translate("settings.nuke_confirm_prod"),
          );
    if (!confirmed) return;
    setNukeConfigBusy(true);
    setNukeConfigStatus(null);
    try {
      if (typeof window !== "undefined") {
        try {
          window.localStorage.clear();
        } catch {
          // ignore
        }
      }

      await new Promise<void>((resolve) => {
        if (typeof window === "undefined") {
          resolve();
          return;
        }
        window.requestAnimationFrame(() => resolve());
      });

      await nukeOpenworkAndOpencodeConfigAndExit();
      setNukeConfigStatus(translate("settings.nuke_success"));
    } catch (error) {
      setNukeConfigStatus(
        error instanceof Error
          ? error.message
          : translate("settings.nuke_failed"),
      );
      setNukeConfigBusy(false);
    }
  };

  const runSandboxDebugProbe = async () => {
    if (!isTauriRuntime() || sandboxProbeBusy()) return;
    setSandboxProbeBusy(true);
    setSandboxProbeStatus(null);
    try {
      const report = await sandboxDebugProbe();
      setSandboxProbeResult(report);
      if (report.ready) {
        setSandboxProbeStatus(translate("settings.sandbox_probe_success"));
      } else {
        setSandboxProbeStatus(
          report.error?.trim() || translate("settings.sandbox_probe_errors"),
        );
      }
    } catch (error) {
      setSandboxProbeStatus(
        error instanceof Error ? error.message : translate("settings.sandbox_probe_failed"),
      );
    } finally {
      setSandboxProbeBusy(false);
    }
  };

  const submitDebugDeepLink = async () => {
    if (debugDeepLinkBusy()) return;
    setDebugDeepLinkBusy(true);
    setDebugDeepLinkStatus(null);
    try {
      const result = await props.openDebugDeepLink(debugDeepLinkInput());
      setDebugDeepLinkStatus(result.message);
    } catch (error) {
      setDebugDeepLinkStatus(
        error instanceof Error ? error.message : translate("settings.deeplink_failed"),
      );
    } finally {
      setDebugDeepLinkBusy(false);
    }
  };

  const compactOutlineActionClass =
    "inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60";
  const compactDangerActionClass =
    "inline-flex items-center gap-1.5 rounded-md border border-red-7/35 bg-red-3/25 px-3 py-1.5 text-xs font-medium text-red-11 transition-colors duration-150 hover:border-red-7/50 hover:bg-red-3/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-7/35 disabled:cursor-not-allowed disabled:opacity-60";
  const settingsRailClass =
    "rounded-[24px] border border-dls-border bg-dls-sidebar p-3";
  const settingsPanelClass =
    "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
  const settingsPanelSoftClass =
    "rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4";

  const tabDescription = (tab: SettingsTab) => {
    switch (tab) {
      case "den":
        return translate("settings.tab_description_den");
      case "automations":
        return translate("settings.tab_description_automations");
      case "skills":
        return translate("settings.tab_description_skills");
      case "extensions":
        return translate("settings.tab_description_extensions");
      case "messaging":
        return translate("settings.tab_description_messaging");
      case "advanced":
        return translate("settings.tab_description_advanced");
      case "appearance":
        return translate("settings.tab_description_appearance");
      case "updates":
        return translate("settings.tab_description_updates");
      case "recovery":
        return translate("settings.tab_description_recovery");
      case "debug":
        return translate("settings.tab_description_debug");
      default:
        return translate("settings.tab_description_general");
    }
  };

  const activeTabGroup = createMemo(() =>
    workspaceTabs().includes(activeTab()) ? translate("settings.group_workspace") : translate("settings.group_global"),
  );

  return (
    <section class="space-y-6 md:grid md:grid-cols-[220px_minmax(0,1fr)] md:gap-8 md:space-y-0">
      <aside class="space-y-6 md:sticky md:top-4 md:self-start">
        <div class={settingsRailClass}>
          <div class="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-8">
            {translate("settings.group_workspace")}
          </div>
          <div class="space-y-1">
            <For each={workspaceTabs()}>
              {(tab) => (
                <button
                  type="button"
                  class={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors ${
                    activeTab() === tab
                      ? "bg-dls-surface text-dls-text shadow-sm"
                      : "text-gray-10 hover:bg-dls-surface/50 hover:text-dls-text"
                  }`}
                  onClick={() => props.setSettingsTab(tab)}
                >
                  <span>{tabLabel(tab)}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        <div class={settingsRailClass}>
          <div class="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-8">
            {translate("settings.group_global")}
          </div>
          <div class="space-y-1">
            <For each={globalTabs()}>
              {(tab) => (
                <button
                  type="button"
                  class={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors ${
                    activeTab() === tab
                      ? "bg-dls-surface text-dls-text shadow-sm"
                      : "text-gray-10 hover:bg-dls-surface/50 hover:text-dls-text"
                  }`}
                  onClick={() => props.setSettingsTab(tab)}
                >
                  <span>{tabLabel(tab)}</span>
                </button>
              )}
            </For>
          </div>
        </div>
      </aside>

      <div class="min-w-0 space-y-6">
        <div class={`${settingsPanelClass} flex flex-col gap-3 md:flex-row md:items-center md:justify-between`}>
          <div class="space-y-1">
            <h2 class="text-lg font-semibold tracking-tight text-gray-12">
              {tabLabel(activeTab())}
            </h2>
            <p class="text-sm text-gray-9">
              {tabDescription(activeTab())}
            </p>
          </div>
          <Show when={showUpdateToolbar() && activeTab() === "general"}>
            <div class="mt-4 space-y-2 md:mt-0 md:max-w-sm md:text-right">
              <div class="flex flex-wrap items-center gap-2 md:justify-end">
                <div
                  class={`rounded-full border px-3 py-1.5 text-xs shadow-sm flex items-center gap-2 ${updateToolbarTone()}`}
                  title={updateToolbarTitle()}
                >
                  <Show when={updateToolbarSpinning()}>
                    <RefreshCcw size={12} class="animate-spin" />
                  </Show>
                  <span class="tabular-nums whitespace-nowrap">
                    {updateToolbarLabel()}
                  </span>
                </div>
                <Show when={updateToolbarActionLabel()}>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3 rounded-full border-gray-6/60 bg-gray-1/70 hover:bg-gray-2/70"
                    onClick={handleUpdateToolbarAction}
                    disabled={updateToolbarDisabled()}
                    title={updateRestartBlockedMessage() ?? ""}
                  >
                    {updateToolbarActionLabel()}
                  </Button>
                </Show>
              </div>
              <Show when={updateRestartBlockedMessage()}>
                <div class="text-xs leading-relaxed text-amber-11/90 md:max-w-sm">
                  {updateRestartBlockedMessage()}
                </div>
              </Show>
            </div>
          </Show>
        </div>

        <Switch>
        <Match when={activeTab() === "general"}>
          <div class="space-y-6">
            <AuthorizedFoldersPanel
              openworkServerClient={props.openworkServerClient}
              openworkServerStatus={props.openworkServerStatus}
              openworkServerCapabilities={props.openworkServerCapabilities}
              runtimeWorkspaceId={props.runtimeWorkspaceId}
              selectedWorkspaceRoot={props.selectedWorkspaceRoot}
              activeWorkspaceType={props.activeWorkspaceType}
              onConfigUpdated={props.markOpencodeConfigReloadRequired}
            />

            <div class={`${settingsPanelClass} space-y-4`}>
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="flex items-center gap-2">
                    <PlugZap size={16} class="text-gray-11" />
                    <div class="text-sm font-medium text-gray-12">
                      {translate("settings.providers_title")}
                    </div>
                  </div>
                  <div class="text-xs text-gray-9 mt-1">
                    {translate("settings.providers_desc")}
                  </div>
                </div>
                <div
                  class={`text-xs px-2 py-1 rounded-full border ${providerStatusStyle()}`}
                >
                  {providerStatusLabel()}
                </div>
              </div>

              <div class="flex flex-wrap items-center gap-3">
                <Button
                  variant="secondary"
                  onClick={handleOpenProviderAuth}
                  disabled={props.busy || props.providerAuthBusy}
                >
                  {props.providerAuthBusy
                    ? translate("settings.loading_providers")
                    : translate("settings.connect_provider")}
                </Button>
                <div class="text-xs text-gray-10">{providerSummary()}</div>
              </div>

              <Show when={connectedProviders().length > 0}>
                <div class="space-y-2">
                  <For each={connectedProviders()}>
                    {(provider) => (
                      <div class={`${settingsPanelSoftClass} flex flex-wrap items-center justify-between gap-3 px-3 py-2`}>
                        <div class="min-w-0 flex items-center gap-3">
                          <ProviderIcon providerId={provider.id} size={18} class="text-gray-12" />
                          <div class="min-w-0">
                            <div class="text-sm font-medium text-gray-12 truncate">
                              {provider.name}
                            </div>
                            <div class="text-[11px] text-gray-8 font-mono truncate">
                              {provider.id}
                            </div>
                            <Show when={providerSourceLabel(provider.source)}>
                              {(label) => (
                                <div class="mt-1 text-[11px] text-gray-9 truncate">{label()}</div>
                              )}
                            </Show>
                          </div>
                        </div>
                        <Button
                          variant="outline"
                          class="text-xs h-8 py-0 px-3"
                          onClick={() =>
                            void handleDisconnectProvider(provider.id)
                          }
                          disabled={
                            props.busy ||
                            props.providerAuthBusy ||
                            providerDisconnectingId() !== null ||
                            !canDisconnectProvider(provider.source)
                          }
                        >
                          {providerDisconnectingId() === provider.id
                            ? translate("settings.disconnecting")
                            : canDisconnectProvider(provider.source)
                              ? translate("settings.disconnect")
                              : translate("settings.managed_by_env")}
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <Show when={providerConnectError()}>
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {providerConnectError()}
                </div>
              </Show>
              <Show when={providerDisconnectStatus()}>
                <div class={`${settingsPanelSoftClass} px-3 py-2 text-xs text-gray-10`}>
                  {providerDisconnectStatus()}
                </div>
              </Show>
              <Show when={providerDisconnectError()}>
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {providerDisconnectError()}
                </div>
              </Show>

              <div class="text-[11px] text-gray-9">
                {translate("settings.api_keys_info")}
              </div>
            </div>

            <div class={`${settingsPanelClass} space-y-4`}>
              <div>
                <div class="text-sm font-medium text-gray-12">{translate("settings.model_title")}</div>
                <div class="text-xs text-gray-10">
                  {translate("settings.model_section_desc")}
                </div>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12 truncate">
                    {modelControls.defaultModelLabel()}
                  </div>
                  <div class="text-xs text-gray-7 font-mono truncate">
                    {modelControls.defaultModelRef()}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={modelControls.openDefaultModelPicker}
                  disabled={props.busy}
                >
                  {translate("settings.change")}
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">{translate("settings.show_model_reasoning")}</div>
                  <div class="text-xs text-gray-7">
                    {translate("settings.show_model_reasoning_desc")}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={toggleShowThinking}
                  disabled={props.busy}
                >
                  {showThinking() ? translate("settings.on") : translate("settings.off")}
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">{translate("settings.model_behavior")}</div>
                  <div class="text-xs text-gray-7 truncate">
                    {translate("settings.model_behavior_desc")}
                  </div>
                  <div class="mt-1 text-xs text-gray-8 font-medium truncate">
                    {modelControls.defaultModelVariantLabel()}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={modelControls.editDefaultModelVariant}
                  disabled={props.busy}
                >
                  {translate("settings.configure")}
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">{translate("settings.auto_compact")}</div>
                  <div class="text-xs text-gray-7">
                    {translate("settings.auto_compact_desc")}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={modelControls.toggleAutoCompactContext}
                  disabled={props.busy || modelControls.autoCompactContextBusy()}
                >
                  {modelControls.autoCompactContext() ? translate("settings.on") : translate("settings.off")}
                </Button>
              </div>
            </div>

              <div class="relative overflow-hidden rounded-2xl border border-blue-7/30 bg-gradient-to-br from-blue-3/35 via-gray-1/75 to-cyan-3/30 p-5">
              <div class="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-blue-6/20 blur-2xl" />
              <div class="pointer-events-none absolute -bottom-12 left-6 h-24 w-24 rounded-full bg-cyan-6/20 blur-2xl" />

              <div class="relative space-y-4">
                <div class="space-y-2">
                  <div class="inline-flex items-center gap-1.5 rounded-full border border-blue-7/35 bg-blue-4/25 px-2.5 py-1 text-[11px] font-medium text-blue-11">
                    <LifeBuoy size={12} />
                    {translate("settings.feedback_badge")}
                  </div>
                  <div class="text-sm font-semibold text-gray-12">
                    {translate("settings.feedback_title")}
                  </div>
                  <div class="max-w-[58ch] text-xs text-gray-10">
                    {translate("settings.feedback_desc")}
                  </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    class="inline-flex h-9 items-center justify-center gap-2 rounded-xl border border-transparent bg-blue-9 px-4 text-xs font-semibold text-blue-1 transition-colors duration-150 active:scale-[0.98] hover:bg-blue-10 focus:outline-none focus:ring-2 focus:ring-blue-7/30"
                    onClick={() =>
                      openExternalLink(
                        buildFeedbackUrl({
                          entrypoint: "settings-feedback-card",
                          deployment: getOpenWorkDeployment(),
                          appVersion: props.appVersion,
                          openworkServerVersion:
                            props.openworkServerDiagnostics?.version ?? null,
                          opencodeVersion:
                            props.orchestratorStatus?.binaries?.opencode
                              ?.actualVersion ?? null,
                          orchestratorVersion:
                            props.orchestratorStatus?.cliVersion ?? null,
                          opencodeRouterVersion:
                            props.opencodeRouterInfo?.version ?? null,
                        }),
                      )
                    }
                  >
                    <MessageCircle size={14} />
                    {translate("settings.send_feedback")}
                    <ArrowUpRight size={13} />
                  </button>

                  <button
                    type="button"
                    class="inline-flex h-9 items-center gap-1.5 rounded-xl border border-blue-7/35 bg-gray-1/70 px-3 text-xs font-medium text-gray-11 transition-colors hover:border-blue-7/50 hover:text-gray-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-7/30"
                    onClick={() => openExternalLink(DISCORD_INVITE_URL)}
                  >
                    {translate("settings.join_discord")}
                    <ArrowUpRight size={13} />
                  </button>

                  <button
                    type="button"
                    class="inline-flex h-9 items-center gap-1.5 rounded-xl border border-gray-7/60 bg-gray-1/70 px-3 text-xs font-medium text-gray-10 transition-colors hover:border-gray-7/80 hover:text-gray-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-7/40"
                    onClick={() => openExternalLink(BUG_REPORT_URL)}
                  >
                    {translate("settings.report_issue")}
                    <ArrowUpRight size={13} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Match>

        <Match when={activeTab() === "automations"}>
          <WebUnavailableSurface unavailable={webDeployment()}>
            <AutomationsView
              busy={props.busy}
              selectedWorkspaceRoot={props.selectedWorkspaceRoot}
              createSessionAndOpen={props.createSessionAndOpen}
              newTaskDisabled={props.newTaskDisabled}
              schedulerInstalled={props.schedulerPluginInstalled}
              canEditPlugins={props.canEditPlugins}
              addPlugin={props.addPlugin}
              reloadWorkspaceEngine={props.reloadWorkspaceEngine}
              reloadBusy={props.reloadBusy}
              canReloadWorkspace={props.canReloadWorkspace}
              showHeader={false}
            />
          </WebUnavailableSurface>
        </Match>

        <Match when={activeTab() === "skills"}>
          <WebUnavailableSurface unavailable={webDeployment()}>
            <SkillsView
              workspaceName={props.selectedWorkspaceRoot.trim() || translate("settings.workspace_fallback_name")}
              busy={props.busy}
              canInstallSkillCreator={props.canInstallSkillCreator}
              canUseDesktopTools={props.canUseDesktopTools}
              accessHint={props.skillsAccessHint}
              createSessionAndOpen={props.createSessionAndOpen}
              showHeader={false}
            />
          </WebUnavailableSurface>
        </Match>

        <Match when={activeTab() === "extensions"}>
          <WebUnavailableSurface unavailable={webDeployment()}>
            <ExtensionsView
              busy={props.busy}
              selectedWorkspaceRoot={props.selectedWorkspaceRoot}
              isRemoteWorkspace={props.activeWorkspaceType === "remote"}
              canEditPlugins={props.canEditPlugins}
              canUseGlobalScope={props.canUseGlobalPluginScope}
              accessHint={props.pluginsAccessHint}
              suggestedPlugins={props.suggestedPlugins}
              showHeader={false}
            />
          </WebUnavailableSurface>
        </Match>

        <Match when={activeTab() === "messaging"}>
          <WebUnavailableSurface unavailable={webDeployment()}>
            <IdentitiesView
              busy={props.busy}
              openworkServerStatus={props.openworkServerStatus}
              openworkServerUrl={props.openworkServerUrl}
              openworkServerClient={props.openworkServerClient}
              openworkReconnectBusy={props.openworkReconnectBusy}
              reconnectOpenworkServer={props.reconnectOpenworkServer}
              restartLocalServer={props.restartLocalServer}
              runtimeWorkspaceId={props.runtimeWorkspaceId}
              selectedWorkspaceRoot={props.selectedWorkspaceRoot}
              developerMode={props.developerMode}
              showHeader={false}
            />
          </WebUnavailableSurface>
        </Match>

        <Match when={activeTab() === "appearance"}>
          <div class="space-y-6">
              <div class={`${settingsPanelClass} space-y-4`}>
                <div>
                  <div class="text-sm font-medium text-gray-12">{translate("settings.appearance_title")}</div>
                <div class="text-xs text-gray-9">
                  {translate("settings.appearance_hint")}
                </div>
              </div>

              <div class="flex flex-wrap gap-2">
                <Button
                  variant={
                    props.themeMode === "system" ? "secondary" : "outline"
                  }
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("system")}
                  disabled={props.busy}
                >
                  {translate("settings.theme_system")}
                </Button>
                <Button
                  variant={
                    props.themeMode === "light" ? "secondary" : "outline"
                  }
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("light")}
                  disabled={props.busy}
                >
                  {translate("settings.theme_light")}
                </Button>
                <Button
                  variant={props.themeMode === "dark" ? "secondary" : "outline"}
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("dark")}
                  disabled={props.busy}
                >
                  {translate("settings.theme_dark")}
                </Button>
              </div>

              <div class="space-y-2">
                <div class="text-xs font-medium text-gray-11">
                  {translate("settings.language")}
                </div>
                <div class="text-xs text-gray-9">
                  {translate("settings.language.description")}
                </div>
                <div class="flex flex-wrap gap-2">
                  <For each={LANGUAGE_OPTIONS}>
                    {(option) => (
                      <Button
                        variant={
                          props.language === option.value
                            ? "secondary"
                            : "outline"
                        }
                        class="text-xs h-8 py-0 px-3"
                        onClick={() => props.setLanguage(option.value)}
                        disabled={props.busy}
                      >
                        {option.nativeName}
                      </Button>
                    )}
                  </For>
                </div>
              </div>

                <div class="text-xs text-gray-8">
                  {translate("settings.theme_system_hint")}
                </div>
              </div>
            <Show when={isTauriRuntime()}>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                <div>
                  <div class="text-sm font-medium text-gray-12">{translate("settings.appearance_title")}</div>
                  <div class="text-xs text-gray-10">
                    {translate("settings.window_appearance_desc")}
                  </div>
                </div>

                <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">{translate("settings.hide_titlebar")}</div>
                    <div class="text-xs text-gray-7">
                      {translate("settings.hide_titlebar_desc")}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.toggleHideTitlebar}
                    disabled={props.busy}
                  >
                    {props.hideTitlebar ? translate("settings.on") : translate("settings.off")}
                  </Button>
                </div>
              </div>
            </Show>
          </div>
        </Match>

        <Match when={activeTab() === "den"}>
            <DenSettingsPanel
              developerMode={props.developerMode}
              connectRemoteWorkspace={props.connectRemoteWorkspace}
              openTeamBundle={props.openTeamBundle}
              cloudOrgProviders={props.cloudOrgProviders}
              importedCloudProviders={props.importedCloudProviders}
              refreshCloudOrgProviders={props.refreshCloudOrgProviders}
              connectCloudProvider={props.connectCloudProvider}
              removeCloudProvider={props.removeCloudProvider}
            />
        </Match>

        <Match when={activeTab() === "advanced"}>
          <div class="space-y-6">
            <div class={`${settingsPanelClass} space-y-4`}>
              <div>
                <div class="text-sm font-medium text-gray-12">{translate("settings.runtime_title")}</div>
                <div class="text-xs text-gray-9">
                  {translate("settings.runtime_desc")}
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class={`${settingsPanelSoftClass} p-4 space-y-3`}>
                  <div class="flex items-start gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
                      <Cpu size={18} />
                    </div>
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.opencode_engine_label")}
                      </div>
                      <div class="text-xs text-gray-9">
                        {translate("settings.opencode_engine_desc")}
                      </div>
                    </div>
                  </div>
                  <div
                    class={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${clientStatusStyle()}`}
                  >
                    <span class={`h-2 w-2 rounded-full ${clientStatusDot()}`} />
                    {clientStatusLabel()}
                  </div>
                </div>

                <div class={`${settingsPanelSoftClass} p-4 space-y-3`}>
                  <div class="flex items-start gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
                      <Server size={18} />
                    </div>
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.openwork_server_label")}
                      </div>
                      <div class="text-xs text-gray-9">
                        {translate("settings.openwork_server_desc")}
                      </div>
                    </div>
                  </div>
                  <div
                    class={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${openworkStatusStyle()}`}
                  >
                    <span
                      class={`h-2 w-2 rounded-full ${openworkStatusDot()}`}
                    />
                    {openworkStatusLabel()}
                  </div>
                </div>
              </div>
            </div>

            <div class={`${settingsPanelClass} space-y-3`}>
              <div>
                <div class="text-sm font-medium text-gray-12">{translate("settings.opencode_section_label")}</div>
                <div class="text-xs text-gray-9">
                  {translate("settings.opencode_runtime_desc")}
                </div>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">{translate("settings.enable_exa")}</div>
                  <div class="text-xs text-gray-7">
                    {translate("settings.enable_exa_desc")}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.toggleOpencodeEnableExa}
                  disabled={props.busy}
                >
                  {props.opencodeEnableExa ? translate("settings.on") : translate("settings.off")}
                </Button>
              </div>

              <div class="text-[11px] text-gray-7">
                {translate("settings.exa_restart_hint")}
              </div>
            </div>

            <div class={`${settingsPanelClass} space-y-3`}>
              <div class="text-sm font-medium text-gray-12">{translate("settings.developer_mode_title")}</div>
              <div class="text-xs text-gray-9">
                {translate("settings.developer_mode_desc")}
              </div>
              <div class="pt-1 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  class={`${compactOutlineActionClass} ${
                    props.developerMode
                      ? "border-blue-7/35 bg-blue-3/20 text-blue-11 hover:bg-blue-3/35 hover:text-blue-11"
                      : ""
                  }`}
                  onClick={props.toggleDeveloperMode}
                >
                  <Zap
                    size={14}
                    class={
                      props.developerMode
                        ? "text-blue-10"
                        : "text-dls-secondary"
                    }
                  />
                  {props.developerMode
                    ? translate("settings.disable_developer_mode")
                    : translate("settings.enable_developer_mode")}
                </button>
                <div class="text-xs text-gray-10">
                  {props.developerMode
                    ? translate("settings.developer_panel_enabled")
                    : translate("settings.developer_panel_disabled")}
                </div>
              </div>
              <Show when={isTauriRuntime() && opencodeDevModeEnabled() && props.developerMode}>
                <div class={`${settingsPanelSoftClass} p-4 space-y-3`}>
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.open_deeplink_title")}
                      </div>
                      <div class="text-xs text-gray-9">
                        {translate("settings.open_deeplink_desc")}
                      </div>
                    </div>
                    <button
                      type="button"
                      class={compactOutlineActionClass}
                      onClick={() => {
                        setDebugDeepLinkOpen((value) => !value);
                        setDebugDeepLinkStatus(null);
                      }}
                      disabled={props.busy || debugDeepLinkBusy()}
                    >
                      {debugDeepLinkOpen() ? translate("common.hide") : translate("settings.open_deeplink_button")}
                    </button>
                  </div>

                  <Show when={debugDeepLinkOpen()}>
                    <div class="space-y-3">
                      <textarea
                        value={debugDeepLinkInput()}
                        onInput={(event) =>
                          setDebugDeepLinkInput(event.currentTarget.value)
                        }
                        rows={3}
                        placeholder="openwork://..."
                        class="w-full rounded-xl border border-gray-6 bg-gray-1 px-3 py-2 text-xs font-mono text-gray-12 outline-none transition focus:border-blue-8"
                      />
                      <div class="flex flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          class="text-xs h-8 py-0 px-3"
                          onClick={() => void submitDebugDeepLink()}
                          disabled={
                            props.busy ||
                            debugDeepLinkBusy() ||
                            !debugDeepLinkInput().trim()
                          }
                        >
                          {debugDeepLinkBusy() ? translate("settings.opening") : translate("settings.open_deeplink_action")}
                        </Button>
                        <div class="text-[11px] text-gray-8">
                          {translate("settings.deeplink_hint")}
                        </div>
                      </div>
                    </div>
                  </Show>

                  <Show when={debugDeepLinkStatus()}>
                    {(value) => (
                      <div class="text-xs text-gray-10">{value()}</div>
                    )}
                  </Show>
                </div>
              </Show>
            </div>

            <div class={`${settingsPanelClass} space-y-3`}>
              <div class="text-sm font-medium text-gray-12">{translate("settings.connection_title")}</div>
              <div class="text-xs text-gray-9">{props.headerStatus}</div>
              <div class="text-xs text-gray-8 font-mono break-all">
                {props.baseUrl}
              </div>
              <div class="pt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  class={compactOutlineActionClass}
                  onClick={handleReconnectOpenworkServer}
                  disabled={
                    props.busy ||
                    props.openworkReconnectBusy ||
                    !props.openworkServerUrl.trim()
                  }
                >
                  <RefreshCcw
                    size={14}
                    class={`text-dls-secondary ${props.openworkReconnectBusy ? "animate-spin" : ""}`}
                  />
                  {props.openworkReconnectBusy
                    ? translate("settings.reconnecting")
                    : translate("settings.reconnect_server")}
                </button>
                <Show when={isLocalEngineRunning()}>
                  <button
                    type="button"
                    class={compactOutlineActionClass}
                    onClick={handleRestartLocalServer}
                    disabled={props.busy || openworkRestartBusy()}
                  >
                    <RefreshCcw
                      size={14}
                      class={`text-dls-secondary ${openworkRestartBusy() ? "animate-spin" : ""}`}
                    />
                    {openworkRestartBusy()
                      ? translate("settings.restarting")
                      : translate("settings.restart_local_server")}
                  </button>
                </Show>
                <Show when={isLocalEngineRunning()}>
                  <button
                    type="button"
                    class={compactDangerActionClass}
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    <CircleAlert size={14} />
                    {translate("settings.stop_local_server")}
                  </button>
                </Show>
                <Show
                  when={
                    !isLocalEngineRunning() &&
                    props.openworkServerStatus === "connected"
                  }
                >
                  <button
                    type="button"
                    class={compactOutlineActionClass}
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    {translate("settings.disconnect_server")}
                  </button>
                </Show>
              </div>
              <Show when={openworkReconnectStatus()}>
                {(value) => <div class="text-xs text-gray-10">{value()}</div>}
              </Show>
              <Show when={openworkReconnectError()}>
                {(value) => <div class="text-xs text-red-11">{value()}</div>}
              </Show>
              <Show when={openworkRestartStatus()}>
                {(value) => <div class="text-xs text-gray-10">{value()}</div>}
              </Show>
              <Show when={openworkRestartError()}>
                {(value) => <div class="text-xs text-red-11">{value()}</div>}
              </Show>
            </div>

            <Show when={props.developerMode}>
              <ConfigView
                busy={props.busy}
                clientConnected={props.clientConnected}
                anyActiveRuns={props.anyActiveRuns}
                openworkServerStatus={props.openworkServerStatus}
                openworkServerUrl={props.openworkServerUrl}
                openworkServerSettings={props.openworkServerSettings}
                openworkServerHostInfo={props.openworkServerHostInfo}
                runtimeWorkspaceId={props.runtimeWorkspaceId}
                updateOpenworkServerSettings={props.updateOpenworkServerSettings}
                resetOpenworkServerSettings={props.resetOpenworkServerSettings}
                testOpenworkServerConnection={props.testOpenworkServerConnection}
                canReloadWorkspace={props.canReloadWorkspace}
                reloadWorkspaceEngine={props.reloadWorkspaceEngine}
                reloadBusy={props.reloadBusy}
                reloadError={props.reloadError}
                developerMode={props.developerMode}
              />
            </Show>



          </div>
        </Match>

        <Match when={activeTab() === "updates"}>
          <div class="space-y-6">
            <div class={`${settingsPanelClass} space-y-3`}>
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-medium text-gray-12">{translate("settings.updates_title")}</div>
                  <div class="text-xs text-gray-10">
                    {translate("settings.updates_desc")}
                  </div>
                </div>
                <div class="text-xs text-gray-7 font-mono">
                  {props.appVersion ? `v${props.appVersion}` : ""}
                </div>
              </div>

              <Show
                when={webDeployment()}
                fallback={
                  <Show
                    when={
                      props.updateEnv && props.updateEnv.supported === false
                    }
                    fallback={
                      <>
                        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="space-y-0.5">
                            <div class="text-sm text-gray-12">
                              {translate("settings.background_checks_title")}
                            </div>
                            <div class="text-xs text-gray-7">
                              {translate("settings.background_checks_desc")}
                            </div>
                          </div>
                          <button
                            class={`min-w-[70px] px-4 py-1.5 rounded-full text-xs font-medium border shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-colors ${
                              props.updateAutoCheck
                                ? "bg-gray-12/12 text-gray-12 border-gray-6/30"
                                : "bg-gray-1/70 text-gray-10 border-gray-6/60 hover:text-gray-12 hover:bg-gray-2/70"
                            }`}
                            onClick={props.toggleUpdateAutoCheck}
                          >
                            {props.updateAutoCheck ? translate("settings.on") : translate("settings.off")}
                          </button>
                        </div>

                        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="space-y-0.5">
                            <div class="text-sm text-gray-12">{translate("settings.auto_update_title")}</div>
                            <div class="text-xs text-gray-7">
                              {translate("settings.auto_update_desc")}
                            </div>
                          </div>
                          <button
                            class={`min-w-[70px] px-4 py-1.5 rounded-full text-xs font-medium border shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] transition-colors ${
                              props.updateAutoDownload
                                ? "bg-gray-12/12 text-gray-12 border-gray-6/30"
                                : "bg-gray-1/70 text-gray-10 border-gray-6/60 hover:text-gray-12 hover:bg-gray-2/70"
                            }`}
                            onClick={props.toggleUpdateAutoDownload}
                          >
                            {props.updateAutoDownload ? translate("settings.on") : translate("settings.off")}
                          </button>
                        </div>

                        <div class="bg-gray-1 p-3 rounded-xl border border-gray-6 space-y-3">
                          <div class="flex items-center justify-between gap-3">
                            <div class="space-y-0.5">
                              <div class="text-sm text-gray-12">
                                <Switch>
                                  <Match when={updateState() === "checking"}>
                                    {translate("settings.update_checking")}
                                  </Match>
                                  <Match when={updateState() === "available"}>
                                    {t("settings.update_available_version", undefined, { version: updateVersion() ?? "" })}
                                  </Match>
                                  <Match when={updateState() === "downloading"}>
                                    {translate("settings.update_downloading")}
                                  </Match>
                                  <Match when={updateState() === "ready"}>
                                    {t("settings.update_ready_version", undefined, { version: updateVersion() ?? "" })}
                                  </Match>
                                  <Match when={updateState() === "error"}>
                                    {translate("settings.update_check_failed")}
                                  </Match>
                                  <Match when={true}>{translate("settings.update_uptodate")}</Match>
                                </Switch>
                              </div>
                              <Show
                                when={
                                  updateState() === "idle" &&
                                  updateLastCheckedAt()
                                }
                              >
                                <div class="text-xs text-gray-7">
                                  {t("settings.update_last_checked", undefined, { time: formatRelativeTime(updateLastCheckedAt() as number) })}
                                </div>
                              </Show>
                              <Show
                                when={
                                  updateState() === "available" && updateDate()
                                }
                              >
                                <div class="text-xs text-gray-7">
                                  {t("settings.update_published", undefined, { date: updateDate() ?? "" })}
                                </div>
                              </Show>
                              <Show when={updateState() === "downloading"}>
                                <div class="text-xs text-gray-7">
                                  {formatBytes(
                                    (updateDownloadedBytes() as number) ?? 0,
                                  )}
                                  <Show when={updateTotalBytes() != null}>
                                    {` / ${formatBytes(updateTotalBytes() as number)}`}
                                  </Show>
                                </div>
                              </Show>
                              <Show when={updateState() === "error"}>
                                <div class="text-xs text-red-11">
                                  {updateErrorMessage()}
                                </div>
                              </Show>
                            </div>

                            <div class="flex items-center gap-2">
                              <Button
                                variant="outline"
                                class="text-xs h-9 py-0 px-4 rounded-full border-gray-6/60 bg-gray-1/70 hover:bg-gray-2/70"
                                onClick={props.checkForUpdates}
                                disabled={
                                  props.busy ||
                                  updateState() === "checking" ||
                                  updateState() === "downloading"
                                }
                              >
                                {translate("settings.update_check_button")}
                              </Button>

                              <Show when={updateState() === "available"}>
                                <Button
                                  variant="secondary"
                                  class="text-xs h-9 py-0 px-4 rounded-full"
                                  onClick={props.downloadUpdate}
                                  disabled={
                                    props.busy || updateState() === "downloading"
                                  }
                                >
                                  {translate("settings.update_download_button")}
                                </Button>
                              </Show>

                              <Show when={updateState() === "ready"}>
                                <Button
                                  variant="secondary"
                                  class="text-xs h-9 py-0 px-4 rounded-full"
                                  onClick={props.installUpdateAndRestart}
                                  disabled={props.busy || props.anyActiveRuns}
                                  title={updateRestartBlockedMessage() ?? ""}
                                >
                                  {translate("settings.update_install_button")}
                                </Button>
                              </Show>
                            </div>
                          </div>

                          <Show when={updateRestartBlockedMessage()}>
                            <div class="rounded-xl border border-amber-7/25 bg-amber-3/10 px-3 py-2 text-xs leading-relaxed text-amber-11">
                              {updateRestartBlockedMessage()}
                            </div>
                          </Show>
                        </div>

                        <Show
                          when={updateState() === "available" && updateNotes()}
                        >
                          <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11 whitespace-pre-wrap max-h-40 overflow-auto">
                            {updateNotes()}
                          </div>
                        </Show>
                      </>
                    }
                  >
                    <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
                      {props.updateEnv?.reason ??
                        translate("settings.updates_not_supported")}
                    </div>
                  </Show>
                }
              >
                <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
                  {translate("settings.updates_desktop_only")}
                </div>
              </Show>
            </div>
          </div>
        </Match>

        <Match when={activeTab() === "recovery"}>
          <div class="space-y-6">
            <div class={`${settingsPanelClass} space-y-3`}>
              <div class="text-sm font-medium text-gray-12">
                {translate("settings.workspace_config_title")}
              </div>
              <div class="text-xs text-gray-10">
                {translate("settings.workspace_config_desc")}
              </div>
              <div class="text-[11px] text-gray-7 font-mono break-all">
                {workspaceConfigPath() || translate("settings.no_active_workspace")}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={revealWorkspaceConfig}
                  disabled={
                    !isTauriRuntime() ||
                    revealConfigBusy() ||
                    !workspaceConfigPath()
                  }
                  title={
                    !isTauriRuntime()
                      ? translate("settings.reveal_config_requires_desktop")
                      : ""
                  }
                >
                  <FolderOpen size={13} class="mr-1.5" />
                  {revealConfigBusy() ? translate("settings.opening") : translate("settings.reveal_config")}
                </Button>
                <Button
                  variant="danger"
                  class="text-xs h-8 py-0 px-3"
                  onClick={resetAppConfigDefaults}
                  disabled={resetConfigBusy() || props.anyActiveRuns}
                  title={
                    props.anyActiveRuns
                      ? translate("settings.stop_runs_before_reset_config")
                      : ""
                  }
                >
                      {resetConfigBusy()
                        ? translate("settings.resetting")
                        : translate("settings.reset_config_defaults")}
                    </Button>
                  </div>
                  <Show when={configActionStatus()}>
                    {(status) => (
                      <div class="text-xs text-gray-10">{status()}</div>
                    )}
                  </Show>
                </div>
                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">{translate("settings.opencode_cache")}</div>
                    <div class="text-xs text-gray-7">
                      {translate("settings.opencode_cache_description")}
                    </div>
                    <Show when={props.cacheRepairResult}>
                      <div class="text-xs text-gray-11 mt-2">
                        {props.cacheRepairResult}
                      </div>
                    </Show>
                  </div>
                  <Button
                    variant="secondary"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.repairOpencodeCache}
                    disabled={props.cacheRepairBusy || !isTauriRuntime()}
                    title={
                      isTauriRuntime()
                        ? ""
                        : translate("settings.cache_repair_requires_desktop")
                    }
                  >
                    {props.cacheRepairBusy ? translate("settings.repairing_cache") : translate("settings.repair_cache")}
                  </Button>
                </div>
                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">
                      {translate("settings.docker_containers_title")}
                    </div>
                    <div class="text-xs text-gray-7">
                      {translate("settings.docker_containers_desc")}
                    </div>
                    <Show when={props.dockerCleanupResult}>
                      <div class="text-xs text-gray-11 mt-2">
                        {props.dockerCleanupResult}
                      </div>
                    </Show>
                  </div>
                  <Button
                    variant="danger"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.cleanupOpenworkDockerContainers}
                    disabled={
                      props.dockerCleanupBusy ||
                      props.anyActiveRuns ||
                      !isTauriRuntime()
                    }
                    title={
                      !isTauriRuntime()
                        ? translate("settings.docker_requires_desktop")
                        : props.anyActiveRuns
                          ? translate("settings.stop_runs_before_cleanup")
                          : ""
                    }
                  >
                    {props.dockerCleanupBusy
                      ? translate("settings.removing_containers")
                      : translate("settings.delete_containers")}
                  </Button>
                </div>
          </div>
        </Match>

        <Match when={activeTab() === "debug"}>
          <Show when={props.developerMode}>
            <section>
              <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">
                {translate("settings.debug_section_title")}
              </h3>

              <div class="space-y-4">
                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.runtime_debug_title")}
                      </div>
                      <div class="text-xs text-gray-10">
                        {translate("settings.runtime_debug_desc")}
                      </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={copyRuntimeDebugReport}
                      >
                        <Copy size={13} class="mr-1.5" />
                        {translate("settings.copy_json")}
                      </Button>
                      <Button
                        variant="secondary"
                        class="text-xs h-8 py-0 px-3"
                        onClick={exportRuntimeDebugReport}
                      >
                        <Download size={13} class="mr-1.5" />
                        {translate("settings.export")}
                      </Button>
                    </div>
                  </div>
                  <div class="grid gap-2 md:grid-cols-2 text-xs text-gray-11">
                    <div>{t("settings.debug_desktop_app", undefined, { version: appVersionLabel() })}</div>
                    <div>{t("settings.debug_commit", undefined, { commit: appCommitLabel() })}</div>
                    <div>{t("settings.debug_orchestrator_version", undefined, { version: orchestratorVersionLabel() })}</div>
                    <div>{t("settings.debug_opencode_version", undefined, { version: opencodeVersionLabel() })}</div>
                    <div>{t("settings.debug_openwork_server_version", undefined, { version: openworkServerVersionLabel() })}</div>
                    <div>{t("settings.debug_opencode_router_version", undefined, { version: opencodeRouterVersionLabel() })}</div>
                  </div>
                  <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1 border border-gray-6 rounded-lg p-3">
                    {runtimeDebugReportJson()}
                  </pre>
                  <Show when={debugReportStatus()}>
                    {(status) => (
                      <div class="text-xs text-gray-10">{status()}</div>
                    )}
                  </Show>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        Developer log stream
                      </div>
                      <div class="text-xs text-gray-10">
                        Captures dev-mode app, workspace, session, and perf logs while Developer Mode is enabled.
                      </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={clearDeveloperLog}
                      >
                        Clear
                      </Button>
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={copyDeveloperLog}
                      >
                        <Copy size={13} class="mr-1.5" />
                        Copy log
                      </Button>
                      <Button
                        variant="secondary"
                        class="text-xs h-8 py-0 px-3"
                        onClick={exportDeveloperLog}
                      >
                        <Download size={13} class="mr-1.5" />
                        Export .log
                      </Button>
                    </div>
                  </div>
                  <div class="text-[11px] text-gray-8">
                    Showing the latest {props.developerMode ? readDevLogs(0).length : 0} retained records.
                  </div>
                  <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1 border border-gray-6 rounded-lg p-3">
                    {developerLogText() || "No developer logs captured yet."}
                  </pre>
                  <Show when={devLogStatus()}>
                    {(status) => (
                      <div class="text-xs text-gray-10">{status()}</div>
                    )}
                  </Show>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.sandbox_probe_title")}
                      </div>
                      <div class="text-xs text-gray-10">
                        {translate("settings.sandbox_probe_desc")}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      class="text-xs h-8 py-0 px-3"
                      onClick={runSandboxDebugProbe}
                      disabled={
                        !isTauriRuntime() ||
                        sandboxProbeBusy() ||
                        props.anyActiveRuns
                      }
                      title={
                        !isTauriRuntime()
                          ? translate("settings.sandbox_requires_desktop")
                          : props.anyActiveRuns
                            ? translate("settings.sandbox_stop_runs_hint")
                            : ""
                      }
                    >
                      {sandboxProbeBusy()
                        ? translate("settings.running_probe")
                        : translate("settings.run_sandbox_probe")}
                    </Button>
                  </div>
                  <Show when={sandboxProbeResult()}>
                    {(result) => (
                      <div class="text-xs text-gray-11 space-y-1">
                        <div>
                          {t("settings.sandbox_run_id", undefined, { id: result().runId ?? "—" })}
                        </div>
                        <div>{t("settings.sandbox_result", undefined, { status: result().ready ? translate("settings.sandbox_ready") : translate("settings.sandbox_error") })}</div>
                        <Show when={result().error}>
                          {(err) => <div class="text-red-11">{err()}</div>}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show when={sandboxProbeStatus()}>
                    {(status) => (
                      <div class="text-xs text-gray-10">{status()}</div>
                    )}
                  </Show>
                  <div class="text-[11px] text-gray-7">
                    {translate("settings.sandbox_export_hint")}
                  </div>
                </div>




                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="text-sm font-medium text-gray-12">{translate("settings.startup_title")}</div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                    <div class="flex items-center gap-3">
                      <div
                        class={`p-2 rounded-lg ${
                          isLocalPreference()
                            ? "bg-indigo-7/10 text-indigo-11"
                            : "bg-green-7/10 text-green-11"
                        }`}
                      >
                        <Show
                          when={isLocalPreference()}
                          fallback={<Smartphone size={18} />}
                        >
                          <HardDrive size={18} />
                        </Show>
                      </div>
                      <span class="text-sm font-medium text-gray-12">
                        {startupLabel()}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3"
                      onClick={props.stopHost}
                      disabled={props.busy}
                    >
                      {translate("settings.switch")}
                    </Button>
                  </div>

                  <Button
                    variant="secondary"
                    class="w-full justify-between group"
                    onClick={props.onResetStartupPreference}
                  >
                    <span>{translate("settings.reset_startup_pref")}</span>
                    <RefreshCcw
                      size={14}
                      class="opacity-80 group-hover:rotate-180 transition-transform"
                    />
                  </Button>

                  <p class="text-xs text-gray-7">
                    {translate("settings.startup_reset_hint")}
                  </p>
                </div>

                <Show
                  when={
                    isTauriRuntime() &&
                    (isLocalPreference() || props.developerMode)
                  }
                >
                  <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                    <div>
                      <div class="text-sm font-medium text-gray-12">{translate("settings.engine_title")}</div>
                      <div class="text-xs text-gray-10">
                        {translate("settings.engine_desc")}
                      </div>
                    </div>

                    <Show when={!isLocalPreference()}>
                      <div class="text-[11px] text-amber-11 bg-amber-3/40 border border-amber-7/40 rounded-lg px-3 py-2">
                        {translate("settings.startup_remote_warning")}
                      </div>
                    </Show>

                    <div class="space-y-3">
                      <div class="text-xs text-gray-10">{translate("settings.engine_source_debug")}</div>
                      <div
                        class={
                          props.developerMode
                            ? "grid grid-cols-3 gap-2"
                            : "grid grid-cols-2 gap-2"
                        }
                      >
                        <Button
                          variant={
                            props.engineSource === "sidecar"
                              ? "secondary"
                              : "outline"
                          }
                          onClick={() => props.setEngineSource("sidecar")}
                          disabled={props.busy}
                        >
                          {translate("settings.engine_bundled")}
                        </Button>
                        <Button
                          variant={
                            props.engineSource === "path"
                              ? "secondary"
                              : "outline"
                          }
                          onClick={() => props.setEngineSource("path")}
                          disabled={props.busy}
                        >
                          {translate("settings.engine_system_path")}
                        </Button>
                        <Show when={props.developerMode}>
                          <Button
                            variant={
                              props.engineSource === "custom"
                                ? "secondary"
                                : "outline"
                            }
                            onClick={() => props.setEngineSource("custom")}
                            disabled={props.busy}
                          >
                            {translate("settings.engine_custom_binary")}
                          </Button>
                        </Show>
                      </div>
                      <div class="text-[11px] text-gray-7">
                        {translate("settings.engine_bundled_hint")}
                      </div>
                    </div>

                    <Show
                      when={
                        props.developerMode && props.engineSource === "custom"
                      }
                    >
                      <div class="space-y-2">
                        <div class="text-xs text-gray-10">
                          {translate("settings.custom_binary_label")}
                        </div>
                        <div class="flex items-center gap-2">
                          <div
                            class="flex-1 min-w-0 text-[11px] text-gray-7 font-mono truncate bg-gray-1 p-3 rounded-xl border border-gray-6"
                            title={engineCustomBinPathLabel()}
                          >
                            {engineCustomBinPathLabel()}
                          </div>
                          <Button
                            variant="outline"
                            class="text-xs h-10 px-3 shrink-0"
                            onClick={handlePickEngineBinary}
                            disabled={props.busy}
                          >
                            {translate("settings.choose")}
                          </Button>
                          <Button
                            variant="outline"
                            class="text-xs h-10 px-3 shrink-0"
                            onClick={() => props.setEngineCustomBinPath("")}
                            disabled={
                              props.busy || !props.engineCustomBinPath.trim()
                            }
                            title={
                              !props.engineCustomBinPath.trim()
                                ? translate("settings.no_custom_path_set")
                                : translate("settings.clear")
                            }
                          >
                            {translate("settings.clear")}
                          </Button>
                        </div>
                        <div class="text-[11px] text-gray-7">
                          {translate("settings.custom_binary_hint")}
                        </div>
                      </div>
                    </Show>

                    <Show when={props.developerMode}>
                      <div class="space-y-3">
                        <div class="text-xs text-gray-10">{translate("settings.engine_runtime_label")}</div>
                        <div class="grid grid-cols-2 gap-2">
                          <Button
                            variant={
                              props.engineRuntime === "direct"
                                ? "secondary"
                                : "outline"
                            }
                            onClick={() => props.setEngineRuntime("direct")}
                            disabled={props.busy}
                          >
                            {translate("settings.runtime_direct")}
                          </Button>
                          <Button
                            variant={
                              props.engineRuntime === "openwork-orchestrator"
                                ? "secondary"
                                : "outline"
                            }
                            onClick={() =>
                              props.setEngineRuntime("openwork-orchestrator")
                            }
                            disabled={props.busy}
                          >
                            {translate("settings.runtime_orchestrator")}
                          </Button>
                        </div>
                        <div class="text-[11px] text-gray-7">
                          {translate("settings.runtime_applies_hint")}
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">
                      {translate("settings.reset_recovery_title")}
                    </div>
                    <div class="text-xs text-gray-10">
                      {translate("settings.reset_recovery_desc")}
                    </div>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-12">{translate("settings.reset_onboarding_title")}</div>
                      <div class="text-xs text-gray-7">
                        {translate("settings.reset_onboarding_description")}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => props.openResetModal("onboarding")}
                      disabled={
                        props.busy ||
                        props.resetModalBusy ||
                        props.anyActiveRuns
                      }
                      title={
                        props.anyActiveRuns ? translate("settings.stop_runs_to_reset") : ""
                      }
                    >
                      {translate("settings.reset_button")}
                    </Button>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-12">{translate("settings.reset_app_data_title")}</div>
                      <div class="text-xs text-gray-7">
                        {translate("settings.reset_app_data_description")}
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      class="text-xs h-8 py-0 px-3 shrink-0"
                      onClick={() => props.openResetModal("all")}
                      disabled={
                        props.busy ||
                        props.resetModalBusy ||
                        props.anyActiveRuns
                      }
                      title={
                        props.anyActiveRuns ? translate("settings.stop_runs_to_reset") : ""
                      }
                    >
                      {translate("settings.reset_button")}
                    </Button>
                  </div>

                  <div class="text-xs text-gray-7">
                    {translate("settings.reset_requires_confirm")}
                  </div>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">{translate("settings.devtools_title")}</div>
                    <div class="text-xs text-gray-10">
                      {translate("settings.devtools_desc")}
                    </div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.service_restarts_title")}
                      </div>
                      <div class="text-xs text-gray-10">
                        {translate("settings.service_restarts_desc")}
                      </div>
                    </div>
                    <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                      <Button
                        variant="secondary"
                        onClick={handleRestartLocalServer}
                        disabled={
                          props.busy ||
                          openworkRestartBusy() ||
                          !isTauriRuntime()
                        }
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw
                          class={`w-3.5 h-3.5 mr-1.5 ${openworkRestartBusy() ? "animate-spin" : ""}`}
                        />
                        {openworkRestartBusy()
                          ? translate("settings.restarting")
                          : translate("settings.restart_orchestrator")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleOpenCodeRestart}
                        disabled={opencodeRestarting() || !isTauriRuntime()}
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw
                          class={`w-3.5 h-3.5 mr-1.5 ${opencodeRestarting() ? "animate-spin" : ""}`}
                        />
                        {opencodeRestarting()
                          ? translate("settings.restarting")
                          : translate("settings.restart_opencode")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleOpenworkServerRestart}
                        disabled={
                          openworkServerRestarting() || !isTauriRuntime()
                        }
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw
                          class={`w-3.5 h-3.5 mr-1.5 ${openworkServerRestarting() ? "animate-spin" : ""}`}
                        />
                        {openworkServerRestarting()
                          ? translate("settings.restarting")
                          : translate("settings.restart_openwork_server")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={handleOpenCodeRouterRestart}
                        disabled={
                          opencodeRouterRestarting() || !isTauriRuntime()
                        }
                        class="text-xs px-3 py-1.5 justify-center"
                      >
                        <RefreshCcw
                          class={`w-3.5 h-3.5 mr-1.5 ${opencodeRouterRestarting() ? "animate-spin" : ""}`}
                        />
                        {opencodeRouterRestarting()
                          ? translate("settings.restarting")
                          : translate("settings.restart_opencode_router")}
                      </Button>
                    </div>
                    <Show when={openworkRestartStatus()}>
                      <div class="text-xs text-green-11 bg-green-3/50 border border-green-6 rounded-lg p-2">
                        {openworkRestartStatus()}
                      </div>
                    </Show>
                    <Show
                      when={
                        openworkRestartError() ||
                        opencodeRestartError() ||
                        openworkServerRestartError() ||
                        opencodeRouterRestartError()
                      }
                    >
                      <div class="text-xs text-red-11 bg-red-3/50 border border-red-6 rounded-lg p-2">
                        {openworkRestartError() ||
                          opencodeRestartError() ||
                          openworkServerRestartError() ||
                          opencodeRouterRestartError()}
                      </div>
                    </Show>
                  </div>

                  <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div>
                        <div class="text-sm font-medium text-gray-12">
                          {translate("settings.versions_title")}
                        </div>
                        <div class="text-xs text-gray-10">
                          {translate("settings.versions_desc")}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.debug_desktop_app", undefined, { version: appVersionLabel() })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.debug_commit", undefined, { commit: appCommitLabel() })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.debug_orchestrator_version", undefined, { version: orchestratorVersionLabel() })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.debug_opencode_version", undefined, { version: opencodeVersionLabel() })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.debug_openwork_server_version", undefined, { version: openworkServerVersionLabel() })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.debug_opencode_router_version", undefined, { version: opencodeRouterVersionLabel() })}
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">
                            {translate("settings.opencode_sdk_title")}
                          </div>
                          <div class="text-xs text-gray-10">
                            {translate("settings.opencode_engine_sidecar_desc")}
                          </div>
                        </div>
                        <div
                          class={`text-xs px-2 py-1 rounded-full border ${engineStatusStyle()}`}
                        >
                          {engineStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.engineInfo?.baseUrl ?? translate("settings.base_url_unavailable")}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.engineInfo?.projectDir ??
                            translate("settings.no_project_directory")}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_pid", undefined, { pid: String(props.engineInfo?.pid ?? "—") })}
                        </div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            {translate("settings.last_stdout")}
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            {translate("settings.last_stderr")}
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">
                            {translate("settings.orchestrator_daemon_title")}
                          </div>
                          <div class="text-xs text-gray-10">
                            {translate("settings.orchestrator_daemon_layer_desc")}
                          </div>
                        </div>
                        <div
                          class={`text-xs px-2 py-1 rounded-full border ${orchestratorStatusStyle()}`}
                        >
                          {orchestratorStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.orchestratorStatus?.dataDir ??
                            translate("settings.data_dir_unavailable")}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_daemon_url", undefined, { url: props.orchestratorStatus?.daemon?.baseUrl ?? "—" })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_opencode_url", undefined, { url: props.orchestratorStatus?.opencode?.baseUrl ?? "—" })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_version", undefined, { version: props.orchestratorStatus?.cliVersion ?? "—" })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_sidecar", undefined, { info: orchestratorSidecarSummary() })}
                        </div>
                        <div
                          class="text-[11px] text-gray-7 font-mono truncate"
                          title={orchestratorBinaryPath()}
                        >
                          {t("settings.diag_opencode_binary", undefined, { binary: formatOrchestratorBinary(props.orchestratorStatus?.binaries?.opencode ?? null) })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_runtime_workspace", undefined, { id: props.orchestratorStatus?.activeId ?? "—" })}
                        </div>
                      </div>
                      <Show when={props.orchestratorStatus?.lastError}>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            {translate("settings.last_error")}
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {props.orchestratorStatus?.lastError}
                          </pre>
                        </div>
                      </Show>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">
                            {translate("settings.opencode_sdk_title")}
                          </div>
                          <div class="text-xs text-gray-10">
                            {translate("settings.opencode_sdk_desc")}
                          </div>
                        </div>
                        <div
                          class={`text-xs px-2 py-1 rounded-full border ${opencodeConnectStatusStyle()}`}
                        >
                          {opencodeConnectStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.opencodeConnectStatus?.baseUrl ??
                            translate("settings.opencode_url_unavailable")}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.opencodeConnectStatus?.directory ??
                            translate("settings.no_worker_directory")}
                        </div>
                        <div class="text-[11px] text-gray-7">
                          {t("settings.diag_last_attempt", undefined, { time: opencodeConnectTimestamp() ?? "—" })}
                        </div>
                        <Show when={props.opencodeConnectStatus?.reason}>
                          <div class="text-[11px] text-gray-7">
                            {t("settings.diag_reason", undefined, { reason: props.opencodeConnectStatus?.reason ?? "" })}
                          </div>
                        </Show>
                        <Show when={props.opencodeConnectStatus?.metrics}>
                          {(metrics) => (
                            <div class="pt-1 space-y-1 text-[11px] text-gray-7">
                              <Show when={metrics().healthyMs != null}>
                                <div>
                                  {t("settings.diag_healthy_ms", undefined, { ms: String(Math.round(metrics().healthyMs as number)) })}
                                </div>
                              </Show>
                              <Show when={metrics().loadSessionsMs != null}>
                                <div>
                                  {t("settings.diag_load_sessions_ms", undefined, { ms: String(Math.round(metrics().loadSessionsMs as number)) })}
                                </div>
                              </Show>
                              <Show
                                when={metrics().pendingPermissionsMs != null}
                              >
                                <div>
                                  {t("settings.diag_pending_permissions_ms", undefined, { ms: String(Math.round(metrics().pendingPermissionsMs as number)) })}
                                </div>
                              </Show>
                              <Show when={metrics().providersMs != null}>
                                <div>
                                  {t("settings.diag_providers_ms", undefined, { ms: String(Math.round(metrics().providersMs as number)) })}
                                </div>
                              </Show>
                              <Show when={metrics().totalMs != null}>
                                <div>
                                  {t("settings.diag_total_ms", undefined, { ms: String(Math.round(metrics().totalMs as number)) })}
                                </div>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                      <Show when={props.opencodeConnectStatus?.error}>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            {translate("settings.last_error")}
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {props.opencodeConnectStatus?.error}
                          </pre>
                        </div>
                      </Show>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">
                            {translate("settings.openwork_server_label")}
                          </div>
                          <div class="text-xs text-gray-10">
                            {translate("settings.openwork_config_sidecar_desc")}
                          </div>
                        </div>
                        <div
                          class={`text-xs px-2 py-1 rounded-full border ${openworkStatusStyle()}`}
                        >
                          {openworkStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {(props.openworkServerHostInfo?.baseUrl ??
                            props.openworkServerUrl) ||
                            translate("settings.base_url_unavailable")}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_pid", undefined, { pid: String(props.openworkServerHostInfo?.pid ?? "—") })}
                        </div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            {translate("settings.last_stdout")}
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {openworkStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            {translate("settings.last_stderr")}
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {openworkStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">
                            {translate("settings.opencode_router_sidecar")}
                          </div>
                          <div class="text-xs text-gray-10">
                            {translate("settings.messaging_bridge_service")}
                          </div>
                        </div>
                        <div
                          class={`text-xs px-2 py-1 rounded-full border ${opencodeRouterStatusStyle()}`}
                        >
                          {opencodeRouterStatusLabel()}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.opencodeRouterInfo?.opencodeUrl?.trim() ||
                            translate("settings.opencode_url_unavailable")}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.opencodeRouterInfo?.workspacePath?.trim() ||
                            translate("settings.no_worker_directory")}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_health_port", undefined, { port: String(props.opencodeRouterInfo?.healthPort ?? "—") })}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {t("settings.diag_pid", undefined, { pid: String(props.opencodeRouterInfo?.pid ?? "—") })}
                        </div>
                      </div>
                      <div class="flex items-center gap-2">
                        <Button
                          variant="secondary"
                          onClick={handleOpenCodeRouterRestart}
                          disabled={
                            opencodeRouterRestarting() || !isTauriRuntime()
                          }
                          class="text-xs px-3 py-1.5"
                        >
                          <RefreshCcw
                            class={`w-3.5 h-3.5 mr-1.5 ${opencodeRouterRestarting() ? "animate-spin" : ""}`}
                          />
                          {opencodeRouterRestarting()
                            ? translate("settings.restarting")
                            : translate("settings.restart_opencode_router")}
                        </Button>
                        <Show when={props.opencodeRouterInfo?.running}>
                          <Button
                            variant="ghost"
                            onClick={handleOpenCodeRouterStop}
                            disabled={opencodeRouterRestarting()}
                            class="text-xs px-3 py-1.5"
                          >
                            {translate("settings.stop_local_server")}
                          </Button>
                        </Show>
                      </div>
                      <Show when={opencodeRouterRestartError()}>
                        <div class="text-xs text-red-11 bg-red-3/50 border border-red-6 rounded-lg p-2">
                          {opencodeRouterRestartError()}
                        </div>
                      </Show>
                      <div class="grid gap-2">
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            {translate("settings.last_stdout")}
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {opencodeRouterStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            {translate("settings.last_stderr")}
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {opencodeRouterStderr()}
                          </pre>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.openwork_diagnostics_title")}
                      </div>
                      <div class="text-[11px] text-gray-8 font-mono truncate">
                        {props.openworkServerDiagnostics?.version ?? "—"}
                      </div>
                    </div>
                    <Show
                      when={props.openworkServerDiagnostics}
                      fallback={
                        <div class="text-xs text-gray-9">
                          {translate("settings.diagnostics_unavailable")}
                        </div>
                      }
                    >
                      {(diag) => (
                        <div class="grid md:grid-cols-2 gap-2 text-xs text-gray-11">
                          <div>{t("settings.diag_started", undefined, { time: formatUptime(diag().uptimeMs) })}</div>
                          <div>
                            {t("settings.diag_read_only", undefined, { value: diag().readOnly ? "true" : "false" })}
                          </div>
                          <div>
                            {t("settings.diag_approval", undefined, { mode: diag().approval.mode, ms: String(diag().approval.timeoutMs) })}
                          </div>
                          <div>{t("settings.diag_workspaces", undefined, { count: String(diag().workspaceCount) })}</div>
                          <div>
                            {t("settings.diag_selected_workspace", undefined, { id: diag().selectedWorkspaceId ?? "—" })}
                          </div>
                          <div>
                            {t("settings.diag_runtime_workspace", undefined, { id: diag().activeWorkspaceId ?? "—" })}
                          </div>
                          <div>
                            {t("settings.diag_config_path", undefined, { path: diag().server.configPath ?? translate("settings.diag_default") })}
                          </div>
                          <div>{t("settings.diag_token_source", undefined, { source: diag().tokenSource.client })}</div>
                          <div>
                            {t("settings.diag_host_token_source", undefined, { source: diag().tokenSource.host })}
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.capabilities_title")}
                      </div>
                      <div class="text-[11px] text-gray-8 font-mono truncate">
                        {props.runtimeWorkspaceId
                          ? t("settings.worker_id_label", undefined, { id: props.runtimeWorkspaceId })
                          : translate("settings.worker_unresolved")}
                      </div>
                    </div>
                    <Show
                      when={props.openworkServerCapabilities}
                      fallback={
                        <div class="text-xs text-gray-9">
                          {translate("settings.capabilities_unavailable")}
                        </div>
                      }
                    >
                      {(caps) => (
                        <div class="grid md:grid-cols-2 gap-2 text-xs text-gray-11">
                          <div>{t("settings.cap_skills", undefined, { value: formatCapability(caps().skills) })}</div>
                          <div>{t("settings.cap_plugins", undefined, { value: formatCapability(caps().plugins) })}</div>
                          <div>{t("settings.cap_mcp", undefined, { value: formatCapability(caps().mcp) })}</div>
                          <div>{t("settings.cap_commands", undefined, { value: formatCapability(caps().commands) })}</div>
                          <div>{t("settings.cap_config", undefined, { value: formatCapability(caps().config) })}</div>
                          <div>
                            {t("settings.cap_proxy", undefined, {
                              value: caps().proxy?.opencodeRouter
                                ? translate("settings.enabled")
                                : translate("settings.disabled")
                            })}
                          </div>
                          <div>
                            {t("settings.cap_browser_tools", undefined, {
                              value: (() => {
                                const browser = caps().toolProviders?.browser;
                                if (!browser?.enabled) return translate("settings.disabled");
                                return `${browser.mode} · ${browser.placement}`;
                              })()
                            })}
                          </div>
                          <div>
                            {t("settings.cap_file_tools", undefined, {
                              value: (() => {
                                const files = caps().toolProviders?.files;
                                if (!files) return translate("config.unavailable");
                                const parts = [
                                  files.injection ? translate("settings.cap_inbox_on") : translate("settings.cap_inbox_off"),
                                  files.outbox ? translate("settings.cap_outbox_on") : translate("settings.cap_outbox_off"),
                                ];
                                return parts.join(" · ");
                              })()
                            })}
                          </div>
                          <div>
                            {t("settings.cap_sandbox", undefined, {
                              value: (() => {
                                const sandbox = caps().sandbox;
                                return sandbox
                                  ? `${sandbox.backend} (${sandbox.enabled ? translate("settings.on") : translate("settings.off")})`
                                  : translate("config.unavailable");
                              })()
                            })}
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="grid md:grid-cols-2 gap-4">
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">
                        {translate("settings.pending_permissions")}
                      </div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.pendingPermissions)}
                      </pre>
                    </div>
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">{translate("settings.recent_events")}</div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.events)}
                      </pre>
                    </div>
                  </div>

                  <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                    <div class="flex items-center justify-between gap-3 mb-2">
                      <div class="text-xs text-gray-10">
                        {translate("settings.workspace_debug_events_label")}
                      </div>
                      <Button
                        variant="outline"
                        class="text-xs h-7 py-0 px-2 shrink-0"
                        onClick={props.clearWorkspaceDebugEvents}
                        disabled={props.busy}
                      >
                        {translate("settings.clear")}
                      </Button>
                    </div>
                    <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                      {props.safeStringify(props.workspaceDebugEvents)}
                    </pre>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-gray-12">
                        {translate("settings.audit_log_title")}
                      </div>
                      <div
                        class={`text-xs px-2 py-1 rounded-full border ${openworkAuditStatusStyle()}`}
                      >
                        {openworkAuditStatusLabel()}
                      </div>
                    </div>
                    <Show when={props.openworkAuditError}>
                      <div class="text-xs text-red-11">
                        {props.openworkAuditError}
                      </div>
                    </Show>
                    <Show
                      when={props.openworkAuditEntries.length > 0}
                      fallback={
                        <div class="text-xs text-gray-9">
                          {translate("settings.no_audit_entries")}
                        </div>
                      }
                    >
                      <div class="divide-y divide-gray-6/50">
                        <For each={props.openworkAuditEntries}>
                          {(entry) => (
                            <div class="flex items-start justify-between gap-4 py-2">
                              <div class="min-w-0">
                                <div class="text-sm text-gray-12 truncate">
                                  {entry.summary}
                                </div>
                                <div class="text-[11px] text-gray-9 truncate">
                                  {entry.action} · {entry.target} ·{" "}
                                  {formatActor(entry)}
                                </div>
                              </div>
                              <div class="text-[11px] text-gray-9 whitespace-nowrap">
                                {entry.timestamp
                                  ? formatRelativeTime(entry.timestamp)
                                  : "—"}
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>

                  <Show when={isTauriRuntime()}>
                    <div class="rounded-2xl border border-red-7/30 bg-red-3/10 p-5 space-y-4">
                      <div class="flex items-start justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">
                            {translate("settings.reset_openwork_title")}
                          </div>
                          <div class="text-xs text-gray-10">
                            {opencodeDevModeEnabled()
                              ? translate("settings.reset_openwork_desc_dev")
                              : translate("settings.reset_openwork_desc_prod")}
                          </div>
                        </div>
                        <div
                          class={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${opencodeDevModeEnabled()
                            ? "border-blue-7/35 bg-blue-3/25 text-blue-11"
                            : "border-gray-6 bg-gray-2 text-gray-10"}`}
                        >
                          {opencodeDevModeEnabled()
                            ? translate("settings.dev_mode_badge")
                            : translate("settings.production_mode_badge")}
                        </div>
                      </div>

                      <div class="text-[11px] text-gray-8">
                        {translate("settings.quit_hint")}
                      </div>

                      <div class="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          class={compactDangerActionClass}
                          onClick={() =>
                            void handleNukeOpenworkAndOpencodeConfig()
                          }
                          disabled={props.busy || nukeConfigBusy()}
                        >
                          <CircleAlert size={14} />
                          {nukeConfigBusy()
                            ? translate("settings.removing_local_state")
                            : translate("settings.delete_local_config")}
                        </button>
                        <div class="text-xs text-gray-10">
                          {translate("settings.nuke_hint")}
                        </div>
                      </div>

                      <Show when={nukeConfigStatus()}>
                        {(value) => (
                          <div class="text-xs text-red-11">{value()}</div>
                        )}
                      </Show>
                    </div>
                  </Show>
                </div>
              </div>
            </section>
          </Show>
        </Match>
      </Switch>
      </div>
    </section>
  );
}
