import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type {
  DashboardTab,
  McpServerEntry,
  McpStatusMap,
  OpencodeConnectStatus,
  PluginScope,
  ProviderListItem,
  SettingsTab,
  ScheduledJob,
  HubSkillCard,
  HubSkillRepo,
  SkillCard,
  StartupPreference,
  View,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../types";
import type { McpDirectoryInfo } from "../constants";
import {
  formatRelativeTime,
  getWorkspaceTaskLoadErrorDisplay,
  isTauriRuntime,
  isWindowsPlatform,
  normalizeDirectoryPath,
} from "../utils";
import { useAuthorizedFolders } from "../hooks/use-authorized-folders";
import { useScheduledJobs } from "../hooks/use-scheduled-jobs";
import { useWorkspaceMaintenance } from "../hooks/use-workspace-maintenance";
import { useExtensions } from "../context/extensions-context";
import { useOpenworkServer } from "../context/openwork-server-context";
import { usePlatform } from "../context/platform";
import { useProviderAuth } from "../context/provider-auth-context";
import { useWorkspaceActions } from "../context/workspace-actions-context";
import { buildFeedbackUrl } from "../lib/feedback";
import { buildDenAuthUrl, createDenClient, readDenSettings, writeDenSettings } from "../lib/den";
import { getOpenWorkDeployment } from "../lib/openwork-deployment";
import { createWorkspaceShellLayout } from "../lib/workspace-shell-layout";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  parseOpenworkWorkspaceIdFromUrl,
} from "../lib/openwork-server";
import type {
  OpenworkAuditEntry,
  OpenworkServerClient,
  OpenworkServerCapabilities,
  OpenworkServerDiagnostics,
  OpenworkWorkspaceExport,
  OpenworkServerSettings,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import type { EngineInfo, OrchestratorStatus, OpenworkServerInfo, OpenCodeRouterInfo, WorkspaceInfo } from "../lib/tauri";
import { DEFAULT_OPENWORK_PUBLISHER_BASE_URL } from "../lib/publisher";

import Button from "../components/button";
import ConfigView from "./config";
import SettingsView from "./settings";
import StatusBar from "../components/status-bar";
import ProviderAuthModal, {
  type ProviderAuthMethod,
  type ProviderOAuthStartResult,
} from "../components/provider-auth-modal";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import WorkspaceToolsPanel from "./workspace-tools-panel";
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

export type DashboardViewProps = {
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
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
  activeWorkspaceType: "local" | "remote";
  opencodeConnectStatus: OpencodeConnectStatus | null;
  engineInfo: EngineInfo | null;
  engineDoctorVersion: string | null;
  orchestratorStatus: OrchestratorStatus | null;
  opencodeRouterInfo: OpenCodeRouterInfo | null;
  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  resetOpenworkServerSettings: () => void;
  testOpenworkServerConnection: (next: OpenworkServerSettings) => Promise<boolean>;
  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;
  workspaceAutoReloadAvailable: boolean;
  workspaceAutoReloadEnabled: boolean;
  setWorkspaceAutoReloadEnabled: (value: boolean) => void | Promise<void>;
  workspaceAutoReloadResumeEnabled: boolean;
  setWorkspaceAutoReloadResumeEnabled: (value: boolean) => void | Promise<void>;
  selectedWorkspaceDisplay: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  switchWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  selectedSessionId: string | null;
  openRenameWorkspace: (workspaceId: string) => void;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  refreshMcpServers: () => void;
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  setSelectedMcp: (value: string | null) => void;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  createSessionAndOpen: () => void;
  setPrompt: (value: string) => void;
  selectSession: (sessionId: string) => Promise<void> | void;
  defaultModelLabel: string;
  defaultModelRef: string;
  openDefaultModelPicker: () => void;
  showThinking: boolean;
  toggleShowThinking: () => void;
  autoCompactContext: boolean;
  toggleAutoCompactContext: () => void;
  autoCompactContextBusy: boolean;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
  opencodeEnableExa: boolean;
  toggleOpencodeEnableExa: () => void;
  modelVariantLabel: string;
  editModelVariant: () => void;
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
  resetAppConfigDefaults: () => Promise<{ ok: boolean; message: string }>;
  openDebugDeepLink: (rawUrl: string) => Promise<{ ok: boolean; message: string }>;
};

type SharedSkillItem = {
  name: string;
  description?: string;
  content: string;
  trigger?: string;
};

type WorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description: string;
  workspace: OpenworkWorkspaceExport;
};

type SkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description: string;
  skills: SharedSkillItem[];
  sourceWorkspace?: {
    id?: string;
    name?: string;
  };
};

