import {
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { useLocation, useNavigate } from "@solidjs/router";

import type {
  Part,
  Session,
} from "@opencode-ai/sdk/v2/client";

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { parse } from "jsonc-parser";

import ModelPickerModal from "./components/model-picker-modal";
import AppOverlays from "./components/app-overlays";
import ResetModal from "./components/reset-modal";
import CreateRemoteWorkspaceModal from "./components/create-remote-workspace-modal";
import CreateWorkspaceModal from "./components/create-workspace-modal";
import SharedSkillDestinationModal from "./components/shared-skill-destination-modal";
import SharedBundleImportModal from "./components/shared-bundle-import-modal";
import StartWithTemplateModal from "./components/start-with-template-modal";
import RenameWorkspaceModal from "./components/rename-workspace-modal";
import McpAuthModal from "./components/mcp-auth-modal";
import ReloadWorkspaceToast from "./components/reload-workspace-toast";
import StatusToast from "./components/status-toast";
import DashboardView from "./pages/dashboard";
import SessionView from "./pages/session";
import { createAppOverlaysPropsBuilder } from "./app-props/app-overlays-props";
import { createDashboardPropsBuilder } from "./app-props/dashboard-props";
import { createSessionPropsBuilder } from "./app-props/session-props";
import { unwrap, type OpencodeAuth } from "./lib/opencode";
import { createDenClient, writeDenSettings } from "./lib/den";
import { clearPerfLogs } from "./lib/perf-log";
import {
  DEFAULT_MODEL,
  MCP_QUICK_CONNECT,
  SESSION_MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
} from "./constants";
import {
  blueprintMaterializedSessions,
  blueprintSessions,
} from "./lib/workspace-blueprints";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "./types";
import type {
  Client,
  DashboardTab,
  MessageWithParts,
  PlaceholderAssistantMessage,
  PlaceholderMessageInfo,
  StartupPreference,
  EngineRuntime,
  OnboardingStep,
  PluginScope,
  ReloadReason,
  ReloadTrigger,
   ResetOpenworkMode,
   SettingsTab,
   SkillCard,
   SidebarSessionItem,
   View,
   WorkspaceSessionGroup,
   ProviderListItem,
   SessionErrorTurn,
   UpdateHandle,
   OpencodeConnectStatus,
   ScheduledJob,
} from "./types";
import {
  clearStartupPreference,
  deriveArtifacts,
  deriveWorkingFiles,
  formatBytes,
  formatModelLabel,
  formatModelRef,
  formatRelativeTime,
  isTauriRuntime,
  normalizeDirectoryPath,
} from "./utils";
import { currentLocale, setLocale, t, type Language } from "../i18n";
import {
  isWindowsPlatform,
  lastUserModelFromMessages,
  // normalizeDirectoryPath,
  safeStringify,
  addOpencodeCacheHint,
} from "./utils";
import { getInitialThemeMode, type ThemeMode } from "./theme";
import { createSystemState } from "./system-state";
import { relaunch } from "@tauri-apps/plugin-process";
import { createSessionStore } from "./context/session";
import {
  describeDirectoryScope,
  shouldApplyScopedSessionLoad,
  shouldRedirectMissingSessionAfterScopedLoad,
} from "./lib/session-scope";

import { createExtensionsStore } from "./context/extensions";
import { createAutomationsStore } from "./context/automations";
import { checkOpenworkServer, createOpenworkServerStore } from "./context/openwork-server";
import { createSidebarSessionsStore } from "./context/sidebar-sessions";
import { createSharedBundleFlow } from "./context/shared-bundle-flow";
import { createMcpStore } from "./context/mcp-store";
import { ExtensionsProvider } from "./context/extensions-context";
import { useGlobalSync } from "./context/global-sync";
import { OpenworkServerProvider } from "./context/openwork-server-context";
import { ProviderAuthProvider } from "./context/provider-auth-context";
import { createProviderAuthStore } from "./context/provider-auth-store";
import { createWorkspaceStore } from "./context/workspace";
import { WorkspaceActionsProvider } from "./context/workspace-actions-context";
import {
  AuthorizedFoldersProvider,
  createAuthorizedFoldersStore,
} from "./hooks/use-authorized-folders";
import { ScheduledJobsProvider } from "./hooks/use-scheduled-jobs";
import {
  WorkspaceMaintenanceProvider,
  createWorkspaceMaintenanceStore,
} from "./hooks/use-workspace-maintenance";
import {
  readOpencodeConfig,
  writeOpencodeConfig,
  openworkServerRestart,
  openworkServerInfo,
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
  parseOpenworkWorkspaceIdFromUrl,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
  clearOpenworkServerSettings,
  type OpenworkServerSettings,
  type OpenworkServerClient,
} from "./lib/openwork-server";
import {
  parseDebugDeepLinkInput,
  parseDenAuthDeepLink,
  parseRemoteConnectDeepLink,
  stripRemoteConnectQuery,
  stripSharedBundleQuery,
  type DenAuthDeepLink,
  type RemoteWorkspaceDefaults,
  type SharedBundleImportIntent,
} from "./lib/shared-bundles";
import { useAppBootstrap } from "./hooks/use-app-bootstrap";
import { useModelPreferences } from "./hooks/use-model-preferences";
import { useAppPreferencePersistence } from "./hooks/use-app-preference-persistence";
import { useOpenworkServerBootstrap } from "./hooks/use-openwork-server-bootstrap";
import { useSessionActions } from "./hooks/use-session-actions";

type SettingsReturnTarget = {
  view: View;
  tab: DashboardTab;
  sessionId: string | null;
};

type PendingInitialSessionSelection = {
  workspaceId: string;
  title: string | null;
  readyAt: number;
};

export default function App() {
  const envOpenworkWorkspaceId =
    typeof import.meta.env?.VITE_OPENWORK_WORKSPACE_ID === "string"
      ? import.meta.env.VITE_OPENWORK_WORKSPACE_ID.trim() || null
      : null;

  // Workspace switch tracing is noisy, so only emit in developer mode.
  // (OpenWork already has a developer mode toggle in Settings.)
  const wsDebugEnabled = () => developerMode();

  const wsDebug = (label: string, payload?: unknown) => {
    if (!wsDebugEnabled()) return;
    try {
      if (payload === undefined) {
        console.log(`[WSDBG] ${label}`);
      } else {
        console.log(`[WSDBG] ${label}`, payload);
      }
    } catch {
      // ignore
    }
  };
  const location = useLocation();
  const navigate = useNavigate();

  const [creatingSession, setCreatingSession] = createSignal(false);
  const [sessionViewLockUntil, setSessionViewLockUntil] = createSignal(0);
  const currentView = createMemo<View>(() => {
    const path = location.pathname.toLowerCase();
    if (path.startsWith("/onboarding")) return "onboarding";
    if (path.startsWith("/session")) return "session";
    return "dashboard";
  });

  const [tab, setTabState] = createSignal<DashboardTab>("scheduled");
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general");
  const [pendingInitialSessionSelection, setPendingInitialSessionSelection] =
    createSignal<PendingInitialSessionSelection | null>(null);

  const goToDashboard = (nextTab: DashboardTab, options?: { replace?: boolean }) => {
    setTabState(nextTab);
    navigate(`/dashboard/${nextTab}`, options);
  };

  const setTab = (nextTab: DashboardTab) => {
    if (currentView() === "dashboard") {
      goToDashboard(nextTab);
      return;
    }
    setTabState(nextTab);
  };

  const setView = (next: View, sessionId?: string) => {
    if (next === "dashboard" && creatingSession()) {
      return;
    }
    if (next === "dashboard" && Date.now() < sessionViewLockUntil()) {
      return;
    }
    if (next === "onboarding") {
      navigate("/onboarding");
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
    goToDashboard(tab());
  };

  const goToSession = (sessionId: string, options?: { replace?: boolean }) => {
    const trimmed = sessionId.trim();
    if (!trimmed) {
      navigate("/session", options);
      return;
    }
    navigate(`/session/${trimmed}`, options);
  };

  const [startupPreference, setStartupPreference] = createSignal<StartupPreference | null>(null);
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
  const [developerMode, setDeveloperMode] = createSignal(false);
  const [documentVisible, setDocumentVisible] = createSignal(true);

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [shareRemoteAccessBusy, setShareRemoteAccessBusy] = createSignal(false);
  const [shareRemoteAccessError, setShareRemoteAccessError] = createSignal<string | null>(null);
  const openworkServerStore = createOpenworkServerStore({
    startupPreference,
    developerMode,
    documentVisible,
    refreshEngine: async () => {
      await workspaceStore?.refreshEngine?.();
    },
  });
  const openworkServerSettings = openworkServerStore.settings;
  const openworkServerUrl = openworkServerStore.url;
  const openworkServerStatus = openworkServerStore.status;
  const openworkServerCapabilities = openworkServerStore.capabilities;
  const openworkServerCheckedAt = openworkServerStore.checkedAt;
  const openworkServerHostInfo = openworkServerStore.hostInfo;
  const openworkServerDiagnostics = openworkServerStore.diagnostics;
  const openworkReconnectBusy = openworkServerStore.reconnectBusy;
  const opencodeRouterInfoState = openworkServerStore.routerInfo;
  const orchestratorStatusState = openworkServerStore.orchestratorStatus;
  const openworkAuditEntries = openworkServerStore.auditEntries;
  const openworkAuditStatus = openworkServerStore.auditStatus;
  const openworkAuditError = openworkServerStore.auditError;
  const devtoolsWorkspaceId = openworkServerStore.devtoolsWorkspaceId;
  const setOpenworkServerSettings = openworkServerStore.setSettings;
  const setOpenworkServerStatus = openworkServerStore.setStatus;
  const setOpenworkServerCapabilities = openworkServerStore.setCapabilities;
  const setOpenworkServerCheckedAt = openworkServerStore.setCheckedAt;
  const setOpenworkServerHostInfo = openworkServerStore.setHostInfo;
  const setOpenworkServerDiagnostics = openworkServerStore.setDiagnostics;
  const setOpenworkReconnectBusy = openworkServerStore.setReconnectBusy;
  const setOpenworkAuditEntries = openworkServerStore.setAuditEntries;
  const setOpenworkAuditStatus = openworkServerStore.setAuditStatus;
  const setOpenworkAuditError = openworkServerStore.setAuditError;
  const setDevtoolsWorkspaceId = openworkServerStore.setDevtoolsWorkspaceId;
  const openworkServerBaseUrl = openworkServerStore.baseUrl;
  const openworkServerAuth = openworkServerStore.auth;
  const openworkServerClient = openworkServerStore.client;
  const devtoolsOpenworkClient = openworkServerStore.devtoolsClient;
  const resolvedOpenworkCapabilities = createMemo(() => openworkServerCapabilities());

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
    const hostInfo = openworkServerHostInfo();
    const port = hostInfo?.port;
    if (!port) return;

    const current = openworkServerSettings();
    if (current.portOverride === port) return;

    updateOpenworkServerSettings({
      ...current,
      portOverride: port,
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
  const mountTime = Date.now();
  createEffect(() => {
    if (developerMode()) return;
    clearPerfLogs();
  });

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    null
  );
  const [settingsReturnTarget, setSettingsReturnTarget] = createSignal<SettingsReturnTarget>({
    view: "dashboard",
    tab: "scheduled",
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
  const [sessionAgentById, setSessionAgentById] = createSignal<Record<string, string>>({});

  createEffect(() => {
    const view = currentView();
    const currentTab = tab();
    if (view === "dashboard" && currentTab === "settings") return;
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
    if (target.view === "onboarding") {
      navigate("/onboarding");
      return;
    }
    goToDashboard(target.tab);
  };

  const toggleSettingsView = (nextTab: SettingsTab = "general") => {
    const settingsOpen = currentView() === "dashboard" && tab() === "settings";
    if (settingsOpen) {
      restoreSettingsReturnTarget();
      return;
    }
    setSettingsTab(nextTab);
    goToDashboard("settings");
  };

  let markReloadRequiredHandler: ((reason: ReloadReason, trigger?: ReloadTrigger) => void) | undefined;
  const markReloadRequired = (reason: ReloadReason, trigger?: ReloadTrigger) => {
    markReloadRequiredHandler?.(reason, trigger);
  };
  const markOpencodeConfigReloadRequired = () => {
    markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
  };

  const sessionStore = createSessionStore({
    client,
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot().trim(),
    selectedSessionId,
    setSelectedSessionId,
    sessionModelState: () => ({
      overrides: sessionModelOverrideById(),
      resolved: sessionModelById(),
    }),
    setSessionModelState: (updater) => {
      const next = updater({
        overrides: sessionModelOverrideById(),
        resolved: sessionModelById(),
      });
      setSessionModelOverrideById(next.overrides);
      setSessionModelById(next.resolved);
      return next;
    },
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
    selectedSession,
    selectedSessionStatus,
    selectedSessionCompactionState,
    messages,
    messagesBySessionId,
    todos,
    pendingPermissions,
    permissionReplyBusy,
    pendingQuestions,
    activeQuestion,
    questionReplyBusy,
    events,
    activePermission,
    loadSessions,
    ensureSessionLoaded,
    refreshPendingPermissions,
    refreshPendingQuestions,
    selectSession,
    loadEarlierMessages,
    respondPermission,
    respondQuestion,
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
  const activeSessions = createMemo(() => sessions());
  const activeSessionStatusById = createMemo(() => sessionStatusById());
  const activeMessages = createMemo(() => messages());
  const activeTodos = createMemo(() => todos());
  const activeWorkingFiles = createMemo(() => workingFiles());

  const sessionActivity = (session: Session) =>
    session.time?.updated ?? session.time?.created ?? 0;
  const sortSessionsByActivity = (list: Session[]) =>
    list
      .slice()
      .sort((a, b) => {
        const delta = sessionActivity(b) - sessionActivity(a);
        if (delta !== 0) return delta;
        return a.id.localeCompare(b.id);
      });

  const [sessionsLoaded, setSessionsLoaded] = createSignal(false);
  const loadSessionsWithReady = async (scopeRoot?: string) => {
    await loadSessions(scopeRoot);
    setSessionsLoaded(true);
  };

  createEffect(() => {
    if (!client()) {
      setSessionsLoaded(false);
    }
  });

  const describeProviderError = (error: unknown, fallback: string) => {
    const readString = (value: unknown, max = 700) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length <= max) return trimmed;
      return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
    };

    const records: Record<string, unknown>[] = [];
    const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
    if (root) {
      records.push(root);
      if (root.data && typeof root.data === "object") records.push(root.data as Record<string, unknown>);
      if (root.cause && typeof root.cause === "object") {
        const cause = root.cause as Record<string, unknown>;
        records.push(cause);
        if (cause.data && typeof cause.data === "object") records.push(cause.data as Record<string, unknown>);
      }
    }

    const firstString = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = readString(record[key]);
          if (value) return value;
        }
      }
      return null;
    };

    const firstNumber = (keys: string[]) => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (typeof value === "number" && Number.isFinite(value)) return value;
        }
      }
      return null;
    };

    const status = firstNumber(["statusCode", "status"]);
    const provider = firstString(["providerID", "providerId", "provider"]);
    const code = firstString(["code", "errorCode"]);
    const response = firstString(["responseBody", "body", "response"]);
    const raw =
      (error instanceof Error ? readString(error.message) : null) ||
      firstString(["message", "detail", "reason", "error"]) ||
      (typeof error === "string" ? readString(error) : null);

    const generic = raw && /^unknown\s+error$/i.test(raw);
    const heading = (() => {
      if (status === 401 || status === 403) return "Authentication failed";
      if (status === 429) return "Rate limit exceeded";
      if (provider) return `Provider error (${provider})`;
      return fallback;
    })();

    const lines = [heading];
    if (raw && !generic && raw !== heading) lines.push(raw);
    if (status && !heading.includes(String(status))) lines.push(`Status: ${status}`);
    if (provider && !heading.includes(provider)) lines.push(`Provider: ${provider}`);
    if (code) lines.push(`Code: ${code}`);
    if (response) lines.push(`Response: ${response}`);
    if (lines.length > 1) return lines.join("\n");

    if (raw && !generic) return raw;
    if (error && typeof error === "object") {
      const serialized = safeStringify(error);
      if (serialized && serialized !== "{}") return serialized;
    }
    return fallback;
  };

  const ensureSelectedWorkspaceRuntime = async () => {
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    if (!workspaceId) return false;
    const ready = await workspaceStore.switchWorkspace(workspaceId);
    if (ready) {
      await refreshSidebarWorkspaceSessions(workspaceId).catch(() => undefined);
    }
    return ready;
  };

  const messageIdFromInfo = (message: MessageWithParts) => {
    const id = (message.info as { id?: string | number }).id;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
    return "";
  };

  const createSyntheticSessionErrorMessage = (
    sessionID: string,
    errorTurn: SessionErrorTurn,
  ): MessageWithParts => {
    const info: PlaceholderAssistantMessage = {
      id: errorTurn.id,
      sessionID,
      role: "assistant",
      time: { created: errorTurn.time, completed: errorTurn.time },
      parentID: errorTurn.afterMessageID ?? "",
      modelID: "",
      providerID: "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    return {
      info,
      parts: [
        {
          id: `${errorTurn.id}:text`,
          sessionID,
          messageID: errorTurn.id,
          type: "text",
          text: errorTurn.text,
        } as Part,
      ],
    };
  };

  const SYNTHETIC_BLUEPRINT_SEED_MESSAGE_PREFIX = "blueprint-seed:";

  const createSyntheticBlueprintSeedMessage = (
    sessionID: string,
    index: number,
    seed: { role?: "assistant" | "user" | null; text?: string | null },
  ): MessageWithParts => {
    const messageId = `${SYNTHETIC_BLUEPRINT_SEED_MESSAGE_PREFIX}${sessionID}:${index}`;
    const role = seed.role === "user" ? "user" : "assistant";
    const text = seed.text?.trim() ?? "";
    const createdAt = Math.max(1, index + 1);
    const info: PlaceholderMessageInfo = {
      id: messageId,
      sessionID,
      role,
      time: { created: createdAt, completed: createdAt },
      parentID: index > 0 ? `${SYNTHETIC_BLUEPRINT_SEED_MESSAGE_PREFIX}${sessionID}:${index - 1}` : "",
      modelID: "",
      providerID: "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    return {
      info,
      parts: [
        {
          id: `${messageId}:text`,
          sessionID,
          messageID: messageId,
          type: "text",
          text,
        } as Part,
      ],
    };
  };

  const [blueprintSeedMessagesBySessionId, setBlueprintSeedMessagesBySessionId] =
    createSignal<Record<string, Array<{ role?: "assistant" | "user" | null; text?: string | null }>>>({});

  const blueprintSeedMessagesForSelectedSession = createMemo(() => {
    const sessionID = selectedSessionId();
    if (!sessionID) return [];

    const fallback = blueprintSeedMessagesBySessionId()[sessionID];
    if (Array.isArray(fallback) && fallback.length > 0) {
      return fallback;
    }

    const materialized = blueprintMaterializedSessions(resolvedActiveWorkspaceConfig());
    const match = materialized.find((item) => item.sessionId?.trim() === sessionID);
    if (!match?.templateId) return [];

    const template = blueprintSessions(resolvedActiveWorkspaceConfig()).find(
      (entry) => entry.id?.trim() === match.templateId,
    );

    return Array.isArray(template?.messages)
      ? template!.messages!.filter((entry) => entry?.text?.trim())
      : [];
  });

  const insertSyntheticBlueprintSeedMessages = (
    list: MessageWithParts[],
    sessionID: string | null,
    seeds: Array<{ role?: "assistant" | "user" | null; text?: string | null }>,
  ) => {
    if (!sessionID || seeds.length === 0) return list;
    if (list.length > 0) return list;
    const existingIds = new Set(list.map((message) => messageIdFromInfo(message)));
    const synthetic = seeds
      .map((seed, index) => createSyntheticBlueprintSeedMessage(sessionID, index, seed))
      .filter((message) => !existingIds.has(messageIdFromInfo(message)));
    if (!synthetic.length) return list;
    return [...synthetic, ...list];
  };

  const insertSyntheticSessionErrors = (
    list: MessageWithParts[],
    sessionID: string | null,
    errorTurns: SessionErrorTurn[],
  ) => {
    if (!sessionID || errorTurns.length === 0) return list;

    const next = list.slice();
    errorTurns.forEach((errorTurn) => {
      if (next.some((message) => messageIdFromInfo(message) === errorTurn.id)) return;
      const syntheticMessage = createSyntheticSessionErrorMessage(sessionID, errorTurn);
      const anchorIndex = errorTurn.afterMessageID
        ? next.findIndex((message) => messageIdFromInfo(message) === errorTurn.afterMessageID)
        : -1;

      if (anchorIndex === -1) {
        next.push(syntheticMessage);
        return;
      }

      next.splice(anchorIndex + 1, 0, syntheticMessage);
    });

    return next;
  };

  // OpenCode keeps reverted messages in the log and uses `session.revert.messageID`
  // as the visibility boundary. OpenWork mirrors that behavior by filtering the
  // displayed transcript.
  const visibleMessages = createMemo(() => {
    const sessionID = selectedSessionId();
    const errorTurns = sessionStore.selectedSessionErrorTurns();
    const blueprintSeeds = blueprintSeedMessagesForSelectedSession();
    const list = messages().filter((message) => {
      const id = messageIdFromInfo(message);
      return !id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX) && !id.startsWith(SYNTHETIC_BLUEPRINT_SEED_MESSAGE_PREFIX);
    });
    const revert = selectedSession()?.revert?.messageID ?? null;
    const visible = !revert ? list : list.filter((message) => {
      const id = messageIdFromInfo(message);
      return Boolean(id) && id < revert;
    });
    return insertSyntheticSessionErrors(
      insertSyntheticBlueprintSeedMessages(visible, sessionID, blueprintSeeds),
      sessionID,
      errorTurns,
    );
  });

  function setSessionAgent(sessionID: string, agent: string | null) {
    const trimmed = agent?.trim() ?? "";
    setSessionAgentById((current) => {
      const next = { ...current };
      if (!trimmed) {
        delete next[sessionID];
        return next;
      }
      next[sessionID] = trimmed;
      return next;
    });
  }

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

  const [notionStatus, setNotionStatus] = createSignal<"disconnected" | "connecting" | "connected" | "error">(
    "disconnected",
  );
  const [notionStatusDetail, setNotionStatusDetail] = createSignal<string | null>(null);
  const [notionError, setNotionError] = createSignal<string | null>(null);
  const [notionBusy, setNotionBusy] = createSignal(false);
  const [notionSkillInstalled, setNotionSkillInstalled] = createSignal(false);
  const [tryNotionPromptVisible, setTryNotionPromptVisible] = createSignal(false);
  const notionIsActive = createMemo(() => notionStatus() === "connected");
  let workspaceStore!: ReturnType<typeof createWorkspaceStore>;

  const extensionsStore = createExtensionsStore({
    client,
    projectDir: () => workspaceProjectDir(),
    selectedWorkspaceId: () => workspaceStore?.selectedWorkspaceId?.() ?? "",
    selectedWorkspaceRoot: () => workspaceStore?.selectedWorkspaceRoot?.() ?? "",
    workspaceType: () => workspaceStore?.selectedWorkspaceDisplay?.().workspaceType ?? "local",
    openworkServerClient,
    openworkServerStatus,
    openworkServerCapabilities,
    runtimeWorkspaceId: () => workspaceStore?.runtimeWorkspaceId?.() ?? null,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
    markReloadRequired,
    onNotionSkillInstalled: () => {
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("openwork.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
      if (notionIsActive()) {
        setTryNotionPromptVisible(true);
      }
    },
  });

  const {
    skills,
    skillsStatus,
    hubSkills,
    hubSkillsStatus,
    hubRepo,
    hubRepos,
    pluginScope,
    setPluginScope,
    pluginConfig,
    pluginConfigPath,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    sidebarPluginList,
    sidebarPluginStatus,
    isPluginInstalledByName,
    refreshSkills,
    refreshHubSkills,
    setHubRepo,
    addHubRepo,
    removeHubRepo,
    refreshPlugins,
    addPlugin,
    removePlugin,
    importLocalSkill,
    installSkillCreator,
    installHubSkill,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    abortRefreshes,
    ensureHubSkillsFresh,
  } = extensionsStore;

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

  const removeProviderFromState = (providerId: string) => {
    const resolved = providerId.trim();
    if (!resolved) return;
    setProviders(providers().filter((provider) => provider.id !== resolved));
    setProviderConnectedIds(providerConnectedIds().filter((id) => id !== resolved));
    setProviderDefaults(
      Object.fromEntries(Object.entries(providerDefaults()).filter(([id]) => id !== resolved)),
    );
  };

  const [showThinking, setShowThinking] = createSignal(false);
  const [hideTitlebar, setHideTitlebar] = createSignal(false);
  const modelPreferences = useModelPreferences({
    selectedSessionId,
    messages,
    providers,
    providerDefaults,
    providerConnectedIds,
    client,
    selectedWorkspaceId: () => workspaceStore.selectedWorkspaceId(),
    selectedWorkspaceDisplay: () => workspaceStore.selectedWorkspaceDisplay(),
    selectedWorkspacePath: () => workspaceStore.selectedWorkspacePath(),
    openworkServerClient,
    openworkServerStatus,
    openworkServerCapabilities: resolvedOpenworkCapabilities,
    runtimeWorkspaceId: () => workspaceStore.runtimeWorkspaceId(),
    markOpencodeConfigReloadRequired,
    focusSessionPromptSoon,
    setError,
  });
  const {
    defaultModel,
    setDefaultModel,
    setLegacyDefaultModel,
    setDefaultModelExplicit,
    sessionModelOverrideById,
    setSessionModelOverrideById,
    sessionModelById,
    setSessionModelById,
    pendingSessionModel,
    setPendingSessionModel,
    selectedSessionModel,
    selectedSessionModelLabel,
    autoCompactContext,
    setAutoCompactContext,
    autoCompactContextSaving,
    toggleAutoCompactContext,
    modelVariantMap,
    setModelVariantMap,
    modelVariant,
    getVariantFor,
    updateModelVariant,
    setModelVariant,
    sanitizeModelVariantForRef,
    getModelBehaviorCopy,
    resolveCodexReasoningEffort,
    modelPickerOpen,
    modelOptions,
    filteredModelOptions,
    modelPickerQuery,
    setModelPickerQuery,
    modelPickerTarget,
    modelPickerCurrent,
    closeModelPicker,
    openSessionModelPicker,
    openDefaultModelPicker,
    applyModelSelection,
    setPendingDefaultModelByWorkspace,
  } = modelPreferences;

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
    readLastSessionByWorkspace: readSessionByWorkspace,
    selectedSessionId,
    selectSession,
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
    setTab,
    isWindowsPlatform,
    openworkServerSettings,
    updateOpenworkServerSettings,
    openworkServerClient,
    openworkServerStatus,
    openworkServerCapabilities,
    openworkEnvWorkspaceId: envOpenworkWorkspaceId,
    ensureLocalOpenworkServerClient,
    onEngineStable: () => {},
    engineRuntime,
    developerMode,
    setPendingInitialSessionSelection,
  });

  const runtimeWorkspaceId = createMemo(() => workspaceStore.runtimeWorkspaceId());
  const activeWorkspaceServerConfig = createMemo(() => workspaceStore.runtimeWorkspaceConfig());

  const logWorkspaceScopeSnapshot = (label: string, extra?: Record<string, unknown>) => {
    if (!developerMode()) return;
    const activeWorkspace = workspaceStore.selectedWorkspaceInfo();
    const selectedWorkspaceId = workspaceStore.selectedWorkspaceId().trim();
    const selectedWorkspaceRoot = workspaceStore.selectedWorkspaceRoot().trim();
    const engineInfo = workspaceStore.engine();
    const map = readSessionByWorkspace();
    wsDebug(label, {
      selectedWorkspaceId: selectedWorkspaceId || null,
      activeWorkspaceType: activeWorkspace?.workspaceType ?? null,
      selectedWorkspacePath: activeWorkspace?.path?.trim() ?? null,
      activeWorkspaceDirectory: activeWorkspace?.directory?.trim() ?? null,
      selectedWorkspaceRoot: selectedWorkspaceRoot || null,
      activeWorkspaceScope: describeDirectoryScope(selectedWorkspaceRoot),
      clientDirectory: clientDirectory().trim() || null,
      clientDirectoryScope: describeDirectoryScope(clientDirectory().trim()),
      engineProjectDir: engineInfo?.projectDir?.trim() ?? null,
      engineProjectScope: describeDirectoryScope(engineInfo?.projectDir?.trim() ?? null),
      lastSessionForActiveWorkspace: selectedWorkspaceId ? map[selectedWorkspaceId] ?? null : null,
      lastSessionMapKeys: Object.keys(map),
      ...extra,
    });
  };

  const sidebarSessionsStore = createSidebarSessionsStore({
    workspaces: () => workspaceStore.workspaces(),
    engine: () => workspaceStore.engine(),
  });

  const {
    workspaceGroups: rawSidebarWorkspaceGroups,
    refreshWorkspaceSessions: refreshSidebarWorkspaceSessions,
  } = sidebarSessionsStore;

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
    if (!developerMode()) {
      setDevtoolsWorkspaceId(null);
      return;
    }
    if (!documentVisible()) return;

    const client = devtoolsOpenworkClient();
    if (!client) {
      setDevtoolsWorkspaceId(null);
      return;
    }
    let active = true;

    const run = async () => {
      try {
        const response = await client.listWorkspaces();
        if (!active) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const activeMatch = response.activeId ? items.find((item) => item.id === response.activeId) : null;
        setDevtoolsWorkspaceId(activeMatch?.id ?? items[0]?.id ?? null);
      } catch {
        if (active) setDevtoolsWorkspaceId(null);
      }
    };

    run();
    const interval = window.setInterval(run, 20_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!developerMode()) {
      setOpenworkAuditEntries([]);
      setOpenworkAuditStatus("idle");
      setOpenworkAuditError(null);
      return;
    }
    if (!documentVisible()) return;

    const client = devtoolsOpenworkClient();
    const workspaceId = devtoolsWorkspaceId();
    if (!client || !workspaceId) {
      setOpenworkAuditEntries([]);
      setOpenworkAuditStatus("idle");
      setOpenworkAuditError(null);
      return;
    }

    let active = true;
    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      setOpenworkAuditStatus("loading");
      setOpenworkAuditError(null);
      try {
        const result = await client.listAudit(workspaceId, 50);
        if (!active) return;
        setOpenworkAuditEntries(Array.isArray(result.items) ? result.items : []);
        setOpenworkAuditStatus("idle");
      } catch (error) {
        if (!active) return;
        setOpenworkAuditEntries([]);
        setOpenworkAuditStatus("error");
        setOpenworkAuditError(error instanceof Error ? error.message : "Failed to load audit log.");
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 15_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
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

  const openworkServerReady = createMemo(() => openworkServerStatus() === "connected");
  const openworkServerWorkspaceReady = createMemo(() => Boolean(runtimeWorkspaceId()));
  const mcpStore = createMcpStore({
    client,
    setClient,
    developerMode,
    workspaceProjectDir: () => workspaceStore.projectDir(),
    setWorkspaceProjectDir: workspaceStore.setProjectDir,
    selectedWorkspaceType: () => workspaceStore.selectedWorkspaceDisplay().workspaceType,
    runtimeWorkspaceId,
    ensureRuntimeWorkspaceId: () => workspaceStore.ensureRuntimeWorkspaceId(),
    openworkServerClient,
    openworkServerStatus,
    openworkServerCapabilities: resolvedOpenworkCapabilities,
    openworkServerBaseUrl,
    openworkServerAuth,
    markReloadRequired,
  });
  const {
    mcpServers,
    mcpStatus,
    mcpLastUpdatedAt,
    mcpStatuses,
    mcpConnectingName,
    selectedMcp,
    setSelectedMcp,
    mcpAuthModalOpen,
    mcpAuthEntry,
    mcpAuthNeedsReload,
    refreshMcpServers,
    connectMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    closeMcpAuthModal,
    completeMcpAuthModal,
  } = mcpStore;
  const openworkServerCanWriteSkills = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.skills?.write ?? false),
  );
  const openworkServerCanWritePlugins = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.plugins?.write ?? false),
  );
  const openworkServerCanReadConfig = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.config?.read ?? false),
  );
  const openworkServerCanWriteConfig = createMemo(
    () =>
      openworkServerReady() &&
      openworkServerWorkspaceReady() &&
      (resolvedOpenworkCapabilities()?.config?.write ?? false),
  );
  const devtoolsCapabilities = createMemo(() => openworkServerCapabilities());

  function updateOpenworkServerSettings(next: OpenworkServerSettings) {
    const stored = writeOpenworkServerSettings(next);
    setOpenworkServerSettings(stored);
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (shareRemoteAccessBusy()) return;
    const previous = openworkServerSettings();
    const next: OpenworkServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    setShareRemoteAccessBusy(true);
    setShareRemoteAccessError(null);
    updateOpenworkServerSettings(next);

    try {
      if (isTauriRuntime() && workspaceStore.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await restartLocalServer();
        if (!restarted) {
          throw new Error("Failed to restart the local worker with the updated sharing setting.");
        }
        await reconnectOpenworkServer();
      }
    } catch (error) {
      updateOpenworkServerSettings(previous);
      setShareRemoteAccessError(
        error instanceof Error
          ? error.message
          : "Failed to update remote access.",
      );
      return;
    } finally {
      setShareRemoteAccessBusy(false);
    }
  };

  const resetOpenworkServerSettings = () => {
    clearOpenworkServerSettings();
    setOpenworkServerSettings({});
  };

  const [editRemoteWorkspaceOpen, setEditRemoteWorkspaceOpen] = createSignal(false);
  const [editRemoteWorkspaceId, setEditRemoteWorkspaceId] = createSignal<string | null>(null);
  const [editRemoteWorkspaceError, setEditRemoteWorkspaceError] = createSignal<string | null>(null);
  const [deepLinkRemoteWorkspaceDefaults, setDeepLinkRemoteWorkspaceDefaults] = createSignal<RemoteWorkspaceDefaults | null>(null);
  const [pendingRemoteConnectDeepLink, setPendingRemoteConnectDeepLink] = createSignal<RemoteWorkspaceDefaults | null>(null);
  const [autoConnectRemoteWorkspaceOverlayOpen, setAutoConnectRemoteWorkspaceOverlayOpen] = createSignal(false);
  const [pendingDenAuthDeepLink, setPendingDenAuthDeepLink] = createSignal<DenAuthDeepLink | null>(null);
  const [processingDenAuthDeepLink, setProcessingDenAuthDeepLink] = createSignal(false);
  const [startupSharedBundleInvite, setStartupSharedBundleInvite] = createSignal<{
    bundleUrl: string;
    intent: SharedBundleImportIntent;
    source?: string;
    orgId?: string;
    label?: string;
  } | null>(null);
  useOpenworkServerBootstrap({
    onboardingStep,
    setStartupPreference,
    setOnboardingStep,
    setOpenworkServerSettings,
    setStartupSharedBundleInvite,
    setPendingRemoteConnectDeepLink,
  });
  const recentClaimedDeepLinks = new Map<string, number>();
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = createSignal(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = createSignal<string | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = createSignal("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = createSignal(false);

  const queueRemoteConnectDeepLink = (rawUrl: string): boolean => {
    const parsed = parseRemoteConnectDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingRemoteConnectDeepLink(parsed);
    return true;
  };

  const completeRemoteConnectDeepLink = async (pending: RemoteWorkspaceDefaults) => {
    const input = {
      openworkHostUrl: pending.openworkHostUrl,
      openworkToken: pending.openworkToken,
      directory: pending.directory,
      displayName: pending.displayName,
    };

    if (!pending.autoConnect) {
      setDeepLinkRemoteWorkspaceDefaults(input);
      workspaceStore.setCreateRemoteWorkspaceOpen(true);
      return;
    }

    setError(null);
    setAutoConnectRemoteWorkspaceOverlayOpen(true);
    try {
      const ok = await workspaceStore.createRemoteWorkspaceFlow(input);
      if (ok) {
        setDeepLinkRemoteWorkspaceDefaults(null);
        return;
      }

      setDeepLinkRemoteWorkspaceDefaults(input);
      workspaceStore.setCreateRemoteWorkspaceOpen(true);
    } finally {
      setAutoConnectRemoteWorkspaceOverlayOpen(false);
    }
  };

  const queueDenAuthDeepLink = (rawUrl: string): boolean => {
    const parsed = parseDenAuthDeepLink(rawUrl);
    if (!parsed) {
      return false;
    }
    setPendingDenAuthDeepLink(parsed);
    return true;
  };

  const stripHandledBrowserDeepLink = (rawUrl: string) => {
    if (typeof window === "undefined" || isTauriRuntime()) {
      return;
    }

    if (window.location.href !== rawUrl) {
      return;
    }

    const remoteStripped = stripRemoteConnectQuery(rawUrl) ?? rawUrl;
    const bundleStripped = stripSharedBundleQuery(remoteStripped) ?? remoteStripped;
    if (bundleStripped !== rawUrl) {
      window.history.replaceState({}, "", bundleStripped);
    }
  };

  const consumeDeepLinks = (urls: readonly string[] | null | undefined) => {
    if (!Array.isArray(urls)) {
      return;
    }

    const normalized = urls.map((url) => url.trim()).filter(Boolean);
    if (normalized.length === 0) {
      return;
    }

    const now = Date.now();
    for (const [url, seenAt] of recentClaimedDeepLinks) {
      if (now - seenAt > 1500) {
        recentClaimedDeepLinks.delete(url);
      }
    }

    for (const url of normalized) {
      const seenAt = recentClaimedDeepLinks.get(url) ?? 0;
      if (now - seenAt < 1500) {
        continue;
      }

      const matchedDen = queueDenAuthDeepLink(url);
      const matchedRemote = !matchedDen && queueRemoteConnectDeepLink(url);
      const matchedBundle = !matchedDen && !matchedRemote && sharedBundleFlow.queueSharedBundleDeepLink(url);
      const claimed = matchedDen || matchedRemote || matchedBundle;
      if (!claimed) {
        continue;
      }

      recentClaimedDeepLinks.set(url, now);
      stripHandledBrowserDeepLink(url);
      break;
    }
  };

  const openDebugDeepLink = async (rawUrl: string): Promise<{ ok: boolean; message: string }> => {
    const parsed = parseDebugDeepLinkInput(rawUrl);
    if (!parsed) {
      return { ok: false, message: "That link is not a recognized OpenWork deep link or share URL." };
    }

    setError(null);
    setView("dashboard");
    if (parsed.kind === "bundle") {
      return sharedBundleFlow.openDebugSharedBundleLink(parsed.link);
    }
    if (parsed.kind === "auth") {
      setPendingDenAuthDeepLink(parsed.link);
      return { ok: true, message: "Queued the Cloud auth deep link for OpenWork." };
    }

    setPendingRemoteConnectDeepLink(parsed.kind === "remote" ? parsed.link : null);
    setTab("scheduled");
    return { ok: true, message: "Queued remote worker link. OpenWork should move into the connect flow." };
  };

  createEffect(() => {
    const pending = pendingDenAuthDeepLink();
    if (!pending || booting() || processingDenAuthDeepLink()) {
      return;
    }

    setProcessingDenAuthDeepLink(true);
    setPendingDenAuthDeepLink(null);
    setView("dashboard");
    setSettingsTab("den");
    goToDashboard("settings");

    void createDenClient({ baseUrl: pending.denBaseUrl })
      .exchangeDesktopHandoff(pending.grant)
      .then((result) => {
        if (!result.token) {
          throw new Error("Desktop sign-in completed, but OpenWork Cloud did not return a session token.");
        }

        writeDenSettings({
          baseUrl: pending.denBaseUrl,
          authToken: result.token,
          activeOrgId: null,
          activeOrgSlug: null,
          activeOrgName: null,
        });

        window.dispatchEvent(
          new CustomEvent("openwork-den-session-updated", {
            detail: {
              status: "success",
              email: result.user?.email ?? null,
            },
          }),
        );
      })
      .catch((error) => {
        window.dispatchEvent(
          new CustomEvent("openwork-den-session-updated", {
            detail: {
              status: "error",
              message: error instanceof Error ? error.message : "Failed to complete OpenWork Cloud sign-in.",
            },
          }),
        );
      })
      .finally(() => {
        setProcessingDenAuthDeepLink(false);
      });
  });

  createEffect(() => {
    const pending = pendingRemoteConnectDeepLink();
    if (!pending || booting()) {
      return;
    }

    if (pending.autoConnect) {
      setView("session");
    } else {
      setView("dashboard");
      setTab("scheduled");
    }
    setPendingRemoteConnectDeepLink(null);
    void completeRemoteConnectDeepLink(pending);
  });

  createEffect(() => {
    if (workspaceStore.createRemoteWorkspaceOpen()) {
      return;
    }
    if (!deepLinkRemoteWorkspaceDefaults()) {
      return;
    }
    setDeepLinkRemoteWorkspaceDefaults(null);
  });

  const editRemoteWorkspaceDefaults = createMemo(() => {
    const workspaceId = editRemoteWorkspaceId();
    if (!workspaceId) return null;
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace || workspace.workspaceType !== "remote") return null;
    return {
      openworkHostUrl: workspace.openworkHostUrl ?? workspace.baseUrl ?? "",
      openworkToken: workspace.openworkToken ?? openworkServerSettings().token ?? "",
      directory: workspace.directory ?? "",
      displayName: workspace.displayName ?? "",
    };
  });

  const openRenameWorkspace = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceName(
      workspace.displayName?.trim() ||
        workspace.openworkWorkspaceName?.trim() ||
        workspace.name?.trim() ||
        ""
    );
    setRenameWorkspaceOpen(true);
  };

  const closeRenameWorkspace = () => {
    if (renameWorkspaceBusy()) return;
    setRenameWorkspaceOpen(false);
    setRenameWorkspaceId(null);
    setRenameWorkspaceName("");
  };

  const saveRenameWorkspace = async () => {
    const workspaceId = renameWorkspaceId();
    if (!workspaceId) return;
    const nextName = renameWorkspaceName().trim();
    if (!nextName) return;
    if (renameWorkspaceBusy()) return;

    setRenameWorkspaceBusy(true);
    setError(null);
    try {
      const ok = await workspaceStore.updateWorkspaceDisplayName(workspaceId, nextName);
      if (!ok) return;
      setRenameWorkspaceOpen(false);
      setRenameWorkspaceId(null);
      setRenameWorkspaceName("");
    } catch (e) {
      const message = e instanceof Error ? e.message : safeStringify(e);
      setError(addOpencodeCacheHint(message));
    } finally {
      setRenameWorkspaceBusy(false);
    }
  };

  const testOpenworkServerConnection = async (next: OpenworkServerSettings) => {
    const derived = normalizeOpenworkServerUrl(next.urlOverride ?? "");
    if (!derived) {
      setOpenworkServerStatus("disconnected");
      setOpenworkServerCapabilities(null);
      setOpenworkServerCheckedAt(Date.now());
      return false;
    }
    const result = await checkOpenworkServer(derived, next.token, openworkServerAuth().hostToken);
    setOpenworkServerStatus(result.status);
    setOpenworkServerCapabilities(result.capabilities);
    setOpenworkServerCheckedAt(Date.now());
    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isTauriRuntime()) {
      const active = workspaceStore.selectedWorkspaceDisplay();
      const shouldAttach = !client() || active.workspaceType !== "remote" || active.remoteType !== "openwork";
      if (shouldAttach) {
        await workspaceStore
          .createRemoteWorkspaceFlow({
            openworkHostUrl: derived,
            openworkToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectOpenworkServer = async () => {
    if (openworkReconnectBusy()) return false;
    setOpenworkReconnectBusy(true);
    try {
      let hostInfo = openworkServerHostInfo();
      if (isTauriRuntime()) {
        try {
          hostInfo = await openworkServerInfo();
          setOpenworkServerHostInfo(hostInfo);
        } catch {
          hostInfo = null;
          setOpenworkServerHostInfo(null);
        }
      }

      // Repair stale local token state by syncing settings token from the live host.
      if (hostInfo?.clientToken?.trim() && startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const settings = openworkServerSettings();
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateOpenworkServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = openworkServerBaseUrl().trim();
      const auth = openworkServerAuth();
      if (!url) {
        setOpenworkServerStatus("disconnected");
        setOpenworkServerCapabilities(null);
        setOpenworkServerCheckedAt(Date.now());
        return false;
      }

      const result = await checkOpenworkServer(url, auth.token, auth.hostToken);
      setOpenworkServerStatus(result.status);
      setOpenworkServerCapabilities(result.capabilities);
      setOpenworkServerCheckedAt(Date.now());
      return result.status === "connected" || result.status === "limited";
    } finally {
      setOpenworkReconnectBusy(false);
    }
  };

  async function ensureLocalOpenworkServerClient(): Promise<OpenworkServerClient | null> {
    let hostInfo = openworkServerHostInfo();
    if (hostInfo?.baseUrl?.trim() && hostInfo.clientToken?.trim()) {
      const existing = createOpenworkServerClient({
        baseUrl: hostInfo.baseUrl.trim(),
        token: hostInfo.clientToken.trim(),
        hostToken: hostInfo.hostToken?.trim() || undefined,
      });
      try {
        await existing.health();
        if (startupPreference() !== "server") {
          await reconnectOpenworkServer();
        }
        return existing;
      } catch {
        // restart below
      }
    }

    if (!isTauriRuntime()) {
      return null;
    }

    try {
      hostInfo = await openworkServerRestart({
        remoteAccessEnabled: openworkServerSettings().remoteAccessEnabled === true,
      });
      setOpenworkServerHostInfo(hostInfo);
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) {
      return null;
    }

    if (startupPreference() !== "server") {
      await reconnectOpenworkServer();
    }

    return createOpenworkServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const restartLocalServer = async () => {
    const activeWorkspace = workspaceStore.selectedWorkspaceDisplay();
    const activeLocalPath =
      activeWorkspace.workspaceType === "local" ? workspaceStore.selectedWorkspacePath().trim() : "";
    const runningProjectDir = workspaceStore.engine()?.projectDir?.trim() ?? "";
    const workspacePath = activeLocalPath || runningProjectDir;

    if (!workspacePath) {
      setError("Pick a local worker folder before restarting the local server.");
      return false;
    }

    return workspaceStore.startHost({ workspacePath, navigate: false });
  };

  const openWorkspaceConnectionSettings = (workspaceId: string) => {
    const workspace = workspaceStore.workspaces().find((item) => item.id === workspaceId) ?? null;
    if (workspace?.workspaceType === "remote" && workspace.remoteType === "openwork") {
      setEditRemoteWorkspaceId(workspace.id);
      setEditRemoteWorkspaceError(null);
      setEditRemoteWorkspaceOpen(true);
      return;
    }
    if (workspace?.workspaceType === "remote") {
      setEditRemoteWorkspaceId(workspace.id);
      setEditRemoteWorkspaceError(null);
      setEditRemoteWorkspaceOpen(true);
      return;
    }
    setTab("config");
    setView("dashboard");
  };

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
      setError("Connect to this worker before applying runtime changes.");
      return false;
    }

    try {
      await client.reloadEngine(workspaceId);
      await workspaceStore.activateWorkspace(workspaceStore.selectedWorkspaceId());
      await refreshMcpServers();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to apply runtime changes.";
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
    notion: {
      status: notionStatus,
      setStatus: setNotionStatus,
      statusDetail: notionStatusDetail,
      setStatusDetail: setNotionStatusDetail,
      skillInstalled: notionSkillInstalled,
      setTryPromptVisible: setTryNotionPromptVisible,
    },
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
    setPendingUpdate,
    updateEnv,
    setUpdateEnv,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
    resetModalOpen,
    setResetModalOpen,
    resetModalMode,
    setResetModalMode,
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
      if (typeof window !== "undefined") {
        try {
          const sessionOverridePrefix = `${SESSION_MODEL_PREF_KEY}.`;
          const keysToRemove: string[] = [];
          for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (!key) continue;
            if (key.startsWith(sessionOverridePrefix)) {
              keysToRemove.push(key);
            }
          }
          for (const key of keysToRemove) {
            window.localStorage.removeItem(key);
          }
        } catch {
          // ignore
        }
      }

      setThemeMode("system");
      setEngineSource(isTauriRuntime() ? "sidecar" : "path");
      setEngineCustomBinPath("");
      setEngineRuntime("openwork-orchestrator");
      setDefaultModel(DEFAULT_MODEL);
      setLegacyDefaultModel(DEFAULT_MODEL);
      setDefaultModelExplicit(false);
      setPendingDefaultModelByWorkspace({});
      setShowThinking(false);
      setHideTitlebar(false);
      setAutoCompactContext(false);
      setModelVariant(null);
      setUpdateAutoCheck(true);
      setUpdateAutoDownload(false);
      setUpdateStatus({ state: "idle", lastCheckedAt: null });
      setDeveloperMode(false);

      clearStartupPreference();
      setStartupPreference(null);
      setRememberStartupChoice(false);

      clearOpenworkServerSettings();
      setOpenworkServerSettings(readOpenworkServerSettings());

      setNotionStatus("disconnected");
      setNotionStatusDetail(null);
      setNotionError(null);
      setNotionSkillInstalled(false);
      setTryNotionPromptVisible(false);

      return { ok: true, message: "Reset app config defaults. Restart OpenWork if any stale settings remain." };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reset app config defaults.";
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

  const workspaceAutoReloadAvailable = createMemo(() =>
    false,
  );

  const workspaceAutoReloadEnabled = createMemo(() => {
    if (!workspaceAutoReloadAvailable()) return false;
    const cfg = workspaceStore.workspaceConfig();
    return Boolean(cfg?.reload?.auto);
  });

  const workspaceAutoReloadResumeEnabled = createMemo(() => {
    if (!workspaceAutoReloadAvailable()) return false;
    const cfg = workspaceStore.workspaceConfig();
    return Boolean(cfg?.reload?.resume);
  });

  const setWorkspaceAutoReloadEnabled = async (next: boolean) => {
    if (!workspaceAutoReloadAvailable()) return;
    const cfg = workspaceStore.workspaceConfig();
    const resume = Boolean(cfg?.reload?.resume);
    await workspaceStore.persistReloadSettings({ auto: next, resume: next ? resume : false });
  };

  const setWorkspaceAutoReloadResumeEnabled = async (next: boolean) => {
    if (!workspaceAutoReloadAvailable()) return;
    const cfg = workspaceStore.workspaceConfig();
    const auto = Boolean(cfg?.reload?.auto);
    await workspaceStore.persistReloadSettings({ auto, resume: auto ? next : false });
  };

  const reloadWorkspaceEngineAndResume = async () => {
    await reloadWorkspaceEngine();
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
    await reloadWorkspaceEngineAndResume();
  };

  onMount(() => {
    // OpenCode hot reload drives freshness now; OpenWork no longer listens for
    // legacy reload-required events.
  });

  const {
    engine,
    engineDoctorResult,
    engineDoctorCheckedAt,
    engineInstallLogs,
    projectDir: workspaceProjectDir,
    newAuthorizedDir,
    refreshEngineDoctor,
    stopHost,
    setEngineInstallLogs,
  } = workspaceStore;

  const schedulerPluginInstalled = createMemo(() => isPluginInstalledByName("opencode-scheduler"));

  const automationsStore = createAutomationsStore({
    selectedWorkspaceId: () => workspaceStore.selectedWorkspaceId(),
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot(),
    runtimeWorkspaceId,
    openworkServerClient,
    openworkServerStatus,
    schedulerPluginInstalled,
  });

  const {
    scheduledJobs,
    scheduledJobsStatus,
    scheduledJobsBusy,
    scheduledJobsUpdatedAt,
    scheduledJobsSource,
    scheduledJobsPollingAvailable,
    refreshScheduledJobs,
    deleteScheduledJob,
  } = automationsStore;

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (currentView() !== "dashboard") return;
    if (tab() !== "scheduled") return;
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

  createEffect(() => {
    if (!isTauriRuntime()) return;
    workspaceStore.selectedWorkspaceId();
    workspaceProjectDir();
    void refreshMcpServers();
  });

  const activeAuthorizedDirs = createMemo(() => workspaceStore.authorizedDirs());
  const selectedWorkspaceDisplay = createMemo(() => workspaceStore.selectedWorkspaceDisplay());
  const resolvedActiveWorkspaceConfig = createMemo(
    () => activeWorkspaceServerConfig() ?? workspaceStore.workspaceConfig(),
  );
  const providerAuthStore = createProviderAuthStore({
    client,
    providers,
    providerConnectedIds,
    selectedWorkspaceType: () =>
      selectedWorkspaceDisplay().workspaceType === "remote" ? "remote" : "local",
    getDisabledProviders: () => globalSync.data.config.disabled_providers ?? [],
    setDisabledProviders: (value) => {
      globalSync.set("config", "disabled_providers", value);
    },
    setProviderListResponse: (value) => {
      globalSync.set("provider", value);
    },
    removeProviderFromState,
    markOpencodeConfigReloadRequired,
    describeProviderError,
    onRestorePromptFocus: focusSessionPromptSoon,
  });
  const {
    providerAuthBusy,
    providerAuthModalOpen,
    providerAuthError,
    providerAuthMethods,
    providerAuthPreferredProviderId,
    providerAuthWorkerType,
    refreshProviders,
    startProviderAuth,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    disconnectProvider,
    openProviderAuthModal,
    closeProviderAuthModal,
  } = providerAuthStore;
  const refreshActiveWorkspaceServerConfig = workspaceStore.refreshRuntimeWorkspaceConfig;
  const sharedBundleFlow = createSharedBundleFlow({
    booting,
    startupPreference,
    openworkServerHostInfo,
    openworkServerSettings,
    openworkServerClient,
    openworkServerStatus,
    runtimeWorkspaceId,
    workspaceStore,
    error,
    setError,
    setView,
    setTab,
    refreshActiveWorkspaceServerConfig,
    refreshSkills,
    refreshHubSkills,
    markReloadRequired,
  });
  const initialSharedBundleInvite = startupSharedBundleInvite();
  if (initialSharedBundleInvite) {
    sharedBundleFlow.queueSharedBundleInvite(initialSharedBundleInvite);
    setStartupSharedBundleInvite(null);
  }
  const activePermissionMemo = createMemo(() => activePermission());
  const authorizedFoldersStore = createAuthorizedFoldersStore({
    openworkServerClient,
    runtimeWorkspaceId,
    openworkServerReady,
    openworkServerWorkspaceReady,
    openworkServerCanReadConfig,
    openworkServerCanWriteConfig,
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot(),
    markOpencodeConfigReloadRequired,
  });

  const workspaceMaintenanceStore = createWorkspaceMaintenanceStore({
    sandboxCreateProgress: workspaceStore.sandboxCreateProgress,
    sandboxCreateProgressLast: workspaceStore.lastSandboxCreateProgress,
    repairOpencodeMigration: workspaceStore.repairOpencodeMigration,
    migrationRepairBusy: workspaceStore.migrationRepairBusy,
    migrationRepairResult: workspaceStore.migrationRepairResult,
    canRepairOpencodeMigration: workspaceStore.canRepairOpencodeMigration,
    selectedWorkspaceType: () => selectedWorkspaceDisplay().workspaceType,
    selectedWorkspacePath: () => workspaceStore.selectedWorkspacePath(),
    repairOpencodeCache,
    cacheRepairBusy,
    cacheRepairResult,
    cleanupOpenworkDockerContainers,
    dockerCleanupBusy,
    dockerCleanupResult,
  });

  const [expandedStepIds, setExpandedStepIds] = createSignal<Set<string>>(
    new Set()
  );
  const [expandedSidebarSections, setExpandedSidebarSections] = createSignal({
    progress: true,
    artifacts: true,
    context: false,
    plugins: false,
    mcp: false,
    skills: true,
    authorizedFolders: false,
  });
  const [autoConnectAttempted, setAutoConnectAttempted] = createSignal(false);

  const [blueprintSessionMaterializeBusyByWorkspaceId, setBlueprintSessionMaterializeBusyByWorkspaceId] =
    createSignal<Record<string, boolean>>({});
  const [blueprintSessionMaterializeAttemptedByWorkspaceId, setBlueprintSessionMaterializeAttemptedByWorkspaceId] =
    createSignal<Record<string, boolean>>({});

  createEffect(() => {
    const workspaceId = (runtimeWorkspaceId() ?? "").trim();
    const client = openworkServerClient();
    const connected = openworkServerStatus() === "connected";
    const root = workspaceStore.selectedWorkspaceRoot().trim();
    const config = resolvedActiveWorkspaceConfig();
    const templates = blueprintSessions(config);
    const materialized = blueprintMaterializedSessions(config);
    const currentSessions = sessions();
    const normalizedRoot = normalizeDirectoryPath(root);
    const hasWorkspaceSessions = currentSessions.some((session) => {
      const directory = typeof session.directory === "string" ? session.directory : "";
      return normalizeDirectoryPath(directory) === normalizedRoot;
    });

    if (!workspaceId || !client || !connected) return;
    if (!root) return;
    if (!sessionsLoaded()) return;
    if (creatingSession()) return;
    if (selectedSessionId()) return;
    if (!templates.length) return;
    if (materialized.length > 0) return;
    if (hasWorkspaceSessions) return;
    if (blueprintSessionMaterializeBusyByWorkspaceId()[workspaceId]) return;
    if (blueprintSessionMaterializeAttemptedByWorkspaceId()[workspaceId]) return;

    setBlueprintSessionMaterializeBusyByWorkspaceId((current) => ({
      ...current,
      [workspaceId]: true,
    }));

    void (async () => {
      try {
        const result = await client.materializeBlueprintSessions(workspaceId);
        const templateMessages = new Map(
          templates.map((template) => [template.id?.trim(), (template.messages ?? []).filter((entry) => entry?.text?.trim())] as const),
        );
        if (result.created.length > 0) {
          setBlueprintSeedMessagesBySessionId((current) => {
            const next = { ...current };
            result.created.forEach((entry) => {
              const messages = templateMessages.get(entry.templateId?.trim());
              if (messages && messages.length > 0) {
                next[entry.sessionId] = messages;
              }
            });
            return next;
          });
        }
        setBlueprintSessionMaterializeAttemptedByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: true,
        }));
        await refreshActiveWorkspaceServerConfig(workspaceId);
        await loadSessionsWithReady(root || undefined);
        const pending = pendingInitialSessionSelection();
        const shouldDeferInitialOpen = pending && pending.workspaceId === workspaceId;
        if (result.openSessionId && !shouldDeferInitialOpen) {
          goToSession(result.openSessionId, { replace: true });
          await selectSession(result.openSessionId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      } finally {
        setBlueprintSessionMaterializeBusyByWorkspaceId((current) => {
          const next = { ...current };
          delete next[workspaceId];
          return next;
        });
      }
    })();
  });

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

  const selectedSessionAgent = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return null;
    return sessionAgentById()[id] ?? null;
  });

  function openSettingsFromModelPicker() {
    setTab("settings");
    setView("dashboard");
  }

  async function connectNotion() {
    if (workspaceStore.selectedWorkspaceDisplay().workspaceType !== "local") {
      setNotionError("Notion connections are only available for local workspaces.");
      return;
    }

    const projectDir = workspaceProjectDir().trim();
    if (!projectDir) {
      setNotionError("Pick a workspace folder first.");
      return;
    }

    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.mcp?.write;

    if (!canUseOpenworkServer && !isTauriRuntime()) {
      setNotionError("Notion connections require the desktop app.");
      return;
    }

    if (notionBusy()) return;

    setNotionBusy(true);
    setNotionError(null);
    setNotionStatus("connecting");
    setNotionStatusDetail(t("mcp.connecting", currentLocale()));
    setNotionSkillInstalled(false);

    try {
      if (canUseOpenworkServer) {
        await openworkClient.addMcp(openworkWorkspaceId, {
          name: "notion",
          config: {
            type: "remote",
            url: "https://mcp.notion.com/mcp",
            enabled: true,
          },
        });
      } else {
        const config = await readOpencodeConfig("project", projectDir);
        const raw = config.content ?? "";
        const nextConfig = raw.trim()
          ? (parse(raw) as Record<string, unknown>)
          : { $schema: "https://opencode.ai/config.json" };

        const mcp = typeof nextConfig.mcp === "object" && nextConfig.mcp
          ? { ...(nextConfig.mcp as Record<string, unknown>) }
          : {};
        mcp.notion = {
          type: "remote",
          url: "https://mcp.notion.com/mcp",
          enabled: true,
        };

        nextConfig.mcp = mcp;
        const formatted = JSON.stringify(nextConfig, null, 2);

        const result = await writeOpencodeConfig("project", projectDir, `${formatted}\n`);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
      }

      markReloadRequired("mcp", { type: "mcp", name: "notion", action: "added" });

      await refreshMcpServers();
      setNotionStatusDetail(t("mcp.connecting", currentLocale()));
      try {
        window.localStorage.setItem("openwork.notionStatus", "connecting");
        window.localStorage.setItem("openwork.notionStatusDetail", t("mcp.connecting", currentLocale()));
        window.localStorage.setItem("openwork.notionSkillInstalled", "0");
      } catch {
        // ignore
      }
    } catch (e) {
      setNotionStatus("error");
      setNotionError(e instanceof Error ? e.message : "Failed to connect Notion.");
    } finally {
      setNotionBusy(false);
    }
  }

  const {
    prompt,
    setPrompt,
    lastPromptSent,
    createSessionAndOpen,
    sendPrompt,
    abortSession,
    retryLastPrompt,
    compactCurrentSession,
    undoLastUserMessage,
    redoLastUserMessage,
    renameSession: renameSessionTitle,
    deleteSession: deleteSessionById,
    listAgents,
    listCommands,
  } = useSessionActions({
    client,
    baseUrl,
    selectedSessionId,
    selectedSession,
    selectedSessionModel,
    selectedSessionAgent,
    workspaceProjectDir,
    selectedWorkspaceId: () => workspaceStore.selectedWorkspaceId(),
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot().trim(),
    messages,
    sessions,
    pendingSessionModel,
    developerMode,
    locationPathname: () => location.pathname,
    ensureSelectedWorkspaceRuntime,
    createSessionRoute: (sessionId) => goToSession(sessionId),
    navigateToSessionList: () => navigate("/session", { replace: true }),
    selectSession,
    refreshSidebarWorkspaceSessions,
    abortRefreshes,
    setBusy,
    setBusyLabel,
    setBusyStartedAt,
    setError,
    setCreatingSession,
    setSelectedSessionId,
    setSessions,
    sessionStatusById,
    setSessionStatusById,
    setPendingSessionModel,
    setSessionModelById,
    setSessionModelOverrideById,
    readSessionByWorkspace,
    writeSessionByWorkspace,
    appendSessionErrorTurn: sessionStore.appendSessionErrorTurn,
    describeProviderError,
    logWorkspaceScopeSnapshot: (label, payload) =>
      logWorkspaceScopeSnapshot(label, payload as Record<string, unknown> | undefined),
    safeStringify,
    getVariantFor,
    sanitizeModelVariantForRef,
    resolveCodexReasoningEffort,
  });


  useAppBootstrap({
    themeMode,
    launchUpdateCheckTriggered,
    setRememberStartupChoice,
    setStartupPreference,
    setBaseUrl,
    setClientDirectory,
    setEngineSource,
    setEngineCustomBinPath,
    setEngineRuntime,
    setOpencodeEnableExa,
    setDefaultModel,
    setLegacyDefaultModel,
    setShowThinking,
    setHideTitlebar,
    setModelVariantMap,
    setUpdateAutoCheck,
    setUpdateAutoDownload,
    setUpdateStatus,
    setNotionStatus,
    setNotionStatusDetail,
    setNotionSkillInstalled,
    setAppVersion,
    setUpdateEnv,
    setLaunchUpdateCheckTriggered,
    refreshMcpServers,
    checkForUpdates,
    consumeDeepLinks,
    bootstrapOnboarding: workspaceStore.bootstrapOnboarding,
    setBooting,
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (onboardingStep() !== "local") return;
    void workspaceStore.refreshEngineDoctor();
  });

  useAppPreferencePersistence({
    baseUrl,
    clientDirectory,
    workspaceProjectDir,
    engineSource,
    engineCustomBinPath,
    engineRuntime,
    opencodeEnableExa,
    defaultModel,
    updateAutoCheck,
    updateAutoDownload,
    showThinking,
    hideTitlebar,
    modelVariantMap,
    updateStatus,
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

  const localHostLabel = createMemo(() => {
    const info = engine();
    if (info?.hostname && info?.port) {
      return `${info.hostname}:${info.port}`;
    }

    try {
      return new URL(baseUrl()).host;
    } catch {
      return "localhost:4096";
    }
  });

  const onboardingProps = () => ({
    startupPreference: startupPreference(),
    onboardingStep: onboardingStep(),
    rememberStartupChoice: rememberStartupChoice(),
    busy: busy(),
    clientDirectory: clientDirectory(),
    openworkHostUrl: openworkServerSettings().urlOverride ?? "",
    openworkToken: openworkServerSettings().token ?? "",
    newAuthorizedDir: newAuthorizedDir(),
    authorizedDirs: workspaceStore.authorizedDirs(),
    selectedWorkspacePath: workspaceStore.selectedWorkspacePath(),
    workspaces: workspaceStore.workspaces(),
    localHostLabel: localHostLabel(),
    engineRunning: Boolean(engine()?.running),
    developerMode: developerMode(),
    engineBaseUrl: engine()?.baseUrl ?? null,
    engineDoctorFound: engineDoctorResult()?.found ?? null,
    engineDoctorSupportsServe: engineDoctorResult()?.supportsServe ?? null,
    engineDoctorVersion: engineDoctorResult()?.version ?? null,
    engineDoctorResolvedPath: engineDoctorResult()?.resolvedPath ?? null,
    engineDoctorNotes: engineDoctorResult()?.notes ?? [],
    engineDoctorServeHelpStdout: engineDoctorResult()?.serveHelpStdout ?? null,
    engineDoctorServeHelpStderr: engineDoctorResult()?.serveHelpStderr ?? null,
    engineDoctorCheckedAt: engineDoctorCheckedAt(),
    engineInstallLogs: engineInstallLogs(),
    error: error(),
    canRepairMigration: workspaceStore.canRepairOpencodeMigration(),
    migrationRepairUnavailableReason: workspaceMaintenanceStore.migrationRepairUnavailableReason(),
    migrationRepairBusy: workspaceStore.migrationRepairBusy(),
    migrationRepairResult: workspaceStore.migrationRepairResult(),
    isWindows: isWindowsPlatform(),
    onClientDirectoryChange: setClientDirectory,
    onOpenworkHostUrlChange: (value: string) =>
      updateOpenworkServerSettings({
        ...openworkServerSettings(),
        urlOverride: value,
      }),
    onOpenworkTokenChange: (value: string) =>
      updateOpenworkServerSettings({
        ...openworkServerSettings(),
        token: value,
      }),
    onSelectStartup: workspaceStore.onSelectStartup,
    onRememberStartupToggle: workspaceStore.onRememberStartupToggle,
    onStartHost: workspaceStore.onStartHost,
    onRepairMigration: workspaceStore.onRepairOpencodeMigration,
    onCreateWorkspace: workspaceStore.createWorkspaceFlow,
    onPickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
    onImportWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
    onAttachHost: workspaceStore.onAttachHost,
    onConnectClient: workspaceStore.onConnectClient,
    onBackToWelcome: workspaceStore.onBackToWelcome,
    onSetAuthorizedDir: workspaceStore.setNewAuthorizedDir,
    onAddAuthorizedDir: workspaceStore.addAuthorizedDir,
    onAddAuthorizedDirFromPicker: () =>
      workspaceStore.addAuthorizedDirFromPicker({ persistToWorkspace: true }),
    onRemoveAuthorizedDir: workspaceStore.removeAuthorizedDirAtIndex,
    onRefreshEngineDoctor: async () => {
      workspaceStore.setEngineInstallLogs(null);
      await workspaceStore.refreshEngineDoctor();
    },
    onInstallEngine: workspaceStore.onInstallEngine,
    onShowSearchNotes: () => {
      const notes =
        workspaceStore.engineDoctorResult()?.notes?.join("\n") ?? "";
      workspaceStore.setEngineInstallLogs(notes || null);
    },
    onOpenSettings: () => {
      setTab("settings");
      setView("dashboard");
    },
    onOpenAdvancedSettings: () => {
      setTab("config");
      setView("dashboard");
    },
    themeMode: themeMode(),
    setThemeMode,
  });

  const canUseDesktopTools = createMemo(
    () => isTauriRuntime() && selectedWorkspaceDisplay().workspaceType !== "remote",
  );
  const canInstallSkillCreator = createMemo(() =>
    selectedWorkspaceDisplay().workspaceType === "remote"
      ? openworkServerCanWriteSkills()
      : isTauriRuntime(),
  );
  const canEditPlugins = createMemo(() =>
    selectedWorkspaceDisplay().workspaceType === "remote"
      ? openworkServerCanWritePlugins()
      : isTauriRuntime(),
  );
  const canUseGlobalPluginScope = createMemo(
    () => selectedWorkspaceDisplay().workspaceType !== "remote" && isTauriRuntime(),
  );
  const skillsAccessHint = createMemo<string | null>(() => {
    if (selectedWorkspaceDisplay().workspaceType !== "remote") {
      return null;
    }
    const status = openworkServerStatus();
    if (status === "disconnected") {
      return "OpenWork server unavailable. Add the server URL/token in Advanced to manage skills.";
    }
    if (status === "limited") {
      return "OpenWork server needs a host token to install/update skills. Add it in Advanced and reconnect.";
    }
    return openworkServerCanWriteSkills()
      ? null
      : "OpenWork server is read-only for skills. Add a host token in Advanced to enable installs.";
  });
  const pluginsAccessHint = createMemo<string | null>(() => {
    if (selectedWorkspaceDisplay().workspaceType !== "remote") {
      return null;
    }
    const status = openworkServerStatus();
    if (status === "disconnected") {
      return "OpenWork server unavailable. Plugins are read-only.";
    }
    if (status === "limited") {
      return "OpenWork server needs a token to edit plugins.";
    }
    return openworkServerCanWritePlugins()
      ? null
      : "OpenWork server is read-only for plugins.";
  });

  const openworkServerContextValue = {
    openworkServerStatus,
    openworkServerUrl,
    openworkServerClient,
    openworkReconnectBusy,
    reconnectOpenworkServer,
    openworkServerSettings,
    openworkServerHostInfo,
    openworkServerCapabilities: devtoolsCapabilities,
    openworkServerDiagnostics,
    runtimeWorkspaceId,
    openworkAuditEntries,
    openworkAuditStatus,
    openworkAuditError,
    shareRemoteAccessBusy,
    shareRemoteAccessError,
    saveShareRemoteAccess,
  };

  const providerAuthContextValue = {
    providers,
    providerConnectedIds,
    providerAuthBusy,
    providerAuthModalOpen,
    providerAuthError,
    providerAuthMethods,
    providerAuthPreferredProviderId,
    providerAuthWorkerType,
    openProviderAuthModal,
    closeProviderAuthModal,
    startProviderAuth,
    completeProviderAuthOAuth,
    submitProviderApiKey,
    disconnectProvider,
    refreshProviders,
  };

  const extensionsContextValue = {
    skills,
    skillsStatus,
    hubSkills,
    hubSkillsStatus,
    hubRepo,
    hubRepos,
    skillsAccessHint,
    canInstallSkillCreator,
    canUseDesktopTools,
    refreshSkills,
    refreshHubSkills,
    ensureHubSkillsFresh,
    importLocalSkill,
    installSkillCreator,
    installHubSkill,
    setHubRepo,
    addHubRepo,
    removeHubRepo,
    revealSkillsFolder,
    uninstallSkill,
    readSkill,
    saveSkill,
    pluginsAccessHint,
    canEditPlugins,
    canUseGlobalPluginScope,
    pluginScope,
    setPluginScope,
    pluginConfigPath: () => pluginConfigPath() ?? pluginConfig()?.path ?? null,
    pluginList,
    pluginInput,
    setPluginInput,
    pluginStatus,
    activePluginGuide,
    setActivePluginGuide,
    isPluginInstalled: isPluginInstalledByName,
    suggestedPlugins: SUGGESTED_PLUGINS,
    refreshPlugins,
    addPlugin,
    removePlugin,
  };

  const workspaceActionsContextValue = {
    openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
    pickFolderWorkspace: workspaceStore.createWorkspaceFromPickedFolder,
    openCreateRemoteWorkspace: () => workspaceStore.setCreateRemoteWorkspaceOpen(true),
    connectRemoteWorkspace: workspaceStore.createRemoteWorkspaceFlow,
    openCloudTemplate: sharedBundleFlow.openCloudTemplate,
    importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig,
    exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
    exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig,
  };

  const scheduledJobsContextValue = {
    scheduledJobs,
    scheduledJobsSource,
    schedulerPluginInstalled,
    scheduledJobsStatus,
    scheduledJobsBusy,
    scheduledJobsUpdatedAt,
    refreshScheduledJobs: async (options?: { force?: boolean }) => {
      await refreshScheduledJobs(options).catch(() => undefined);
    },
    deleteScheduledJob,
  };

  const authorizedFoldersContextValue = authorizedFoldersStore;

  const workspaceMaintenanceContextValue = workspaceMaintenanceStore;

  const dashboardProps = createDashboardPropsBuilder({
    tab,
    setTab,
    settingsTab,
    setSettingsTab,
    setView,
    toggleSettings: () => toggleSettingsView("general"),
    startupPreference,
    baseUrl,
    clientConnected: () => Boolean(client()),
    busy,
    busyHint,
    newTaskDisabled,
    headerStatus,
    error,
    activeWorkspaceType: () => workspaceStore.selectedWorkspaceDisplay().workspaceType,
    opencodeConnectStatus,
    engineInfo: workspaceStore.engine,
    orchestratorStatus: orchestratorStatusState,
    opencodeRouterInfo: opencodeRouterInfoState,
    engineDoctorVersion: () => workspaceStore.engineDoctorResult()?.version ?? null,
    updateOpenworkServerSettings,
    resetOpenworkServerSettings,
    testOpenworkServerConnection,
    canReloadWorkspace,
    reloadWorkspaceEngine: reloadWorkspaceEngineAndResume,
    reloadBusy,
    reloadError,
    workspaceAutoReloadAvailable,
    workspaceAutoReloadEnabled,
    setWorkspaceAutoReloadEnabled,
    workspaceAutoReloadResumeEnabled,
    setWorkspaceAutoReloadResumeEnabled,
    selectedWorkspaceDisplay,
    workspaces: workspaceStore.workspaces,
    selectedWorkspaceId: workspaceStore.selectedWorkspaceId,
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId,
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById,
    switchWorkspace: workspaceStore.switchWorkspace,
    testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
    recoverWorkspace: workspaceStore.recoverWorkspace,
    workspaceSessionGroups: sidebarWorkspaceGroups,
    selectedSessionId: activeSessionId,
    openRenameWorkspace,
    editWorkspaceConnection: openWorkspaceConnectionSettings,
    forgetWorkspace: workspaceStore.forgetWorkspace,
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot().trim(),
    isRemoteWorkspace: () => workspaceStore.selectedWorkspaceDisplay().workspaceType === "remote",
    createSessionAndOpen,
    setPrompt,
    selectSession,
    defaultModelLabel: () => formatModelLabel(defaultModel(), providers()),
    defaultModelRef: () => formatModelRef(defaultModel()),
    openDefaultModelPicker,
    showThinking,
    toggleShowThinking: () => setShowThinking((v) => !v),
    autoCompactContext,
    toggleAutoCompactContext,
    autoCompactContextBusy: autoCompactContextSaving,
    hideTitlebar,
    toggleHideTitlebar: () => setHideTitlebar((v) => !v),
    modelVariantLabel: () => getModelBehaviorCopy(defaultModel(), getVariantFor(defaultModel())).label,
    editModelVariant: openDefaultModelPicker,
    updateAutoCheck,
    toggleUpdateAutoCheck: () => setUpdateAutoCheck((v) => !v),
    updateAutoDownload,
    toggleUpdateAutoDownload: () =>
      setUpdateAutoDownload((v) => {
        const next = !v;
        if (next) {
          setUpdateAutoCheck(true);
        }
        return next;
      }),
    updateStatus,
    updateEnv,
    appVersion,
    checkForUpdates: () => checkForUpdates(),
    downloadUpdate: () => downloadUpdate(),
    installUpdateAndRestart,
    anyActiveRuns,
    engineSource,
    setEngineSource,
    engineCustomBinPath,
    setEngineCustomBinPath,
    engineRuntime,
    setEngineRuntime,
    opencodeEnableExa,
    toggleOpencodeEnableExa: () => setOpencodeEnableExa((v) => !v),
    isWindows: isWindowsPlatform,
    toggleDeveloperMode: () => setDeveloperMode((v) => !v),
    developerMode,
    stopHost,
    restartLocalServer,
    openResetModal,
    resetModalBusy,
    onResetStartupPreference: () => {
      clearStartupPreference();
      setStartupPreference(null);
      setRememberStartupChoice(false);
    },
    themeMode,
    setThemeMode,
    pendingPermissions,
    events,
    workspaceDebugEvents: workspaceStore.workspaceDebugEvents,
    sandboxCreateProgress: workspaceStore.sandboxCreateProgress,
    sandboxCreateProgressLast: workspaceStore.lastSandboxCreateProgress,
    clearWorkspaceDebugEvents: workspaceStore.clearWorkspaceDebugEvents,
    safeStringify,
    resetAppConfigDefaults,
    openDebugDeepLink,
    mcpServers,
    mcpStatus,
    mcpLastUpdatedAt,
    mcpStatuses,
    mcpConnectingName,
    selectedMcp,
    setSelectedMcp,
    quickConnect: MCP_QUICK_CONNECT,
    connectMcp,
    authorizeMcp,
    logoutMcpAuth,
    removeMcp,
    refreshMcpServers,
    language: currentLocale,
    setLanguage: setLocale,
  });

  const searchWorkspaceFiles = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const activeClient = client();
    if (!activeClient) return [];
    try {
      const directory = workspaceProjectDir().trim();
      const result = unwrap(
        await activeClient.find.files({
          query: trimmed,
          dirs: "true",
          limit: 50,
          directory: directory || undefined,
        }),
      );
      return result;
    } catch {
      return [];
    }
  };

  const sessionProps = createSessionPropsBuilder({
    booting,
    selectedSessionId: activeSessionId,
    setView,
    setTab,
    setSettingsTab,
    toggleSettings: () => toggleSettingsView("general"),
    selectedWorkspaceDisplay,
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot().trim(),
    activeWorkspaceConfig: resolvedActiveWorkspaceConfig,
    workspaces: workspaceStore.workspaces,
    selectedWorkspaceId: workspaceStore.selectedWorkspaceId,
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId,
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById,
    switchWorkspace: workspaceStore.switchWorkspace,
    testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
    recoverWorkspace: workspaceStore.recoverWorkspace,
    editWorkspaceConnection: openWorkspaceConnectionSettings,
    forgetWorkspace: workspaceStore.forgetWorkspace,
    clientConnected: () => Boolean(client()),
    engineInfo: workspaceStore.engine,
    engineDoctorVersion: () => workspaceStore.engineDoctorResult()?.version ?? null,
    orchestratorStatus: orchestratorStatusState,
    opencodeRouterInfo: opencodeRouterInfoState,
    appVersion,
    headerStatus,
    busyHint,
    updateStatus,
    anyActiveRuns,
    installUpdateAndRestart,
    createSessionAndOpen,
    sendPromptAsync: sendPrompt,
    abortSession,
    sessionRevertMessageId: () => selectedSession()?.revert?.messageID ?? null,
    undoLastUserMessage,
    redoLastUserMessage,
    compactSession: compactCurrentSession,
    lastPromptSent,
    retryLastPrompt,
    newTaskDisabled,
    workspaceSessionGroups: sidebarWorkspaceGroups,
    openRenameWorkspace,
    selectSession,
    messages: visibleMessages,
    getSessionById: sessionById,
    getMessagesBySessionId: messagesBySessionId,
    ensureSessionLoaded,
    sessionLoadingById,
    todos: activeTodos,
    developerMode,
    showThinking,
    sessionCompactionState: selectedSessionCompactionState,
    expandedStepIds,
    setExpandedStepIds,
    workingFiles: activeWorkingFiles,
    mcpStatuses,
    busy,
    prompt,
    setPrompt,
    selectedSessionModelLabel,
    openSessionModelPicker,
    modelVariantLabel: () =>
      getModelBehaviorCopy(selectedSessionModel(), getVariantFor(selectedSessionModel())).label,
    modelVariant: () => getVariantFor(selectedSessionModel()),
    modelBehaviorOptions: () =>
      getModelBehaviorCopy(selectedSessionModel(), getVariantFor(selectedSessionModel())).options,
    setModelVariant: (value: string | null) => updateModelVariant(selectedSessionModel(), value),
    activePermission: activePermissionMemo,
    showTryNotionPrompt: () => tryNotionPromptVisible() && notionIsActive(),
    onTryNotionPrompt: () => {
      setPrompt("setup my crm");
      setTryNotionPromptVisible(false);
      setNotionSkillInstalled(true);
      try {
        window.localStorage.setItem("openwork.notionSkillInstalled", "1");
      } catch {
        // ignore
      }
    },
    permissionReplyBusy,
    respondPermission,
    respondPermissionAndRemember,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
    safeStringify,
    error,
    sessionStatus: selectedSessionStatus,
    renameSession: renameSessionTitle,
    listAgents,
    searchFiles: searchWorkspaceFiles,
    listCommands,
    selectedSessionAgent,
    setSessionAgent,
    sessionStatusById: activeSessionStatusById,
    hasEarlierMessages: selectedSessionHasEarlierMessages,
    loadingEarlierMessages: selectedSessionLoadingEarlierMessages,
    loadEarlierMessages,
    deleteSession: deleteSessionById,
  });

  const appOverlaysProps = createAppOverlaysPropsBuilder({
    modelPickerOpen: modelPickerOpen,
    modelPickerOptions: modelOptions,
    filteredModelOptions,
    modelPickerQuery,
    setModelPickerQuery,
    modelPickerTarget,
    modelPickerCurrent,
    applyModelSelection,
    onModelBehaviorChange: (model, value) => {
      updateModelVariant(model, sanitizeModelVariantForRef(model, value));
    },
    openSettingsFromModelPicker,
    closeModelPicker,
    resetModalOpen,
    resetModalMode,
    resetModalText,
    resetModalBusy,
    canReset: () =>
      !resetModalBusy() && !anyActiveRuns() && resetModalText().trim().toUpperCase() === "RESET",
    hasActiveRuns: anyActiveRuns,
    language: currentLocale,
    closeResetModal: () => setResetModalOpen(false),
    confirmReset,
    setResetModalText,
    mcpAuthModalOpen,
    mcpAuthClient: client,
    mcpAuthEntry,
    workspaceProjectDir,
    mcpAuthNeedsReload,
    mcpAuthReloadBlocked: () => activeReloadBlockingSessions().length > 0,
    activeReloadBlockingSessions,
    isRemoteWorkspace: () => selectedWorkspaceDisplay().workspaceType === "remote",
    forceStopSession: (sessionID) => abortSession(sessionID),
    closeMcpAuthModal,
    completeMcpAuthModal,
    reloadWorkspaceEngine: () => reloadWorkspaceEngineAndResume(),
    sharedBundleImportOpen: () => Boolean(sharedBundleFlow.sharedBundleImportChoice()),
    sharedBundleImportTitle: () => sharedBundleFlow.sharedBundleImportCopy()?.title ?? "Import shared bundle",
    sharedBundleImportDescription: () =>
      sharedBundleFlow.sharedBundleImportCopy()?.description ?? "Choose how to import this shared bundle.",
    sharedBundleImportItems: () => sharedBundleFlow.sharedBundleImportCopy()?.items ?? [],
    sharedBundleWorkerOptions: sharedBundleFlow.sharedBundleWorkerOptions,
    sharedBundleImportBusy: sharedBundleFlow.sharedBundleImportBusy,
    sharedBundleImportError: sharedBundleFlow.sharedBundleImportError,
    closeSharedBundleImportChoice: sharedBundleFlow.closeSharedBundleImportChoice,
    openSharedBundleCreateWorkerFlow: () => {
      void sharedBundleFlow.openSharedBundleCreateWorkerFlow();
    },
    importSharedBundleIntoExistingWorkspace: (workspaceId) => {
      void sharedBundleFlow.importSharedBundleIntoExistingWorkspace(workspaceId);
    },
    startWithTemplateOpen: () => Boolean(sharedBundleFlow.sharedTemplateStartRequest()),
    sharedTemplateName: () => sharedBundleFlow.sharedTemplateStartRequest()?.bundle.name?.trim() || "this template",
    sharedTemplateDescription: () => sharedBundleFlow.sharedTemplateStartRequest()?.bundle.description ?? "",
    sharedTemplateStartItems: sharedBundleFlow.sharedTemplateStartItems,
    sharedTemplateStartBusy: sharedBundleFlow.sharedTemplateStartBusy,
    closeTemplateStart: sharedBundleFlow.closeTemplateStart,
    pickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
    startWorkspaceFromTemplate: (folder) => {
      void sharedBundleFlow.startWorkspaceFromTemplate(folder);
    },
    createWorkspace: {
      open: workspaceStore.createWorkspaceOpen(),
      onClose: () => {
        workspaceStore.setCreateWorkspaceOpen(false);
        workspaceStore.clearSandboxCreateProgress?.();
        sharedBundleFlow.clearSharedBundleCreateWorkerRequest();
      },
      onPickFolder: workspaceStore.pickWorkspaceFolder,
      defaultPreset: sharedBundleFlow.createWorkspaceDefaultPreset(),
      onConfirmRemote: (input) => workspaceStore.createRemoteWorkspaceFlow(input),
      onConfirmTemplate: (template, preset, folder) =>
        sharedBundleFlow.startWorkspaceFromCloudTemplate({
          name: template.name,
          templateData: template.templateData,
          folder,
          preset,
        }),
      onConfirm: (preset, folder) => sharedBundleFlow.confirmCreateWorkspaceImport(preset, folder),
      onConfirmWorker: isTauriRuntime()
        ? (preset, folder) => sharedBundleFlow.confirmCreateSandboxImport(preset, folder)
        : undefined,
      workerDisabled: (() => {
        if (!isTauriRuntime()) return true;
        if (workspaceStore.sandboxDoctorBusy?.()) return true;
        const doctor = workspaceStore.sandboxDoctorResult?.();
        if (!doctor) return false;
        return !doctor?.ready;
      })(),
      workerDisabledReason: (() => {
        if (!isTauriRuntime()) return t("app.error.tauri_required", currentLocale());
        if (workspaceStore.sandboxDoctorBusy?.()) {
          return t("dashboard.sandbox_checking_docker", currentLocale());
        }
        const doctor = workspaceStore.sandboxDoctorResult?.();
        if (!doctor || doctor.ready) return null;
        const message = doctor?.error?.trim();
        return message || t("dashboard.sandbox_get_ready_desc", currentLocale());
      })(),
      workerCtaLabel: t("dashboard.sandbox_get_ready_action", currentLocale()),
      workerCtaDescription: t("dashboard.sandbox_get_ready_desc", currentLocale()),
      onWorkerCta: async () => {
        const url = "https://www.docker.com/products/docker-desktop/";
        if (isTauriRuntime()) {
          const { openUrl } = await import("@tauri-apps/plugin-opener");
          await openUrl(url);
        } else {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
      workerRetryLabel: t("common.retry", currentLocale()),
      workerDebugLines: (() => {
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
      })(),
      onWorkerRetry: () => {
        void workspaceStore.refreshSandboxDoctor?.();
      },
      workerSubmitting: workspaceStore.sandboxPreflightBusy?.() ?? false,
      remoteSubmitting: busy() && busyLabel() === "status.connecting",
      remoteError: busyLabel() === "status.connecting" ? error() : null,
      submitting: (() => {
        const phase = workspaceStore.sandboxCreatePhase?.() ?? "idle";
        if (phase === "provisioning" || phase === "finalizing") return true;
        return busy() && busyLabel() === "status.creating_workspace";
      })(),
      submittingProgress: workspaceStore.sandboxCreateProgress?.() ?? null,
    },
    sharedSkillDestination: {
      open:
        Boolean(sharedBundleFlow.sharedSkillDestinationRequest()) &&
        !workspaceStore.createWorkspaceOpen() &&
        !workspaceStore.createRemoteWorkspaceOpen(),
      skill: (() => {
        const request = sharedBundleFlow.sharedSkillDestinationRequest();
        if (!request) return null;
        return {
          name: request.bundle.name,
          description: request.bundle.description ?? null,
          trigger: request.bundle.trigger ?? null,
        };
      })(),
      workspaces: sharedBundleFlow.sharedSkillDestinationWorkspaces(),
      selectedWorkspaceId: workspaceStore.selectedWorkspaceId(),
      busyWorkspaceId: sharedBundleFlow.sharedSkillDestinationBusyId(),
      onClose: sharedBundleFlow.closeSharedSkillDestination,
      onSubmitWorkspace: sharedBundleFlow.importSharedSkillIntoWorkspace,
      onCreateWorker: isTauriRuntime()
        ? sharedBundleFlow.openCreateWorkerFromSharedSkillDestination
        : undefined,
      onConnectRemote: () => {
        setError(null);
        workspaceStore.setCreateRemoteWorkspaceOpen(true);
      },
    },
    createRemoteWorkspace: {
      open: workspaceStore.createRemoteWorkspaceOpen(),
      onClose: () => {
        workspaceStore.setCreateRemoteWorkspaceOpen(false);
        setDeepLinkRemoteWorkspaceDefaults(null);
      },
      onConfirm: (input) => workspaceStore.createRemoteWorkspaceFlow(input),
      initialValues: deepLinkRemoteWorkspaceDefaults() ?? undefined,
      submitting:
        busy() &&
        (busyLabel() === "status.creating_workspace" || busyLabel() === "status.connecting"),
    },
    reloadToast: {
      open: reloadRequired("config", "mcp", "plugin", "skill", "agent", "command"),
      title: reloadCopy().title,
      description: reloadCopy().body,
      trigger: reloadTrigger(),
      error: reloadError(),
      reloadLabel: activeReloadBlockingSessions().length > 0 ? "Reload & Stop Tasks" : "Reload now",
      dismissLabel: "Later",
      busy: reloadBusy(),
      canReload: canReloadWorkspace(),
      hasActiveRuns: activeReloadBlockingSessions().length > 0,
      onReload: () => {
        void (activeReloadBlockingSessions().length > 0
          ? forceStopActiveSessionsAndReload()
          : reloadWorkspaceEngineAndResume());
      },
      onDismiss: clearReloadRequired,
    },
    statusToast: {
      open: Boolean(sharedBundleFlow.sharedSkillSuccessToast()),
      tone: "success",
      title: sharedBundleFlow.sharedSkillSuccessToast()?.title ?? "Skill added",
      description: sharedBundleFlow.sharedSkillSuccessToast()?.description ?? null,
      dismissLabel: "Dismiss",
      onDismiss: sharedBundleFlow.clearSharedSkillSuccessToast,
    },
    renameWorkspace: {
      open: renameWorkspaceOpen(),
      title: renameWorkspaceName(),
      busy: renameWorkspaceBusy(),
      canSave: renameWorkspaceName().trim().length > 0 && !renameWorkspaceBusy(),
      onClose: closeRenameWorkspace,
      onSave: saveRenameWorkspace,
      onTitleChange: setRenameWorkspaceName,
    },
    editRemoteWorkspace: {
      open: editRemoteWorkspaceOpen(),
      onClose: () => {
        setEditRemoteWorkspaceOpen(false);
        setEditRemoteWorkspaceId(null);
        setEditRemoteWorkspaceError(null);
      },
      onConfirm: (input) => {
        const workspaceId = editRemoteWorkspaceId();
        if (!workspaceId) return;
        setEditRemoteWorkspaceError(null);
        void (async () => {
          try {
            const ok = await workspaceStore.updateRemoteWorkspaceFlow(workspaceId, input);
            if (ok) {
              setEditRemoteWorkspaceOpen(false);
              setEditRemoteWorkspaceId(null);
              setEditRemoteWorkspaceError(null);
            } else {
              setEditRemoteWorkspaceError(error() || "Connection failed. Check the URL and token.");
              setError(null);
            }
          } catch (e) {
            const message = e instanceof Error ? e.message : "Connection failed";
            setEditRemoteWorkspaceError(message);
            setError(null);
          }
        })();
      },
      initialValues: editRemoteWorkspaceDefaults() ?? undefined,
      submitting: busy() && busyLabel() === "status.connecting",
      error: editRemoteWorkspaceError(),
      title: t("dashboard.edit_remote_workspace_title", currentLocale()),
      subtitle: t("dashboard.edit_remote_workspace_subtitle", currentLocale()),
      confirmLabel: t("dashboard.edit_remote_workspace_confirm", currentLocale()),
    },
  });

  const dashboardTabs = new Set<DashboardTab>([
    "scheduled",
    "skills",
    "plugins",
    "mcp",
    "identities",
    "config",
    "settings",
  ]);

  const resolveDashboardTab = (value?: string | null) => {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (dashboardTabs.has(normalized as DashboardTab)) {
      return normalized as DashboardTab;
    }
    return "scheduled";
  };

  const initialRoute = () => {
    if (typeof window === "undefined") return "/session";
    return "/session";
  };

  createEffect(() => {
    const rawPath = location.pathname.trim();
    const path = rawPath.toLowerCase();

    if (path === "" || path === "/") {
      navigate(initialRoute(), { replace: true });
      return;
    }

    if (path.startsWith("/dashboard")) {
      const [, , tabSegment] = path.split("/");
      const resolvedTab = resolveDashboardTab(tabSegment);

      if (resolvedTab !== tab()) {
        setTabState(resolvedTab);
      }
      if (!tabSegment || tabSegment !== resolvedTab) {
        goToDashboard(resolvedTab, { replace: true });
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

    if (path.startsWith("/proto-v1-ux") || path.startsWith("/proto")) {
      if (isTauriRuntime()) {
        navigate("/dashboard/scheduled", { replace: true });
        return;
      }

      navigate("/dashboard/scheduled", { replace: true });
      return;
    }

    if (path.startsWith("/onboarding")) {
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
    <OpenworkServerProvider value={openworkServerContextValue}>
      <ProviderAuthProvider value={providerAuthContextValue}>
        <ExtensionsProvider value={extensionsContextValue}>
          <WorkspaceActionsProvider value={workspaceActionsContextValue}>
            <ScheduledJobsProvider value={scheduledJobsContextValue}>
              <AuthorizedFoldersProvider value={authorizedFoldersContextValue}>
                <WorkspaceMaintenanceProvider value={workspaceMaintenanceContextValue}>
                  <>
                    <Switch>
                      <Match when={currentView() === "session"}>
                        <SessionView {...sessionProps()} />
                      </Match>
                      <Match when={true}>
                        <DashboardView {...dashboardProps()} />
                      </Match>
                    </Switch>

                    <AppOverlays {...appOverlaysProps()} />
                  </>
                </WorkspaceMaintenanceProvider>
              </AuthorizedFoldersProvider>
            </ScheduledJobsProvider>
          </WorkspaceActionsProvider>
        </ExtensionsProvider>
      </ProviderAuthProvider>
    </OpenworkServerProvider>
  );
}
