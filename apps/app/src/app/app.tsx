import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { useLocation, useNavigate } from "@solidjs/router";

import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import ModelPickerModal from "./components/model-picker-modal";
import ConfirmModal from "./components/confirm-modal";
import ResetModal from "./components/reset-modal";
import SkillDestinationModal from "./bundles/skill-destination-modal";
import BundleImportModal from "./bundles/import-modal";
import BundleStartModal from "./bundles/start-modal";
import RenameWorkspaceModal from "./components/rename-workspace-modal";
import ConnectionsModals from "./connections/modals";
import { OpenworkServerProvider } from "./connections/openwork-server-provider";
import { createOpenworkServerStore } from "./connections/openwork-server-store";
import { ConnectionsProvider } from "./connections/provider";
import { ExtensionsProvider } from "./extensions/provider";
import { AutomationsProvider } from "./automations/provider";
import { SessionActionsProvider } from "./session/actions-provider";
import { createSessionActionsStore } from "./session/actions-store";
import { createDeepLinksController } from "./shell/deep-links";
import SettingsShell from "./shell/settings-shell";
import TopRightNotifications from "./shell/top-right-notifications";
import { createStatusToastsStore, StatusToastsProvider } from "./shell/status-toasts";
import {
  CreateRemoteWorkspaceModal,
  CreateWorkspaceModal,
} from "./workspace";
import SessionView from "./pages/session";
import { clearDevLogs } from "./lib/dev-log";
import { clearPerfLogs } from "./lib/perf-log";
import { deepLinkBridgeEvent, drainPendingDeepLinks, type DeepLinkBridgeDetail } from "./lib/deep-link-bridge";
import {
  HIDE_TITLEBAR_PREF_KEY,
  SUGGESTED_PLUGINS,
} from "./constants";
import type {
  Client,
  StartupPreference,
  EngineRuntime,
  OnboardingStep,
  ReloadReason,
  ReloadTrigger,
  SettingsTab,
  View,
  WorkspaceDisplay,
  WorkspaceSessionGroup,
  ProviderListItem,
  OpencodeConnectStatus,
} from "./types";
import {
  clearStartupPreference,
  deriveArtifacts,
  deriveWorkingFiles,
  isTauriRuntime,
  normalizeDirectoryPath,
} from "./utils";
import { currentLocale, setLocale, t } from "../i18n";
import {
  isWindowsPlatform,
  lastUserModelFromMessages,
  readStartupPreference,
  safeStringify,
} from "./utils";
import {
  applyThemeMode,
  getInitialThemeMode,
  persistThemeMode,
  subscribeToSystemTheme,
  type ThemeMode,
} from "./theme";
import { createSystemState } from "./system-state";
import { createSessionStore } from "./context/session";
import {
  createModelConfigStore,
} from "./context/model-config";
import { createProvidersStore } from "./context/providers";
import { ModelControlsProvider } from "./app-settings/model-controls-provider";
import { createModelControlsStore } from "./app-settings/model-controls-store";
import { useSessionDisplayPreferences } from "./app-settings/session-display-preferences";
import {
  shouldRedirectMissingSessionAfterScopedLoad,
} from "./lib/session-scope";
import { createExtensionsStore } from "./context/extensions";
import { createConnectionsStore } from "./connections/store";
import { createAutomationsStore } from "./context/automations";
import { createSidebarSessionsStore } from "./context/sidebar-sessions";
import { useGlobalSync } from "./context/global-sync";
import { createWorkspaceStore } from "./context/workspace";
import {
  updaterEnvironment,
  setWindowDecorations,
} from "./lib/tauri";
import {
  FONT_ZOOM_STEP,
  applyWebviewZoom,
  applyFontZoom,
  normalizeFontZoom,
  parseFontZoomShortcut,
  persistFontZoom,
  readStoredFontZoom,
} from "./lib/font-zoom";
import {
  buildOpenworkWorkspaceBaseUrl,
  parseOpenworkWorkspaceIdFromUrl,
  readOpenworkConnectInviteFromSearch,
  stripOpenworkConnectInviteFromUrl,
  hydrateOpenworkServerSettingsFromEnv,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
  type OpenworkServerSettings,
} from "./lib/openwork-server";
import { ReactIsland } from "../react/island";
import { reactSessionEnabled } from "../react/feature-flag";
import { ReactSessionRuntime } from "../react/session/runtime-sync.react";
import {
  parseBundleDeepLink,
  stripBundleQuery,
} from "./bundles";
import { createBundlesStore } from "./bundles/store";
import {
  classifyStartupBranch,
  pushStartupTraceEvent,
  type BootPhase,
  type StartupBranch,
  type StartupTraceEvent,
} from "./lib/startup-boot";

type SettingsReturnTarget = {
  view: View;
  tab: SettingsTab;
  sessionId: string | null;
};

type PendingInitialSessionSelection = {
  workspaceId: string;
  title: string | null;
  readyAt: number;
};

const STARTUP_SESSION_SNAPSHOT_KEY = "openwork.startupSessionSnapshot.v1";
const STARTUP_SESSION_SNAPSHOT_VERSION = 1;
const STARTUP_SESSION_SNAPSHOT_MAX_PER_WORKSPACE = 12;

type StartupSessionSnapshotEntry = {
  id: string;
  title: string;
  parentID?: string | null;
  directory?: string | null;
  time?: {
    updated?: number | null;
    created?: number | null;
  };
};

type StartupSessionSnapshot = {
  version: number;
  updatedAt: number;
  sessionsByWorkspaceId: Record<string, StartupSessionSnapshotEntry[]>;
};

