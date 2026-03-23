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
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
  View,
} from "../types";
import type { McpDirectoryInfo } from "../constants";
import {
  formatRelativeTime,
  getWorkspaceTaskLoadErrorDisplay,
  isTauriRuntime,
  isWindowsPlatform,
  normalizeDirectoryPath,
} from "../utils";
import { usePlatform } from "../context/platform";
import { buildFeedbackUrl } from "../lib/feedback";
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
import { DEFAULT_OPENWORK_PUBLISHER_BASE_URL, publishOpenworkBundleJson } from "../lib/publisher";

import Button from "../components/button";
import ExtensionsView from "./extensions";
import ScheduledTasksView from "./scheduled";
import ConfigView from "./config";
import SettingsView from "./settings";
import SkillsView from "./skills";
import IdentitiesView from "./identities";
import StatusBar from "../components/status-bar";
import ProviderAuthModal, {
  type ProviderAuthMethod,
  type ProviderOAuthStartResult,
} from "../components/provider-auth-modal";
import ShareWorkspaceModal from "../components/share-workspace-modal";
import WorkspaceSessionList from "../components/session/workspace-session-list";
import MobileSidebarDrawer from "../components/mobile-sidebar-drawer";
import WebUnavailableSurface from "../components/web-unavailable-surface";
import WorkspaceRightSidebar from "../components/workspace-right-sidebar";
import {
  Box,
  Circle,
  History,
  Loader2,
  Menu,
  MessageCircle,
  Plus,
  SlidersHorizontal,
  Zap,
} from "lucide-solid";
import type { Language } from "../../i18n";

