import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type {
  OpencodeConnectStatus,
  ProviderListItem,
  SettingsTab,
  StartupPreference,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
  View,
} from "../types";
import {
  formatRelativeTime,
  getWorkspaceTaskLoadErrorDisplay,
  isTauriRuntime,
  isWindowsPlatform,
  normalizeDirectoryPath,
} from "../utils";
import { usePlatform } from "../context/platform";
import { buildFeedbackUrl } from "../lib/feedback";
import { buildDenAuthUrl, readDenSettings, type DenOrgLlmProvider } from "../lib/den";
import { useConnections } from "../connections/provider";
import { useExtensions } from "../extensions/provider";
import type { CloudImportedProvider } from "../cloud/import-state";
import { getOpenWorkDeployment } from "../lib/openwork-deployment";
import { createWorkspaceShellLayout } from "../lib/workspace-shell-layout";
import {
  publishSkillsSetBundleFromWorkspace,
  publishWorkspaceProfileBundleFromWorkspace,
  saveWorkspaceProfileBundleToTeam,
} from "../bundles/publish";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  OpenworkServerError,
  parseOpenworkWorkspaceIdFromUrl,
} from "../lib/openwork-server";
import type {
  OpenworkAuditEntry,
  OpenworkServerClient,
  OpenworkServerCapabilities,
  OpenworkServerDiagnostics,
  OpenworkServerSettings,
  OpenworkServerStatus,
  OpenworkWorkspaceExportSensitiveMode,
  OpenworkWorkspaceExportWarning,
} from "../lib/openwork-server";
import type { EngineInfo, OrchestratorStatus, OpenworkServerInfo, OpenCodeRouterInfo, WorkspaceInfo } from "../lib/tauri";

import Button from "../components/button";
import SettingsView from "../pages/settings";
import StatusBar from "../components/status-bar";
import { ProviderAuthModal,
  type ProviderAuthProvider,
  type ProviderAuthMethod,
  type ProviderOAuthStartResult,
} from "../context/providers";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import { ShareWorkspaceModal } from "../workspace";
import {
  ArrowDownToLine,
  Box,
  History,
  Loader2,
  MessageCircle,
  Plus,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-solid";
import type { Language } from "../../i18n";
import { t } from "../../i18n";

export type SettingsShellProps = {
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  providerAuthBusy: boolean;
  providerAuthModalOpen: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthProviders: ProviderAuthProvider[];
  providerAuthPreferredProviderId: string | null;
  providerAuthWorkerType: "local" | "remote";
  cloudOrgProviders: DenOrgLlmProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
  openProviderAuthModal: (options?: {
    returnFocusTarget?: "none" | "composer";
    preferredProviderId?: string;
  }) => Promise<void>;
  disconnectProvider: (providerId: string) => Promise<string | void>;
  removeCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  closeProviderAuthModal: (options?: { restorePromptFocus?: boolean }) => void;
  startProviderAuth: (providerId?: string, methodIndex?: number) => Promise<ProviderOAuthStartResult>;
  completeProviderAuthOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string
  ) => Promise<{ connected: boolean; pending?: boolean; message?: string }>;
  submitProviderApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  connectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  refreshCloudOrgProviders: (options?: { force?: boolean }) => Promise<DenOrgLlmProvider[]>;
  refreshProviders: () => Promise<unknown>;
  setView: (view: View, sessionId?: string) => void;
  toggleSettings: () => void;
  startupPreference: StartupPreference | null;
  baseUrl: string;
  clientConnected: boolean;
  busy: boolean;
  busyHint: string | null;
  newTaskDisabled: boolean;
  headerStatus: string;
  error: string | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerClient: OpenworkServerClient | null;
  openworkReconnectBusy: boolean;
  reconnectOpenworkServer: () => Promise<boolean>;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerHostInfo: OpenworkServerInfo | null;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  saveShareRemoteAccess: (enabled: boolean) => Promise<void>;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  runtimeWorkspaceId: string | null;
  activeWorkspaceType: "local" | "remote";
  openworkAuditEntries: OpenworkAuditEntry[];
  openworkAuditStatus: "idle" | "loading" | "error";
  openworkAuditError: string | null;
  opencodeConnectStatus: OpencodeConnectStatus | null;
  engineInfo: EngineInfo | null;
  engineDoctorVersion: string | null;
  orchestratorStatus: OrchestratorStatus | null;
  opencodeRouterInfo: OpenCodeRouterInfo | null;
  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  resetOpenworkServerSettings: () => void;
  testOpenworkServerConnection: (next: OpenworkServerSettings) => Promise<boolean>;
  markOpencodeConfigReloadRequired: () => void;
  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;
  selectedWorkspaceDisplay: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  selectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  switchWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  openCreateWorkspace: () => void;
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
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: boolean;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  selectedSessionId: string | null;
  openRenameWorkspace: (workspaceId: string) => void;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  schedulerPluginInstalled: boolean;
  selectedWorkspaceRoot: string;
  skillsAccessHint?: string | null;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  pluginsAccessHint?: string | null;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
  suggestedPlugins: Array<{
    name: string;
    packageName: string;
    description: string;
    tags: string[];
    aliases?: string[];
    installMode?: "simple" | "guided";
    steps?: Array<{
      title: string;
      description: string;
      command?: string;
      url?: string;
      path?: string;
      note?: string;
    }>;
  }>; 
  addPlugin: (pluginNameOverride?: string) => void;
  createSessionInWorkspace: (workspaceId: string, initialPrompt?: string) => Promise<string | undefined> | string | void;
  createSessionAndOpen: (initialPrompt?: string) => Promise<string | undefined> | string | void;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
  opencodeEnableExa: boolean;
  toggleOpencodeEnableExa: () => void;
  language: Language;
  setLanguage: (value: Language) => void;
  updateAutoCheck: boolean;
  toggleUpdateAutoCheck: () => void;
  updateAutoDownload: boolean;
  toggleUpdateAutoDownload: () => void;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
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
  engineSource: "path" | "sidecar" | "custom";
  setEngineSource: (value: "path" | "sidecar" | "custom") => void;
  engineCustomBinPath: string;
  setEngineCustomBinPath: (value: string) => void;
  engineRuntime: "direct" | "openwork-orchestrator";
  setEngineRuntime: (value: "direct" | "openwork-orchestrator") => void;
  isWindows: boolean;
  toggleDeveloperMode: () => void;
  developerMode: boolean;
  stopHost: () => void;
  restartLocalServer: () => Promise<boolean>;
  openResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  onResetStartupPreference: () => void;
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
  resetAppConfigDefaults: () => Promise<{ ok: boolean; message: string }>;
  openDebugDeepLink: (rawUrl: string) => Promise<{ ok: boolean; message: string }>;
};