export default function App() {
  const { resetSessionDisplayPreferences } = useSessionDisplayPreferences();
  const envOpenworkWorkspaceId =
    typeof import.meta.env?.VITE_OPENWORK_WORKSPACE_ID === "string"
      ? import.meta.env.VITE_OPENWORK_WORKSPACE_ID.trim() || null
      : null;

  const location = useLocation();
  const navigate = useNavigate();

  const [creatingSession, setCreatingSession] = createSignal(false);
  const currentView = createMemo<View>(() => {
    const path = location.pathname.toLowerCase();
    if (path.startsWith("/session")) return "session";
    return "settings";
  });

  const [settingsTab, setSettingsTabState] = createSignal<SettingsTab>("general");
  const [pendingInitialSessionSelection, setPendingInitialSessionSelection] =
    createSignal<PendingInitialSessionSelection | null>(null);

  const goToSettings = (nextTab: SettingsTab, options?: { replace?: boolean }) => {
    setSettingsTabState(nextTab);
    navigate(`/settings/${nextTab}`, options);
  };

  const setSettingsTab = (nextTab: SettingsTab) => {
    if (currentView() === "settings") {
      goToSettings(nextTab);
      return;
    }
    setSettingsTabState(nextTab);
  };

  const setView = (next: View, sessionId?: string) => {
    if (next === "settings" && creatingSession()) {
      return;
    }
    if (next === "session") {
      if (sessionId) {
        goToSession(sessionId);
        return;
      }
      navigate("/session");
      return;
    }
    goToSettings(settingsTab());
  };

  const goToSession = (sessionId: string, options?: { replace?: boolean }) => {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      navigate("/session", options);
      return;
    }
    navigate(`/session/${trimmed}`, options);
  };

  const [startupPreference, setStartupPreference] = createSignal<StartupPreference | null>(
    readStartupPreference(),
  );
  const [onboardingStep, setOnboardingStep] =
    createSignal<OnboardingStep>("welcome");
  const [rememberStartupChoice, setRememberStartupChoice] = createSignal(false);
  const [themeMode, setThemeMode] = createSignal<ThemeMode>(getInitialThemeMode());

  const [engineSource, setEngineSource] = createSignal<"path" | "sidecar" | "custom">(
    isTauriRuntime() ? "sidecar" : "path"
  );

  const [engineCustomBinPath, setEngineCustomBinPath] = createSignal("");

  const [engineRuntime, setEngineRuntime] = createSignal<EngineRuntime>("openwork-orchestrator");
  const [opencodeEnableExa, setOpencodeEnableExa] = createSignal(false);

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  createEffect(() => {
    if (typeof window === "undefined") return;
    hydrateOpenworkServerSettingsFromEnv();

    const stored = readOpenworkServerSettings();
    const invite = readOpenworkConnectInviteFromSearch(window.location.search);
    const bundleInvite = parseBundleDeepLink(window.location.href);

    if (!invite) {
      setOpenworkServerSettings(stored);
    } else {
      const merged: OpenworkServerSettings = {
        ...stored,
        urlOverride: invite.url,
        token: invite.token ?? stored.token,
      };

      const next = writeOpenworkServerSettings(merged);
      setOpenworkServerSettings(next);

      if (invite.startup === "server" && untrack(onboardingStep) === "welcome") {
        setStartupPreference("server");
        setOnboardingStep("server");
      }
    }

    if (bundleInvite?.bundleUrl) {
      bundlesStore.queueBundleLink(window.location.href);
    }

    if (invite?.autoConnect) {
      deepLinks.queueRemoteConnectDefaults({
        openworkHostUrl: invite.url,
        openworkToken: invite.token ?? null,
        directory: null,
        displayName: null,
        autoConnect: true,
      });
    }

    const cleanedConnect = stripOpenworkConnectInviteFromUrl(window.location.href);
    const cleaned = stripBundleQuery(cleanedConnect) ?? cleanedConnect;
    if (cleaned !== window.location.href) {
      window.history.replaceState(window.history.state ?? null, "", cleaned);
    }
  });

  createEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    onCleanup(() => document.removeEventListener("visibilitychange", update));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!isTauriRuntime()) return;

    const applyAndPersistFontZoom = (value: number) => {
      const next = normalizeFontZoom(value);
      persistFontZoom(window.localStorage, next);

      try {
        const webview = getCurrentWebview();
        void applyWebviewZoom(webview, next)
          .then(() => {
            document.documentElement.style.removeProperty("--openwork-font-size");
          })
          .catch(() => {
            applyFontZoom(document.documentElement.style, next);
          });
      } catch {
        applyFontZoom(document.documentElement.style, next);
      }

      return next;
    };

    let fontZoom = applyAndPersistFontZoom(readStoredFontZoom(window.localStorage) ?? 1);

    const handleZoomShortcut = (event: KeyboardEvent) => {
      const action = parseFontZoomShortcut(event);
      if (!action) return;

      if (action === "in") {
        fontZoom = applyAndPersistFontZoom(fontZoom + FONT_ZOOM_STEP);
      } else if (action === "out") {
        fontZoom = applyAndPersistFontZoom(fontZoom - FONT_ZOOM_STEP);
      } else {
        fontZoom = applyAndPersistFontZoom(1);
      }

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleZoomShortcut, true);
    onCleanup(() => window.removeEventListener("keydown", handleZoomShortcut, true));
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) return;
    if (!documentVisible()) return;
    if (booting()) return;
    if (workspaceStore?.connectingWorkspaceId?.()) return;

    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        await workspaceStore.refreshEngine();
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      window.clearInterval(interval);
    });
  });

  const [client, setClient] = createSignal<Client | null>(null);
  const [connectedVersion, setConnectedVersion] = createSignal<string | null>(
    null
  );
  const [sseConnected, setSseConnected] = createSignal(false);

  const [busy, setBusy] = createSignal(false);
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [opencodeConnectStatus, setOpencodeConnectStatus] = createSignal<OpencodeConnectStatus | null>(null);
  const [booting, setBooting] = createSignal(true);
  const [bootPhase, setBootPhase] = createSignal<BootPhase>("nativeInit");
  const [startupBranch, setStartupBranch] = createSignal<StartupBranch>("unknown");
  const [startupTrace, setStartupTrace] = createSignal<StartupTraceEvent[]>([]);
  const [firstSidebarVisibleAt, setFirstSidebarVisibleAt] = createSignal<number | null>(null);
  const [firstSessionPaintAt, setFirstSessionPaintAt] = createSignal<number | null>(null);
  const [, setLastKnownConfigSnapshot] = createSignal("");
  const [developerMode, setDeveloperMode] = createSignal(false);
  const [documentVisible, setDocumentVisible] = createSignal(true);

  const markStartupTrace = (phase: BootPhase, event: string, detail?: Record<string, unknown>) => {
    setStartupTrace((current) =>
      pushStartupTraceEvent(current, {
        at: Date.now(),
        phase,
        event,
        ...(detail ? { detail } : {}),
      }),
    );
  };

  createEffect(() => {
    const phase = bootPhase();
    const isBooting = phase !== "ready" && phase !== "error";
    setBooting(isBooting);
  });

  createEffect(() => {
    if (bootPhase() === "ready" || bootPhase() === "error") return;
    const message = error();
    if (!message) return;
    setBootPhase("error");
    markStartupTrace("error", "startup-error", { message });
  });

  createEffect(() => {
    if (developerMode()) return;
    clearDevLogs();
    clearPerfLogs();
  });

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(null);
  const [prompt, setPrompt] = createSignal("");
  const [settingsReturnTarget, setSettingsReturnTarget] = createSignal<SettingsReturnTarget>({
    view: "settings",
    tab: "general",
    sessionId: null,
  });
  const SESSION_BY_WORKSPACE_KEY = "openwork.workspace-last-session.v1";
  const readSessionByWorkspace = () => {
    if (typeof window === "undefined") return {} as Record<string, string>;
    try {
      const raw = window.localStorage.getItem(SESSION_BY_WORKSPACE_KEY);
      if (!raw) return {} as Record<string, string>;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {} as Record<string, string>;
      return parsed as Record<string, string>;
    } catch {
      return {} as Record<string, string>;
    }
  };
  const writeSessionByWorkspace = (map: Record<string, string>) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SESSION_BY_WORKSPACE_KEY, JSON.stringify(map));
    } catch {
      // ignore
    }
  };

  const globalSync = useGlobalSync();
  const providers = createMemo(() => globalSync.data.provider.all ?? []);
  const providerDefaults = createMemo(() => globalSync.data.provider.default ?? {});
  const providerConnectedIds = createMemo(() => globalSync.data.provider.connected ?? []);
  const setProviders = (value: ProviderListItem[]) => {
    globalSync.set("provider", "all", value);
  };
  const setProviderDefaults = (value: Record<string, string>) => {
    globalSync.set("provider", "default", value);
  };
  const setProviderConnectedIds = (value: string[]) => {
    globalSync.set("provider", "connected", value);
  };

  let workspaceStore!: ReturnType<typeof createWorkspaceStore>;
  let sessionStore!: ReturnType<typeof createSessionStore>;
  let openworkServerStore!: ReturnType<typeof createOpenworkServerStore>;

  const modelConfig = createModelConfigStore({
    client,
    selectedSessionId,
    messages: () => sessionStore?.messages?.() ?? [],
    providers,
    providerDefaults,
    providerConnectedIds,
    selectedWorkspaceId: () => workspaceStore?.selectedWorkspaceId?.() ?? "",
    selectedWorkspaceDisplay: () =>
      workspaceStore?.selectedWorkspaceDisplay?.() ?? ({ workspaceType: "local" } as WorkspaceDisplay),
    selectedWorkspacePath: () => workspaceStore?.selectedWorkspacePath?.() ?? "",
    openworkServerClient: () => openworkServerStore?.openworkServerClient?.() ?? null,
    openworkServerStatus: () => openworkServerStore?.openworkServerStatus?.() ?? "disconnected",
    openworkServerCapabilities: () => openworkServerStore?.openworkServerCapabilities?.() ?? null,
    runtimeWorkspaceId: () => workspaceStore?.runtimeWorkspaceId?.() ?? null,
    focusSessionPromptSoon: () => focusSessionPromptSoon(),
    setError,
    setLastKnownConfigSnapshot,
    markOpencodeConfigReloadRequired: () =>
      markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" }),
  });

  createEffect(() => {
    const view = currentView();
    const currentTab = settingsTab();
    if (view === "settings") return;
    setSettingsReturnTarget({
      view,
      tab: currentTab,
      sessionId: selectedSessionId(),
    });
  });

  const restoreSettingsReturnTarget = () => {
    const target = settingsReturnTarget();
    if (target.view === "session") {
      if (target.sessionId) {
        goToSession(target.sessionId);
        return;
      }
      navigate("/session");
      return;
    }
    goToSettings(target.tab);
  };

  const toggleSettingsView = (nextTab: SettingsTab = "general") => {
    const settingsOpen = currentView() === "settings";
    if (settingsOpen) {
      restoreSettingsReturnTarget();
      return;
    }
    setSettingsTab(nextTab);
    goToSettings(nextTab);
  };

  let markReloadRequiredHandler: ((reason: ReloadReason, trigger?: ReloadTrigger) => void) | undefined;
  const markReloadRequired = (reason: ReloadReason, trigger?: ReloadTrigger) => {
    markReloadRequiredHandler?.(reason, trigger);
  };

  sessionStore = createSessionStore({
    client,
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot().trim(),
    selectedSessionId,
    setSelectedSessionId,
    setPrompt,
    sessionModelState: modelConfig.sessionModelState,
    setSessionModelState: modelConfig.setSessionModelState,
    lastUserModelFromMessages,
    developerMode,
    setError,
    setSseConnected,
    markReloadRequired,
    onHotReloadApplied: () => {
      void refreshSkills({ force: true });
      void refreshPlugins(pluginScope());
      void refreshMcpServers();
    },
  });

  const {
    sessions,
    loadedScopeRoot: loadedSessionScopeRoot,
    sessionById,
    sessionStatusById,
    messageIdFromInfo,
    selectedSession,
    selectedSessionStatus,
    selectedSessionErrorTurns,
    selectedSessionCompactionState,
    messages,
    visibleMessages,
    messagesBySessionId,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    activeQuestion,
    questionReplyBusy,
    events,
    activePermission,
    loadSessions,
    ensureSessionLoaded,
    refreshPendingPermissions,
    selectSession,
    loadEarlierMessages,
    renameSession,
    respondPermission,
    respondQuestion,
    restorePromptFromUserMessage,
    upsertLocalSession,
    setBlueprintSeedMessagesBySessionId,
    setSessions,
    setSessionStatusById,
    setMessages,
    setTodos,
    setPendingPermissions,
    selectedSessionHasEarlierMessages,
    selectedSessionLoadingEarlierMessages,
    sessionLoadingById,
  } = sessionStore;

  const ARTIFACT_SCAN_MESSAGE_WINDOW = 220;
  const artifacts = createMemo(() =>
    deriveArtifacts(messages(), { maxMessages: ARTIFACT_SCAN_MESSAGE_WINDOW }),
  );
  const workingFiles = createMemo(() => deriveWorkingFiles(artifacts()));
  const activeSessionId = createMemo(() => {
    const path = location.pathname.trim();
    const [, sessionSegment, idSegment] = path.split("/");
    if (sessionSegment?.toLowerCase() === "session") {
      const routeId = (idSegment ?? "").trim();
      if (routeId) return routeId;
    }
    return selectedSessionId();
  });
  const activeSessionStatusById = createMemo(() => sessionStatusById());
  const activeTodos = createMemo(() => todos());
  const activeWorkingFiles = createMemo(() => workingFiles());
  const [startupSessionSnapshotByWorkspaceId, setStartupSessionSnapshotByWorkspaceId] = createSignal<
    Record<string, StartupSessionSnapshotEntry[]>
  >({});

  const [sessionsLoaded, setSessionsLoaded] = createSignal(false);
  const loadSessionsWithReady = async (scopeRoot?: string) => {
    await loadSessions(scopeRoot);
    setSessionsLoaded(true);
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STARTUP_SESSION_SNAPSHOT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StartupSessionSnapshot;
      if (!parsed || parsed.version !== STARTUP_SESSION_SNAPSHOT_VERSION) return;
      if (!parsed.sessionsByWorkspaceId || typeof parsed.sessionsByWorkspaceId !== "object") return;
      setStartupSessionSnapshotByWorkspaceId(parsed.sessionsByWorkspaceId);
    } catch {
      // ignore malformed snapshots
    }
  });

  createEffect(() => {
    if (!client()) {
      setSessionsLoaded(false);
    }
  });

  const ensureWorkspaceRuntime = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return false;
    const ready = await workspaceStore.activateWorkspace(id);
    if (ready) {
      await refreshSidebarWorkspaceSessions(id).catch(() => undefined);
    }
    return ready;
  };

  function focusSessionPromptSoon() {
    if (typeof window === "undefined" || currentView() !== "session") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("openwork:focusPrompt"));
      });
    });
  }

  async function respondPermissionAndRemember(
    requestID: string,
    reply: "once" | "always" | "reject"
  ) {
    // Intentional no-op: permission prompts grant session-scoped access only.
    // Persistent workspace roots must be managed explicitly via workspace settings.
    await respondPermission(requestID, reply);
  }

  openworkServerStore = createOpenworkServerStore({
    startupPreference,
    documentVisible,
    developerMode,
    runtimeWorkspaceId: () => workspaceStore?.runtimeWorkspaceId?.() ?? null,
    activeClient: client,
    selectedWorkspaceDisplay: () =>
      workspaceStore?.selectedWorkspaceDisplay?.() ?? ({ workspaceType: "local" } as WorkspaceDisplay),
    restartLocalServer,
    createRemoteWorkspaceFlow: async (input) =>
      (await workspaceStore?.createRemoteWorkspaceFlow?.(input)) ?? false,
  });

  const {
    openworkServerSettings,
    setOpenworkServerSettings,
    updateOpenworkServerSettings,
    resetOpenworkServerSettings,
    shareRemoteAccessBusy,
    shareRemoteAccessError,
    saveShareRemoteAccess,
    openworkServerUrl,
    openworkServerBaseUrl,
    openworkServerAuth,
    openworkServerClient,
    openworkServerStatus,
    openworkServerCapabilities,
    openworkServerReady,
    openworkServerWorkspaceReady,
    resolvedOpenworkCapabilities,
    openworkServerCanWriteSkills,
    openworkServerCanWritePlugins,
    openworkServerHostInfo,
    openworkServerDiagnostics,
    openworkReconnectBusy,
    opencodeRouterInfoState,
    orchestratorStatusState,
    openworkAuditEntries,
    openworkAuditStatus,
    openworkAuditError,
    testOpenworkServerConnection,
    reconnectOpenworkServer,
    ensureLocalOpenworkServerClient,
  } = openworkServerStore;

  const extensionsStore = createExtensionsStore({
    client,
    projectDir: () => workspaceProjectDir(),
    selectedWorkspaceId: () => workspaceStore?.selectedWorkspaceId?.() ?? "",
    selectedWorkspaceRoot: () => workspaceStore?.selectedWorkspaceRoot?.() ?? "",
    workspaceType: () => workspaceStore?.selectedWorkspaceDisplay?.().workspaceType ?? "local",
    openworkServer: openworkServerStore,
    runtimeWorkspaceId: () => workspaceStore?.runtimeWorkspaceId?.() ?? null,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
    markReloadRequired,
  });

  const {
    skills,
    skillsStatus,
    pluginScope,
    sidebarPluginList,
    sidebarPluginStatus,
    isPluginInstalledByName,
    refreshSkills,
    refreshHubSkills,
    refreshPlugins,
    addPlugin,
    abortRefreshes,
  } = extensionsStore;

  const connectionsStore = createConnectionsStore({
    client,
    setClient,
    projectDir: () => workspaceProjectDir(),
    selectedWorkspaceId: () => workspaceStore?.selectedWorkspaceId?.() ?? "",
    selectedWorkspaceRoot: () => workspaceStore?.selectedWorkspaceRoot?.() ?? "",
    workspaceType: () => workspaceStore?.selectedWorkspaceDisplay?.().workspaceType ?? "local",
    openworkServer: openworkServerStore,
    runtimeWorkspaceId: () => workspaceStore?.runtimeWorkspaceId?.() ?? null,
    ensureRuntimeWorkspaceId: () => workspaceStore?.ensureRuntimeWorkspaceId?.(),
    setProjectDir: (value: string) => workspaceStore?.setProjectDir?.(value),
    developerMode,
    markReloadRequired,
  });

  const { refreshMcpServers } = connectionsStore;

  const [hideTitlebar, setHideTitlebar] = createSignal(false);
  const {
    defaultModel,
    selectedSessionModel,
    selectedSessionModelLabel,
    defaultModelLabel,
    defaultModelRef,
    defaultModelVariantLabel,
    modelVariant,
    sessionModelVariantLabel,
    sessionModelBehaviorOptions,
    setSessionModelVariant,
    sanitizeModelVariantForRef,
    resolveCodexReasoningEffort,
    modelPickerOpen,
    modelPickerQuery,
    setModelPickerQuery,
    modelPickerTarget,
    modelPickerCurrent,
    modelOptions,
    filteredModelOptions,
    openSessionModelPicker,
    openDefaultModelPicker,
    closeModelPicker,
    applyModelSelection,
    setModelPickerBehavior,
    autoCompactContext,
    toggleAutoCompactContext,
    autoCompactContextSaving,
  } = modelConfig;

  workspaceStore = createWorkspaceStore({
    startupPreference,
    setStartupPreference,
    onboardingStep,
    setOnboardingStep,
    rememberStartupChoice,
    setRememberStartupChoice,
    baseUrl,
    setBaseUrl,
    clientDirectory,
    setClientDirectory,
    client,
    setClient,
    setConnectedVersion,
    setSseConnected,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setOpencodeConnectStatus,
    loadSessions: loadSessionsWithReady,
    refreshPendingPermissions,
    refreshWorkspaceSessions: (workspaceId: string) => refreshSidebarWorkspaceSessions(workspaceId),
    sessions,
    sessionsLoaded,
    creatingSession,
    readLastSessionByWorkspace: readSessionByWorkspace,
    selectedSessionId,
    selectSession,
    setBlueprintSeedMessagesBySessionId,
    setSelectedSessionId,
    setMessages,
    setTodos,
    setPendingPermissions,
    setSessionStatusById,
    defaultModel,
    modelVariant,
    refreshSkills,
    refreshPlugins,
    engineSource,
    engineCustomBinPath,
    opencodeEnableExa,
    setEngineSource,
    setView,
    setSettingsTab,
    isWindowsPlatform,
    openworkServer: openworkServerStore,
    openworkEnvWorkspaceId: envOpenworkWorkspaceId,
    onEngineStable: () => {},
    onBootPhaseChange: (phase, detail) => {
      setBootPhase(phase);
      markStartupTrace(phase, "phase-change", detail);
    },
    onStartupBranch: (branch, detail) => {
      setStartupBranch(branch);
      markStartupTrace(bootPhase(), "branch", { branch, ...(detail ?? {}) });
    },
    onStartupTrace: (event, detail) => {
      markStartupTrace(bootPhase(), event, detail);
    },
    engineRuntime,
    developerMode,
    pendingInitialSessionSelection,
    setPendingInitialSessionSelection,
  });

  createEffect(() => {
    if (startupBranch() !== "unknown") return;
    const active = workspaceStore.selectedWorkspaceInfo?.() ?? null;
    const derived = classifyStartupBranch({
      workspaceCount: workspaceStore.workspaces().length,
      activeWorkspaceType: active?.workspaceType ?? null,
      startupPreference: startupPreference(),
      engineHasBaseUrl: Boolean(workspaceStore.engine()?.baseUrl),
      selectedWorkspacePath: workspaceStore.selectedWorkspacePath?.() ?? "",
    });
    if (derived !== "unknown") {
      setStartupBranch(derived);
      markStartupTrace(bootPhase(), "branch-derived", { branch: derived });
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!developerMode()) return;
    const payload = {
      phase: bootPhase(),
      branch: startupBranch(),
      events: startupTrace(),
    };
    try {
      (window as { __openworkStartupTrace?: typeof payload }).__openworkStartupTrace = payload;
      console.log("[startup-trace]", payload);
    } catch {
      // ignore trace publishing failures
    }
  });

  const {
    providerAuthModalOpen,
    providerAuthBusy,
    providerAuthError,
    providerAuthMethods,
    providerAuthProviders,
    providerAuthPreferredProviderId,
    providerAuthWorkerType,
    cloudOrgProviders,
    importedCloudProviders,
    startProviderAuth,
    refreshProviders,
    refreshCloudOrgProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    connectCloudProvider,
    removeCloudProvider,
    disconnectProvider,
    openProviderAuthModal,
    closeProviderAuthModal,
  } = createProvidersStore({
    client,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviders: () => globalSync.data.config.disabled_providers ?? [],
    selectedWorkspaceDisplay: () => workspaceStore.selectedWorkspaceDisplay(),
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot(),
    runtimeWorkspaceId: () => workspaceStore.runtimeWorkspaceId(),
    openworkServer: openworkServerStore,
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setDisabledProviders: (value) => globalSync.set("config", "disabled_providers", value),
    markOpencodeConfigReloadRequired: () => markOpencodeConfigReloadRequired(),
    focusPromptSoon: focusSessionPromptSoon,
  });

  const runtimeWorkspaceId = createMemo(() => workspaceStore.runtimeWorkspaceId());
  const activeWorkspaceServerConfig = createMemo(() => workspaceStore.runtimeWorkspaceConfig());
  const statusToastsStore = createStatusToastsStore();
  const bundlesStore = createBundlesStore({
    booting,
    startupPreference,
    openworkServer: openworkServerStore,
    runtimeWorkspaceId,
    workspaceStore,
    setError,
    error,
    setView,
    setSettingsTab,
    refreshActiveWorkspaceServerConfig: workspaceStore.refreshRuntimeWorkspaceConfig,
    refreshSkills,
    refreshHubSkills,
    markReloadRequired,
    showStatusToast: statusToastsStore.showToast,
  });

  const deepLinks = createDeepLinksController({
    booting,
    setError,
    setView,
    setSettingsTab,
    goToSettings,
    workspaceStore,
    bundlesStore,
  });

  const sidebarSessionsStore = createSidebarSessionsStore({
    workspaces: () => workspaceStore.workspaces(),
    engine: () => workspaceStore.engine(),
  });

  const {
    workspaceGroups: rawSidebarWorkspaceGroups,
    refreshWorkspaceSessions: refreshSidebarWorkspaceSessions,
  } = sidebarSessionsStore;

  const sessionActionsStore = createSessionActionsStore({
    client,
    baseUrl,
    developerMode,
    prompt,
    setPrompt,
    selectedSessionId,
    selectedSession,
    sessions,
    messages,
    setSessions,
    sessionStatusById,
    setSessionStatusById,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setCreatingSession,
    setError,
    selectWorkspace: workspaceStore.selectWorkspace,
    workspaceRootForId: workspaceStore.workspaceRootForId,
    selectedWorkspaceId: () => workspaceStore.selectedWorkspaceId(),
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot(),
    runtimeWorkspaceRoot: () => workspaceStore.runtimeWorkspaceRoot(),
    ensureWorkspaceRuntime,
    selectSession,
    refreshSidebarWorkspaceSessions,
    abortRefreshes,
    modelConfig,
    selectedSessionModel: () => selectedSessionModel(),
    modelVariant,
    sanitizeModelVariantForRef: (ref, value) => sanitizeModelVariantForRef(ref, value),
    resolveCodexReasoningEffort: (modelId, variant) => resolveCodexReasoningEffort(modelId, variant),
    messageIdFromInfo,
    restorePromptFromUserMessage,
    upsertLocalSession,
    readSessionByWorkspace,
    writeSessionByWorkspace,
    setSelectedSessionId,
    locationPath: () => location.pathname,
    navigate,
    renameSession,
    appendSessionErrorTurn: sessionStore.appendSessionErrorTurn,
  });

  const {
    lastPromptSent,
    selectedSessionAgent,
    sessionRevertMessageId,
    createSessionInWorkspace,
    createSessionAndOpen,
    sendPrompt,
    abortSession,
    retryLastPrompt,
    compactCurrentSession,
    undoLastUserMessage,
    redoLastUserMessage,
    renameSessionTitle,
    deleteSessionById,
    listAgents,
    listCommands,
    setSessionAgent,
    searchWorkspaceFiles,
  } = sessionActionsStore;

  const sidebarWorkspaceGroups = createMemo<WorkspaceSessionGroup[]>(() => {
    const groups = rawSidebarWorkspaceGroups();
    const selectedWorkspaceId = workspaceStore.selectedWorkspaceId().trim();
    const connectingWorkspaceId = workspaceStore.connectingWorkspaceId()?.trim() ?? "";
    const dedupedGroups: typeof groups = [];
    const dedupeKeyToIndex = new Map<string, number>();
    for (const group of groups) {
      const workspace = group.workspace;
      if (workspace.workspaceType !== "remote") {
        dedupedGroups.push(group);
        continue;
      }
      const hostKey =
        normalizeOpenworkServerUrl(workspace.openworkHostUrl?.trim() ?? "") ??
        normalizeOpenworkServerUrl(workspace.baseUrl?.trim() ?? "") ??
        "";
      const workspaceIdKey =
        workspace.openworkWorkspaceId?.trim() ||
        parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
        parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
        "";
      const directoryKey = normalizeDirectoryPath(workspace.directory?.trim() ?? workspace.path?.trim() ?? "");
      const identityKey = workspaceIdKey ? `id:${workspaceIdKey}` : (directoryKey ? `dir:${directoryKey}` : "");
      if (!hostKey || !identityKey) {
        dedupedGroups.push(group);
        continue;
      }
      const dedupeKey = `${workspace.remoteType ?? ""}|${hostKey}|${identityKey}`;
      const existingIndex = dedupeKeyToIndex.get(dedupeKey);
      if (existingIndex === undefined) {
        dedupeKeyToIndex.set(dedupeKey, dedupedGroups.length);
        dedupedGroups.push(group);
        continue;
      }
      const existingWorkspace = dedupedGroups[existingIndex].workspace;
      const existingIsPriority =
        existingWorkspace.id === selectedWorkspaceId || existingWorkspace.id === connectingWorkspaceId;
      const currentIsPriority =
        workspace.id === selectedWorkspaceId || workspace.id === connectingWorkspaceId;
      if (currentIsPriority && !existingIsPriority) {
        dedupedGroups[existingIndex] = group;
      }
    }
    return dedupedGroups.map((group) => {
      const workspace = group.workspace;
      const groupSessions = group.sessions;
      if (developerMode()) {
        console.log("[sidebar-groups] workspace group", {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceType: workspace.workspaceType,
          workspacePath: workspace.path,
          workspaceDirectory: workspace.directory,
          sessionCount: groupSessions.length,
          sessions: groupSessions.map((session) => ({
            id: session.id,
            title: session.title,
            directory: session.directory,
            parentID: session.parentID,
          })),
        });
      }
      return {
        workspace,
        sessions: groupSessions,
        status: group.status,
        error: group.error,
      };
    });
  });

  const hydratedSidebarWorkspaceGroups = createMemo<WorkspaceSessionGroup[]>(() => {
    const liveGroups = sidebarWorkspaceGroups();
    if (liveGroups.some((group) => group.sessions.length > 0)) {
      return liveGroups;
    }

    const snapshotByWorkspaceId = startupSessionSnapshotByWorkspaceId();
    if (!snapshotByWorkspaceId || Object.keys(snapshotByWorkspaceId).length === 0) {
      return liveGroups;
    }

    return liveGroups.map((group) => {
      if (group.sessions.length > 0) return group;
      const cachedSessions = snapshotByWorkspaceId[group.workspace.id] ?? [];
      if (!cachedSessions.length) return group;
      return {
        ...group,
        sessions: cachedSessions,
      };
    });
  });

  const sidebarHydratedFromCache = createMemo(() => {
    const liveGroups = sidebarWorkspaceGroups();
    const hydratedGroups = hydratedSidebarWorkspaceGroups();
    if (!hydratedGroups.length) return false;
    if (liveGroups.length !== hydratedGroups.length) return false;
    return hydratedGroups.some((group, index) => {
      const liveGroup = liveGroups[index];
      if (!liveGroup) return false;
      return liveGroup.sessions.length === 0 && group.sessions.length > 0;
    });
  });

  createEffect(() => {
    if (firstSidebarVisibleAt()) return;
    const anyRowsVisible = hydratedSidebarWorkspaceGroups().some((group) => group.sessions.length > 0);
    if (!anyRowsVisible) return;
    const at = Date.now();
    setFirstSidebarVisibleAt(at);
    markStartupTrace(bootPhase(), "first-sidebar-visible", {
      at,
      source: sidebarHydratedFromCache() ? "cache" : "live",
    });
  });

  createEffect(() => {
    if (firstSessionPaintAt()) return;
    if (currentView() !== "session") return;
    const selected = activeSessionId();
    if (!selected) return;
    const hasVisibleSessionSurface = visibleMessages().length > 0 || sessionsLoaded();
    if (!hasVisibleSessionSurface) return;
    const at = Date.now();
    setFirstSessionPaintAt(at);
    markStartupTrace(bootPhase(), "first-session-paint", { at, sessionId: selected });
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!sessionsLoaded()) return;

    const groups = sidebarWorkspaceGroups();
    const sessionsByWorkspaceId: Record<string, StartupSessionSnapshotEntry[]> = {};
    for (const group of groups) {
      if (!group.sessions.length) continue;
      sessionsByWorkspaceId[group.workspace.id] = group.sessions
        .slice(0, STARTUP_SESSION_SNAPSHOT_MAX_PER_WORKSPACE)
        .map((session) => ({
          id: session.id,
          title: session.title,
          parentID: session.parentID ?? null,
          directory: session.directory ?? null,
          time: session.time,
        }));
    }
    if (Object.keys(sessionsByWorkspaceId).length === 0) return;

    const payload: StartupSessionSnapshot = {
      version: STARTUP_SESSION_SNAPSHOT_VERSION,
      updatedAt: Date.now(),
      sessionsByWorkspaceId,
    };

    try {
      window.localStorage.setItem(STARTUP_SESSION_SNAPSHOT_KEY, JSON.stringify(payload));
      setStartupSessionSnapshotByWorkspaceId(sessionsByWorkspaceId);
    } catch {
      // ignore storage write failures
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.selectedWorkspaceId();
    const sessionId = selectedSessionId();
    if (!workspaceId || !sessionId) return;
    const map = readSessionByWorkspace();
    if (map[workspaceId] === sessionId) return;
    map[workspaceId] = sessionId;
    writeSessionByWorkspace(map);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const pending = pendingInitialSessionSelection();
    if (!pending) return;
    const delayMs = pending.readyAt - Date.now();
    if (delayMs <= 0) return;
    const timer = window.setTimeout(() => {
      setPendingInitialSessionSelection((current) =>
        current && current.workspaceId === pending.workspaceId && current.readyAt === pending.readyAt
          ? { ...current }
          : current,
      );
    }, delayMs);
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    const pending = pendingInitialSessionSelection();
    if (!pending) return;
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    if (!workspaceId || pending.workspaceId !== workspaceId) return;
    const path = location.pathname.trim().toLowerCase();
    if (path.startsWith("/session/") || !!selectedSessionId()) {
      setPendingInitialSessionSelection(null);
    }
  });

  createEffect(() => {
    // Only auto-select on bare /session. If the URL already includes /session/:id,
    // let the route-driven selector own the fetch to avoid duplicate selection runs.
    const pending = pendingInitialSessionSelection();
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    if (pending && pending.workspaceId === workspaceId) {
      if (Date.now() < pending.readyAt) return;
      if (!sessionsLoaded()) return;
      if (sessions().length === 0) return;
      const workspaceRoot = normalizeDirectoryPath(workspaceStore.selectedWorkspaceRoot().trim());
      const normalizedTitle = pending.title?.trim().toLowerCase() ?? "";
      const match = normalizedTitle
        ? sessions().find((session) => {
            const sessionTitle = session.title?.trim().toLowerCase() ?? "";
            if (sessionTitle !== normalizedTitle) return false;
            if (!workspaceRoot) return true;
            const sessionRoot = normalizeDirectoryPath(typeof session.directory === "string" ? session.directory : "");
            return sessionRoot === workspaceRoot;
          })
        : null;
      if (match) {
        goToSession(match.id, { replace: true });
        return;
      }
      setPendingInitialSessionSelection(null);
      setView("session");
      return;
    }

    if (currentView() !== "session") return;
    const normalizedPath = location.pathname.toLowerCase().replace(/\/+$/, "");
    if (normalizedPath !== "/session") return;
    if (!client()) return;
    if (!sessionsLoaded()) return;
    if (creatingSession()) return;
    if (selectedSessionId()) return;

    // Keep /session as a draft-ready empty state until the user picks a session
    // or sends a prompt. Avoid auto-selecting prior sessions on app launch.
    return;
  });

  createEffect(() => {
    const active = workspaceStore.selectedWorkspaceDisplay();
    if (active.workspaceType !== "remote" || active.remoteType !== "openwork") {
      return;
    }
    const hostUrl = active.openworkHostUrl?.trim() ?? "";
    if (!hostUrl) return;
    const token = active.openworkToken?.trim() ?? "";
    const settings = openworkServerSettings();
    if (settings.urlOverride?.trim() === hostUrl && (!token || settings.token?.trim() === token)) {
      return;
    }
    updateOpenworkServerSettings({
      ...settings,
      urlOverride: hostUrl,
      token: token || settings.token,
    });
  });

  async function restartLocalServer() {
    const activeWorkspace = workspaceStore.selectedWorkspaceDisplay();
    const activeLocalPath =
      activeWorkspace.workspaceType === "local" ? workspaceStore.selectedWorkspacePath().trim() : "";
    const runningProjectDir = workspaceStore.engine()?.projectDir?.trim() ?? "";
    const workspacePath = activeLocalPath || runningProjectDir;

    if (!workspacePath) {
      setError(t("app.error_pick_local_folder"));
      return false;
    }

    return workspaceStore.startHost({ workspacePath, navigate: false });
  }

  const canReloadLocalEngine = () =>
    isTauriRuntime() && workspaceStore.selectedWorkspaceDisplay().workspaceType === "local";

  const canReloadWorkspace = createMemo(() => {
    if (canReloadLocalEngine()) return true;
    if (workspaceStore.selectedWorkspaceDisplay().workspaceType !== "remote") return false;
    return openworkServerStatus() === "connected" && Boolean(openworkServerClient() && runtimeWorkspaceId());
  });

  const reloadWorkspaceEngineFromUi = async () => {
    if (canReloadLocalEngine()) {
      return workspaceStore.reloadWorkspaceEngine();
    }

    if (workspaceStore.selectedWorkspaceDisplay().workspaceType !== "remote") {
      return false;
    }

    const client = openworkServerClient();
    const workspaceId = runtimeWorkspaceId();
    if (!client || !workspaceId || openworkServerStatus() !== "connected") {
      setError(t("app.error_connect_first"));
      return false;
    }

    try {
      await client.reloadEngine(workspaceId);
      await workspaceStore.activateWorkspace(workspaceStore.selectedWorkspaceId());
      await refreshMcpServers();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : t("app.error_runtime_changes");
      setError(message);
      return false;
    }
  };

  const systemState = createSystemState({
    client,
    sessions,
    sessionStatusById,
    refreshPlugins,
    refreshSkills,
    refreshMcpServers,
    reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
    canReloadWorkspaceEngine: () => canReloadWorkspace(),
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setError,
  });

  const {
    reloadPending,
    reloadCopy,
    reloadTrigger,
    reloadBusy,
    reloadError,
    reloadWorkspaceEngine,
    clearReloadRequired,
    cacheRepairBusy,
    cacheRepairResult,
    repairOpencodeCache,
    dockerCleanupBusy,
    dockerCleanupResult,
    cleanupOpenworkDockerContainers,
    updateAutoCheck,
    setUpdateAutoCheck,
    updateAutoDownload,
    setUpdateAutoDownload,
    updateStatus,
    setUpdateStatus,
    pendingUpdate,
    updateEnv,
    setUpdateEnv,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
    resetModalOpen,
    setResetModalOpen,
    resetModalMode,
    resetModalText,
    setResetModalText,
    resetModalBusy,
    openResetModal,
    confirmReset,
    anyActiveRuns,
  } = systemState;

  markReloadRequiredHandler = systemState.markReloadRequired;

  const UPDATE_AUTO_CHECK_EVERY_MS = 12 * 60 * 60_000;
  const UPDATE_AUTO_CHECK_POLL_MS = 60_000;

  const resetAppConfigDefaults = async () => {
    try {
      setThemeMode("system");
      setEngineSource(isTauriRuntime() ? "sidecar" : "path");
      setEngineCustomBinPath("");
      setEngineRuntime("openwork-orchestrator");
      modelConfig.resetAppDefaults();
      resetSessionDisplayPreferences();
      setHideTitlebar(false);
      setUpdateAutoCheck(true);
      setUpdateAutoDownload(false);
      setUpdateStatus({ state: "idle", lastCheckedAt: null });
      setDeveloperMode(false);

      clearStartupPreference();
      setStartupPreference(null);
      setRememberStartupChoice(false);

      resetOpenworkServerSettings();

      return { ok: true, message: t("app.reset_config_ok") };
    } catch (error) {
      const message = error instanceof Error ? error.message : t("app.error_reset_config");
      return { ok: false, message };
    }
  };

  const getUpdateLastCheckedAt = (state: ReturnType<typeof updateStatus>) => {
    if (state.state === "checking") return null;
    return state.lastCheckedAt ?? null;
  };

  const shouldAutoCheckForUpdates = () => {
    const state = updateStatus();
    const lastCheckedAt = getUpdateLastCheckedAt(state);
    if (!lastCheckedAt) return true;
    return Date.now() - lastCheckedAt >= UPDATE_AUTO_CHECK_EVERY_MS;
  };

  const isActiveSessionStatus = (status: string | null | undefined) =>
    status === "running" || status === "retry";

  const reloadRequired = (...sources: ReloadTrigger["type"][]) => {
    if (!reloadPending()) return false;
    const triggerType = reloadTrigger()?.type;
    if (!triggerType) return false;
    if (!sources.length) return true;
    return sources.includes(triggerType);
  };

  const markOpencodeConfigReloadRequired = () => {
    markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
  };

  const activeReloadBlockingSessions = createMemo(() => {
    const statuses = sessionStatusById();
    return sessions()
      .filter((session) => isActiveSessionStatus(statuses[session.id]))
      .map((session) => ({
        id: session.id,
        title: session.title?.trim() || session.slug?.trim() || session.id,
      }));
  });

  const forceStopActiveSessionsAndReload = async () => {
    const activeSessions = activeReloadBlockingSessions();
    for (const session of activeSessions) {
      try {
        await abortSession(session.id);
      } catch {
        // ignore and continue stopping the rest before reload
      }
    }
    await reloadWorkspaceEngine();
  };

  const {
    projectDir: workspaceProjectDir,
    stopHost,
  } = workspaceStore;

  const schedulerPluginInstalled = createMemo(() => isPluginInstalledByName("opencode-scheduler"));

  const automationsStore = createAutomationsStore({
    selectedWorkspaceId: () => workspaceStore.selectedWorkspaceId(),
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot(),
    runtimeWorkspaceId,
    openworkServer: openworkServerStore,
    schedulerPluginInstalled,
  });

  const {
    scheduledJobsPollingAvailable,
    refreshScheduledJobs,
  } = automationsStore;

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (currentView() !== "settings") return;
    if (settingsTab() !== "automations") return;
    if (!documentVisible()) return;

    const pollingAvailable = scheduledJobsPollingAvailable();
    const startedAt = Date.now();
    let active = true;
    let failureCount = 0;
    let timeoutId: number | undefined;

    const clearTimer = () => {
      if (timeoutId == null) return;
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    };

    const nextDelayMs = () => {
      const baseDelay = Date.now() - startedAt < 60_000 ? 5_000 : 15_000;
      if (failureCount <= 0) return baseDelay;
      return Math.min(baseDelay * 2 ** failureCount, 60_000);
    };

    const scheduleNext = () => {
      clearTimer();
      if (!active || !pollingAvailable) return;
      timeoutId = window.setTimeout(() => {
        void run("poll");
      }, nextDelayMs());
    };

    const run = async (_reason: "initial" | "focus" | "poll") => {
      if (!active) return;
      const result = await refreshScheduledJobs();
      if (!active) return;

      if (result === "error") {
        failureCount += 1;
      } else if (result === "success" || result === "unavailable") {
        failureCount = 0;
      }

      scheduleNext();
    };

    const handleFocus = () => {
      clearTimer();
      void run("focus");
    };

    void run("initial");
    window.addEventListener("focus", handleFocus);

    onCleanup(() => {
      active = false;
      clearTimer();
      window.removeEventListener("focus", handleFocus);
    });
  });

  const selectedWorkspaceDisplay = createMemo(() => workspaceStore.selectedWorkspaceDisplay());
  const resolvedActiveWorkspaceConfig = createMemo(
    () => activeWorkspaceServerConfig() ?? workspaceStore.workspaceConfig(),
  );
  const activePermissionMemo = createMemo(() => activePermission());

  const [expandedStepIds, setExpandedStepIds] = createSignal<Set<string>>(
    new Set()
  );
  const [autoConnectAttempted, setAutoConnectAttempted] = createSignal(false);

  const [appVersion, setAppVersion] = createSignal<string | null>(null);
  const [launchUpdateCheckTriggered, setLaunchUpdateCheckTriggered] = createSignal(false);


  const busySeconds = createMemo(() => {
    const start = busyStartedAt();
    if (!start) return 0;
    return Math.max(0, Math.round((Date.now() - start) / 1000));
  });

  const newTaskDisabled = createMemo(() => {
    if (!client()) {
      return true;
    }

    const label = busyLabel();
    // Allow creating a new session even while a run is in progress.
    if (busy() && label === "status.running") return false;

    // Otherwise, block during engine / connection transitions.
    if (
      busy() &&
      (label === "status.connecting" ||
        label === "status.starting_engine" ||
        label === "status.disconnecting")
    ) {
      return true;
    }

    return busy();
  });

  createEffect(() => {
    if (isTauriRuntime()) return;
    if (autoConnectAttempted()) return;
    if (client()) return;
    if (openworkServerStatus() !== "connected") return;

    const settings = openworkServerSettings();
    if (!settings.urlOverride || !settings.token) return;

    setAutoConnectAttempted(true);
    void workspaceStore.onConnectClient();
  });

  function openSettingsFromModelPicker() {
    setSettingsTab("general");
    setView("settings");
  }


  onMount(async () => {
    const startupPref = readStartupPreference();
    if (startupPref) {
      setRememberStartupChoice(true);
      setStartupPreference(startupPref);
    }

    const unsubscribeTheme = subscribeToSystemTheme((isDark) => {
      if (themeMode() !== "system") return;
      applyThemeMode(isDark ? "dark" : "light");
    });

    onCleanup(() => {
      unsubscribeTheme();
    });

    createEffect(() => {
      const next = themeMode();
      persistThemeMode(next);
      applyThemeMode(next);
    });

    if (typeof window !== "undefined") {
      try {
        // In Tauri/desktop mode, do NOT restore the cached baseUrl from localStorage.
        // OpenCode is assigned a random port on every restart, so the stored URL is
        // always stale after a relaunch. The correct baseUrl is provided by engine_info().
        // Web mode still needs the cached value since it connects to a fixed server URL.
        if (!isTauriRuntime()) {
          const storedBaseUrl = window.localStorage.getItem("openwork.baseUrl");
          if (storedBaseUrl) {
            setBaseUrl(storedBaseUrl);
          }
        }

        const storedClientDir = window.localStorage.getItem(
          "openwork.clientDirectory"
        );
        if (storedClientDir) {
          setClientDirectory(storedClientDir);
        }

        const storedEngineSource = window.localStorage.getItem(
          "openwork.engineSource"
        );
        const storedEngineCustomBinPath = window.localStorage.getItem(
          "openwork.engineCustomBinPath"
        );
        if (storedEngineCustomBinPath) {
          setEngineCustomBinPath(storedEngineCustomBinPath);
        }
        if (
          storedEngineSource === "path" ||
          storedEngineSource === "sidecar" ||
          storedEngineSource === "custom"
        ) {
          if (storedEngineSource === "custom" && !(storedEngineCustomBinPath ?? "").trim()) {
            setEngineSource(isTauriRuntime() ? "sidecar" : "path");
          } else {
            setEngineSource(storedEngineSource);
          }
        }

        const storedEngineRuntime = window.localStorage.getItem(
          "openwork.engineRuntime"
        );
        if (storedEngineRuntime === "direct" || storedEngineRuntime === "openwork-orchestrator") {
          setEngineRuntime(storedEngineRuntime);
        }

        const storedOpencodeEnableExa = window.localStorage.getItem(
          "openwork.opencodeEnableExa"
        );
        if (storedOpencodeEnableExa === "0" || storedOpencodeEnableExa === "1") {
          setOpencodeEnableExa(storedOpencodeEnableExa === "1");
        }

        const storedHideTitlebar = window.localStorage.getItem(HIDE_TITLEBAR_PREF_KEY);
        if (storedHideTitlebar != null) {
          try {
            const parsed = JSON.parse(storedHideTitlebar);
            if (typeof parsed === "boolean") {
              setHideTitlebar(parsed);
            }
          } catch {
            // ignore
          }
        }

        const storedUpdateAutoCheck = window.localStorage.getItem(
          "openwork.updateAutoCheck"
        );
        if (storedUpdateAutoCheck === "0" || storedUpdateAutoCheck === "1") {
          setUpdateAutoCheck(storedUpdateAutoCheck === "1");
        }

        const storedUpdateAutoDownload = window.localStorage.getItem(
          "openwork.updateAutoDownload"
        );
        if (storedUpdateAutoDownload === "0" || storedUpdateAutoDownload === "1") {
          const enabled = storedUpdateAutoDownload === "1";
          setUpdateAutoDownload(enabled);
          if (enabled) {
            setUpdateAutoCheck(true);
          }
        }

        const storedUpdateCheckedAt = window.localStorage.getItem(
          "openwork.updateLastCheckedAt"
        );
        if (storedUpdateCheckedAt) {
          const parsed = Number(storedUpdateCheckedAt);
          if (Number.isFinite(parsed) && parsed > 0) {
            setUpdateStatus({ state: "idle", lastCheckedAt: parsed });
          }
        }

        await refreshMcpServers();
      } catch {
        // ignore
      }
    }

    if (isTauriRuntime()) {
      try {
        setAppVersion(await getVersion());
      } catch {
        // ignore
      }

      try {
        setUpdateEnv(await updaterEnvironment());
      } catch {
        // ignore
      }

      if (!launchUpdateCheckTriggered()) {
        setLaunchUpdateCheckTriggered(true);
        checkForUpdates({ quiet: true }).catch(() => undefined);
      }
    }

    if (typeof window !== "undefined") {
        const handleDeepLinkEvent = (event: Event) => {
          const detail = (event as CustomEvent<DeepLinkBridgeDetail>).detail;
          deepLinks.consumeDeepLinks(detail?.urls ?? []);
        };

        deepLinks.consumeDeepLinks(drainPendingDeepLinks(window));
        window.addEventListener(deepLinkBridgeEvent, handleDeepLinkEvent as EventListener);
      onCleanup(() => {
        window.removeEventListener(deepLinkBridgeEvent, handleDeepLinkEvent as EventListener);
      });
    }

    void workspaceStore.bootstrapOnboarding();
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (onboardingStep() !== "local") return;
    void workspaceStore.refreshEngineDoctor();
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.baseUrl", baseUrl());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.clientDirectory",
        clientDirectory()
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    // Legacy key: keep for backwards compatibility.
    try {
      window.localStorage.setItem("openwork.projectDir", workspaceProjectDir());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.engineSource", engineSource());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const value = engineCustomBinPath().trim();
      if (value) {
        window.localStorage.setItem("openwork.engineCustomBinPath", value);
      } else {
        window.localStorage.removeItem("openwork.engineCustomBinPath");
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("openwork.engineRuntime", engineRuntime());
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.opencodeEnableExa",
        opencodeEnableExa() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.updateAutoCheck",
        updateAutoCheck() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "openwork.updateAutoDownload",
        updateAutoDownload() ? "1" : "0"
      );
    } catch {
      // ignore
    }
  });

  // Persist and apply hideTitlebar setting
  createEffect(() => {
    if (typeof window === "undefined") return;
    const hide = hideTitlebar();
    try {
      window.localStorage.setItem(HIDE_TITLEBAR_PREF_KEY, JSON.stringify(hide));
    } catch {
      // ignore
    }
    // Apply to window decorations (only in Tauri desktop environment)
    if (isTauriRuntime()) {
      setWindowDecorations(!hide).catch(() => {
        // ignore errors (e.g., window not ready)
      });
    }
  });

  createEffect(() => {
    const state = updateStatus();
    if (typeof window === "undefined") return;
    if (state.state === "idle" && state.lastCheckedAt) {
      try {
        window.localStorage.setItem(
          "openwork.updateLastCheckedAt",
          String(state.lastCheckedAt)
        );
      } catch {
        // ignore
      }
    }
  });

  createEffect(() => {
    if (booting()) return;
    if (!isTauriRuntime()) return;
    if (launchUpdateCheckTriggered()) return;

    const state = updateStatus();
    if (state.state === "checking" || state.state === "downloading") return;

    setLaunchUpdateCheckTriggered(true);
    checkForUpdates({ quiet: true }).catch(() => undefined);
  });

  createEffect(() => {
    if (booting()) return;
    if (typeof window === "undefined") return;
    if (!isTauriRuntime()) return;
    if (!launchUpdateCheckTriggered()) return;
    if (!updateAutoCheck()) return;

    const maybeRunAutoUpdateCheck = () => {
      if (!updateAutoCheck()) return;
      const state = updateStatus();
      if (state.state === "checking" || state.state === "downloading") return;
      if (!shouldAutoCheckForUpdates()) return;
      checkForUpdates({ quiet: true }).catch(() => undefined);
    };

    const interval = window.setInterval(maybeRunAutoUpdateCheck, UPDATE_AUTO_CHECK_POLL_MS);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!updateAutoDownload()) return;

    const state = updateStatus();
    if (state.state !== "available") return;
    if (!pendingUpdate()) return;

    downloadUpdate().catch(() => undefined);
  });

  const headerConnectedVersion = createMemo(() => {
    const fallbackVersion = connectedVersion()?.trim() ?? "";
    if (!developerMode()) {
      return fallbackVersion || null;
    }

    const openworkVersion =
      appVersion()?.trim() ||
      openworkServerDiagnostics()?.version?.trim() ||
      "";
    if (!openworkVersion) {
      return fallbackVersion || null;
    }

    const normalizedVersion = openworkVersion.startsWith("v")
      ? openworkVersion
      : `v${openworkVersion}`;
    return `OpenWork ${normalizedVersion}`;
  });

  const headerStatus = createMemo(() => {
    if (!client() || !headerConnectedVersion()) return t("status.disconnected", currentLocale());
    const bits = [`${t("status.connected", currentLocale())} · ${headerConnectedVersion()}`];
    if (sseConnected()) bits.push(t("status.live", currentLocale()));
    return bits.join(" · ");
  });

  const busyHint = createMemo(() => {
    if (!busy() || !busyLabel()) return null;
    const seconds = busySeconds();
    const label = t(busyLabel()!, currentLocale());
    return seconds > 0 ? `${label} · ${seconds}s` : label;
  });

  const modelControlsStore = createModelControlsStore({
    selectedSessionModelLabel,
    openSessionModelPicker,
    sessionModelVariantLabel,
    sessionModelVariant: modelVariant,
    sessionModelBehaviorOptions,
    setSessionModelVariant,
    defaultModelLabel,
    defaultModelRef,
    openDefaultModelPicker,
    autoCompactContext,
    toggleAutoCompactContext,
    autoCompactContextBusy: autoCompactContextSaving,
    defaultModelVariantLabel,
    editDefaultModelVariant: openDefaultModelPicker,
  });

  const settingsShellProps = () => {
    const workspaceType = selectedWorkspaceDisplay().workspaceType;
    const isRemoteWorkspace = workspaceType === "remote";
    const openworkStatus = openworkServerStatus();
    const canUseDesktopTools = isTauriRuntime() && !isRemoteWorkspace;
    const canInstallSkillCreator = isRemoteWorkspace
      ? openworkServerCanWriteSkills()
      : isTauriRuntime();
    const canEditPlugins = isRemoteWorkspace
      ? openworkServerCanWritePlugins()
      : isTauriRuntime();
    const canUseGlobalPluginScope = !isRemoteWorkspace && isTauriRuntime();
    const skillsAccessHint = isRemoteWorkspace
      ? openworkStatus === "disconnected"
        ? t("app.skills_hint_disconnected")
        : openworkStatus === "limited"
          ? t("app.skills_hint_limited")
          : openworkServerCanWriteSkills()
            ? null
            : t("app.skills_hint_readonly")
      : null;
    const pluginsAccessHint = isRemoteWorkspace
      ? openworkStatus === "disconnected"
        ? t("app.plugins_hint_disconnected")
        : openworkStatus === "limited"
          ? t("app.plugins_hint_limited")
          : openworkServerCanWritePlugins()
            ? null
            : t("app.plugins_hint_readonly")
      : null;

    return {
      settingsTab: settingsTab(),
      setSettingsTab,
      providers: providers(),
      providerConnectedIds: providerConnectedIds(),
      providerAuthBusy: providerAuthBusy(),
      providerAuthModalOpen: providerAuthModalOpen(),
      providerAuthError: providerAuthError(),
      providerAuthMethods: providerAuthMethods(),
      providerAuthProviders: providerAuthProviders(),
      providerAuthPreferredProviderId: providerAuthPreferredProviderId(),
      providerAuthWorkerType: providerAuthWorkerType(),
      cloudOrgProviders: cloudOrgProviders(),
      importedCloudProviders: importedCloudProviders(),
      openProviderAuthModal,
      disconnectProvider,
      removeCloudProvider,
      closeProviderAuthModal,
      startProviderAuth,
      completeProviderAuthOAuth,
      refreshProviders,
      refreshCloudOrgProviders,
      submitProviderApiKey,
      connectCloudProvider,
      setView,
      toggleSettings: () => toggleSettingsView("general"),
      startupPreference: startupPreference(),
      baseUrl: baseUrl(),
      clientConnected: Boolean(client()),
      busy: busy(),
      busyHint: busyHint(),
      newTaskDisabled: newTaskDisabled(),
      headerStatus: headerStatus(),
      error: error(),
      openworkServerStatus: openworkStatus,
      openworkServerUrl: openworkServerUrl(),
      openworkServerClient: openworkServerClient(),
      openworkReconnectBusy: openworkReconnectBusy(),
      reconnectOpenworkServer,
      openworkServerSettings: openworkServerSettings(),
      openworkServerHostInfo: openworkServerHostInfo(),
      shareRemoteAccessBusy: shareRemoteAccessBusy(),
      shareRemoteAccessError: shareRemoteAccessError(),
      saveShareRemoteAccess,
      openworkServerCapabilities: openworkServerCapabilities(),
      openworkServerDiagnostics: openworkServerDiagnostics(),
      runtimeWorkspaceId: runtimeWorkspaceId(),
      activeWorkspaceType: workspaceStore.selectedWorkspaceDisplay().workspaceType,
      openworkAuditEntries: openworkAuditEntries(),
      openworkAuditStatus: openworkAuditStatus(),
      openworkAuditError: openworkAuditError(),
      opencodeConnectStatus: opencodeConnectStatus(),
      engineInfo: workspaceStore.engine(),
      orchestratorStatus: orchestratorStatusState(),
      opencodeRouterInfo: opencodeRouterInfoState(),
      engineDoctorVersion: workspaceStore.engineDoctorResult()?.version ?? null,
      updateOpenworkServerSettings,
      resetOpenworkServerSettings,
      testOpenworkServerConnection,
      canReloadWorkspace: canReloadWorkspace(),
      reloadWorkspaceEngine,
      reloadBusy: reloadBusy(),
      reloadError: reloadError(),
      selectedWorkspaceDisplay: selectedWorkspaceDisplay(),
      workspaces: workspaceStore.workspaces(),
      selectedWorkspaceId: workspaceStore.selectedWorkspaceId(),
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
      workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
      selectWorkspace: workspaceStore.selectWorkspace,
      switchWorkspace: workspaceStore.switchWorkspace,
      testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
      recoverWorkspace: workspaceStore.recoverWorkspace,
      openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
      connectRemoteWorkspace: workspaceStore.createRemoteWorkspaceFlow,
      openTeamBundle: bundlesStore.openTeamBundle,
      exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
      exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
      createWorkspaceOpen: workspaceStore.createWorkspaceOpen(),
      setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
      createWorkspaceFlow: workspaceStore.createWorkspaceFlow,
      pickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
      workspaceSessionGroups: hydratedSidebarWorkspaceGroups(),
      selectedSessionId: activeSessionId(),
      openRenameWorkspace: workspaceStore.openRenameWorkspace,
      editWorkspaceConnection: workspaceStore.openWorkspaceConnectionSettings,
      forgetWorkspace: workspaceStore.forgetWorkspace,
      schedulerPluginInstalled: schedulerPluginInstalled(),
      selectedWorkspaceRoot: workspaceStore.selectedWorkspaceRoot().trim(),
      skillsAccessHint,
      canInstallSkillCreator,
      canUseDesktopTools,
      pluginsAccessHint,
      canEditPlugins,
      canUseGlobalPluginScope,
      suggestedPlugins: SUGGESTED_PLUGINS,
      addPlugin,
      createSessionInWorkspace,
      createSessionAndOpen,
      hideTitlebar: hideTitlebar(),
      toggleHideTitlebar: () => setHideTitlebar((v) => !v),
      updateAutoCheck: updateAutoCheck(),
      toggleUpdateAutoCheck: () => setUpdateAutoCheck((v) => !v),
      updateAutoDownload: updateAutoDownload(),
      toggleUpdateAutoDownload: () =>
        setUpdateAutoDownload((v) => {
          const next = !v;
          if (next) {
            setUpdateAutoCheck(true);
          }
          return next;
        }),
      updateStatus: updateStatus(),
      updateEnv: updateEnv(),
      appVersion: appVersion(),
      checkForUpdates: () => checkForUpdates(),
      downloadUpdate: () => downloadUpdate(),
      installUpdateAndRestart,
      anyActiveRuns: anyActiveRuns(),
      engineSource: engineSource(),
      setEngineSource,
      engineCustomBinPath: engineCustomBinPath(),
      setEngineCustomBinPath,
      engineRuntime: engineRuntime(),
      setEngineRuntime,
      opencodeEnableExa: opencodeEnableExa(),
      toggleOpencodeEnableExa: () => setOpencodeEnableExa((v) => !v),
      isWindows: isWindowsPlatform(),
      toggleDeveloperMode: () => setDeveloperMode((v) => !v),
      developerMode: developerMode(),
      stopHost,
      restartLocalServer,
      openResetModal,
      resetModalBusy: resetModalBusy(),
      onResetStartupPreference: () => {
        clearStartupPreference();
        setStartupPreference(null);
        setRememberStartupChoice(false);
      },
      themeMode: themeMode(),
      setThemeMode,
      pendingPermissions: pendingPermissions(),
      events: events(),
      workspaceDebugEvents: workspaceStore.workspaceDebugEvents(),
      sandboxCreateProgress: workspaceStore.sandboxCreateProgress(),
      sandboxCreateProgressLast: workspaceStore.lastSandboxCreateProgress(),
      clearWorkspaceDebugEvents: workspaceStore.clearWorkspaceDebugEvents,
      safeStringify,
      repairOpencodeCache,
      cacheRepairBusy: cacheRepairBusy(),
      cacheRepairResult: cacheRepairResult(),
      cleanupOpenworkDockerContainers,
      dockerCleanupBusy: dockerCleanupBusy(),
      dockerCleanupResult: dockerCleanupResult(),
      markOpencodeConfigReloadRequired,
      resetAppConfigDefaults,
      openDebugDeepLink: deepLinks.openDebugDeepLink,
      language: currentLocale(),
      setLanguage: setLocale,
    };
  };

  const sessionProps = () => ({
    providerAuthWorkerType: providerAuthWorkerType(),
    selectedSessionId: activeSessionId(),
    setView,
    setSettingsTab,
    toggleSettings: () => toggleSettingsView("general"),
    selectedWorkspaceDisplay: selectedWorkspaceDisplay(),
    selectedWorkspaceRoot: workspaceStore.selectedWorkspaceRoot().trim(),
    activeWorkspaceConfig: resolvedActiveWorkspaceConfig(),
    workspaces: workspaceStore.workspaces(),
    selectedWorkspaceId: workspaceStore.selectedWorkspaceId(),
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
    selectWorkspace: workspaceStore.selectWorkspace,
    switchWorkspace: workspaceStore.switchWorkspace,
    testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
    recoverWorkspace: workspaceStore.recoverWorkspace,
    editWorkspaceConnection: workspaceStore.openWorkspaceConnectionSettings,
    forgetWorkspace: workspaceStore.forgetWorkspace,
    openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
    exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
    exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
    clientConnected: Boolean(client()),
    openworkServerStatus: openworkServerStatus(),
    openworkServerClient: openworkServerClient(),
    openworkServerDiagnostics: openworkServerDiagnostics(),
    openworkServerSettings: openworkServerSettings(),
    openworkServerHostInfo: openworkServerHostInfo(),
    shareRemoteAccessBusy: shareRemoteAccessBusy(),
    shareRemoteAccessError: shareRemoteAccessError(),
    saveShareRemoteAccess,
    runtimeWorkspaceId: runtimeWorkspaceId(),
    engineInfo: workspaceStore.engine(),
    engineDoctorVersion: workspaceStore.engineDoctorResult()?.version ?? null,
    orchestratorStatus: orchestratorStatusState(),
    opencodeRouterInfo: opencodeRouterInfoState(),
    appVersion: appVersion(),
    booting: booting(),
    startupPhase: bootPhase(),
    startupBranch: startupBranch(),
    startupTrace: startupTrace(),
    headerStatus: headerStatus(),
    busyHint: busyHint(),
    updateStatus: updateStatus(),
    anyActiveRuns: anyActiveRuns(),
    installUpdateAndRestart,
    skills: skills(),
    newTaskDisabled: newTaskDisabled(),
    sidebarHydratedFromCache: sidebarHydratedFromCache(),
    workspaceSessionGroups: hydratedSidebarWorkspaceGroups(),
    openRenameWorkspace: workspaceStore.openRenameWorkspace,
    messages: visibleMessages(),
    getSessionById: sessionById,
    getMessagesBySessionId: messagesBySessionId,
    ensureSessionLoaded,
    sessionLoadingById,
    todos: activeTodos(),
    busyLabel: busyLabel(),
    developerMode: developerMode(),
    sessionCompactionState: selectedSessionCompactionState(),
    expandedStepIds: expandedStepIds(),
    setExpandedStepIds: setExpandedStepIds,
    workingFiles: activeWorkingFiles(),
    busy: busy(),
    prompt: prompt(),
    setPrompt: setPrompt,
    activePermission: activePermissionMemo(),
    permissionReplyBusy: permissionReplyBusy(),
    respondPermission: respondPermission,
    respondPermissionAndRemember: respondPermissionAndRemember,
    activeQuestion: activeQuestion(),
    questionReplyBusy: questionReplyBusy(),
    respondQuestion: respondQuestion,
    safeStringify: safeStringify,
    startProviderAuth: startProviderAuth,
    completeProviderAuthOAuth: completeProviderAuthOAuth,
    refreshProviders: refreshProviders,
    submitProviderApiKey: submitProviderApiKey,
    connectCloudProvider: connectCloudProvider,
    openProviderAuthModal: openProviderAuthModal,
    closeProviderAuthModal: closeProviderAuthModal,
    providerAuthModalOpen: providerAuthModalOpen(),
    providerAuthBusy: providerAuthBusy(),
    providerAuthError: providerAuthError(),
    providerAuthMethods: providerAuthMethods(),
    providerAuthProviders: providerAuthProviders(),
    providerAuthPreferredProviderId: providerAuthPreferredProviderId(),
    providers: providers(),
    providerConnectedIds: providerConnectedIds(),
    sessionStatusById: activeSessionStatusById(),
    hasEarlierMessages: selectedSessionHasEarlierMessages(),
    loadingEarlierMessages: selectedSessionLoadingEarlierMessages(),
    loadEarlierMessages,
    sessionErrorTurns: selectedSessionErrorTurns(),
    sessionStatus: selectedSessionStatus(),
    error: error(),
  });

  const reactSessionRuntimeEnabled = createMemo(() => reactSessionEnabled());
  const reactSessionRuntimeBaseUrl = createMemo(() => {
    const workspaceId = runtimeWorkspaceId()?.trim() ?? "";
    const baseUrl = openworkServerClient()?.baseUrl?.trim() ?? "";
    if (!workspaceId || !baseUrl) return "";
    const mounted = buildOpenworkWorkspaceBaseUrl(baseUrl, workspaceId) ?? baseUrl;
    return `${mounted.replace(/\/+$/, "")}/opencode`;
  });
  const reactSessionRuntimeToken = createMemo(
    () => openworkServerClient()?.token?.trim() || openworkServerSettings().token?.trim() || "",
  );
  const showReactSessionRuntime = createMemo(
    () =>
      reactSessionRuntimeEnabled() &&
      openworkServerStatus() === "connected" &&
      Boolean(runtimeWorkspaceId()?.trim() && reactSessionRuntimeBaseUrl() && reactSessionRuntimeToken()),
  );

  const settingsTabs = new Set<SettingsTab>([
    "general",
    "den",
    "automations",
    "skills",
    "extensions",
    "messaging",
    "advanced",
    "appearance",
    "updates",
    "recovery",
    "debug",
  ]);

  const resolveSettingsTab = (value?: string | null) => {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (settingsTabs.has(normalized as SettingsTab)) {
      return normalized as SettingsTab;
    }
    return "general";
  };

  createEffect(() => {
    const rawPath = location.pathname.trim();
    const path = rawPath.toLowerCase();

    if (path === "" || path === "/") {
      navigate("/session", { replace: true });
      return;
    }

    if (path.startsWith("/settings")) {
      const [, , tabSegment] = path.split("/");
      const resolvedTab = resolveSettingsTab(tabSegment);

      if (resolvedTab !== settingsTab()) {
        setSettingsTabState(resolvedTab);
      }
      if (!tabSegment || tabSegment !== resolvedTab) {
        goToSettings(resolvedTab, { replace: true });
      }
      return;
    }

    if (path.startsWith("/session")) {
      const [, , sessionSegment] = rawPath.split("/");
      const id = (sessionSegment ?? "").trim();

      if (!id) {
        if (selectedSessionId()) {
          workspaceStore.clearSelectedSessionSurface();
        }
        return;
      }

      // If the URL points at a session that no longer exists (e.g. after deletion),
      // route back to /session so the app can fall back safely.
      const pendingInitialSelection = pendingInitialSessionSelection();
      const selectedWorkspaceRoot = normalizeDirectoryPath(workspaceStore.selectedWorkspaceRoot().trim());
      const matchingSession = sessions().find((session) => session.id === id) ?? null;
      const hasMatchingSessionInScope = matchingSession
        ? !selectedWorkspaceRoot || normalizeDirectoryPath(matchingSession.directory) === selectedWorkspaceRoot
        : false;
      if (
        sessionsLoaded() &&
        !pendingInitialSelection &&
        shouldRedirectMissingSessionAfterScopedLoad({
          loadedScopeRoot: loadedSessionScopeRoot(),
          workspaceRoot: workspaceStore.selectedWorkspaceRoot().trim(),
          hasMatchingSession: hasMatchingSessionInScope,
        })
      ) {
        if (selectedSessionId() === id) {
          setSelectedSessionId(null);
        }
        navigate("/session", { replace: true });
        return;
      }

      if (selectedSessionId() !== id) {
        setSelectedSessionId(id);
        void selectSession(id);
      }
      return;
    }

    const fallback = activeSessionId();
    if (fallback) {
      goToSession(fallback, { replace: true });
      return;
    }
    navigate("/session", { replace: true });
  });

  return (
    <OpenworkServerProvider store={openworkServerStore}>
      <ModelControlsProvider store={modelControlsStore}>
        <SessionActionsProvider store={sessionActionsStore}>
          <ConnectionsProvider store={connectionsStore}>
            <ExtensionsProvider store={extensionsStore}>
              <AutomationsProvider store={automationsStore}>
                <StatusToastsProvider store={statusToastsStore}>
                  <Show when={showReactSessionRuntime()}>
                    <ReactIsland
                      class="hidden"
                      instanceKey={`react-runtime:${runtimeWorkspaceId()!}`}
                      component={ReactSessionRuntime}
                      props={{
                        workspaceId: runtimeWorkspaceId()!,
                        opencodeBaseUrl: reactSessionRuntimeBaseUrl(),
                        openworkToken: reactSessionRuntimeToken(),
                      }}
                    />
                  </Show>
            <Switch>
              <Match when={currentView() === "session"}>
                <SessionView {...sessionProps()} />
              </Match>
              <Match when={true}>
                <SettingsShell {...settingsShellProps()} />
              </Match>
            </Switch>

      <ModelPickerModal
        open={modelPickerOpen()}
        options={modelOptions()}
        filteredOptions={filteredModelOptions()}
        query={modelPickerQuery()}
        setQuery={setModelPickerQuery}
        target={modelPickerTarget()}
        current={modelPickerCurrent()}
        onSelect={applyModelSelection}
        onBehaviorChange={setModelPickerBehavior}
        onOpenSettings={openSettingsFromModelPicker}
        onClose={closeModelPicker}
      />

      <ResetModal
        open={resetModalOpen()}
        mode={resetModalMode()}
        text={resetModalText()}
        busy={resetModalBusy()}
        canReset={
          !resetModalBusy() &&
          !anyActiveRuns() &&
          resetModalText().trim().toUpperCase() === "RESET"
        }
        hasActiveRuns={anyActiveRuns()}
        language={currentLocale()}
        onClose={() => setResetModalOpen(false)}
        onConfirm={confirmReset}
        onTextChange={setResetModalText}
      />

      <ConnectionsModals
        client={client()}
        projectDir={workspaceProjectDir()}
        language={currentLocale()}
        reloadBlocked={activeReloadBlockingSessions().length > 0}
        activeSessions={activeReloadBlockingSessions()}
        isRemoteWorkspace={selectedWorkspaceDisplay().workspaceType === "remote"}
        onForceStopSession={(sessionID) => abortSession(sessionID)}
        onReloadEngine={() => reloadWorkspaceEngine()}
      />

      <BundleImportModal
        open={Boolean(bundlesStore.bundleImportChoice())}
        title={bundlesStore.bundleImportSummary()?.title ?? t("app.import_shared_bundle")}
        description={bundlesStore.bundleImportSummary()?.description ?? t("app.import_bundle_desc")}
        items={bundlesStore.bundleImportSummary()?.items ?? []}
        workers={bundlesStore.bundleWorkerOptions()}
        busy={bundlesStore.bundleImportBusy()}
        error={bundlesStore.bundleImportError()}
        onClose={bundlesStore.closeBundleImportChoice}
        onCreateNewWorker={() => {
          void bundlesStore.openCreateWorkspaceFromChoice();
        }}
        onSelectWorker={(workspaceId) => {
          void bundlesStore.importBundleIntoExistingWorkspace(workspaceId);
        }}
      />

      <ConfirmModal
        open={Boolean(bundlesStore.untrustedBundleWarning())}
        title="Import from an untrusted bundle link?"
        message={(() => {
          const warning = bundlesStore.untrustedBundleWarning();
          const actualOrigin = warning?.actualOrigin?.trim() || "an unknown origin";
          const configuredOrigin = warning?.configuredOrigin?.trim() || "the configured OpenWork share service";
          return `This link points to ${actualOrigin}, but OpenWork only auto-imports bundles from ${configuredOrigin}. Untrusted bundles can contain malicious instructions or settings. Only continue if you trust the sender and expect this import.`;
        })()}
        confirmLabel="Import anyway"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => {
          void bundlesStore.confirmUntrustedBundleWarning();
        }}
        onCancel={bundlesStore.dismissUntrustedBundleWarning}
      />

      <BundleStartModal
        open={Boolean(bundlesStore.bundleStartRequest())}
        templateName={bundlesStore.bundleStartRequest()?.bundle.name?.trim() || "this template"}
        description={bundlesStore.bundleStartRequest()?.bundle.description ?? ""}
        items={bundlesStore.bundleStartItems()}
        busy={bundlesStore.bundleStartBusy()}
        onClose={() => {
          bundlesStore.clearBundleStartRequest();
        }}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        onConfirm={(folder) => {
          void bundlesStore.startWorkspaceFromBundle(folder);
        }}
      />

      <CreateWorkspaceModal
        open={workspaceStore.createWorkspaceOpen()}
        onClose={() => {
          workspaceStore.setCreateWorkspaceOpen(false);
          workspaceStore.clearSandboxCreateProgress?.();
          bundlesStore.clearCreateWorkspaceRequest();
        }}
        onPickFolder={workspaceStore.pickWorkspaceFolder}
        onImportConfig={isTauriRuntime() ? workspaceStore.importWorkspaceConfig : undefined}
        importingConfig={workspaceStore.importingWorkspaceConfig()}
        defaultPreset={bundlesStore.createWorkspaceDefaultPreset()}
        onConfirmRemote={(input) => workspaceStore.createRemoteWorkspaceFlow(input)}
        onConfirmTemplate={(template, preset, folder) =>
          bundlesStore.startWorkspaceFromTeamTemplate({
            name: template.name,
            templateData: template.templateData,
            folder,
            preset,
          })
        }
        onConfirm={bundlesStore.handleCreateWorkspaceConfirm}
        onConfirmWorker={
          isTauriRuntime()
            ? bundlesStore.handleCreateSandboxConfirm
            : undefined
        }
        workerDisabled={(() => {
          if (!isTauriRuntime()) return true;
          if (workspaceStore.sandboxDoctorBusy?.()) return true;
          const doctor = workspaceStore.sandboxDoctorResult?.();
          if (!doctor) return false;
          return !doctor?.ready;
        })()}
        workerDisabledReason={(() => {
          if (!isTauriRuntime()) return t("app.error.tauri_required", currentLocale());
          if (workspaceStore.sandboxDoctorBusy?.()) {
            return t("dashboard.sandbox_checking_docker", currentLocale());
          }
          const doctor = workspaceStore.sandboxDoctorResult?.();
          if (!doctor || doctor.ready) return null;
          const message = doctor?.error?.trim();
          return message || t("dashboard.sandbox_get_ready_desc", currentLocale());
        })()}
        workerCtaLabel={t("dashboard.sandbox_get_ready_action", currentLocale())}
        workerCtaDescription={t("dashboard.sandbox_get_ready_desc", currentLocale())}
        onWorkerCta={async () => {
          const url = "https://www.docker.com/products/docker-desktop/";
          if (isTauriRuntime()) {
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            await openUrl(url);
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }}
        workerRetryLabel={t("common.retry", currentLocale())}
        workerDebugLines={(() => {
          const doctor = workspaceStore.sandboxDoctorResult?.();
          const lines: string[] = [];
          if (!doctor?.debug) return lines;
          const selected = doctor.debug.selectedBin?.trim();
          if (selected) lines.push(`selected: ${selected}`);
          if (doctor.debug.candidates?.length) {
            lines.push(`candidates: ${doctor.debug.candidates.join(", ")}`);
          }
          if (doctor.debug.versionCommand) {
            const cmd = doctor.debug.versionCommand;
            lines.push(`docker --version exit=${cmd.status}`);
            if (cmd.stderr?.trim()) lines.push(`docker --version stderr: ${cmd.stderr.trim()}`);
          }
          if (doctor.debug.infoCommand) {
            const cmd = doctor.debug.infoCommand;
            lines.push(`docker info exit=${cmd.status}`);
            if (cmd.stderr?.trim()) lines.push(`docker info stderr: ${cmd.stderr.trim()}`);
          }
          return lines;
        })()}
        onWorkerRetry={() => {
          void workspaceStore.refreshSandboxDoctor?.();
        }}
        workerSubmitting={workspaceStore.sandboxPreflightBusy?.() ?? false}
        localDisabled={!isTauriRuntime()}
        localDisabledReason={
          !isTauriRuntime()
            ? t("app.local_disabled_reason")
            : null
        }
        remoteSubmitting={busy() && busyLabel() === "status.connecting"}
        remoteError={busyLabel() === "status.connecting" ? error() : null}
        submitting={(() => {
          const phase = workspaceStore.sandboxCreatePhase?.() ?? "idle";
          if (phase === "provisioning" || phase === "finalizing") return true;
          return busy() && busyLabel() === "status.creating_workspace";
        })()}
        submittingProgress={workspaceStore.sandboxCreateProgress?.() ?? null}
      />

      <SkillDestinationModal
        open={
          Boolean(bundlesStore.skillDestinationRequest()) &&
          !workspaceStore.createWorkspaceOpen() &&
          !workspaceStore.createRemoteWorkspaceOpen()
        }
        skill={(() => {
          const request = bundlesStore.skillDestinationRequest();
          if (!request) return null;
          return {
            name: request.bundle.name,
            description: request.bundle.description ?? null,
            trigger: request.bundle.trigger ?? null,
          };
        })()}
        workspaces={bundlesStore.skillDestinationWorkspaces()}
        selectedWorkspaceId={workspaceStore.selectedWorkspaceId()}
        busyWorkspaceId={bundlesStore.skillDestinationBusyId()}
        onClose={() => {
          bundlesStore.clearSkillDestinationRequest();
        }}
        onSubmitWorkspace={bundlesStore.importSkillIntoWorkspace}
        onCreateWorker={
          isTauriRuntime()
            ? bundlesStore.openCreateWorkspaceFromSkillDestination
            : undefined
        }
        onConnectRemote={() => {
          bundlesStore.openRemoteConnectFromSkillDestination();
        }}
      />

            <CreateRemoteWorkspaceModal
              open={workspaceStore.createRemoteWorkspaceOpen()}
              onClose={() => {
                workspaceStore.setCreateRemoteWorkspaceOpen(false);
                deepLinks.clearDeepLinkRemoteWorkspaceDefaults();
              }}
              onConfirm={(input) => workspaceStore.createRemoteWorkspaceFlow(input)}
              initialValues={deepLinks.deepLinkRemoteWorkspaceDefaults() ?? undefined}
              submitting={
                busy() &&
                (busyLabel() === "status.creating_workspace" || busyLabel() === "status.connecting")
              }
            />

      <TopRightNotifications
        reloadOpen={reloadRequired("config", "mcp", "plugin", "skill", "agent", "command")}
        reloadTitle={reloadCopy().title}
        reloadDescription={reloadCopy().body}
        reloadTrigger={reloadTrigger()}
        reloadError={reloadError()}
        reloadLabel={activeReloadBlockingSessions().length > 0 ? t("app.reload_stop_tasks") : t("app.reload_now")}
        dismissLabel={t("app.reload_later")}
        reloadBusy={reloadBusy()}
        canReload={canReloadWorkspace()}
        hasActiveRuns={activeReloadBlockingSessions().length > 0}
        onReload={() => {
          void (activeReloadBlockingSessions().length > 0
            ? forceStopActiveSessionsAndReload()
            : reloadWorkspaceEngine());
        }}
        onDismissReload={clearReloadRequired}
      />

      <RenameWorkspaceModal
        open={workspaceStore.renameWorkspaceOpen()}
        title={workspaceStore.renameWorkspaceName()}
        busy={workspaceStore.renameWorkspaceBusy()}
        canSave={workspaceStore.renameWorkspaceName().trim().length > 0 && !workspaceStore.renameWorkspaceBusy()}
        onClose={workspaceStore.closeRenameWorkspace}
        onSave={workspaceStore.saveRenameWorkspace}
        onTitleChange={workspaceStore.setRenameWorkspaceName}
      />

      <CreateRemoteWorkspaceModal
        open={workspaceStore.editRemoteWorkspaceOpen()}
        onClose={workspaceStore.closeWorkspaceConnectionSettings}
        onConfirm={(input) => {
          void workspaceStore.saveWorkspaceConnectionSettings(input);
        }}
        initialValues={workspaceStore.editRemoteWorkspaceDefaults() ?? undefined}
        submitting={busy() && busyLabel() === "status.connecting"}
        error={workspaceStore.editRemoteWorkspaceError()}
        title={t("dashboard.edit_remote_workspace_title", currentLocale())}
        subtitle={t("dashboard.edit_remote_workspace_subtitle", currentLocale())}
        confirmLabel={t("dashboard.edit_remote_workspace_confirm", currentLocale())}
      />
                </StatusToastsProvider>
              </AutomationsProvider>
            </ExtensionsProvider>
          </ConnectionsProvider>
        </SessionActionsProvider>
      </ModelControlsProvider>
    </OpenworkServerProvider>
  );
}