export type DashboardViewProps = {
  tab: DashboardTab;
  setTab: (tab: DashboardTab) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  providers: ProviderListItem[];
  providerConnectedIds: string[];
  providerAuthBusy: boolean;
  providerAuthModalOpen: boolean;
  providerAuthError: string | null;
  providerAuthMethods: Record<string, ProviderAuthMethod[]>;
  providerAuthPreferredProviderId: string | null;
  providerAuthWorkerType: "local" | "remote";
  openProviderAuthModal: (options?: {
    returnFocusTarget?: "none" | "composer";
    preferredProviderId?: string;
  }) => Promise<void>;
  disconnectProvider: (providerId: string) => Promise<string | void>;
  closeProviderAuthModal: (options?: { restorePromptFocus?: boolean }) => void;
  startProviderAuth: (providerId?: string, methodIndex?: number) => Promise<ProviderOAuthStartResult>;
  completeProviderAuthOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string
  ) => Promise<{ connected: boolean; pending?: boolean; message?: string }>;
  submitProviderApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  refreshProviders: () => Promise<unknown>;
  view: View;
  setView: (view: View, sessionId?: string) => void;
  toggleSettings: () => void;
  startupPreference: StartupPreference | null;
  baseUrl: string;
  clientConnected: boolean;
  busy: boolean;
  busyHint: string | null;
  busyLabel: string | null;
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
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  openworkServerWorkspaceId: string | null;
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
  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;
  workspaceAutoReloadAvailable: boolean;
  workspaceAutoReloadEnabled: boolean;
  setWorkspaceAutoReloadEnabled: (value: boolean) => void | Promise<void>;
  workspaceAutoReloadResumeEnabled: boolean;
  setWorkspaceAutoReloadResumeEnabled: (value: boolean) => void | Promise<void>;
  activeWorkspaceDisplay: WorkspaceInfo;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  activateWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  testWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean;
  recoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean;
  openCreateWorkspace: () => void;
  openCreateRemoteWorkspace: () => void;
  connectRemoteWorkspace: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  importWorkspaceConfig: () => void;
  importingWorkspaceConfig: boolean;
  exportWorkspaceConfig: (workspaceId?: string) => void;
  exportWorkspaceBusy: boolean;
  workspaceSessionGroups: WorkspaceSessionGroup[];
  selectedSessionId: string | null;
  openRenameWorkspace: (workspaceId: string) => void;
  editWorkspaceConnection: (workspaceId: string) => void;
  forgetWorkspace: (workspaceId: string) => void;
  stopSandbox: (workspaceId: string) => void;
  scheduledJobs: ScheduledJob[];
  scheduledJobsSource: "local" | "remote";
  scheduledJobsSourceReady: boolean;
  schedulerPluginInstalled: boolean;
  scheduledJobsStatus: string | null;
  scheduledJobsBusy: boolean;
  scheduledJobsUpdatedAt: number | null;
  refreshScheduledJobs: (options?: { force?: boolean }) => void;
  deleteScheduledJob: (name: string) => Promise<void> | void;
  activeWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  refreshSkills: (options?: { force?: boolean }) => void;
  refreshHubSkills: (options?: { force?: boolean }) => void;
  refreshPlugins: (scopeOverride?: PluginScope) => void;
  refreshMcpServers: () => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  hubRepo: HubSkillRepo | null;
  hubRepos: HubSkillRepo[];
  skillsAccessHint?: string | null;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  importLocalSkill: () => void;
  installSkillCreator: () => Promise<{ ok: boolean; message: string }>;
  installHubSkill: (name: string) => Promise<{ ok: boolean; message: string }>;
  setHubRepo: (repo: Partial<HubSkillRepo> | null) => void;
  addHubRepo: (repo: Partial<HubSkillRepo>) => void;
  removeHubRepo: (repo: Partial<HubSkillRepo>) => void;
  revealSkillsFolder: () => void;
  uninstallSkill: (name: string) => void;
  readSkill: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; content: string; description?: string }) => void;
  pluginsAccessHint?: string | null;
  canEditPlugins: boolean;
  canUseGlobalPluginScope: boolean;
  pluginScope: PluginScope;
  setPluginScope: (scope: PluginScope) => void;
  pluginConfigPath: string | null;
  pluginList: string[];
  pluginInput: string;
  setPluginInput: (value: string) => void;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  setActivePluginGuide: (value: string | null) => void;
  isPluginInstalled: (name: string, aliases?: string[]) => boolean;
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
  removePlugin: (pluginName: string) => void;
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
  showMcpReloadBanner: boolean;
  mcpReloadBlocked: boolean;
  reloadMcpEngine: () => void;
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
  authorizedFolders: string[];
  authorizedFolderDraft: string;
  setAuthorizedFolderDraft: (value: string) => void;
  authorizedFoldersLoading: boolean;
  authorizedFoldersSaving: boolean;
  authorizedFoldersError: string | null;
  authorizedFoldersStatus: string | null;
  authorizedFoldersAvailable: boolean;
  authorizedFoldersEditable: boolean;
  authorizedFoldersHint: string | null;
  addAuthorizedFolder: () => Promise<void>;
  pickAuthorizedFolder: () => Promise<void>;
  removeAuthorizedFolder: (folder: string) => Promise<void>;
  resetAppConfigDefaults: () => Promise<{ ok: boolean; message: string }>;
  notionStatus: "disconnected" | "connecting" | "connected" | "error";
  notionStatusDetail: string | null;
  notionError: string | null;
  notionBusy: boolean;
  connectNotion: () => void;
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
  const webDeployment = createMemo(() => getOpenWorkDeployment() === "web");
  const [mobileRightSidebarOpen, setMobileRightSidebarOpen] = createSignal(false);
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
    // Route-driven selection: navigate first and let the route effect own selectSession.
    if (workspaceId === props.activeWorkspaceId) {
      props.setView("session", sessionId);
      return;
    }
    // For different workspace, activate workspace first
    void (async () => {
      await Promise.resolve(props.activateWorkspace(workspaceId));
      props.setView("session", sessionId);
    })();
  };

  const createTaskInWorkspace = (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    if (id === props.activeWorkspaceId) {
      props.createSessionAndOpen();
      return;
    }
    void (async () => {
      await Promise.resolve(props.activateWorkspace(id));
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
    rightSidebarExpanded,
    rightSidebarWidth,
    startLeftSidebarResize,
    toggleRightSidebar,
  } = createWorkspaceShellLayout({ expandedRightWidth: 280 });

  const openFeedback = () => {
    const resolved = buildFeedbackUrl({
      entrypoint: "dashboard-status-bar",
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
      throw new Error("Provider auth is already in progress.");
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
          await props.refreshSkills();
        }
        if ((currentTab === "plugins" || currentTab === "mcp") && !cancelled) {
          await Promise.all([props.refreshPlugins(), props.refreshMcpServers()]);
        }
        if (currentTab === "scheduled" && !cancelled) {
          await props.refreshScheduledJobs();
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
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(null);
  const [shareSkillsSetError, setShareSkillsSetError] = createSignal<string | null>(null);

  createEffect(
    on(shareWorkspaceId, () => {
      setShareWorkspaceProfileBusy(false);
      setShareWorkspaceProfileUrl(null);
      setShareWorkspaceProfileError(null);
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
      const exported = await client.exportWorkspace(workspaceId);
      const payload: WorkspaceProfileBundleV1 = {
        schemaVersion: 1,
        type: "workspace-profile",
        name: `${workspaceLabel(workspace)} profile`,
        description: "Full OpenWork workspace profile with config, MCP setup, commands, and skills.",
        workspace: exported,
      };

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "workspace-profile",
        name: payload.name,
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

      const result = await publishOpenworkBundleJson({
        payload,
        bundleType: "skills-set",
        name: payload.name,
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
    return "text-dls-secondary hover:text-emerald-11 hover:bg-emerald-3/25";
  });

  const updatePillBorderTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "border-amber-7/35" : "border-green-7/35";
    }
    if (state === "downloading") {
      return "border-blue-7/35";
    }
    return "border-dls-border";
  });

  const updatePillDotTone = createMemo(() => {
    const state = props.updateStatus?.state;
    if (state === "ready") {
      return props.anyActiveRuns ? "text-amber-10 fill-amber-10" : "text-green-10 fill-green-10";
    }
    if (state === "downloading") {
      return "text-blue-10";
    }
    return "text-emerald-10 fill-emerald-10";
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
    openSettings("advanced");
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
              class={`group mb-3 w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.2)] ${updatePillButtonTone()}`}
              onClick={handleUpdatePillClick}
              title={updatePillTitle()}
              aria-label={updatePillTitle()}
            >
              <Show
                when={props.updateStatus?.state === "downloading"}
                fallback={
                  <Circle
                    size={8}
                    class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "group-hover:animate-pulse" : ""}`}
                  />
                }
              >
                <Loader2 size={13} class={`animate-spin shrink-0 ${updatePillDotTone()}`} />
              </Show>
              <span class="flex-1 text-left">{updatePillLabel()}</span>
              <Show when={props.updateStatus?.version}>
                {(version) => (
                  <span class={`ml-auto font-mono text-[10px] ${updatePillVersionTone()}`}>v{version()}</span>
                )}
              </Show>
            </button>
          </Show>
        </div>
        <div class="flex min-h-0 flex-1">
          <WorkspaceSessionList
            workspaceSessionGroups={props.workspaceSessionGroups}
            activeWorkspaceId={props.activeWorkspaceId}
            developerMode={props.developerMode}
            selectedSessionId={props.selectedSessionId}
            connectingWorkspaceId={props.connectingWorkspaceId}
            workspaceConnectionStateById={props.workspaceConnectionStateById}
            newTaskDisabled={props.newTaskDisabled}
            importingWorkspaceConfig={props.importingWorkspaceConfig}
            onActivateWorkspace={props.activateWorkspace}
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
            onOpenCreateRemoteWorkspace={props.openCreateRemoteWorkspace}
            onImportWorkspaceConfig={props.importWorkspaceConfig}
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
                    <Circle
                      size={8}
                      class={`${updatePillDotTone()} shrink-0 ${props.updateStatus?.state === "available" ? "animate-pulse" : ""}`}
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
              class="flex h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2/70 hover:text-dls-text md:hidden"
              onClick={() => setMobileRightSidebarOpen(true)}
              title="Open sidebar"
              aria-label="Open sidebar"
            >
              <Menu size={16} />
            </button>
          </div>
        </header>

        <div class="mx-auto w-full max-w-[1100px] space-y-10 p-6 md:p-10">
          <Switch>
            <Match when={props.tab === "scheduled"}>
              <WebUnavailableSurface unavailable={webDeployment()}>
                <ScheduledTasksView
                  jobs={props.scheduledJobs}
                  source={props.scheduledJobsSource}
                  sourceReady={props.scheduledJobsSourceReady}
                  status={props.scheduledJobsStatus}
                  busy={props.scheduledJobsBusy}
                  lastUpdatedAt={props.scheduledJobsUpdatedAt}
                  refreshJobs={props.refreshScheduledJobs}
                  deleteJob={props.deleteScheduledJob}
                  isWindows={props.isWindows}
                  activeWorkspaceRoot={props.activeWorkspaceRoot}
                  createSessionAndOpen={props.createSessionAndOpen}
                  setPrompt={props.setPrompt}
                  newTaskDisabled={props.newTaskDisabled}
                  schedulerInstalled={props.schedulerPluginInstalled}
                  canEditPlugins={props.canEditPlugins}
                  addPlugin={props.addPlugin}
                  reloadWorkspaceEngine={props.reloadWorkspaceEngine}
                  reloadBusy={props.reloadBusy}
                  canReloadWorkspace={props.canReloadWorkspace}
                />
              </WebUnavailableSurface>
            </Match>
            <Match when={props.tab === "skills"}>
              <WebUnavailableSurface unavailable={webDeployment()}>
                <SkillsView
                  workspaceName={props.activeWorkspaceDisplay.name}
                  busy={props.busy}
                  canInstallSkillCreator={props.canInstallSkillCreator}
                  canUseDesktopTools={props.canUseDesktopTools}
                  accessHint={props.skillsAccessHint}
                  refreshSkills={props.refreshSkills}
                  refreshHubSkills={props.refreshHubSkills}
                  skills={props.skills}
                  skillsStatus={props.skillsStatus}
                  hubSkills={props.hubSkills}
                  hubSkillsStatus={props.hubSkillsStatus}
                  hubRepo={props.hubRepo}
                  hubRepos={props.hubRepos}
                  importLocalSkill={props.importLocalSkill}
                  installSkillCreator={props.installSkillCreator}
                  installHubSkill={props.installHubSkill}
                  setHubRepo={props.setHubRepo}
                  addHubRepo={props.addHubRepo}
                  removeHubRepo={props.removeHubRepo}
                  revealSkillsFolder={props.revealSkillsFolder}
                  uninstallSkill={props.uninstallSkill}
                  readSkill={props.readSkill}
                  saveSkill={props.saveSkill}
                  createSessionAndOpen={props.createSessionAndOpen}
                  setPrompt={props.setPrompt}
                />
              </WebUnavailableSurface>
            </Match>

            <Match when={props.tab === "plugins" || props.tab === "mcp"}>
              <WebUnavailableSurface unavailable={webDeployment()}>
                <ExtensionsView
                  initialSection={props.tab === "plugins" ? "plugins" : "mcp"}
                  setDashboardTab={props.setTab}
                  busy={props.busy}
                  activeWorkspaceRoot={props.activeWorkspaceRoot}
                  isRemoteWorkspace={props.isRemoteWorkspace}
                  refreshMcpServers={props.refreshMcpServers}
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
                  showMcpReloadBanner={props.showMcpReloadBanner}
                  reloadBlocked={props.mcpReloadBlocked}
                  reloadMcpEngine={props.reloadMcpEngine}
                  canEditPlugins={props.canEditPlugins}
                  canUseGlobalScope={props.canUseGlobalPluginScope}
                  accessHint={props.pluginsAccessHint}
                  pluginScope={props.pluginScope}
                  setPluginScope={props.setPluginScope}
                  pluginConfigPath={props.pluginConfigPath}
                  pluginList={props.pluginList}
                  pluginInput={props.pluginInput}
                  setPluginInput={props.setPluginInput}
                  pluginStatus={props.pluginStatus}
                  activePluginGuide={props.activePluginGuide}
                  setActivePluginGuide={props.setActivePluginGuide}
                  isPluginInstalled={props.isPluginInstalled}
                  suggestedPlugins={props.suggestedPlugins}
                  refreshPlugins={props.refreshPlugins}
                  addPlugin={props.addPlugin}
                  removePlugin={props.removePlugin}
                />
              </WebUnavailableSurface>
            </Match>

            <Match when={props.tab === "identities"}>
              <WebUnavailableSurface unavailable={webDeployment()}>
                <IdentitiesView
                  busy={props.busy}
                  openworkServerStatus={props.openworkServerStatus}
                  openworkServerUrl={props.openworkServerUrl}
                  openworkServerClient={props.openworkServerClient}
                  openworkReconnectBusy={props.openworkReconnectBusy}
                  reconnectOpenworkServer={props.reconnectOpenworkServer}
                  restartLocalServer={props.restartLocalServer}
                  openworkServerWorkspaceId={props.openworkServerWorkspaceId}
                  activeWorkspaceRoot={props.activeWorkspaceRoot}
                  developerMode={props.developerMode}
                />
              </WebUnavailableSurface>
            </Match>

            <Match when={props.tab === "config" && props.developerMode}>
              <ConfigView
                busy={props.busy}
                clientConnected={props.clientConnected}
                anyActiveRuns={props.anyActiveRuns}
                openworkServerStatus={props.openworkServerStatus}
                openworkServerUrl={props.openworkServerUrl}
                openworkServerSettings={props.openworkServerSettings}
                openworkServerHostInfo={props.openworkServerHostInfo}
                openworkServerWorkspaceId={props.openworkServerWorkspaceId}
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
                  providers={props.providers}
                  providerConnectedIds={props.providerConnectedIds}
                  providerAuthBusy={props.providerAuthBusy}
                  openProviderAuthModal={props.openProviderAuthModal}
                  disconnectProvider={props.disconnectProvider}
                  openworkServerStatus={props.openworkServerStatus}
                  openworkServerUrl={props.openworkServerUrl}
                  openworkReconnectBusy={props.openworkReconnectBusy}
                  reconnectOpenworkServer={props.reconnectOpenworkServer}
                  openworkServerHostInfo={props.openworkServerHostInfo}
                  openworkServerCapabilities={props.openworkServerCapabilities}
                  openworkServerDiagnostics={props.openworkServerDiagnostics}
                  openworkServerWorkspaceId={props.openworkServerWorkspaceId}
                  activeWorkspaceRoot={props.activeWorkspaceRoot}
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
                  defaultModelLabel={props.defaultModelLabel}
                  defaultModelRef={props.defaultModelRef}
                  openDefaultModelPicker={props.openDefaultModelPicker}
                  showThinking={props.showThinking}
                  toggleShowThinking={props.toggleShowThinking}
                  autoCompactContext={props.autoCompactContext}
                  toggleAutoCompactContext={props.toggleAutoCompactContext}
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
                  repairOpencodeMigration={props.repairOpencodeMigration}
                  migrationRepairBusy={props.migrationRepairBusy}
                  migrationRepairResult={props.migrationRepairResult}
                  migrationRepairAvailable={props.migrationRepairAvailable}
                  migrationRepairUnavailableReason={props.migrationRepairUnavailableReason}
                  repairOpencodeCache={props.repairOpencodeCache}
                  cacheRepairBusy={props.cacheRepairBusy}
                  cacheRepairResult={props.cacheRepairResult}
                  cleanupOpenworkDockerContainers={props.cleanupOpenworkDockerContainers}
                  dockerCleanupBusy={props.dockerCleanupBusy}
                  dockerCleanupResult={props.dockerCleanupResult}
                  authorizedFolders={props.authorizedFolders}
                  authorizedFolderDraft={props.authorizedFolderDraft}
                  setAuthorizedFolderDraft={props.setAuthorizedFolderDraft}
                  authorizedFoldersLoading={props.authorizedFoldersLoading}
                  authorizedFoldersSaving={props.authorizedFoldersSaving}
                  authorizedFoldersError={props.authorizedFoldersError}
                  authorizedFoldersStatus={props.authorizedFoldersStatus}
                  authorizedFoldersAvailable={props.authorizedFoldersAvailable}
                  authorizedFoldersEditable={props.authorizedFoldersEditable}
                  authorizedFoldersHint={props.authorizedFoldersHint}
                  addAuthorizedFolder={props.addAuthorizedFolder}
                  pickAuthorizedFolder={props.pickAuthorizedFolder}
                  removeAuthorizedFolder={props.removeAuthorizedFolder}
                  resetAppConfigDefaults={props.resetAppConfigDefaults}
                  notionStatus={props.notionStatus}
                  notionStatusDetail={props.notionStatusDetail}
                  notionError={props.notionError}
                  notionBusy={props.notionBusy}
                  connectNotion={props.connectNotion}
                  openDebugDeepLink={props.openDebugDeepLink}
                  connectRemoteWorkspace={props.connectRemoteWorkspace}
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
                    onClick={props.repairOpencodeCache}
                    disabled={props.cacheRepairBusy || !props.developerMode}
                  >
                    {props.cacheRepairBusy ? "Repairing cache" : "Repair cache"}
                  </Button>
                  <Button
                    variant="outline"
                    class="text-xs h-8 py-0 px-3"
                    onClick={props.stopHost}
                    disabled={props.busy}
                  >
                    Retry
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
          providers={props.providers}
          connectedProviderIds={props.providerConnectedIds}
          authMethods={props.providerAuthMethods}
          onSelect={handleProviderAuthSelect}
          onSubmitApiKey={handleProviderAuthApiKey}
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
          note={shareNote()}
          publisherBaseUrl={DEFAULT_OPENWORK_PUBLISHER_BASE_URL}
          onShareWorkspaceProfile={publishWorkspaceProfileLink}
          shareWorkspaceProfileBusy={shareWorkspaceProfileBusy()}
          shareWorkspaceProfileUrl={shareWorkspaceProfileUrl()}
          shareWorkspaceProfileError={shareWorkspaceProfileError()}
          shareWorkspaceProfileDisabledReason={shareServiceDisabledReason()}
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
                props.exportWorkspaceConfig(id);
              }
          }
          exportDisabledReason={exportDisabledReason()}
          onOpenBots={openConfig}
        />
        </div>

        <StatusBar
          clientConnected={props.clientConnected}
          openworkServerStatus={props.openworkServerStatus}
          developerMode={props.developerMode}
          settingsOpen={props.tab === "settings"}
          showSettingsButton={false}
          onSendFeedback={openFeedback}
          onOpenSettings={props.toggleSettings}
          onOpenMessaging={openConfig}
          onOpenProviders={() => props.openProviderAuthModal()}
          onOpenMcp={() => props.setTab("mcp")}
          providerConnectedIds={props.providerConnectedIds}
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

      <aside
        class="hidden shrink-0 md:flex"
        style={{
          width: `${rightSidebarWidth()}px`,
          "min-width": `${rightSidebarWidth()}px`,
        }}
      >
        <WorkspaceRightSidebar
          expanded={rightSidebarExpanded()}
          tab={props.tab}
          developerMode={props.developerMode}
          activeWorkspaceLabel={props.activeWorkspaceDisplay.displayName || props.activeWorkspaceDisplay.name || "Workspace"}
          activeWorkspaceType={props.activeWorkspaceDisplay.workspaceType}
          openworkServerClient={props.openworkServerClient}
          openworkServerWorkspaceId={props.openworkServerWorkspaceId}
          inboxId="dashboard-sidebar-inbox"
          onToggleExpanded={toggleRightSidebar}
          onOpenAutomations={() => props.setTab("scheduled")}
          onOpenSkills={() => props.setTab("skills")}
          onOpenExtensions={() => props.setTab("mcp")}
          onOpenMessaging={() => props.setTab("identities")}
          onOpenAdvanced={openConfig}
          onOpenSettings={() => openSettings("general")}
        />
      </aside>

      <MobileSidebarDrawer
        open={mobileRightSidebarOpen()}
        onClose={() => setMobileRightSidebarOpen(false)}
      >
        <WorkspaceRightSidebar
          expanded
          mobile
          tab={props.tab}
          developerMode={props.developerMode}
          activeWorkspaceLabel={props.activeWorkspaceDisplay.displayName || props.activeWorkspaceDisplay.name || "Workspace"}
          activeWorkspaceType={props.activeWorkspaceDisplay.workspaceType}
          openworkServerClient={props.openworkServerClient}
          openworkServerWorkspaceId={props.openworkServerWorkspaceId}
          inboxId="dashboard-mobile-sidebar-inbox"
          onToggleExpanded={toggleRightSidebar}
          onCloseMobile={() => setMobileRightSidebarOpen(false)}
          onOpenAutomations={() => props.setTab("scheduled")}
          onOpenSkills={() => props.setTab("skills")}
          onOpenExtensions={() => props.setTab("mcp")}
          onOpenMessaging={() => props.setTab("identities")}
          onOpenAdvanced={openConfig}
          onOpenSettings={() => openSettings("general")}
        />
      </MobileSidebarDrawer>
      </div>

    </div>
  );
}