export default function DashboardView(props: DashboardViewProps) {
  const platform = usePlatform();
  const authorizedFolders = useAuthorizedFolders();
  const extensions = useExtensions();
  const openworkServer = useOpenworkServer();
  const providerAuth = useProviderAuth();
  const scheduledJobs = useScheduledJobs();
  const workspaceMaintenance = useWorkspaceMaintenance();
  const workspaceActions = useWorkspaceActions();
  const openworkServerStatus = openworkServer.openworkServerStatus;
  const openworkServerUrl = openworkServer.openworkServerUrl;
  const openworkServerClient = openworkServer.openworkServerClient;
  const openworkReconnectBusy = openworkServer.openworkReconnectBusy;
  const reconnectOpenworkServer = openworkServer.reconnectOpenworkServer;
  const openworkServerSettings = openworkServer.openworkServerSettings;
  const openworkServerHostInfo = openworkServer.openworkServerHostInfo;
  const openworkServerCapabilities = openworkServer.openworkServerCapabilities;
  const openworkServerDiagnostics = openworkServer.openworkServerDiagnostics;
  const runtimeWorkspaceId = openworkServer.runtimeWorkspaceId;
  const openworkAuditEntries = openworkServer.openworkAuditEntries;
  const openworkAuditStatus = openworkServer.openworkAuditStatus;
  const openworkAuditError = openworkServer.openworkAuditError;
  const shareRemoteAccessBusy = openworkServer.shareRemoteAccessBusy;
  const shareRemoteAccessError = openworkServer.shareRemoteAccessError;
  const saveShareRemoteAccess = openworkServer.saveShareRemoteAccess;
  const providers = providerAuth.providers;
  const providerConnectedIds = providerAuth.providerConnectedIds;
  const providerAuthBusy = providerAuth.providerAuthBusy;
  const providerAuthModalOpen = providerAuth.providerAuthModalOpen;
  const providerAuthError = providerAuth.providerAuthError;
  const providerAuthMethods = providerAuth.providerAuthMethods;
  const providerAuthPreferredProviderId = providerAuth.providerAuthPreferredProviderId;
  const providerAuthWorkerType = providerAuth.providerAuthWorkerType;
  const openProviderAuthModal = providerAuth.openProviderAuthModal;
  const disconnectProvider = providerAuth.disconnectProvider;
  const closeProviderAuthModal = providerAuth.closeProviderAuthModal;
  const startProviderAuth = providerAuth.startProviderAuth;
  const completeProviderAuthOAuth = providerAuth.completeProviderAuthOAuth;
  const submitProviderApiKey = providerAuth.submitProviderApiKey;
  const refreshProviders = providerAuth.refreshProviders;
  const webDeployment = createMemo(() => getOpenWorkDeployment() === "web");
  const title = createMemo(() => {
    switch (props.tab) {
      case "scheduled":
        return "Automations";
      case "skills":
        return "Skills";
      case "plugins":
        return "Extensions";
      case "mcp":
        return "Extensions";
      case "identities":
        return "Messaging";
      case "config":
        return "Advanced";
      case "settings":
        return "Settings";
      default:
        return "Automations";
    }
  });

  const workspaceLabel = (workspace: WorkspaceInfo) =>
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    "Workspace";
  const workspaceKindLabel = (workspace: WorkspaceInfo) =>
    workspace.workspaceType === "remote"
      ? workspace.sandboxBackend === "docker" ||
        Boolean(workspace.sandboxRunId?.trim()) ||
        Boolean(workspace.sandboxContainerName?.trim())
        ? "Sandbox"
        : "Remote"
      : "Local";

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
      const ready = await Promise.resolve(props.switchWorkspace(id));
      if (!ready) return;
      props.createSessionAndOpen();
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
      entrypoint: "dashboard-status-bar",
      deployment: getOpenWorkDeployment(),
      appVersion: props.appVersion,
      openworkServerVersion: openworkServerDiagnostics()?.version ?? null,
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
      throw new Error("Provider auth is already in progress.");
    }
    setProviderAuthActionBusy(true);
    try {
      return await startProviderAuth(providerId, methodIndex);
    } finally {
      setProviderAuthActionBusy(false);
    }
  };

  const handleProviderAuthOAuth = async (providerId: string, methodIndex: number, code?: string) => {
    if (providerAuthActionBusy()) return { connected: false, pending: true };
    setProviderAuthActionBusy(true);
    try {
      const result = await completeProviderAuthOAuth(providerId, methodIndex, code);
      if (result.connected) {
        closeProviderAuthModal();
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
      await submitProviderApiKey(providerId, apiKey);
      closeProviderAuthModal();
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
    const currentTab = props.tab;

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
        if ((currentTab === "plugins" || currentTab === "mcp") && !cancelled) {
          await Promise.all([extensions.refreshPlugins(), props.refreshMcpServers()]);
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
    props.setTab("settings");
  };

  const openConfig = () => {
    props.setTab(props.developerMode ? "config" : "identities");
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

  createEffect(() => {
    if (props.developerMode) return;
    if (props.tab !== "config") return;
    props.setTab("identities");
  });

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

  const [shareLocalOpenworkWorkspaceId, setShareLocalOpenworkWorkspaceId] = createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] = createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<string | null>(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] = createSignal<string | null>(null);
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
    const baseUrl = openworkServerHostInfo()?.baseUrl?.trim() ?? "";
    const token =
      openworkServerHostInfo()?.ownerToken?.trim() ||
      openworkServerHostInfo()?.clientToken?.trim() ||
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
      if (openworkServerHostInfo()?.remoteAccessEnabled !== true) {
        return [];
      }
      const hostUrl =
        openworkServerHostInfo()?.connectUrl?.trim() ||
        openworkServerHostInfo()?.lanUrl?.trim() ||
        openworkServerHostInfo()?.mdnsUrl?.trim() ||
        openworkServerHostInfo()?.baseUrl?.trim() ||
        "";
      const mountedUrl = shareLocalOpenworkWorkspaceId()
        ? buildOpenworkWorkspaceBaseUrl(hostUrl, shareLocalOpenworkWorkspaceId())
        : null;
      const url = mountedUrl || hostUrl;
      const ownerToken = openworkServerHostInfo()?.ownerToken?.trim() || "";
      const collaboratorToken = openworkServerHostInfo()?.clientToken?.trim() || "";
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
        openworkServerSettings().token?.trim() ||
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
      const baseUrl = openworkServerHostInfo()?.baseUrl?.trim() ?? "";
      const token =
        openworkServerHostInfo()?.ownerToken?.trim() ||
        openworkServerHostInfo()?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        return "Local OpenWork host is not ready yet.";
      }
    } else {
      const hostUrl = ws.openworkHostUrl?.trim() || ws.baseUrl?.trim() || "";
      const token = ws.openworkToken?.trim() || openworkServerSettings().token?.trim() || "";
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
      const baseUrl = openworkServerHostInfo()?.baseUrl?.trim() ?? "";
      const token =
        openworkServerHostInfo()?.ownerToken?.trim() ||
        openworkServerHostInfo()?.clientToken?.trim() ||
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
    const token = ws.openworkToken?.trim() || openworkServerSettings().token?.trim() || "";
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
      const exported = await client.exportWorkspace(workspaceId);
      const payload: WorkspaceProfileBundleV1 = {
        schemaVersion: 1,
        type: "workspace-profile",
        name: `${workspaceLabel(workspace)} template`,
        description: "Full OpenWork workspace template with config, commands, skills, and extra .opencode files.",
        workspace: exported,
      };

      const result = await client.publishBundle(payload, "workspace-profile", {
        name: payload.name,
        baseUrl: DEFAULT_OPENWORK_PUBLISHER_BASE_URL,
      });

      setShareWorkspaceProfileUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
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
      const exported = await client.exportWorkspace(workspaceId);
      const fallbackName = `${workspaceLabel(workspace)} template`;
      const name = templateName.trim() || fallbackName;
      const payload: WorkspaceProfileBundleV1 = {
        schemaVersion: 1,
        type: "workspace-profile",
        name,
        description: "Full OpenWork workspace template with config, commands, skills, and extra .opencode files.",
        workspace: exported,
      };

      const settings = readDenSettings();
      const token = settings.authToken?.trim() ?? "";
      if (!token) {
        throw new Error("Sign in to OpenWork Cloud in Settings to share with your team.");
      }

      const cloudClient = createDenClient({ baseUrl: settings.baseUrl, token });
      let orgId = settings.activeOrgId?.trim() ?? "";
      let orgSlug = settings.activeOrgSlug?.trim() ?? "";
      let orgName = settings.activeOrgName?.trim() ?? "";

      if (!orgSlug || !orgName) {
        const response = await cloudClient.listOrgs();
        const match = orgId
          ? response.orgs.find((org) => org.id === orgId)
          : response.orgs.find((org) => org.slug === orgSlug) ?? response.orgs[0];
        if (!match) {
          throw new Error("Choose an organization in Settings -> Cloud before sharing with your team.");
        }
        orgId = match.id;
        orgSlug = match.slug;
        orgName = match.name;
        writeDenSettings({
          ...settings,
          baseUrl: settings.baseUrl,
          authToken: token,
          activeOrgId: orgId,
          activeOrgSlug: orgSlug,
          activeOrgName: orgName,
        });
      }

      const created = await cloudClient.createTemplate(orgSlug, {
        name,
        templateData: payload,
      });

      setShareWorkspaceProfileTeamSuccess(
        `Saved ${created.name} to ${orgName || "your team templates"}.`,
      );
    } catch (error) {
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
      const exported = await client.exportWorkspace(workspaceId);
      const skills = Array.isArray(exported.skills) ? exported.skills : [];
      if (!skills.length) {
        throw new Error("No skills found in this workspace.");
      }

      const payload: SkillsSetBundleV1 = {
        schemaVersion: 1,
        type: "skills-set",
        name: `${workspaceLabel(workspace)} skills`,
        description: "Complete skills set from an OpenWork workspace.",
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
        sourceWorkspace: {
          id: workspaceId,
          name: workspaceLabel(workspace),
        },
      };

      const result = await client.publishBundle(payload, "skills-set", {
        name: payload.name,
        baseUrl: DEFAULT_OPENWORK_PUBLISHER_BASE_URL,
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
    if (workspaceActions.exportWorkspaceBusy()) return "Export is already running.";
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
      return props.anyActiveRuns ? "Update ready" : "Install update";
    }
    if (state === "downloading") {
      const percent = updateDownloadPercent();
      return percent == null ? "Downloading" : `Downloading ${percent}%`;
    }
    return "Update available";
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
        ? `Update ready ${version}. Stop active runs to restart.`
        : `Restart to apply update ${version}`;
    }
    if (state === "downloading") return `Downloading update ${version}`;
    return `Update available ${version}`;
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
            onSelectWorkspace={props.switchWorkspace}
            onOpenSession={openSessionFromList}
            onCreateTaskInWorkspace={createTaskInWorkspace}
            onOpenRenameWorkspace={props.openRenameWorkspace}
            onShareWorkspace={(workspaceId) => setShareWorkspaceId(workspaceId)}
            onRevealWorkspace={revealWorkspaceInFinder}
            onRecoverWorkspace={props.recoverWorkspace}
            onTestWorkspaceConnection={props.testWorkspaceConnection}
            onEditWorkspaceConnection={props.editWorkspaceConnection}
            onForgetWorkspace={props.forgetWorkspace}
          />
        </div>
        <div
          class="absolute right-0 top-3 hidden h-[calc(100%-24px)] w-2 translate-x-1/2 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-gray-6/40 md:block"
          onPointerDown={startLeftSidebarResize}
          title="Resize workspace column"
          aria-label="Resize workspace column"
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
            <Show when={props.tab === "settings"}>
              <span class="hidden truncate text-[13px] text-dls-secondary lg:inline">
                {workspaceLabel(props.selectedWorkspaceDisplay)}
              </span>
            </Show>
            <Show when={props.developerMode}>
              <span class="hidden text-[12px] text-dls-secondary lg:inline">{props.headerStatus}</span>
            </Show>
            <Show when={props.busyHint}>
              <span class="hidden text-[12px] text-dls-secondary lg:inline">{props.busyHint}</span>
            </Show>
          </div>
          <div class="flex items-center text-gray-10">
            <Show when={props.tab === "settings"}>
              <button
                type="button"
                class="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text"
                onClick={props.toggleSettings}
                title="Close settings"
                aria-label="Close settings"
              >
                <X size={18} />
              </button>
            </Show>
          </div>
        </header>

        <div class={props.tab === "settings" ? "w-full space-y-10 p-6 md:p-10" : "mx-auto w-full max-w-[1100px] space-y-10 p-6 md:p-10"}>
          <Switch>
            <Match when={props.tab === "scheduled"}>
              <WorkspaceToolsPanel
                section="scheduled"
                scheduled={{
                  jobs: scheduledJobs.scheduledJobs(),
                  source: scheduledJobs.scheduledJobsSource(),
                  status: scheduledJobs.scheduledJobsStatus(),
                  busy: scheduledJobs.scheduledJobsBusy(),
                  lastUpdatedAt: scheduledJobs.scheduledJobsUpdatedAt(),
                  refreshJobs: scheduledJobs.refreshScheduledJobs,
                  deleteJob: scheduledJobs.deleteScheduledJob,
                  selectedWorkspaceRoot: props.selectedWorkspaceRoot,
                  createSessionAndOpen: props.createSessionAndOpen,
                  setPrompt: props.setPrompt,
                  newTaskDisabled: props.newTaskDisabled,
                  schedulerInstalled: scheduledJobs.schedulerPluginInstalled(),
                  canEditPlugins: extensions.canEditPlugins(),
                  addPlugin: extensions.addPlugin,
                  reloadWorkspaceEngine: props.reloadWorkspaceEngine,
                  reloadBusy: props.reloadBusy,
                  canReloadWorkspace: props.canReloadWorkspace,
                }}
              />
            </Match>
            <Match when={props.tab === "skills"}>
              <WorkspaceToolsPanel
                section="skills"
                skills={{
                  workspaceName: props.selectedWorkspaceDisplay.name,
                  busy: props.busy,
                  canInstallSkillCreator: extensions.canInstallSkillCreator(),
                  canUseDesktopTools: extensions.canUseDesktopTools(),
                  accessHint: extensions.skillsAccessHint(),
                  refreshSkills: extensions.refreshSkills,
                  refreshHubSkills: extensions.refreshHubSkills,
                  ensureHubSkillsFresh: extensions.ensureHubSkillsFresh,
                  skills: extensions.skills(),
                  skillsStatus: extensions.skillsStatus(),
                  hubSkills: extensions.hubSkills(),
                  hubSkillsStatus: extensions.hubSkillsStatus(),
                  hubRepo: extensions.hubRepo(),
                  hubRepos: extensions.hubRepos(),
                  importLocalSkill: extensions.importLocalSkill,
                  installSkillCreator: extensions.installSkillCreator,
                  installHubSkill: extensions.installHubSkill,
                  setHubRepo: extensions.setHubRepo,
                  addHubRepo: extensions.addHubRepo,
                  removeHubRepo: extensions.removeHubRepo,
                  revealSkillsFolder: extensions.revealSkillsFolder,
                  uninstallSkill: extensions.uninstallSkill,
                  readSkill: extensions.readSkill,
                  saveSkill: extensions.saveSkill,
                  createSessionAndOpen: props.createSessionAndOpen,
                  setPrompt: props.setPrompt,
                }}
              />
            </Match>

            <Match when={props.tab === "plugins" || props.tab === "mcp"}>
              <WorkspaceToolsPanel
                section="extensions"
                extensions={{
                  initialSection: props.tab === "plugins" ? "plugins" : "mcp",
                  setDashboardTab: props.setTab,
                  busy: props.busy,
                  selectedWorkspaceRoot: props.selectedWorkspaceRoot,
                  isRemoteWorkspace: props.isRemoteWorkspace,
                  refreshMcpServers: props.refreshMcpServers,
                  mcpServers: props.mcpServers,
                  mcpStatus: props.mcpStatus,
                  mcpLastUpdatedAt: props.mcpLastUpdatedAt,
                  mcpStatuses: props.mcpStatuses,
                  mcpConnectingName: props.mcpConnectingName,
                  selectedMcp: props.selectedMcp,
                  setSelectedMcp: props.setSelectedMcp,
                  quickConnect: props.quickConnect,
                  connectMcp: props.connectMcp,
                  authorizeMcp: props.authorizeMcp,
                  logoutMcpAuth: props.logoutMcpAuth,
                  removeMcp: props.removeMcp,
                  canEditPlugins: extensions.canEditPlugins(),
                  canUseGlobalScope: extensions.canUseGlobalPluginScope(),
                  accessHint: extensions.pluginsAccessHint(),
                  pluginScope: extensions.pluginScope(),
                  setPluginScope: extensions.setPluginScope,
                  pluginConfigPath: extensions.pluginConfigPath(),
                  pluginList: extensions.pluginList(),
                  pluginInput: extensions.pluginInput(),
                  setPluginInput: extensions.setPluginInput,
                  pluginStatus: extensions.pluginStatus(),
                  activePluginGuide: extensions.activePluginGuide(),
                  setActivePluginGuide: extensions.setActivePluginGuide,
                  isPluginInstalled: extensions.isPluginInstalled,
                  suggestedPlugins: extensions.suggestedPlugins,
                  refreshPlugins: extensions.refreshPlugins,
                  addPlugin: extensions.addPlugin,
                  removePlugin: extensions.removePlugin,
                }}
              />
            </Match>

            <Match when={props.tab === "identities"}>
              <WorkspaceToolsPanel
                section="identities"
                identities={{
                  busy: props.busy,
                  openworkServerStatus: openworkServerStatus(),
                  openworkServerUrl: openworkServerUrl(),
                  openworkServerClient: openworkServerClient(),
                  openworkReconnectBusy: openworkReconnectBusy(),
                  reconnectOpenworkServer,
                  restartLocalServer: props.restartLocalServer,
                  runtimeWorkspaceId: runtimeWorkspaceId(),
                  selectedWorkspaceRoot: props.selectedWorkspaceRoot,
                  developerMode: props.developerMode,
                }}
              />
            </Match>

            <Match when={props.tab === "config" && props.developerMode}>
              <ConfigView
                busy={props.busy}
                clientConnected={props.clientConnected}
                anyActiveRuns={props.anyActiveRuns}
                openworkServerStatus={openworkServerStatus()}
                openworkServerUrl={openworkServerUrl()}
                openworkServerSettings={openworkServerSettings()}
                openworkServerHostInfo={openworkServerHostInfo()}
                runtimeWorkspaceId={runtimeWorkspaceId()}
                updateOpenworkServerSettings={props.updateOpenworkServerSettings}
                resetOpenworkServerSettings={props.resetOpenworkServerSettings}
                testOpenworkServerConnection={props.testOpenworkServerConnection}
                canReloadWorkspace={props.canReloadWorkspace}
                reloadWorkspaceEngine={props.reloadWorkspaceEngine}
                reloadBusy={props.reloadBusy}
                reloadError={props.reloadError}
                workspaceAutoReloadAvailable={props.workspaceAutoReloadAvailable}
                workspaceAutoReloadEnabled={props.workspaceAutoReloadEnabled}
                setWorkspaceAutoReloadEnabled={props.setWorkspaceAutoReloadEnabled}
                workspaceAutoReloadResumeEnabled={props.workspaceAutoReloadResumeEnabled}
                setWorkspaceAutoReloadResumeEnabled={props.setWorkspaceAutoReloadResumeEnabled}
                developerMode={props.developerMode}
              />
            </Match>

            <Match when={props.tab === "settings"}>
              <SettingsView
                  startupPreference={props.startupPreference}
                  baseUrl={props.baseUrl}
                  headerStatus={props.headerStatus}
                  busy={props.busy}
                  clientConnected={props.clientConnected}
                  settingsTab={props.settingsTab}
                  setSettingsTab={props.setSettingsTab}
                  providers={providers()}
                  providerConnectedIds={providerConnectedIds()}
                  providerAuthBusy={providerAuthBusy()}
                  openProviderAuthModal={openProviderAuthModal}
                  disconnectProvider={disconnectProvider}
                  openworkServerStatus={openworkServerStatus()}
                  openworkServerUrl={openworkServerUrl()}
                  openworkServerClient={openworkServerClient()}
                  openworkReconnectBusy={openworkReconnectBusy()}
                  reconnectOpenworkServer={reconnectOpenworkServer}
                  openworkServerSettings={openworkServerSettings()}
                  openworkServerHostInfo={openworkServerHostInfo()}
                  openworkServerCapabilities={openworkServerCapabilities()}
                  openworkServerDiagnostics={openworkServerDiagnostics()}
                  runtimeWorkspaceId={runtimeWorkspaceId()}
                  selectedWorkspaceRoot={props.selectedWorkspaceRoot}
                  activeWorkspaceType={props.activeWorkspaceType}
                  openworkAuditEntries={openworkAuditEntries()}
                  openworkAuditStatus={openworkAuditStatus()}
                  openworkAuditError={openworkAuditError()}
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
                  defaultModelLabel={props.defaultModelLabel}
                  defaultModelRef={props.defaultModelRef}
                  openDefaultModelPicker={props.openDefaultModelPicker}
                  showThinking={props.showThinking}
                  toggleShowThinking={props.toggleShowThinking}
                  autoCompactContext={props.autoCompactContext}
                  toggleAutoCompactContext={props.toggleAutoCompactContext}
                  autoCompactContextBusy={props.autoCompactContextBusy}
                  hideTitlebar={props.hideTitlebar}
                  toggleHideTitlebar={props.toggleHideTitlebar}
                  modelVariantLabel={props.modelVariantLabel}
                  editModelVariant={props.editModelVariant}
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
                  repairOpencodeMigration={workspaceMaintenance.repairOpencodeMigration}
                  migrationRepairBusy={workspaceMaintenance.migrationRepairBusy()}
                  migrationRepairResult={workspaceMaintenance.migrationRepairResult()}
                  migrationRepairAvailable={workspaceMaintenance.migrationRepairAvailable()}
                  migrationRepairUnavailableReason={workspaceMaintenance.migrationRepairUnavailableReason()}
                  repairOpencodeCache={workspaceMaintenance.repairOpencodeCache}
                  cacheRepairBusy={workspaceMaintenance.cacheRepairBusy()}
                  cacheRepairResult={workspaceMaintenance.cacheRepairResult()}
                  cleanupOpenworkDockerContainers={workspaceMaintenance.cleanupOpenworkDockerContainers}
                  dockerCleanupBusy={workspaceMaintenance.dockerCleanupBusy()}
                  dockerCleanupResult={workspaceMaintenance.dockerCleanupResult()}
                  authorizedFolders={authorizedFolders.authorizedFolders()}
                  authorizedFolderDraft={authorizedFolders.authorizedFolderDraft()}
                  setAuthorizedFolderDraft={authorizedFolders.setAuthorizedFolderDraft}
                  authorizedFoldersLoading={authorizedFolders.authorizedFoldersLoading()}
                  authorizedFoldersSaving={authorizedFolders.authorizedFoldersSaving()}
                  authorizedFoldersError={authorizedFolders.authorizedFoldersError()}
                  authorizedFoldersStatus={authorizedFolders.authorizedFoldersStatus()}
                  authorizedFoldersAvailable={authorizedFolders.authorizedFoldersAvailable()}
                  authorizedFoldersEditable={authorizedFolders.authorizedFoldersEditable()}
                  authorizedFoldersHint={authorizedFolders.authorizedFoldersHint()}
                  addAuthorizedFolder={authorizedFolders.addAuthorizedFolder}
                  pickAuthorizedFolder={authorizedFolders.pickAuthorizedFolder}
                  removeAuthorizedFolder={authorizedFolders.removeAuthorizedFolder}
                  resetAppConfigDefaults={props.resetAppConfigDefaults}
                  openDebugDeepLink={props.openDebugDeepLink}
                  scheduledJobs={scheduledJobs.scheduledJobs()}
                  scheduledJobsSource={scheduledJobs.scheduledJobsSource()}
                  scheduledJobsStatus={scheduledJobs.scheduledJobsStatus()}
                  scheduledJobsBusy={scheduledJobs.scheduledJobsBusy()}
                  scheduledJobsUpdatedAt={scheduledJobs.scheduledJobsUpdatedAt()}
                  refreshScheduledJobs={scheduledJobs.refreshScheduledJobs}
                  deleteScheduledJob={scheduledJobs.deleteScheduledJob}
                  newTaskDisabled={props.newTaskDisabled}
                  schedulerPluginInstalled={scheduledJobs.schedulerPluginInstalled()}
                  refreshSkills={extensions.refreshSkills}
                  refreshHubSkills={extensions.refreshHubSkills}
                  ensureHubSkillsFresh={extensions.ensureHubSkillsFresh}
                  skills={extensions.skills()}
                  skillsStatus={extensions.skillsStatus()}
                  hubSkills={extensions.hubSkills()}
                  hubSkillsStatus={extensions.hubSkillsStatus()}
                  hubRepo={extensions.hubRepo()}
                  hubRepos={extensions.hubRepos()}
                  skillsAccessHint={extensions.skillsAccessHint()}
                  canInstallSkillCreator={extensions.canInstallSkillCreator()}
                  canUseDesktopTools={extensions.canUseDesktopTools()}
                  importLocalSkill={extensions.importLocalSkill}
                  installSkillCreator={extensions.installSkillCreator}
                  installHubSkill={extensions.installHubSkill}
                  setHubRepo={extensions.setHubRepo}
                  addHubRepo={extensions.addHubRepo}
                  removeHubRepo={extensions.removeHubRepo}
                  revealSkillsFolder={extensions.revealSkillsFolder}
                  uninstallSkill={extensions.uninstallSkill}
                  readSkill={extensions.readSkill}
                  saveSkill={extensions.saveSkill}
                  refreshPlugins={extensions.refreshPlugins}
                  refreshMcpServers={props.refreshMcpServers}
                  pluginsAccessHint={extensions.pluginsAccessHint()}
                  canEditPlugins={extensions.canEditPlugins()}
                  canUseGlobalPluginScope={extensions.canUseGlobalPluginScope()}
                  pluginScope={extensions.pluginScope()}
                  setPluginScope={extensions.setPluginScope}
                  pluginConfigPath={extensions.pluginConfigPath()}
                  pluginList={extensions.pluginList()}
                  pluginInput={extensions.pluginInput()}
                  setPluginInput={extensions.setPluginInput}
                  pluginStatus={extensions.pluginStatus()}
                  activePluginGuide={extensions.activePluginGuide()}
                  setActivePluginGuide={extensions.setActivePluginGuide}
                  isPluginInstalled={extensions.isPluginInstalled}
                  suggestedPlugins={extensions.suggestedPlugins}
                  addPlugin={extensions.addPlugin}
                  removePlugin={extensions.removePlugin}
                  mcpServers={props.mcpServers}
                  mcpStatus={props.mcpStatus}
                  mcpLastUpdatedAt={props.mcpLastUpdatedAt}
                  mcpStatuses={props.mcpStatuses}
                  mcpConnectingName={props.mcpConnectingName}
                  selectedMcp={props.selectedMcp}
                  setSelectedMcp={props.setSelectedMcp}
                  quickConnect={props.quickConnect}
                   connectMcp={props.connectMcp}
                   authorizeMcp={props.authorizeMcp}
                   logoutMcpAuth={props.logoutMcpAuth}
                   removeMcp={props.removeMcp}
                   createSessionAndOpen={props.createSessionAndOpen}
                  setPrompt={props.setPrompt}
                  canReloadWorkspace={props.canReloadWorkspace}
                  reloadWorkspaceEngine={props.reloadWorkspaceEngine}
                  reloadBusy={props.reloadBusy}
                  connectRemoteWorkspace={workspaceActions.connectRemoteWorkspace}
                  openCloudTemplate={workspaceActions.openCloudTemplate}
              />

            </Match>
          </Switch>
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
                    onClick={workspaceMaintenance.repairOpencodeCache}
                    disabled={workspaceMaintenance.cacheRepairBusy() || !props.developerMode}
                  >
                    {workspaceMaintenance.cacheRepairBusy() ? "Repairing cache" : "Repair cache"}
                  </Button>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    Retry
                  </Button>
                  <Show when={workspaceMaintenance.cacheRepairResult()}>
                    <span class="text-xs text-red-12/80">
                      {workspaceMaintenance.cacheRepairResult()}
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </Show>

        <ProviderAuthModal
          open={providerAuthModalOpen()}
          loading={providerAuthBusy()}
          submitting={providerAuthActionBusy()}
          error={providerAuthError()}
          preferredProviderId={providerAuthPreferredProviderId()}
          workerType={providerAuthWorkerType()}
          providers={providers()}
          connectedProviderIds={providerConnectedIds()}
          authMethods={providerAuthMethods()}
          onSelect={handleProviderAuthSelect}
          onSubmitApiKey={handleProviderAuthApiKey}
          onSubmitOAuth={handleProviderAuthOAuth}
          onRefreshProviders={refreshProviders}
          onClose={() => closeProviderAuthModal()}
        />

        <ShareWorkspaceModal
          open={Boolean(shareWorkspaceId())}
          onClose={() => setShareWorkspaceId(null)}
          workspaceName={shareWorkspaceName()}
          workspaceDetail={shareWorkspaceDetail()}
          fields={shareFields()}
          remoteAccess={shareWorkspace()?.workspaceType === "local"
            ? {
                enabled: openworkServerHostInfo()?.remoteAccessEnabled === true,
                busy: shareRemoteAccessBusy(),
                error: shareRemoteAccessError(),
                onSave: saveShareRemoteAccess,
              }
            : undefined}
          note={shareNote()}
          publisherBaseUrl={DEFAULT_OPENWORK_PUBLISHER_BASE_URL}
          onShareWorkspaceProfile={publishWorkspaceProfileLink}
          shareWorkspaceProfileBusy={shareWorkspaceProfileBusy()}
          shareWorkspaceProfileUrl={shareWorkspaceProfileUrl()}
          shareWorkspaceProfileError={shareWorkspaceProfileError()}
          shareWorkspaceProfileDisabledReason={shareServiceDisabledReason()}
          onShareWorkspaceProfileToTeam={shareWorkspaceProfileToTeam}
          shareWorkspaceProfileToTeamBusy={shareWorkspaceProfileTeamBusy()}
          shareWorkspaceProfileToTeamError={shareWorkspaceProfileTeamError()}
          shareWorkspaceProfileToTeamSuccess={shareWorkspaceProfileTeamSuccess()}
          shareWorkspaceProfileToTeamDisabledReason={shareWorkspaceProfileTeamDisabledReason()}
          shareWorkspaceProfileToTeamOrgName={shareWorkspaceProfileTeamOrgName()}
          shareWorkspaceProfileToTeamNeedsSignIn={shareWorkspaceProfileToTeamNeedsSignIn()}
          onShareWorkspaceProfileToTeamSignIn={startShareWorkspaceProfileToTeamSignIn}
          onShareSkillsSet={publishSkillsSetLink}
          onOpenSingleSkillShare={() => {
            setShareWorkspaceId(null);
            props.setTab("skills");
          }}
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
                workspaceActions.exportWorkspaceConfig(id);
              }
          }
          exportDisabledReason={exportDisabledReason()}
          onOpenBots={openConfig}
        />
        </div>

        <StatusBar
          clientConnected={props.clientConnected}
          openworkServerStatus={openworkServerStatus()}
          developerMode={props.developerMode}
          settingsOpen={props.tab === "settings"}
          showSettingsButton={true}
          onSendFeedback={openFeedback}
          onOpenSettings={props.toggleSettings}
          onOpenMessaging={() => openSettings("messaging")}
          onOpenProviders={() => openProviderAuthModal()}
          onOpenMcp={() => openSettings("extensions")}
          providerConnectedIds={providerConnectedIds()}
          mcpStatuses={props.mcpStatuses}
        />
        <nav class="hidden border-t border-dls-border bg-dls-surface">
          <div class={`mx-auto max-w-5xl px-4 py-3 grid gap-2 ${props.developerMode ? "grid-cols-5" : "grid-cols-4"}`}>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "scheduled" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => props.setTab("scheduled")}
            >
              <History size={18} />
              Automations
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "skills" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => props.setTab("skills")}
            >
              <Zap size={18} />
              Skills
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "mcp" || props.tab === "plugins" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => props.setTab("mcp")}
            >
              <Box size={18} />
              Extensions
            </button>
            <button
              class={`flex flex-col items-center gap-1 text-xs ${
                props.tab === "identities" ? "text-gray-12" : "text-gray-10"
              }`}
              onClick={() => props.setTab("identities")}
            >
              <MessageCircle size={18} />
              IDs
            </button>
            <Show when={props.developerMode}>
              <button
                class={`flex flex-col items-center gap-1 text-xs ${
                  props.tab === "config" ? "text-gray-12" : "text-gray-10"
                }`}
                onClick={() => props.setTab("config")}
              >
                <SlidersHorizontal size={18} />
                Advanced
              </button>
            </Show>
          </div>
        </nav>
      </main>
      </div>

    </div>
  );
}
