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

import Button from "../components/button";
import DenSettingsPanel from "../components/den-settings-panel";
import { usePlatform } from "../context/platform";
import { FEEDBACK_EMAIL_URL } from "../lib/feedback";
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
  X,
  Zap,
} from "lucide-solid";
import type {
  OpencodeConnectStatus,
  ProviderListItem,
  SettingsTab,
  StartupPreference,
} from "../types";
import type {
  OpenworkAuditEntry,
  OpenworkServerCapabilities,
  OpenworkServerDiagnostics,
  OpenworkServerSettings,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import type {
  EngineInfo,
  OrchestratorBinaryInfo,
  OrchestratorStatus,
  OpenworkServerInfo,
  AppBuildInfo,
  OpenCodeRouterInfo,
  SandboxDebugProbeResult,
} from "../lib/tauri";
import {
  appBuildInfo,
  engineRestart,
  nukeOpencodeDevConfigAndExit,
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
  openProviderAuthModal: (options?: {
    returnFocusTarget?: "none" | "composer";
    preferredProviderId?: string;
  }) => Promise<void>;
  disconnectProvider: (providerId: string) => Promise<string | void>;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkReconnectBusy: boolean;
  reconnectOpenworkServer: () => Promise<boolean>;
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  openworkServerWorkspaceId: string | null;
  activeWorkspaceRoot: string;
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
  isWindows: boolean;
  defaultModelLabel: string;
  defaultModelRef: string;
  openDefaultModelPicker: () => void;
  showThinking: boolean;
  toggleShowThinking: () => void;
  autoCompactContext: boolean;
  toggleAutoCompactContext: () => void;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
  modelVariantLabel: string;
  editModelVariant: () => void;
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
  repairOpencodeMigration: () => void;
  migrationRepairBusy: boolean;
  migrationRepairResult: { ok: boolean; message: string } | null;
  migrationRepairAvailable: boolean;
  migrationRepairUnavailableReason: string | null;
  repairOpencodeCache: () => void;
  cacheRepairBusy: boolean;
  cacheRepairResult: string | null;
  cleanupOpenworkDockerContainers: () => void;
  dockerCleanupBusy: boolean;
  dockerCleanupResult: string | null;
  resetAppConfigDefaults: () => Promise<{ ok: boolean; message: string }>;
  notionStatus: "disconnected" | "connecting" | "connected" | "error";
  notionStatusDetail: string | null;
  notionError: string | null;
  notionBusy: boolean;
  connectNotion: () => void;
  engineDoctorVersion: string | null;
  openDebugDeepLink: (
    rawUrl: string,
  ) => Promise<{ ok: boolean; message: string }>;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
};

const DISCORD_INVITE_URL = "https://discord.gg/VEhNQXxYMB";
const BUG_REPORT_URL =
  "https://github.com/different-ai/openwork/issues/new?template=bug.yml";

// OpenCodeRouter Settings Component
//
// Messaging identities + routing are managed in the Identities tab.
export function OpenCodeRouterSettings(_props: {
  busy: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerWorkspaceId: string | null;
  openworkServerHostInfo: OpenworkServerInfo | null;
  developerMode: boolean;
}) {
  return (
    <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
      <div class="flex items-center gap-2">
        <MessageCircle size={16} class="text-gray-11" />
        <div class="text-sm font-medium text-gray-12">Messaging</div>
      </div>
      <div class="text-xs text-gray-10">
        Manage Telegram/Slack identities and bindings in the{" "}
        <span class="font-medium text-gray-12">Identities</span> tab.
      </div>
    </div>
  );
}

export default function SettingsView(props: SettingsViewProps) {
  const platform = usePlatform();
  const webDeployment = createMemo(() => getOpenWorkDeployment() === "web");
  const translate = (key: string) => t(key, currentLocale());
  const engineCustomBinPathLabel = () =>
    props.engineCustomBinPath.trim() || "No binary selected.";

  const openExternalLink = (url: string) => {
    const resolved = url.trim();
    if (!resolved) return;
    platform.openLink(resolved);
  };

  const handlePickEngineBinary = async () => {
    if (!isTauriRuntime()) return;
    try {
      const selected = await pickFile({ title: "Select OpenCode binary" });
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
      return `Update available${version ? ` · v${version}` : ""}`;
    }
    if (state === "ready") {
      return `Ready to install${version ? ` · v${version}` : ""}`;
    }
    if (state === "downloading") {
      const downloaded = updateDownloadedBytes() ?? 0;
      const percent = updateDownloadPercent();
      if (percent != null) return `Downloading ${percent}%`;
      return `Downloading ${formatBytes(downloaded)}`;
    }
    if (state === "checking") {
      return "Checking for updates";
    }
    if (state === "error") {
      return "Update check failed";
    }
    return "Up to date";
  });

  const updateToolbarTitle = createMemo(() => {
    const state = updateState();
    const version = updateVersion();
    if (state !== "downloading") return updateToolbarLabel();

    const downloaded = updateDownloadedBytes() ?? 0;
    const total = updateTotalBytes();
    const percent = updateDownloadPercent();

    if (total != null && percent != null) {
      return `Downloading ${formatBytes(downloaded)} / ${formatBytes(total)} (${percent}%)${version ? ` · v${version}` : ""}`;
    }

    return `Downloading ${formatBytes(downloaded)}${version ? ` · v${version}` : ""}`;
  });

  const updateToolbarActionLabel = createMemo(() => {
    const state = updateState();
    if (state === "available") return "Download";
    if (state === "ready") return "Install";
    if (state === "error") return "Retry";
    if (state === "idle") return "Check";
    return null;
  });

  const updateToolbarDisabled = createMemo(() => {
    const state = updateState();
    if (state === "checking" || state === "downloading") return true;
    if (state === "ready" && props.anyActiveRuns) return true;
    return props.busy;
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

  const notionStatusLabel = () => {
    switch (props.notionStatus) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Reload required";
      case "error":
        return "Connection failed";
      default:
        return "Not connected";
    }
  };

  const notionStatusStyle = () => {
    if (props.notionStatus === "connected") {
      return "bg-green-7/10 text-green-11 border-green-7/20";
    }
    if (props.notionStatus === "error") {
      return "bg-red-7/10 text-red-11 border-red-7/20";
    }
    if (props.notionStatus === "connecting") {
      return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    }
    return "bg-gray-4/60 text-gray-11 border-gray-7/50";
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
  const providerConnectedCount = createMemo(
    () => (props.providerConnectedIds ?? []).length,
  );
  const providerAvailableCount = createMemo(
    () => (props.providers ?? []).length,
  );
  const connectedProviders = createMemo(() => {
    const connectedIds = props.providerConnectedIds ?? [];
    if (!connectedIds.length) return [] as { id: string; name: string }[];
    const providersById = new Map(
      (props.providers ?? []).map((provider) => [provider.id, provider]),
    );
    return connectedIds
      .map((id) => {
        const provider = providersById.get(id);
        const label =
          provider?.name?.trim() || provider?.id?.trim() || id.trim();
        return { id, name: label || id };
      })
      .filter((entry) => entry.id.trim());
  });
  const providerStatusLabel = createMemo(() => {
    if (!providerAvailableCount()) return "Unavailable";
    if (!providerConnectedCount()) return "Not connected";
    return `${providerConnectedCount()} connected`;
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
      return "Connect to OpenCode to load providers.";
    const connected = providerConnectedCount();
    const available = providerAvailableCount();
    if (!connected) return `${available} available`;
    return `${connected} connected · ${available} available`;
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
        error instanceof Error ? error.message : "Failed to open providers";
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
            `Disconnect ${resolved}? This removes stored API keys or OAuth credentials for this provider.`,
          );
    if (!confirmed) return;
    setProviderDisconnectError(null);
    setProviderDisconnectStatus(null);
    setProviderDisconnectingId(resolved);
    try {
      const result = await props.disconnectProvider(resolved);
      setProviderDisconnectStatus(result || `Disconnected ${resolved}.`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to disconnect provider";
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
        setOpenworkReconnectError(
          "Reconnect failed. Check server URL/token and try again.",
        );
        return;
      }
      setOpenworkReconnectStatus("Reconnected to OpenWork server.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenworkReconnectError(
        message || "Failed to reconnect OpenWork server.",
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
        setOpenworkRestartError("Restart failed. Check logs and try again.");
        return;
      }
      setOpenworkRestartStatus("Restarted local server.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenworkRestartError(message || "Failed to restart local server.");
    } finally {
      setOpenworkRestartBusy(false);
    }
  };

  const openworkStatusLabel = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "Connected";
      case "limited":
        return "Limited";
      default:
        return "Not connected";
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
    if (status === "connecting") return "Connecting";
    if (status === "error") return "Connection failed";
    return props.clientConnected ? "Connected" : "Not connected";
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
    if (!isTauriRuntime()) return "Unavailable";
    return props.engineInfo?.running ? "Running" : "Offline";
  });

  const engineStatusStyle = createMemo(() => {
    if (!isTauriRuntime()) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.engineInfo?.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const opencodeConnectStatusLabel = createMemo(() => {
    const status = props.opencodeConnectStatus?.status;
    if (!status) return "Idle";
    if (status === "connected") return "Connected";
    if (status === "connecting") return "Connecting";
    return "Failed";
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
    if (!isTauriRuntime()) return "Unavailable";
    return props.opencodeRouterInfo?.running ? "Running" : "Offline";
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
      setOpenCodeRouterRestartError("No worker path available");
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
      await openworkServerRestart();
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
      await engineRestart();
      await props.reconnectOpenworkServer();
    } catch (e) {
      setOpencodeRestartError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpencodeRestarting(false);
    }
  };

  const orchestratorStatusLabel = createMemo(() => {
    if (!props.orchestratorStatus) return "Unavailable";
    return props.orchestratorStatus.running ? "Running" : "Offline";
  });

  const orchestratorStatusStyle = createMemo(() => {
    if (!props.orchestratorStatus)
      return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return props.orchestratorStatus.running
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  });

  const openworkAuditStatusLabel = createMemo(() => {
    if (!props.openworkServerWorkspaceId) return "Unavailable";
    if (props.openworkAuditStatus === "loading") return "Loading";
    if (props.openworkAuditStatus === "error") return "Error";
    return "Ready";
  });

  const openworkAuditStatusStyle = createMemo(() => {
    if (!props.openworkServerWorkspaceId)
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
    if (props.startupPreference === "local") return "Start local server";
    if (props.startupPreference === "server") return "Connect to server";
    return "Not set";
  });

  const tabLabel = (tab: SettingsTab) => {
    switch (tab) {
      case "den":
        return "Cloud";
      case "model":
        return "Model";
      case "advanced":
        return "Advanced";
      case "debug":
        return "Debug";
      default:
        return "General";
    }
  };

  const availableTabs = createMemo<SettingsTab[]>(() => {
    const tabs: SettingsTab[] = ["general", "den", "model", "advanced"];
    if (props.developerMode) tabs.push("debug");
    return tabs;
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
    if (!actor) return "unknown";
    if (actor.type === "host") return "host";
    if (actor.type === "remote") {
      return actor.clientId ? `remote:${actor.clientId}` : "remote";
    }
    return "unknown";
  };

  const formatCapability = (cap?: {
    read?: boolean;
    write?: boolean;
    source?: string;
  }) => {
    if (!cap) return "Unavailable";
    const parts = [cap.read ? "read" : null, cap.write ? "write" : null]
      .filter(Boolean)
      .join(" / ");
    const label = parts || "no access";
    return cap.source ? `${label} · ${cap.source}` : label;
  };

  const engineStdout = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.engineInfo?.lastStdout?.trim() || "No stdout captured yet.";
  };

  const engineStderr = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return props.engineInfo?.lastStderr?.trim() || "No stderr captured yet.";
  };

  const openworkStdout = () => {
    if (!props.openworkServerHostInfo) return "Logs are available on the host.";
    return (
      props.openworkServerHostInfo.lastStdout?.trim() ||
      "No stdout captured yet."
    );
  };

  const openworkStderr = () => {
    if (!props.openworkServerHostInfo) return "Logs are available on the host.";
    return (
      props.openworkServerHostInfo.lastStderr?.trim() ||
      "No stderr captured yet."
    );
  };

  const opencodeRouterStdout = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return (
      props.opencodeRouterInfo?.lastStdout?.trim() || "No stdout captured yet."
    );
  };

  const opencodeRouterStderr = () => {
    if (!isTauriRuntime()) return "Available in the desktop app.";
    return (
      props.opencodeRouterInfo?.lastStderr?.trim() || "No stderr captured yet."
    );
  };

  const formatOrchestratorBinary = (binary?: OrchestratorBinaryInfo | null) => {
    if (!binary) return "Binary unavailable";
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
    if (!info) return "Sidecar config unavailable";
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
  const [nukeDevConfigBusy, setNukeDevConfigBusy] = createSignal(false);
  const [nukeDevConfigStatus, setNukeDevConfigStatus] = createSignal<
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
    const root = props.activeWorkspaceRoot.trim();
    if (!root) return "";
    const normalized = root.replace(/[\\/]+$/, "");
    const separator = props.isWindows ? "\\" : "/";
    return `${normalized}${separator}.opencode${separator}openwork.json`;
  });

  const runtimeDebugReport = createMemo(() => ({
    generatedAt: new Date().toISOString(),
    app: {
      version: appVersionLabel(),
      commit: appCommitLabel(),
      startupPreference: props.startupPreference ?? "unset",
      workspaceRoot: props.activeWorkspaceRoot.trim() || null,
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
        status: engineStatusLabel(),
        baseUrl: props.engineInfo?.baseUrl ?? null,
        pid: props.engineInfo?.pid ?? null,
        stdout: engineStdout(),
        stderr: engineStderr(),
      },
      orchestrator: {
        status: orchestratorStatusLabel(),
        dataDir: props.orchestratorStatus?.dataDir ?? null,
        activeWorkspace: props.orchestratorStatus?.activeId ?? null,
        sidecar: orchestratorSidecarSummary(),
      },
      openworkServer: {
        status: openworkStatusLabel(),
        baseUrl:
          (props.openworkServerHostInfo?.baseUrl ?? props.openworkServerUrl) ||
          null,
        pid: props.openworkServerHostInfo?.pid ?? null,
        stdout: openworkStdout(),
        stderr: openworkStderr(),
      },
      opencodeRouter: {
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
      setDebugReportStatus("Clipboard is unavailable in this environment.");
      return;
    }
    try {
      await navigator.clipboard.writeText(runtimeDebugReportJson());
      setDebugReportStatus("Copied runtime report JSON.");
    } catch (error) {
      setDebugReportStatus(
        error instanceof Error
          ? error.message
          : "Failed to copy runtime report.",
      );
    }
  };

  const exportRuntimeDebugReport = () => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      setDebugReportStatus("Export is unavailable in this environment.");
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
      setDebugReportStatus("Exported runtime report JSON.");
    } catch (error) {
      setDebugReportStatus(
        error instanceof Error
          ? error.message
          : "Failed to export runtime report.",
      );
    }
  };

  const revealWorkspaceConfig = async () => {
    if (!isTauriRuntime() || revealConfigBusy()) return;
    const path = workspaceConfigPath();
    if (!path) {
      setConfigActionStatus(
        "Select a local workspace before revealing config.",
      );
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
      setConfigActionStatus("Revealed workspace config.");
    } catch (error) {
      setConfigActionStatus(
        error instanceof Error
          ? error.message
          : "Failed to reveal workspace config.",
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
        error instanceof Error ? error.message : "Failed to reset app config.",
      );
    } finally {
      setResetConfigBusy(false);
    }
  };

  const handleNukeOpencodeDevConfig = async () => {
    if (!isTauriRuntime() || !opencodeDevModeEnabled() || nukeDevConfigBusy())
      return;
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            "Delete the isolated OpenCode dev config and auth/data state, then quit OpenWork? This only affects dev-mode state.",
          );
    if (!confirmed) return;
    setNukeDevConfigBusy(true);
    setNukeDevConfigStatus(null);
    try {
      await nukeOpencodeDevConfigAndExit();
      setNukeDevConfigStatus(
        "Removed OpenCode dev state. OpenWork is closing...",
      );
    } catch (error) {
      setNukeDevConfigStatus(
        error instanceof Error
          ? error.message
          : "Failed to nuke OpenCode dev config.",
      );
      setNukeDevConfigBusy(false);
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
        setSandboxProbeStatus(
          "Sandbox probe succeeded. Export the debug report for support.",
        );
      } else {
        setSandboxProbeStatus(
          report.error?.trim() || "Sandbox probe completed with errors.",
        );
      }
    } catch (error) {
      setSandboxProbeStatus(
        error instanceof Error ? error.message : "Sandbox probe failed.",
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
        error instanceof Error ? error.message : "Failed to open deep link.",
      );
    } finally {
      setDebugDeepLinkBusy(false);
    }
  };

  const compactOutlineActionClass =
    "inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60";
  const compactDangerActionClass =
    "inline-flex items-center gap-1.5 rounded-md border border-red-7/35 bg-red-3/25 px-3 py-1.5 text-xs font-medium text-red-11 transition-colors duration-150 hover:border-red-7/50 hover:bg-red-3/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-7/35 disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <section class="space-y-6">
      <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between rounded-2xl border border-gray-6/40 bg-gray-1/40 px-3 py-2">
        <div class="flex flex-wrap gap-2">
          <For each={availableTabs()}>
            {(tab) => (
              <button
                class={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
                  activeTab() === tab
                    ? "bg-gray-12/10 text-white border-gray-6/30"
                    : "text-gray-10 border-gray-6/50 hover:text-gray-12 hover:bg-gray-2/40"
                }`}
                onClick={() => props.setSettingsTab(tab)}
              >
                {tabLabel(tab)}
              </button>
            )}
          </For>
        </div>
        <Show when={showUpdateToolbar()}>
          <div class="flex flex-wrap items-center gap-2">
            <div
              class={`text-xs px-2 py-1 rounded-full border flex items-center gap-2 ${updateToolbarTone()}`}
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
                title={
                  updateState() === "ready" && props.anyActiveRuns
                    ? "Stop active runs to update"
                    : ""
                }
              >
                {updateToolbarActionLabel()}
              </Button>
            </Show>
          </div>
        </Show>
      </div>

      <Switch>
        <Match when={activeTab() === "general"}>
          <div class="space-y-6">
            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="flex items-center gap-2">
                    <PlugZap size={16} class="text-gray-11" />
                    <div class="text-sm font-medium text-gray-12">
                      Providers
                    </div>
                  </div>
                  <div class="text-xs text-gray-9 mt-1">
                    Connect services for models and tools.
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
                    ? "Loading providers..."
                    : "Connect provider"}
                </Button>
                <div class="text-xs text-gray-10">{providerSummary()}</div>
              </div>

              <Show when={connectedProviders().length > 0}>
                <div class="space-y-2">
                  <For each={connectedProviders()}>
                    {(provider) => (
                      <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-6/60 bg-gray-1/40 px-3 py-2">
                        <div class="min-w-0">
                          <div class="text-sm font-medium text-gray-12 truncate">
                            {provider.name}
                          </div>
                          <div class="text-[11px] text-gray-8 font-mono truncate">
                            {provider.id}
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
                            providerDisconnectingId() !== null
                          }
                        >
                          {providerDisconnectingId() === provider.id
                            ? "Disconnecting..."
                            : "Disconnect"}
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
                <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-3 py-2 text-xs text-gray-10">
                  {providerDisconnectStatus()}
                </div>
              </Show>
              <Show when={providerDisconnectError()}>
                <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                  {providerDisconnectError()}
                </div>
              </Show>

              <div class="text-[11px] text-gray-9">
                API keys are stored locally by OpenCode. Set your default model
                in the <span class="font-medium">Model</span> tab.
              </div>
            </div>

            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">Appearance</div>
                <div class="text-xs text-gray-9">
                  Match the system or force light/dark mode.
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
                  System
                </Button>
                <Button
                  variant={
                    props.themeMode === "light" ? "secondary" : "outline"
                  }
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("light")}
                  disabled={props.busy}
                >
                  Light
                </Button>
                <Button
                  variant={props.themeMode === "dark" ? "secondary" : "outline"}
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => props.setThemeMode("dark")}
                  disabled={props.busy}
                >
                  Dark
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
                System mode follows your OS preference automatically.
              </div>
            </div>

            <div class="relative overflow-hidden rounded-2xl border border-blue-7/30 bg-gradient-to-br from-blue-3/35 via-gray-1/75 to-cyan-3/30 p-5">
              <div class="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-blue-6/20 blur-2xl" />
              <div class="pointer-events-none absolute -bottom-12 left-6 h-24 w-24 rounded-full bg-cyan-6/20 blur-2xl" />

              <div class="relative space-y-4">
                <div class="space-y-2">
                  <div class="inline-flex items-center gap-1.5 rounded-full border border-blue-7/35 bg-blue-4/25 px-2.5 py-1 text-[11px] font-medium text-blue-11">
                    <LifeBuoy size={12} />
                    We read every message
                  </div>
                  <div class="text-sm font-semibold text-gray-12">
                    Help shape OpenWork
                  </div>
                  <div class="max-w-[58ch] text-xs text-gray-10">
                    Tell us what feels great and what feels rough. Feedback goes
                    straight to the team and helps us prioritize what ships
                    next.
                  </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    class="h-9 rounded-xl bg-blue-10 px-4 text-xs font-semibold text-white hover:bg-blue-11"
                    onClick={() => openExternalLink(FEEDBACK_EMAIL_URL)}
                  >
                    <MessageCircle size={14} />
                    Send feedback
                    <ArrowUpRight size={13} />
                  </Button>

                  <button
                    type="button"
                    class="inline-flex h-9 items-center gap-1.5 rounded-xl border border-blue-7/35 bg-gray-1/70 px-3 text-xs font-medium text-gray-11 transition-colors hover:border-blue-7/50 hover:text-gray-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-7/30"
                    onClick={() => openExternalLink(DISCORD_INVITE_URL)}
                  >
                    Join Discord
                    <ArrowUpRight size={13} />
                  </button>

                  <button
                    type="button"
                    class="inline-flex h-9 items-center gap-1.5 rounded-xl border border-gray-7/60 bg-gray-1/70 px-3 text-xs font-medium text-gray-10 transition-colors hover:border-gray-7/80 hover:text-gray-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-7/40"
                    onClick={() => openExternalLink(BUG_REPORT_URL)}
                  >
                    Report an issue
                    <ArrowUpRight size={13} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Match>

        <Match when={activeTab() === "den"}>
          <DenSettingsPanel
            developerMode={props.developerMode}
            connectRemoteWorkspace={props.connectRemoteWorkspace}
          />
        </Match>

        <Match when={activeTab() === "model"}>
          <div class="space-y-6">
            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">Model</div>
                <div class="text-xs text-gray-10">
                  Defaults + thinking controls for runs.
                </div>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12 truncate">
                    {props.defaultModelLabel}
                  </div>
                  <div class="text-xs text-gray-7 font-mono truncate">
                    {props.defaultModelRef}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.openDefaultModelPicker}
                  disabled={props.busy}
                >
                  Change
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">Thinking</div>
                  <div class="text-xs text-gray-7">
                    Show thinking parts (Developer mode only).
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.toggleShowThinking}
                  disabled={props.busy}
                >
                  {props.showThinking ? "On" : "Off"}
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">
                    Auto context compaction
                  </div>
                  <div class="text-xs text-gray-7">
                    Automatically compact after a run completes.
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.toggleAutoCompactContext}
                  disabled={props.busy}
                >
                  {props.autoCompactContext ? "On" : "Off"}
                </Button>
              </div>

              <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                <div class="min-w-0">
                  <div class="text-sm text-gray-12">Model variant</div>
                  <div class="text-xs text-gray-7 font-mono truncate">
                    {props.modelVariantLabel}
                  </div>
                </div>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3 shrink-0"
                  onClick={props.editModelVariant}
                  disabled={props.busy}
                >
                  Edit
                </Button>
              </div>
            </div>
          </div>
        </Match>

        <Match when={activeTab() === "advanced"}>
          <div class="space-y-6">
            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">Runtime</div>
                <div class="text-xs text-gray-9">
                  Status for your local engine and OpenWork server.
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-3">
                  <div class="flex items-start gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
                      <Cpu size={18} />
                    </div>
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        OpenCode engine
                      </div>
                      <div class="text-xs text-gray-9">
                        Local runtime for agents, tools, and model providers.
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

                <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-3">
                  <div class="flex items-start gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
                      <Server size={18} />
                    </div>
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        OpenWork server
                      </div>
                      <div class="text-xs text-gray-9">
                        Session control plane for app sync, workers, and remote
                        access.
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

            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-3">
              <div class="text-sm font-medium text-gray-12">Developer mode</div>
              <div class="text-xs text-gray-9">
                Enables debug tools, diagnostics, and the Developer tab.
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
                    ? "Disable Developer Mode"
                    : "Enable Developer Mode"}
                </button>
                <div class="text-xs text-gray-10">
                  {props.developerMode
                    ? "Developer panel enabled."
                    : "Enable this to access the Developer panel."}
                </div>
              </div>
              <Show when={isTauriRuntime() && opencodeDevModeEnabled()}>
                <div class="pt-1 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    class={compactDangerActionClass}
                    onClick={() => void handleNukeOpencodeDevConfig()}
                    disabled={props.busy || nukeDevConfigBusy()}
                  >
                    <CircleAlert size={14} />
                    {nukeDevConfigBusy()
                      ? "Nuking OpenCode Dev Config..."
                      : "Nuke Opencode Dev Config"}
                  </button>
                  <div class="text-xs text-gray-10">
                    Deletes isolated OpenCode dev state and then quits OpenWork.
                  </div>
                </div>
                <Show when={nukeDevConfigStatus()}>
                  {(value) => <div class="text-xs text-red-11">{value()}</div>}
                </Show>

                <Show when={props.developerMode}>
                  <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-3">
                    <div class="flex items-start justify-between gap-3">
                      <div>
                          <div class="text-sm font-medium text-gray-12">
                          Open Deeplink
                          </div>
                          <div class="text-xs text-gray-9">
                          Paste any supported <span class="font-mono">openwork://</span> deeplink and route it through the dev app.
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
                        {debugDeepLinkOpen() ? "Hide" : "Open Deeplink"}
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
                            {debugDeepLinkBusy() ? "Opening..." : "Open deeplink"}
                          </Button>
                          <div class="text-[11px] text-gray-8">
                            Accepts <span class="font-mono">openwork://</span>,{" "}
                            <span class="font-mono">openwork-dev://</span>, or a
                            raw supported{" "}
                            <span class="font-mono">
                              https://share.openwork.software/b/...
                            </span>{" "}
                            URL.
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
              </Show>
            </div>

            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-3">
              <div class="text-sm font-medium text-gray-12">Connection</div>
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
                    ? "Reconnecting..."
                    : "Reconnect server"}
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
                      ? "Restarting..."
                      : "Restart local server"}
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
                    Stop local server
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
                    Disconnect server
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

            <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
              <div>
                <div class="text-sm font-medium text-gray-12">
                  {translate("settings.migration_recovery_label")}
                </div>
                <div class="text-xs text-gray-9">
                  {translate("settings.migration_recovery_hint")}
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  class="text-xs h-8 py-0 px-3"
                  onClick={props.repairOpencodeMigration}
                  disabled={
                    webDeployment() ||
                    props.busy ||
                    props.migrationRepairBusy ||
                    !props.migrationRepairAvailable
                  }
                  title={
                    webDeployment()
                      ? "Migration repair requires the desktop app."
                      : (props.migrationRepairUnavailableReason ?? "")
                  }
                >
                  {props.migrationRepairBusy
                    ? translate("settings.fixing_migration")
                    : translate("settings.fix_migration")}
                </Button>
              </div>

              <Show when={props.migrationRepairUnavailableReason}>
                {(reason) => (
                  <div class="text-xs text-amber-11">{reason()}</div>
                )}
              </Show>
              <Show when={props.migrationRepairBusy}>
                <div class="text-xs text-gray-10">
                  {translate("status.repairing_migration")}
                </div>
              </Show>
              <Show when={props.migrationRepairResult}>
                {(result) => (
                  <div
                    class={`rounded-xl border px-3 py-2 text-xs ${
                      result().ok
                        ? "border-green-7/30 bg-green-2/30 text-green-12"
                        : "border-red-7/30 bg-red-2/30 text-red-12"
                    }`}
                  >
                    {result().message}
                  </div>
                )}
              </Show>
            </div>

            <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-medium text-gray-12">Updates</div>
                  <div class="text-xs text-gray-10">
                    Keep OpenWork up to date.
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
                              Background checks
                            </div>
                            <div class="text-xs text-gray-7">
                              OpenWork always checks on launch. Also checks once
                              per day (quiet).
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
                            {props.updateAutoCheck ? "On" : "Off"}
                          </button>
                        </div>

                        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="space-y-0.5">
                            <div class="text-sm text-gray-12">Auto-update</div>
                            <div class="text-xs text-gray-7">
                              Download updates automatically (prompts to
                              restart)
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
                            {props.updateAutoDownload ? "On" : "Off"}
                          </button>
                        </div>

                        <div class="flex items-center justify-between gap-3 bg-gray-1 p-3 rounded-xl border border-gray-6">
                          <div class="space-y-0.5">
                            <div class="text-sm text-gray-12">
                              <Switch>
                                <Match when={updateState() === "checking"}>
                                  Checking...
                                </Match>
                                <Match when={updateState() === "available"}>
                                  Update available: v{updateVersion()}
                                </Match>
                                <Match when={updateState() === "downloading"}>
                                  Downloading...
                                </Match>
                                <Match when={updateState() === "ready"}>
                                  Ready to install: v{updateVersion()}
                                </Match>
                                <Match when={updateState() === "error"}>
                                  Update check failed
                                </Match>
                                <Match when={true}>Up to date</Match>
                              </Switch>
                            </div>
                            <Show
                              when={
                                updateState() === "idle" &&
                                updateLastCheckedAt()
                              }
                            >
                              <div class="text-xs text-gray-7">
                                Last checked{" "}
                                {formatRelativeTime(
                                  updateLastCheckedAt() as number,
                                )}
                              </div>
                            </Show>
                            <Show
                              when={
                                updateState() === "available" && updateDate()
                              }
                            >
                              <div class="text-xs text-gray-7">
                                Published {updateDate()}
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
                              Check
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
                                Download
                              </Button>
                            </Show>

                            <Show when={updateState() === "ready"}>
                              <Button
                                variant="secondary"
                                class="text-xs h-9 py-0 px-4 rounded-full"
                                onClick={props.installUpdateAndRestart}
                                disabled={props.busy || props.anyActiveRuns}
                                title={
                                  props.anyActiveRuns
                                    ? "Stop active runs to update"
                                    : ""
                                }
                              >
                                Install & Restart
                              </Button>
                            </Show>
                          </div>
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
                        "Updates are not supported in this environment."}
                    </div>
                  </Show>
                }
              >
                <div class="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-sm text-gray-11">
                  Updates are only available in the desktop app.
                </div>
              </Show>
            </div>

            <Show when={isTauriRuntime()}>
              <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                <div>
                  <div class="text-sm font-medium text-gray-12">Appearance</div>
                  <div class="text-xs text-gray-10">
                    Customize window appearance.
                  </div>
                </div>

                <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">Hide titlebar</div>
                    <div class="text-xs text-gray-7">
                      Hide the window titlebar. Useful for tiling window
                      managers on Linux (Hyprland, i3, sway).
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3 shrink-0"
                    onClick={props.toggleHideTitlebar}
                    disabled={props.busy}
                  >
                    {props.hideTitlebar ? "On" : "Off"}
                  </Button>
                </div>
              </div>
            </Show>
          </div>
        </Match>

        <Match when={activeTab() === "debug"}>
          <Show when={props.developerMode}>
            <section>
              <h3 class="text-sm font-medium text-gray-11 uppercase tracking-wider mb-4">
                Developer
              </h3>

              <div class="space-y-4">
                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        Runtime debug report
                      </div>
                      <div class="text-xs text-gray-10">
                        Readable diagnostics snapshot with one-click export.
                      </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        class="text-xs h-8 py-0 px-3"
                        onClick={copyRuntimeDebugReport}
                      >
                        <Copy size={13} class="mr-1.5" />
                        Copy JSON
                      </Button>
                      <Button
                        variant="secondary"
                        class="text-xs h-8 py-0 px-3"
                        onClick={exportRuntimeDebugReport}
                      >
                        <Download size={13} class="mr-1.5" />
                        Export
                      </Button>
                    </div>
                  </div>
                  <div class="grid gap-2 md:grid-cols-2 text-xs text-gray-11">
                    <div>Desktop app: {appVersionLabel()}</div>
                    <div>Commit: {appCommitLabel()}</div>
                    <div>Orchestrator: {orchestratorVersionLabel()}</div>
                    <div>OpenCode: {opencodeVersionLabel()}</div>
                    <div>OpenWork server: {openworkServerVersionLabel()}</div>
                    <div>OpenCodeRouter: {opencodeRouterVersionLabel()}</div>
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
                        Sandbox probe
                      </div>
                      <div class="text-xs text-gray-10">
                        Runs a temporary Docker sandbox startup check and
                        captures inspect/log output.
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
                          ? "Sandbox probe requires desktop app"
                          : props.anyActiveRuns
                            ? "Stop active runs before probing"
                            : ""
                      }
                    >
                      {sandboxProbeBusy()
                        ? "Running probe..."
                        : "Run sandbox probe"}
                    </Button>
                  </div>
                  <Show when={sandboxProbeResult()}>
                    {(result) => (
                      <div class="text-xs text-gray-11 space-y-1">
                        <div>
                          Run ID:{" "}
                          <span class="font-mono">{result().runId}</span>
                        </div>
                        <div>Result: {result().ready ? "ready" : "error"}</div>
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
                    Use <strong>Export</strong> in Runtime debug report above to
                    save this probe output with logs.
                  </div>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="text-sm font-medium text-gray-12">
                    Workspace config
                  </div>
                  <div class="text-xs text-gray-10">
                    Reveal or reset `.opencode/openwork.json` defaults for this
                    app workspace.
                  </div>
                  <div class="text-[11px] text-gray-7 font-mono break-all">
                    {workspaceConfigPath() || "No active local workspace."}
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
                          ? "Reveal config requires the desktop app"
                          : ""
                      }
                    >
                      <FolderOpen size={13} class="mr-1.5" />
                      {revealConfigBusy() ? "Opening..." : "Reveal config"}
                    </Button>
                    <Button
                      variant="danger"
                      class="text-xs h-8 py-0 px-3"
                      onClick={resetAppConfigDefaults}
                      disabled={resetConfigBusy() || props.anyActiveRuns}
                      title={
                        props.anyActiveRuns
                          ? "Stop active runs before resetting config"
                          : ""
                      }
                    >
                      {resetConfigBusy()
                        ? "Resetting..."
                        : "Reset config defaults"}
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
                    <div class="text-sm text-gray-12">OpenCode cache</div>
                    <div class="text-xs text-gray-7">
                      Repairs cached data used to start the engine. Safe to run.
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
                        : "Cache repair requires the desktop app"
                    }
                  >
                    {props.cacheRepairBusy ? "Repairing cache" : "Repair cache"}
                  </Button>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div class="min-w-0">
                    <div class="text-sm text-gray-12">
                      OpenWork Docker containers
                    </div>
                    <div class="text-xs text-gray-7">
                      Force-remove Docker containers launched by OpenWork
                      (sandbox + local dev stacks).
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
                        ? "Docker cleanup requires the desktop app"
                        : props.anyActiveRuns
                          ? "Stop active runs before cleanup"
                          : ""
                    }
                  >
                    {props.dockerCleanupBusy
                      ? "Removing containers..."
                      : "Delete containers"}
                  </Button>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
                  <div class="text-sm font-medium text-gray-12">Startup</div>

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
                      Switch
                    </Button>
                  </div>

                  <Button
                    variant="secondary"
                    class="w-full justify-between group"
                    onClick={props.onResetStartupPreference}
                  >
                    <span>Reset startup preference</span>
                    <RefreshCcw
                      size={14}
                      class="opacity-80 group-hover:rotate-180 transition-transform"
                    />
                  </Button>

                  <p class="text-xs text-gray-7">
                    This clears your saved preference and shows the connection
                    choice on next launch.
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
                      <div class="text-sm font-medium text-gray-12">Engine</div>
                      <div class="text-xs text-gray-10">
                        Choose how OpenCode runs locally.
                      </div>
                    </div>

                    <Show when={!isLocalPreference()}>
                      <div class="text-[11px] text-amber-11 bg-amber-3/40 border border-amber-7/40 rounded-lg px-3 py-2">
                        Startup preference is currently remote. Engine settings
                        are saved now and apply the next time you run locally.
                      </div>
                    </Show>

                    <div class="space-y-3">
                      <div class="text-xs text-gray-10">Engine source</div>
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
                          Bundled (recommended)
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
                          System install (PATH)
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
                            Custom binary
                          </Button>
                        </Show>
                      </div>
                      <div class="text-[11px] text-gray-7">
                        Bundled engine is the most reliable option. Use System
                        install only if you manage OpenCode yourself.
                      </div>
                    </div>

                    <Show
                      when={
                        props.developerMode && props.engineSource === "custom"
                      }
                    >
                      <div class="space-y-2">
                        <div class="text-xs text-gray-10">
                          Custom OpenCode binary
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
                            Choose
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
                                ? "No custom path set"
                                : "Clear"
                            }
                          >
                            Clear
                          </Button>
                        </div>
                        <div class="text-[11px] text-gray-7">
                          Use this to point OpenWork at a local OpenCode build
                          (e.g. your fork). Applies next time the engine starts
                          or reloads.
                        </div>
                      </div>
                    </Show>

                    <Show when={props.developerMode}>
                      <div class="space-y-3">
                        <div class="text-xs text-gray-10">Engine runtime</div>
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
                            Direct (OpenCode)
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
                            OpenWork Orchestrator
                          </Button>
                        </div>
                        <div class="text-[11px] text-gray-7">
                          Applies the next time the engine starts or reloads.
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">
                      Reset & Recovery
                    </div>
                    <div class="text-xs text-gray-10">
                      Clear data or restart the setup flow.
                    </div>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-12">Reset onboarding</div>
                      <div class="text-xs text-gray-7">
                        Clears OpenWork preferences and restarts the app.
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
                        props.anyActiveRuns ? "Stop active runs to reset" : ""
                      }
                    >
                      Reset
                    </Button>
                  </div>

                  <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
                    <div class="min-w-0">
                      <div class="text-sm text-gray-12">Reset app data</div>
                      <div class="text-xs text-gray-7">
                        More aggressive. Clears OpenWork cache + app data.
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
                        props.anyActiveRuns ? "Stop active runs to reset" : ""
                      }
                    >
                      Reset
                    </Button>
                  </div>

                  <div class="text-xs text-gray-7">
                    Requires typing{" "}
                    <span class="font-mono text-gray-11">RESET</span> and will
                    restart the app.
                  </div>
                </div>

                <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
                  <div>
                    <div class="text-sm font-medium text-gray-12">Devtools</div>
                    <div class="text-xs text-gray-10">
                      Sidecar health, capabilities, and audit trail.
                    </div>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div>
                      <div class="text-sm font-medium text-gray-12">
                        Service restarts
                      </div>
                      <div class="text-xs text-gray-10">
                        Restart specific host services without leaving this
                        screen.
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
                          ? "Restarting..."
                          : "Restart orchestrator"}
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
                          ? "Restarting..."
                          : "Restart OpenCode"}
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
                          ? "Restarting..."
                          : "Restart OpenWork server"}
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
                          ? "Restarting..."
                          : "Restart OpenCodeRouter"}
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
                          Versions
                        </div>
                        <div class="text-xs text-gray-10">
                          Sidecar + desktop build info.
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          Desktop app: {appVersionLabel()}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          Commit: {appCommitLabel()}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          Orchestrator: {orchestratorVersionLabel()}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          OpenCode: {opencodeVersionLabel()}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          OpenWork server: {openworkServerVersionLabel()}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          OpenCodeRouter: {opencodeRouterVersionLabel()}
                        </div>
                      </div>
                    </div>

                    <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                      <div class="flex items-center justify-between gap-3">
                        <div>
                          <div class="text-sm font-medium text-gray-12">
                            OpenCode engine
                          </div>
                          <div class="text-xs text-gray-10">
                            Local execution sidecar.
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
                          {props.engineInfo?.baseUrl ?? "Base URL unavailable"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.engineInfo?.projectDir ??
                            "No project directory"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          PID: {props.engineInfo?.pid ?? "—"}
                        </div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            Last stdout
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {engineStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            Last stderr
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
                            Orchestrator daemon
                          </div>
                          <div class="text-xs text-gray-10">
                            Workspace orchestration layer.
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
                            "Data directory unavailable"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          Daemon:{" "}
                          {props.orchestratorStatus?.daemon?.baseUrl ?? "—"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          OpenCode:{" "}
                          {props.orchestratorStatus?.opencode?.baseUrl ?? "—"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          Version: {props.orchestratorStatus?.cliVersion ?? "—"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          Sidecar: {orchestratorSidecarSummary()}
                        </div>
                        <div
                          class="text-[11px] text-gray-7 font-mono truncate"
                          title={orchestratorBinaryPath()}
                        >
                          Opencode binary:{" "}
                          {formatOrchestratorBinary(
                            props.orchestratorStatus?.binaries?.opencode ??
                              null,
                          )}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          Active workspace:{" "}
                          {props.orchestratorStatus?.activeId ?? "—"}
                        </div>
                      </div>
                      <Show when={props.orchestratorStatus?.lastError}>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            Last error
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
                            OpenCode SDK
                          </div>
                          <div class="text-xs text-gray-10">
                            UI connection diagnostics.
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
                            "Base URL unavailable"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.opencodeConnectStatus?.directory ??
                            "No project directory"}
                        </div>
                        <div class="text-[11px] text-gray-7">
                          Last attempt: {opencodeConnectTimestamp() ?? "—"}
                        </div>
                        <Show when={props.opencodeConnectStatus?.reason}>
                          <div class="text-[11px] text-gray-7">
                            Reason: {props.opencodeConnectStatus?.reason}
                          </div>
                        </Show>
                        <Show when={props.opencodeConnectStatus?.metrics}>
                          {(metrics) => (
                            <div class="pt-1 space-y-1 text-[11px] text-gray-7">
                              <Show when={metrics().healthyMs != null}>
                                <div>
                                  Healthy:{" "}
                                  {Math.round(metrics().healthyMs as number)}ms
                                </div>
                              </Show>
                              <Show when={metrics().loadSessionsMs != null}>
                                <div>
                                  Load sessions:{" "}
                                  {Math.round(
                                    metrics().loadSessionsMs as number,
                                  )}
                                  ms
                                </div>
                              </Show>
                              <Show
                                when={metrics().pendingPermissionsMs != null}
                              >
                                <div>
                                  Pending permissions:{" "}
                                  {Math.round(
                                    metrics().pendingPermissionsMs as number,
                                  )}
                                  ms
                                </div>
                              </Show>
                              <Show when={metrics().providersMs != null}>
                                <div>
                                  Providers:{" "}
                                  {Math.round(metrics().providersMs as number)}
                                  ms
                                </div>
                              </Show>
                              <Show when={metrics().totalMs != null}>
                                <div>
                                  Total:{" "}
                                  {Math.round(metrics().totalMs as number)}ms
                                </div>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                      <Show when={props.opencodeConnectStatus?.error}>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            Last error
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
                            OpenWork server
                          </div>
                          <div class="text-xs text-gray-10">
                            Config and approvals sidecar.
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
                            "Base URL unavailable"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          PID: {props.openworkServerHostInfo?.pid ?? "—"}
                        </div>
                      </div>
                      <div class="grid gap-2">
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            Last stdout
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {openworkStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            Last stderr
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
                            OpenCodeRouter sidecar
                          </div>
                          <div class="text-xs text-gray-10">
                            Messaging bridge service.
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
                            "OpenCode URL unavailable"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          {props.opencodeRouterInfo?.workspacePath?.trim() ||
                            "No worker directory"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          Health port:{" "}
                          {props.opencodeRouterInfo?.healthPort ?? "—"}
                        </div>
                        <div class="text-[11px] text-gray-7 font-mono truncate">
                          PID: {props.opencodeRouterInfo?.pid ?? "—"}
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
                            ? "Restarting..."
                            : "Restart"}
                        </Button>
                        <Show when={props.opencodeRouterInfo?.running}>
                          <Button
                            variant="ghost"
                            onClick={handleOpenCodeRouterStop}
                            disabled={opencodeRouterRestarting()}
                            class="text-xs px-3 py-1.5"
                          >
                            Stop
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
                            Last stdout
                          </div>
                          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-24 overflow-auto bg-gray-2/50 border border-gray-6 rounded-lg p-2">
                            {opencodeRouterStdout()}
                          </pre>
                        </div>
                        <div>
                          <div class="text-[11px] text-gray-9 mb-1">
                            Last stderr
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
                        OpenWork server diagnostics
                      </div>
                      <div class="text-[11px] text-gray-8 font-mono truncate">
                        {props.openworkServerDiagnostics?.version ?? "—"}
                      </div>
                    </div>
                    <Show
                      when={props.openworkServerDiagnostics}
                      fallback={
                        <div class="text-xs text-gray-9">
                          Diagnostics unavailable.
                        </div>
                      }
                    >
                      {(diag) => (
                        <div class="grid md:grid-cols-2 gap-2 text-xs text-gray-11">
                          <div>Started: {formatUptime(diag().uptimeMs)}</div>
                          <div>
                            Read-only: {diag().readOnly ? "true" : "false"}
                          </div>
                          <div>
                            Approval: {diag().approval.mode} (
                            {diag().approval.timeoutMs}ms)
                          </div>
                          <div>Workspaces: {diag().workspaceCount}</div>
                          <div>
                            Active workspace: {diag().activeWorkspaceId ?? "—"}
                          </div>
                          <div>
                            Config path: {diag().server.configPath ?? "default"}
                          </div>
                          <div>Token source: {diag().tokenSource.client}</div>
                          <div>
                            Host token source: {diag().tokenSource.host}
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-gray-12">
                        OpenWork server capabilities
                      </div>
                      <div class="text-[11px] text-gray-8 font-mono truncate">
                        {props.openworkServerWorkspaceId
                          ? `Worker ${props.openworkServerWorkspaceId}`
                          : "Worker unresolved"}
                      </div>
                    </div>
                    <Show
                      when={props.openworkServerCapabilities}
                      fallback={
                        <div class="text-xs text-gray-9">
                          Capabilities unavailable. Connect with a client token.
                        </div>
                      }
                    >
                      {(caps) => (
                        <div class="grid md:grid-cols-2 gap-2 text-xs text-gray-11">
                          <div>Skills: {formatCapability(caps().skills)}</div>
                          <div>Plugins: {formatCapability(caps().plugins)}</div>
                          <div>MCP: {formatCapability(caps().mcp)}</div>
                          <div>
                            Commands: {formatCapability(caps().commands)}
                          </div>
                          <div>Config: {formatCapability(caps().config)}</div>
                          <div>
                            Proxy (OpenCodeRouter):{" "}
                            {caps().proxy?.opencodeRouter
                              ? "enabled"
                              : "disabled"}
                          </div>
                          <div>
                            Browser tools:{" "}
                            {(() => {
                              const browser = caps().toolProviders?.browser;
                              if (!browser?.enabled) return "disabled";
                              return `${browser.mode} · ${browser.placement}`;
                            })()}
                          </div>
                          <div>
                            File tools:{" "}
                            {(() => {
                              const files = caps().toolProviders?.files;
                              if (!files) return "Unavailable";
                              const parts = [
                                files.injection ? "inbox on" : "inbox off",
                                files.outbox ? "outbox on" : "outbox off",
                              ];
                              return parts.join(" · ");
                            })()}
                          </div>
                          <div>
                            Sandbox:{" "}
                            {(() => {
                              const sandbox = caps().sandbox;
                              return sandbox
                                ? `${sandbox.backend} (${sandbox.enabled ? "on" : "off"})`
                                : "Unavailable";
                            })()}
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>

                  <div class="grid md:grid-cols-2 gap-4">
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">
                        Pending permissions
                      </div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.pendingPermissions)}
                      </pre>
                    </div>
                    <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                      <div class="text-xs text-gray-10 mb-2">Recent events</div>
                      <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                        {props.safeStringify(props.events)}
                      </pre>
                    </div>
                  </div>

                  <div class="bg-gray-1 border border-gray-6 rounded-xl p-4">
                    <div class="flex items-center justify-between gap-3 mb-2">
                      <div class="text-xs text-gray-10">
                        Workspace debug events
                      </div>
                      <Button
                        variant="outline"
                        class="text-xs h-7 py-0 px-2 shrink-0"
                        onClick={props.clearWorkspaceDebugEvents}
                        disabled={props.busy}
                      >
                        Clear
                      </Button>
                    </div>
                    <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto">
                      {props.safeStringify(props.workspaceDebugEvents)}
                    </pre>
                  </div>

                  <div class="bg-gray-1 p-4 rounded-xl border border-gray-6 space-y-3">
                    <div class="flex items-center justify-between gap-3">
                      <div class="text-sm font-medium text-gray-12">
                        Audit log
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
                          No audit entries yet.
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
                </div>
              </div>
            </section>
          </Show>
        </Match>
      </Switch>
    </section>
  );
}