export default function SettingsShell(props: SettingsShellProps) {
  const connections = useConnections();
  const extensions = useExtensions();
  const platform = usePlatform();
  const webDeployment = createMemo(() => getOpenWorkDeployment() === "web");
  const title = createMemo(() => {
    switch (props.settingsTab) {
      case "automations":
        return t("settings.tab_automations");
      case "skills":
        return t("settings.tab_skills");
      case "extensions":
        return t("settings.tab_extensions");
      case "messaging":
        return t("settings.tab_messaging");
      case "advanced":
        return t("settings.tab_advanced");
      case "appearance":
        return t("settings.tab_appearance");
      case "updates":
        return t("settings.tab_updates");
      case "recovery":
        return t("settings.tab_recovery");
      case "den":
        return t("settings.tab_cloud");
      case "debug":
        return t("settings.tab_debug");
      default:
        return t("settings.tab_general");
    }
  });

  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    t("share.workspace_fallback");
  const workspaceKindLabel = (workspace: WorkspaceInfo) =>
    workspace.workspaceType === "remote"
      ? workspace.sandboxBackend === "docker" ||
        Boolean(workspace.sandboxRunId?.trim()) ||
        Boolean(workspace.sandboxContainerName?.trim())
        ? t("workspace.sandbox_badge")
        : t("workspace.remote_badge")
      : t("workspace.local_badge");

  const openSessionFromList = (workspaceId: string, sessionId: string) => {
    void (async () => {
      const ready = await Promise.resolve(props.switchWorkspace(workspaceId));
      if (!ready) return;
      props.setView("session", sessionId);
    })();
  };

  const createTaskInWorkspace = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    void (async () => {
      await Promise.resolve(props.createSessionInWorkspace(id));
    })();
  };

  // Track last refreshed tab to avoid duplicate calls
  const [lastRefreshedTab, setLastRefreshedTab] = createSignal<string | null>(null);
  const [refreshInProgress, setRefreshInProgress] = createSignal(false);
  const [providerAuthActionBusy, setProviderAuthActionBusy] = createSignal(false);
  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);
  const {
    leftSidebarWidth,
    startLeftSidebarResize,
  } = createWorkspaceShellLayout({ expandedRightWidth: 280 });

  const openFeedback = () => {
    const resolved = buildFeedbackUrl({
      entrypoint: "settings-shell-status-bar",
      deployment: getOpenWorkDeployment(),
      appVersion: props.appVersion,
      openworkServerVersion: props.openworkServerDiagnostics?.version ?? null,
      opencodeVersion:
        props.orchestratorStatus?.binaries?.opencode?.actualVersion ??
        props.engineDoctorVersion ??
        null,
      orchestratorVersion: props.orchestratorStatus?.cliVersion ?? null,
      opencodeRouterVersion: props.opencodeRouterInfo?.version ?? null,
    });
    if (!resolved) return;
    platform.openLink(resolved);
  };

  const handleProviderAuthSelect = async (
    providerId: string,
    methodIndex?: number,
  ): Promise<ProviderOAuthStartResult> => {
    if (providerAuthActionBusy()) {
      throw new Error(t("session.provider_auth_in_progress"));
    }
    setProviderAuthActionBusy(true);
    try {
      return await props.startProviderAuth(providerId, methodIndex);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthOAuth = async (providerId: string, methodIndex: number, code?: string) => {
    if (providerAuthActionBusy()) return { connected: false, pending: true };
    setProviderAuthActionBusy(true);
    try {
      const result = await props.completeProviderAuthOAuth(providerId, methodIndex, code);
      if (result.connected) {
        props.closeProviderAuthModal();
      }
      return result;
    } catch {
      // Errors are surfaced in the modal.
      return { connected: false };
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthApiKey = async (providerId: string, apiKey: string) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      await props.submitProviderApiKey(providerId, apiKey);
      props.closeProviderAuthModal();
    } catch {
      // Errors are surfaced in the modal.
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleCloudProviderConnect = async (cloudProviderId: string) => {
    if (providerAuthActionBusy()) return;
    setProviderAuthActionBusy(true);
    try {
      await props.connectCloudProvider(cloudProviderId);
      props.closeProviderAuthModal();
    } catch {
      // Errors are surfaced in the modal.
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  onCleanup(() => {
    // no-op
  });

  createEffect(() => {
    const currentTab = props.settingsTab;

    // Skip if we already refreshed this tab or a refresh is in progress
    if (lastRefreshedTab() === currentTab || refreshInProgress()) {
      return;
    }

    // Track that we're refreshing this tab
    setRefreshInProgress(true);
    setLastRefreshedTab(currentTab);

    // Use a cancelled flag to prevent stale updates after navigation
    let cancelled = false;

    const doRefresh = async () => {
      try {
        if (currentTab === "skills" && !cancelled) {
          await extensions.refreshSkills();
        }
        if (currentTab === "extensions" && !cancelled) {
          await Promise.all([extensions.refreshPlugins(), connections.refreshMcpServers()]);
        }
      } catch {
        // Ignore errors during navigation
      } finally {
        if (!cancelled) {
          setRefreshInProgress(false);
        }
      }
    };

    doRefresh();

    onCleanup(() => {
      cancelled = true;
      setRefreshInProgress(false);
    });
  });

  const openSettings = (tab: SettingsTab = "general") => {
    props.setSettingsTab(tab);
  };

  const openAdvanced = () => {
    openSettings("advanced");
  };

  const revealWorkspaceInFinder = async (workspaceId: string) => {
    const workspace = props.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "local") return;
    const target = workspace.path?.trim() ?? "";
    if (!target || !isTauriRuntime()) return;
    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      if (isWindowsPlatform()) {
        await openPath(target);
      } else {
        await revealItemInDir(target);
      }
    } catch (error) {
      console.warn("Failed to reveal workspace", error);
    }
  };

  const shareWorkspace = createMemo(() => {
    const id = shareWorkspaceId();
    if (!id) return null;
    return props.workspaces.find((ws) => ws.id === id) ?? null;
  });

  const shareWorkspaceName = createMemo(() => {
    const ws = shareWorkspace();
    return ws ? workspaceLabel(ws) : "";
  });

  const shareWorkspaceDetail = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "";
    if (ws.workspaceType === "remote") {
      if (ws.remoteType === "openwork") {
        const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
        const mounted = buildOpenworkWorkspaceBaseUrl(hostUrl, ws.openworkWorkspaceId);
        return mounted || hostUrl;
      }
      return ws.baseUrl?.trim() || "";
    }
    return ws.path?.trim() || "";
  });

  type ShareWorkspaceProfileSensitiveMode = Exclude<OpenworkWorkspaceExportSensitiveMode, "auto">;

  const [shareLocalOpenworkWorkspaceId, setShareLocalOpenworkWorkspaceId] = createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] = createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<string | null>(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] = createSignal<string | null>(null);
  const [shareWorkspaceProfileSensitiveWarnings, setShareWorkspaceProfileSensitiveWarnings] = createSignal<OpenworkWorkspaceExportWarning[] | null>(null);
  const [shareWorkspaceProfileSensitiveMode, setShareWorkspaceProfileSensitiveMode] = createSignal<ShareWorkspaceProfileSensitiveMode | null>(null);
  const [shareWorkspaceProfileTeamBusy, setShareWorkspaceProfileTeamBusy] = createSignal(false);
  const [shareWorkspaceProfileTeamError, setShareWorkspaceProfileTeamError] = createSignal<string | null>(null);
  const [shareWorkspaceProfileTeamSuccess, setShareWorkspaceProfileTeamSuccess] = createSignal<string | null>(null);
  const [shareCloudSettingsVersion, setShareCloudSettingsVersion] = createSignal(0);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(null);
  const [shareSkillsSetError, setShareSkillsSetError] = createSignal<string | null>(null);

  createEffect(
    on(shareWorkspaceId, () => {
      setShareWorkspaceProfileBusy(false);
      setShareWorkspaceProfileUrl(null);
      setShareWorkspaceProfileError(null);
      setShareWorkspaceProfileSensitiveWarnings(null);
      setShareWorkspaceProfileSensitiveMode(null);
      setShareWorkspaceProfileTeamBusy(false);
      setShareWorkspaceProfileTeamError(null);
      setShareWorkspaceProfileTeamSuccess(null);
      setShareSkillsSetBusy(false);
      setShareSkillsSetUrl(null);
      setShareSkillsSetError(null);
    }),
  );

  createEffect(() => {
    const ws = shareWorkspace();
    const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
    const token =
      props.openworkServerHostInfo?.ownerToken?.trim() ||
      props.openworkServerHostInfo?.clientToken?.trim() ||
      "";
    const workspacePath = ws?.workspaceType === "local" ? ws.path?.trim() ?? "" : "";

    if (!ws || ws.workspaceType !== "local" || !workspacePath || !baseUrl || !token) {
      setShareLocalOpenworkWorkspaceId(null);
      return;
    }

    let cancelled = false;
    setShareLocalOpenworkWorkspaceId(null);

    void (async () => {
      try {
        const client = createOpenworkServerClient({ baseUrl, token });
        const response = await client.listWorkspaces();
        if (cancelled) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(workspacePath);
        const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
        setShareLocalOpenworkWorkspaceId(match?.id ?? null);
      } catch {
        if (!cancelled) setShareLocalOpenworkWorkspaceId(null);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const shareFields = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) {
      return [] as Array<{
        label: string;
        value: string;
        secret?: boolean;
        placeholder?: string;
        hint?: string;
      }>;
    }

    if (ws.workspaceType !== "remote") {
      if (props.openworkServerHostInfo?.remoteAccessEnabled !== true) {
        return [];
      }
      const hostUrl =
        props.openworkServerHostInfo?.connectUrl?.trim() ||
        props.openworkServerHostInfo?.lanUrl?.trim() ||
        props.openworkServerHostInfo?.mdnsUrl?.trim() ||
        props.openworkServerHostInfo?.baseUrl?.trim() ||
        "";
      const mountedUrl = shareLocalOpenworkWorkspaceId()
        ? buildOpenworkWorkspaceBaseUrl(hostUrl, shareLocalOpenworkWorkspaceId())
        : null;
      const url = mountedUrl || hostUrl;
      const ownerToken = props.openworkServerHostInfo?.ownerToken?.trim() || "";
      const collaboratorToken = props.openworkServerHostInfo?.clientToken?.trim() || "";
      return [
        {
          label: "Worker URL",
          value: url,
          placeholder: !isTauriRuntime() ? "Desktop app required" : "Starting server...",
          hint: mountedUrl
            ? "Use on phones or laptops connecting to this worker."
            : hostUrl
              ? "Worker URL is resolving; host URL shown as fallback."
              : undefined,
        },
        {
          label: "Password",
          value: ownerToken,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : "Desktop app required",
          hint: mountedUrl
            ? "Use on phones or laptops connecting to this worker."
            : "Use when the remote client must answer permission prompts.",
        },
        {
          label: "Collaborator token",
          value: collaboratorToken,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : "Desktop app required",
          hint: mountedUrl
            ? "Routine remote access when you do not need owner-only actions."
            : "Routine remote access to this host without owner-only actions.",
        },
      ];
    }

    if (ws.remoteType === "openwork") {
      const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const url = buildOpenworkWorkspaceBaseUrl(hostUrl, ws.openworkWorkspaceId) || hostUrl;
      const token =
        ws.openworkToken?.trim() ||
        props.openworkServerSettings.token?.trim() ||
        "";
      return [
        {
          label: "Worker URL",
          value: url,
        },
        {
          label: "Password",
          value: token,
          secret: true,
          placeholder: token ? undefined : "Set token in Advanced",
          hint: "This workspace is currently connected with this password.",
        },
      ];
    }

    const baseUrl = ws.baseUrl?.trim() || ws.path?.trim() || "";
    const directory = ws.directory?.trim() || "";
    return [
      {
        label: "OpenCode base URL",
        value: baseUrl,
      },
      {
        label: "Directory",
        value: directory,
        placeholder: "(auto)",
      },
    ];
  });

  const shareNote = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return null;
    if (ws.workspaceType === "local" && props.engineInfo?.runtime === "direct") {
      return "Engine runtime is set to Direct. Switching local workspaces can restart the host and disconnect clients. The token may change after a restart.";
    }
    return null;
  });

  const shareServiceDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "Select a workspace first.";
    if (ws.workspaceType === "remote" && ws.remoteType !== "openwork") {
      return "Share service links are available for OpenWork workers.";
    }
    if (ws.workspaceType !== "remote") {
      const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        props.openworkServerHostInfo?.ownerToken?.trim() ||
        props.openworkServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        return "Local OpenWork host is not ready yet.";
      }
    } else {
      const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const token = ws.openworkToken?.trim() || props.openworkServerSettings.token?.trim() || "";
      if (!hostUrl) return "Missing OpenWork host URL.";
      if (!token) return "Missing OpenWork token.";
    }
    return null;
  });

  const shareCloudSettings = createMemo(() => {
    shareWorkspaceId();
    shareCloudSettingsVersion();
    return readDenSettings();
  });

  createEffect(() => {
    const handleCloudSessionUpdate = () =>
      setShareCloudSettingsVersion((value) => value + 1);
    window.addEventListener("openwork-den-session-updated", handleCloudSessionUpdate);
    onCleanup(() =>
      window.removeEventListener(
        "openwork-den-session-updated",
        handleCloudSessionUpdate,
      ),
    );
  });

  const shareWorkspaceProfileTeamOrgName = createMemo(() => {
    const orgName = shareCloudSettings().activeOrgName?.trim();
    if (orgName) return orgName;
    return "Active Cloud org";
  });

  const shareWorkspaceProfileToTeamNeedsSignIn = createMemo(
    () => !shareCloudSettings().authToken?.trim(),
  );

  const shareWorkspaceProfileTeamDisabledReason = createMemo(() => {
    const exportReason = shareServiceDisabledReason();
    if (exportReason) return exportReason;
    if (shareWorkspaceProfileToTeamNeedsSignIn()) return null;
    const settings = shareCloudSettings();
    if (!settings.activeOrgId?.trim() && !settings.activeOrgSlug?.trim()) {
      return "Choose an organization in Settings -> Cloud before sharing with your team.";
    }
    return null;
  });

  const startShareWorkspaceProfileToTeamSignIn = () => {
    const settings = readDenSettings();
    platform.openLink(buildDenAuthUrl(settings.baseUrl, "sign-in"));
  };

  const resolveShareExportContext = async (): Promise<{
    client: OpenworkServerClient;
    workspaceId: string;
    workspace: WorkspaceInfo;
  }> => {
    const ws = shareWorkspace();
    if (!ws) {
      throw new Error("Select a workspace first.");
    }

    if (ws.workspaceType !== "remote") {
      const baseUrl = props.openworkServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        props.openworkServerHostInfo?.ownerToken?.trim() ||
        props.openworkServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        throw new Error("Local OpenWork host is not ready yet.");
      }
      const client = createOpenworkServerClient({ baseUrl, token });

      let workspaceId = shareLocalOpenworkWorkspaceId()?.trim() ?? "";
      if (!workspaceId) {
        const response = await client.listWorkspaces();
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(ws.path?.trim() ?? "");
        const match = items.find((entry) => normalizeDirectoryPath(entry.path) === targetPath);
        workspaceId = (match?.id ?? "").trim();
        setShareLocalOpenworkWorkspaceId(workspaceId || null);
      }

      if (!workspaceId) {
        throw new Error("Could not resolve this workspace on the local OpenWork host.");
      }

      return { client, workspaceId, workspace: ws };
    }

    if (ws.remoteType !== "openwork") {
      throw new Error("Share service links are available for OpenWork workers.");
    }

    const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
    const token = ws.openworkToken?.trim() || props.openworkServerSettings.token?.trim() || "";
    if (!hostUrl || !token) {
      throw new Error("OpenWork host URL and token are required.");
    }

    const client = createOpenworkServerClient({ baseUrl: hostUrl, token });
    let workspaceId =
      ws.openworkWorkspaceId?.trim() ||
      parseOpenworkWorkspaceIdFromUrl(ws.openworkHostUrl ?? "") ||
      parseOpenworkWorkspaceIdFromUrl(ws.baseUrl ?? "") ||
      "";

    if (!workspaceId) {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const directoryHint = normalizeDirectoryPath(ws.directory?.trim() ?? ws.path?.trim() ?? "");
      const match = directoryHint
        ? items.find((entry) => {
            const entryPath = normalizeDirectoryPath(
              (entry.opencode?.directory ?? entry.directory ?? entry.path ?? "").trim(),
            );
            return Boolean(entryPath && entryPath === directoryHint);
          })
        : (response.activeId ? items.find((entry) => entry.id === response.activeId) : null) ??
          items[0];
      workspaceId = (match?.id ?? "").trim();
    }

    if (!workspaceId) {
      throw new Error("Could not resolve this workspace on the OpenWork host.");
    }

    return { client, workspaceId, workspace: ws };
  };

  const publishWorkspaceProfileLink = async () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const result = await publishWorkspaceProfileBundleFromWorkspace({
        client,
        workspaceId,
        workspaceName: workspaceLabel(workspace),
        sensitiveMode: shareWorkspaceProfileSensitiveMode(),
      });

      setShareWorkspaceProfileUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      const warnings = readWorkspaceExportWarnings(error);
      if (warnings) {
        setShareWorkspaceProfileSensitiveWarnings(warnings);
        setShareWorkspaceProfileError(null);
        return;
      }
      setShareWorkspaceProfileError(error instanceof Error ? error.message : "Failed to publish workspace profile");
    } finally {
      setShareWorkspaceProfileBusy(false);
    }
  };

  const shareWorkspaceProfileToTeam = async (templateName: string) => {
    if (shareWorkspaceProfileTeamBusy()) return;
    setShareWorkspaceProfileTeamBusy(true);
    setShareWorkspaceProfileTeamError(null);
    setShareWorkspaceProfileTeamSuccess(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const { created, orgName } = await saveWorkspaceProfileBundleToTeam({
        client,
        workspaceId,
        workspaceName: workspaceLabel(workspace),
        requestedName: templateName,
        sensitiveMode: shareWorkspaceProfileSensitiveMode(),
      });

      setShareWorkspaceProfileTeamSuccess(
        `Saved ${created.name} to ${orgName || "your team templates"}.`,
      );
    } catch (error) {
      const warnings = readWorkspaceExportWarnings(error);
      if (warnings) {
        setShareWorkspaceProfileSensitiveWarnings(warnings);
        setShareWorkspaceProfileTeamError(null);
        return;
      }
      setShareWorkspaceProfileTeamError(
        error instanceof Error ? error.message : "Failed to save team template",
      );
    } finally {
      setShareWorkspaceProfileTeamBusy(false);
    }
  };

  const publishSkillsSetLink = async () => {
    if (shareSkillsSetBusy()) return;
    setShareSkillsSetBusy(true);
    setShareSkillsSetError(null);
    setShareSkillsSetUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const result = await publishSkillsSetBundleFromWorkspace({
        client,
        workspaceId,
        workspaceName: workspaceLabel(workspace),
      });

      setShareSkillsSetUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareSkillsSetError(error instanceof Error ? error.message : "Failed to publish skills set");
    } finally {
      setShareSkillsSetBusy(false);
    }
  };

  const exportDisabledReason = createMemo(() => {
    const ws = shareWorkspace();
    if (!ws) return "Export is available for local workers in the desktop app.";
    if (ws.workspaceType === "remote") return "Export is only supported for local workers.";
    if (!isTauriRuntime()) return "Export is available in the desktop app.";
    if (props.exportWorkspaceBusy) return "Export is already running.";
    return null;
  });

  const showUpdatePill = createMemo(() => {
    if (!isTauriRuntime()) return false;
    const state = props.updateStatus?.state;
    return state === "available" || state === "downloading" || state === "ready";
  });

  const updateDownloadPercent = createMemo<number | null>(() => {
    const total = props.updateStatus?.totalBytes;
    if (total == null || total <= 0) return null;
    const downloaded = props.updateStatus?.downloadedBytes ?? 0;
    const clamped = Math.max(0, Math.min(1, downloaded / total));
    return Math.floor(clamped * 100);
  });

  const updatePillLabel = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? t("session.update_ready") : t("session.install_update");
    }
    if (state === "downloading") {
      const percent = updateDownloadPercent();
      return percent == null ? t("session.downloading") : t("session.downloading_percent", undefined, { percent });
    }
    return t("session.update_available");
  });

  const updatePillButtonTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns
        ? "text-amber-11 hover:text-amber-11 hover:bg-amber-3/30"
        : "text-green-11 hover:text-green-11 hover:bg-green-3/30";
    }
    if (state === "downloading") {
      return "text-blue-11 hover:text-blue-11 hover:bg-blue-3/30";
    }
    return "text-dls-secondary hover:text-dls-secondary hover:bg-lime-3/15";
  });

  const updatePillBorderTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "border-amber-7/35" : "border-green-7/35";
    }
    if (state === "downloading") {
      return "border-blue-7/35";
    }
    return "border-lime-8/60";
  });

  const updatePillDotTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "text-amber-10 fill-amber-10" : "text-green-10 fill-green-10";
    }
    if (state === "downloading") {
      return "text-blue-10";
    }
    return "text-lime-11 fill-lime-11";
  });

  const updatePillVersionTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "text-amber-11/75" : "text-green-11/75";
    }
    if (state === "downloading") {
      return "text-blue-11/75";
    }
    return "text-dls-secondary";
  });

  const updatePillTitle = createMemo(() => {
    const version = props.updateStatus?.version ? `v${props.updateStatus.version}` : "";
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns
        ? t("session.update_ready_stop_runs_title", undefined, { version })
        : t("session.restart_update_title", undefined, { version });
    }
    if (state === "downloading") return t("session.downloading_update_title", undefined, { version });
    return t("session.update_available_title", undefined, { version });
  });

  const handleUpdatePillClick = () => {
    const state = props.updateStatus?.state;
    if (state === "ready" && !props.anyActiveRuns) {
      props.installUpdateAndRestart();
      return;
    }
    openSettings("general");
  };

  return (
    <div class="h-[100dvh] min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] p-3 md:p-4 text-dls-text font-sans">
      <div class="flex h-full w-full gap-3 md:gap-4">
      <aside
        class="relative hidden md:flex shrink-0 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar p-2.5"
        style={{
          width: `${leftSidebarWidth()}px`,
          "min-width": `${leftSidebarWidth()}px`,
        }}
      >
        <div class="shrink-0">
          <Show when={showUpdatePill()}>
            <button
              type="button"
              class={`group relative mb-3 flex w-full items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] ${updatePillBorderTone()} ${updatePillButtonTone()}`}
              onClick={handleUpdatePillClick}
              title={updatePillTitle()}
              aria-label={updatePillTitle()}
            >
              <Show
                when={props.updateStatus?.state === "downloading"}
                fallback={
                  <ArrowDownToLine
                    size={12}
                    class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "animate-pulse" : ""}`}
                    style={props.updateStatus?.state === "available" ? { "animation-duration": "3.5s" } : undefined}
                  />
                }
              >
                <Loader2 size={13} class={`animate-spin shrink-0 ${updatePillDotTone()}`} />
              </Show>
              <span class="min-w-0 flex-1 truncate whitespace-nowrap text-left">{updatePillLabel()}</span>
              <Show when={props.updateStatus?.version}>
                {(version) => (
                  <span class={`ml-auto shrink-0 font-mono text-[10px] ${updatePillVersionTone()}`}>v{version()}</span>
                )}
              </Show>
            </button>
          </Show>
        </div>
        <div class="flex min-h-0 flex-1">
          <WorkspaceSessionList
            workspaceSessionGroups={props.workspaceSessionGroups}
            selectedWorkspaceId={props.selectedWorkspaceId}
            developerMode={props.developerMode}
            selectedSessionId={props.selectedSessionId}
            connectingWorkspaceId={props.connectingWorkspaceId}
            workspaceConnectionStateById={props.workspaceConnectionStateById}
            newTaskDisabled={props.newTaskDisabled}
            onSelectWorkspace={props.selectWorkspace}
            onOpenSession={openSessionFromList}
            onCreateTaskInWorkspace={createTaskInWorkspace}
            onOpenRenameWorkspace={props.openRenameWorkspace}
            onShareWorkspace={(workspaceId) => setShareWorkspaceId(workspaceId)}
            onRevealWorkspace={revealWorkspaceInFinder}
            onRecoverWorkspace={props.recoverWorkspace}
            onTestWorkspaceConnection={props.testWorkspaceConnection}
            onEditWorkspaceConnection={props.editWorkspaceConnection}
            onForgetWorkspace={props.forgetWorkspace}
            onOpenCreateWorkspace={props.openCreateWorkspace}
          />
        </div>
        <div
          class="absolute right-0 top-3 hidden h-[calc(100%-24px)] w-2 translate-x-1/2 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-gray-6/40 md:block"
          onPointerDown={startLeftSidebarResize}
          title={t("session.resize_workspace_column")}
          aria-label={t("session.resize_workspace_column")}
        />

      </aside>

      <main class="min-w-0 flex-1 flex flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
        <div class="flex-1 overflow-y-auto">
        <header class="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-dls-border bg-dls-surface px-4 md:px-6">
          <div class="flex min-w-0 items-center gap-3">
            <Show when={showUpdatePill()}>
              <button
                type="button"
                class={`md:hidden flex items-center gap-1.5 rounded-full border bg-dls-surface px-2.5 py-1 text-xs font-medium shadow-sm transition-colors active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] ${updatePillBorderTone()} ${updatePillButtonTone()}`}
                onClick={handleUpdatePillClick}
                title={updatePillTitle()}
                aria-label={updatePillTitle()}
              >
                <Show
                  when={props.updateStatus?.state === "downloading"}
                  fallback={
                    <ArrowDownToLine
                      size={12}
                      class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "animate-pulse" : ""}`}
                      style={props.updateStatus?.state === "available" ? { "animation-duration": "3.5s" } : undefined}
                    />
                  }
                >
                  <Loader2 size={13} class={`animate-spin shrink-0 ${updatePillDotTone()}`} />
                </Show>
                <span class="text-[11px]">{updatePillLabel()}</span>
                <Show when={props.updateStatus?.version}>
                  {(version) => (
                    <span class={`hidden sm:inline font-mono text-[10px] ${updatePillVersionTone()}`}>v{version()}</span>
                  )}
                </Show>
              </button>
            </Show>
            <h1 class="truncate text-[15px] font-semibold text-dls-text">{title()}</h1>
            <span class="hidden truncate text-[13px] text-dls-secondary lg:inline">
              {workspaceLabel(props.selectedWorkspaceDisplay)}
            </span>
            <Show when={props.developerMode}>
              <span class="hidden text-[12px] text-dls-secondary lg:inline">{props.headerStatus}</span>
            </Show>
            <Show when={props.busyHint}>
              <span class="hidden text-[12px] text-dls-secondary lg:inline">{props.busyHint}</span>
            </Show>
          </div>
          <div class="flex items-center text-gray-10">
            <button
              type="button"
              class="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
              onClick={props.toggleSettings}
              title={t("dashboard.close_settings")}
              aria-label={t("dashboard.close_settings")}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div class="w-full space-y-10 p-6 md:p-10">
          <SettingsView
                  startupPreference={props.startupPreference}
                  baseUrl={props.baseUrl}
                  headerStatus={props.headerStatus}
                  busy={props.busy}
                  clientConnected={props.clientConnected}
                  settingsTab={props.settingsTab}
                  setSettingsTab={props.setSettingsTab}
                  providers={props.providers}
                  providerConnectedIds={props.providerConnectedIds}
                  providerAuthBusy={props.providerAuthBusy}
                  cloudOrgProviders={props.cloudOrgProviders}
                  importedCloudProviders={props.importedCloudProviders}
                  openProviderAuthModal={props.openProviderAuthModal}
                  disconnectProvider={props.disconnectProvider}
                  removeCloudProvider={props.removeCloudProvider}
                  refreshCloudOrgProviders={props.refreshCloudOrgProviders}
                  connectCloudProvider={props.connectCloudProvider}
                  openworkServerStatus={props.openworkServerStatus}
                  openworkServerUrl={props.openworkServerUrl}
                  openworkServerClient={props.openworkServerClient}
                  openworkReconnectBusy={props.openworkReconnectBusy}
                  reconnectOpenworkServer={props.reconnectOpenworkServer}
                  openworkServerSettings={props.openworkServerSettings}
                  openworkServerHostInfo={props.openworkServerHostInfo}
                  openworkServerCapabilities={props.openworkServerCapabilities}
                  openworkServerDiagnostics={props.openworkServerDiagnostics}
                  updateOpenworkServerSettings={props.updateOpenworkServerSettings}
                  resetOpenworkServerSettings={props.resetOpenworkServerSettings}
                  testOpenworkServerConnection={props.testOpenworkServerConnection}
                  runtimeWorkspaceId={props.runtimeWorkspaceId}
                  selectedWorkspaceRoot={props.selectedWorkspaceRoot}
                  activeWorkspaceType={props.activeWorkspaceType}
                  openworkAuditEntries={props.openworkAuditEntries}
                  openworkAuditStatus={props.openworkAuditStatus}
                  openworkAuditError={props.openworkAuditError}
                  opencodeConnectStatus={props.opencodeConnectStatus}
                  engineInfo={props.engineInfo}
                  orchestratorStatus={props.orchestratorStatus}
                  opencodeRouterInfo={props.opencodeRouterInfo}
                  engineDoctorVersion={props.engineDoctorVersion}
                  developerMode={props.developerMode}
                  toggleDeveloperMode={props.toggleDeveloperMode}
                  stopHost={props.stopHost}
                  restartLocalServer={props.restartLocalServer}
                  engineSource={props.engineSource}
                  setEngineSource={props.setEngineSource}
                  engineCustomBinPath={props.engineCustomBinPath}
                  setEngineCustomBinPath={props.setEngineCustomBinPath}
                  engineRuntime={props.engineRuntime}
                  setEngineRuntime={props.setEngineRuntime}
                  opencodeEnableExa={props.opencodeEnableExa}
                  toggleOpencodeEnableExa={props.toggleOpencodeEnableExa}
                  isWindows={props.isWindows}
                  hideTitlebar={props.hideTitlebar}
                  toggleHideTitlebar={props.toggleHideTitlebar}
                  language={props.language}
                  setLanguage={props.setLanguage}
                  updateAutoCheck={props.updateAutoCheck}
                  toggleUpdateAutoCheck={props.toggleUpdateAutoCheck}
                  updateAutoDownload={props.updateAutoDownload}
                  toggleUpdateAutoDownload={props.toggleUpdateAutoDownload}
                  themeMode={props.themeMode}
                  setThemeMode={props.setThemeMode}
                  updateStatus={props.updateStatus}
                  updateEnv={props.updateEnv}
                  appVersion={props.appVersion}
                  checkForUpdates={props.checkForUpdates}
                  downloadUpdate={props.downloadUpdate}
                  installUpdateAndRestart={props.installUpdateAndRestart}
                  anyActiveRuns={props.anyActiveRuns}
                  onResetStartupPreference={props.onResetStartupPreference}
                  openResetModal={props.openResetModal}
                  resetModalBusy={props.resetModalBusy}
                  pendingPermissions={props.pendingPermissions}
                  events={props.events}
                  workspaceDebugEvents={props.workspaceDebugEvents}
                  sandboxCreateProgress={props.sandboxCreateProgress}
                  sandboxCreateProgressLast={props.sandboxCreateProgressLast}
                  clearWorkspaceDebugEvents={props.clearWorkspaceDebugEvents}
                  safeStringify={props.safeStringify}
                  repairOpencodeCache={props.repairOpencodeCache}
                  cacheRepairBusy={props.cacheRepairBusy}
                  cacheRepairResult={props.cacheRepairResult}
                  cleanupOpenworkDockerContainers={props.cleanupOpenworkDockerContainers}
                  dockerCleanupBusy={props.dockerCleanupBusy}
                  dockerCleanupResult={props.dockerCleanupResult}
                   markOpencodeConfigReloadRequired={props.markOpencodeConfigReloadRequired}
                   resetAppConfigDefaults={props.resetAppConfigDefaults}
                   openDebugDeepLink={props.openDebugDeepLink}
                   newTaskDisabled={props.newTaskDisabled}
                   schedulerPluginInstalled={props.schedulerPluginInstalled}
                   skillsAccessHint={props.skillsAccessHint}
                   canInstallSkillCreator={props.canInstallSkillCreator}
                   canUseDesktopTools={props.canUseDesktopTools}
                   pluginsAccessHint={props.pluginsAccessHint}
                   canEditPlugins={props.canEditPlugins}
                   canUseGlobalPluginScope={props.canUseGlobalPluginScope}
                    suggestedPlugins={props.suggestedPlugins}
                    addPlugin={props.addPlugin}
                    createSessionAndOpen={props.createSessionAndOpen}
                    canReloadWorkspace={props.canReloadWorkspace}
                    reloadWorkspaceEngine={props.reloadWorkspaceEngine}
                   reloadBusy={props.reloadBusy}
                   reloadError={props.reloadError}
                    connectRemoteWorkspace={props.connectRemoteWorkspace}
                     openTeamBundle={props.openTeamBundle}
                />
        </div>

        <Show when={props.error}>
          <div class="mx-auto max-w-5xl px-6 md:px-10 pb-24 md:pb-10">
            <div class="rounded-2xl bg-red-1/40 px-5 py-4 text-sm text-red-12 border border-red-7/20 space-y-3">
              <div>{props.error}</div>
              <Show when={props.developerMode}>
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.repairOpencodeCache}
                    disabled={props.cacheRepairBusy || !props.developerMode}
                  >
                    {props.cacheRepairBusy ? t("dashboard.repairing_cache") : t("dashboard.repair_cache")}
                  </Button>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    {t("common.retry")}
                  </Button>
                  <Show when={props.cacheRepairResult}>
                    <span class="text-xs text-red-12/80">
                      {props.cacheRepairResult}
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        <ProviderAuthModal
          open={props.providerAuthModalOpen}
          loading={props.providerAuthBusy}
          submitting={providerAuthActionBusy()}
          error={props.providerAuthError}
          preferredProviderId={props.providerAuthPreferredProviderId}
          workerType={props.providerAuthWorkerType}
          providers={props.providerAuthProviders}
          connectedProviderIds={props.providerConnectedIds}
          authMethods={props.providerAuthMethods}
          onSelect={handleProviderAuthSelect}
          onSubmitApiKey={handleProviderAuthApiKey}
          onConnectCloudProvider={handleCloudProviderConnect}
          onSubmitOAuth={handleProviderAuthOAuth}
          onRefreshProviders={props.refreshProviders}
          onClose={() => props.closeProviderAuthModal()}
        />

        <ShareWorkspaceModal
          open={Boolean(shareWorkspaceId())}
          onClose={() => setShareWorkspaceId(null)}
          workspaceName={shareWorkspaceName()}
          workspaceDetail={shareWorkspaceDetail()}
          fields={shareFields()}
          remoteAccess={shareWorkspace()?.workspaceType === "local"
            ? {
                enabled: props.openworkServerHostInfo?.remoteAccessEnabled === true,
                busy: props.shareRemoteAccessBusy,
                error: props.shareRemoteAccessError,
                onSave: props.saveShareRemoteAccess,
              }
            : undefined}
          note={shareNote()}
          onShareWorkspaceProfile={publishWorkspaceProfileLink}
          shareWorkspaceProfileBusy={shareWorkspaceProfileBusy()}
          shareWorkspaceProfileUrl={shareWorkspaceProfileUrl()}
          shareWorkspaceProfileError={shareWorkspaceProfileError()}
          shareWorkspaceProfileDisabledReason={shareServiceDisabledReason()}
          shareWorkspaceProfileSensitiveWarnings={shareWorkspaceProfileSensitiveWarnings()}
          shareWorkspaceProfileSensitiveMode={shareWorkspaceProfileSensitiveMode()}
          onShareWorkspaceProfileSensitiveModeChange={setShareWorkspaceProfileSensitiveMode}
          onShareWorkspaceProfileToTeam={shareWorkspaceProfileToTeam}
          shareWorkspaceProfileToTeamBusy={shareWorkspaceProfileTeamBusy()}
          shareWorkspaceProfileToTeamError={shareWorkspaceProfileTeamError()}
          shareWorkspaceProfileToTeamSuccess={shareWorkspaceProfileTeamSuccess()}
          shareWorkspaceProfileToTeamDisabledReason={shareWorkspaceProfileTeamDisabledReason()}
          shareWorkspaceProfileToTeamOrgName={shareWorkspaceProfileTeamOrgName()}
          shareWorkspaceProfileToTeamNeedsSignIn={shareWorkspaceProfileToTeamNeedsSignIn()}
          onShareWorkspaceProfileToTeamSignIn={startShareWorkspaceProfileToTeamSignIn}
          templateContentSummary={{
            skillNames: extensions.skills().map((s) => s.name),
            commandNames: [],
            configFiles: ["opencode.json", "openwork.json"],
          }}
          onShareSkillsSet={publishSkillsSetLink}
          shareSkillsSetBusy={shareSkillsSetBusy()}
          shareSkillsSetUrl={shareSkillsSetUrl()}
          shareSkillsSetError={shareSkillsSetError()}
          shareSkillsSetDisabledReason={shareServiceDisabledReason()}
          onExportConfig={
            exportDisabledReason()
              ? undefined
              : () => {
                const id = shareWorkspaceId();
                if (!id) return;
                props.exportWorkspaceConfig(id);
              }
          }
          exportDisabledReason={exportDisabledReason()}
          onOpenBots={openAdvanced}
        />
        </div>

        <StatusBar
          clientConnected={props.clientConnected}
          openworkServerStatus={props.openworkServerStatus}
          developerMode={props.developerMode}
          settingsOpen={true}
          showSettingsButton={true}
          onSendFeedback={openFeedback}
          onOpenSettings={props.toggleSettings}
          providerConnectedIds={props.providerConnectedIds}
        />
      </main>
      </div>

    </div>
  );
}

function readWorkspaceExportWarnings(error: unknown): OpenworkWorkspaceExportWarning[] | null {
  if (!(error instanceof OpenworkServerError) || error.code !== "workspace_export_requires_decision") {
    return null;
  }
  const warnings = Array.isArray((error.details as { warnings?: unknown } | undefined)?.warnings)
    ? (error.details as { warnings: unknown[] }).warnings
    : [];
  const normalized = warnings
    .map((warning) => {
      if (!warning || typeof warning !== "object") return null;
      const record = warning as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const detail = typeof record.detail === "string" ? record.detail.trim() : "";
      if (!id || !label || !detail) return null;
      return { id, label, detail } satisfies OpenworkWorkspaceExportWarning;
    })
    .filter((warning): warning is OpenworkWorkspaceExportWarning => Boolean(warning));
  return normalized.length ? normalized : null;
}
