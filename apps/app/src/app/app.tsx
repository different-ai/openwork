import {
  Match,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";

import { useLocation, useNavigate } from "@solidjs/router";

import type {
  Agent,
  Part,
  Session,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from "@opencode-ai/sdk/v2/client";

import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { parse } from "jsonc-parser";

import ModelPickerModal from "./components/model-picker-modal";
import ResetModal from "./components/reset-modal";
import CreateRemoteWorkspaceModal from "./components/create-remote-workspace-modal";
import CreateWorkspaceModal from "./components/create-workspace-modal";
import SkillDestinationModal from "./bundles/skill-destination-modal";
import BundleImportModal from "./bundles/import-modal";
import BundleStartModal from "./bundles/start-modal";
import RenameWorkspaceModal from "./components/rename-workspace-modal";
import ReloadWorkspaceToast from "./components/reload-workspace-toast";
import StatusToast from "./components/status-toast";
import ConnectionsModals from "./connections/modals";
import { ConnectionsProvider } from "./connections/provider";
import { ExtensionsProvider } from "./extensions/provider";
import { AutomationsProvider } from "./automations/provider";
import BootShell from "./shell/boot-shell";
import SettingsShell from "./shell/settings-shell";
import SessionView from "./pages/session";
import { unwrap } from "./lib/opencode";
import { createDenClient, writeDenSettings } from "./lib/den";
import {
  abortSession as abortSessionTyped,
  abortSessionSafe,
  compactSession as compactSessionTyped,
  revertSession,
  unrevertSession,
  shellInSession,
  listCommands as listCommandsTyped,
} from "./lib/opencode-session";
import { clearPerfLogs, finishPerf, perfNow, recordPerfLog } from "./lib/perf-log";
import { deepLinkBridgeEvent, drainPendingDeepLinks, type DeepLinkBridgeDetail } from "./lib/deep-link-bridge";
import {
  DEFAULT_MODEL,
  HIDE_TITLEBAR_PREF_KEY,
  MODEL_PREF_KEY,
  SESSION_MODEL_PREF_KEY,
  SUGGESTED_PLUGINS,
  VARIANT_PREF_KEY,
} from "./constants";
import { compareProviders, providerPriorityRank } from "./utils/providers";
import {
  blueprintMaterializedSessions,
  blueprintSessions,
} from "./lib/workspace-blueprints";
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "./types";
import type {
  Client,
  MessageWithParts,
  PlaceholderAssistantMessage,
  PlaceholderMessageInfo,
  StartupPreference,
  EngineRuntime,
  ModelOption,
  ModelRef,
  OnboardingStep,
  ReloadReason,
  ReloadTrigger,
  SettingsTab,
  View,
  WorkspaceSessionGroup,
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  ProviderListItem,
  SessionErrorTurn,
  OpencodeConnectStatus,
} from "./types";
import {
  clearStartupPreference,
  deriveArtifacts,
  deriveWorkingFiles,
  formatModelLabel,
  formatModelRef,
  isVisibleTextPart,
  isTauriRuntime,
  modelEquals,
  normalizeDirectoryPath,
} from "./utils";
import { currentLocale, setLocale, t } from "../i18n";
import {
  isWindowsPlatform,
  lastUserModelFromMessages,
  // normalizeDirectoryPath,
  parseModelRef,
  readStartupPreference,
  safeStringify,
  addOpencodeCacheHint,
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
  parseSessionChoiceOverrides,
  parseWorkspaceModelVariants,
  serializeSessionChoiceOverrides,
  sessionModelOverridesKey,
  workspaceModelVariantsKey,
} from "./context/model-config";
import { createProvidersStore } from "./context/providers";
import { useSessionDisplayPreferences } from "./app-settings/session-display-preferences";
import {
  formatGenericBehaviorLabel,
  getModelBehaviorSummary,
  normalizeModelBehaviorValue,
  sanitizeModelBehaviorValue,
} from "./lib/model-behavior";
import {
  describeDirectoryScope,
  shouldRedirectMissingSessionAfterScopedLoad,
  toSessionTransportDirectory,
} from "./lib/session-scope";

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read attachment: ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
import { createExtensionsStore } from "./context/extensions";
import { createConnectionsStore } from "./connections/store";
import { createAutomationsStore } from "./context/automations";
import { createSidebarSessionsStore } from "./context/sidebar-sessions";
import { useGlobalSync } from "./context/global-sync";
import { createWorkspaceStore } from "./context/workspace";
import {
  updaterEnvironment,
  readOpencodeConfig,
  writeOpencodeConfig,
  openworkServerRestart,
  openworkServerInfo,
  orchestratorStatus,
  opencodeRouterInfo,
  setWindowDecorations,
  type OrchestratorStatus,
  type OpenworkServerInfo,
  type OpenCodeRouterInfo,
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
  readOpenworkConnectInviteFromSearch,
  stripOpenworkConnectInviteFromUrl,
  createOpenworkServerClient,
  hydrateOpenworkServerSettingsFromEnv,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
  clearOpenworkServerSettings,
  type OpenworkAuditEntry,
  type OpenworkServerCapabilities,
  type OpenworkServerDiagnostics,
  type OpenworkServerStatus,
  type OpenworkServerSettings,
  type OpenworkServerClient,
  OpenworkServerError,
} from "./lib/openwork-server";
import {
  parseBundleDeepLink,
  stripBundleQuery,
} from "./bundles";
import { createBundlesStore } from "./bundles/store";
import {
  parseDebugDeepLinkInput,
  parseDenAuthDeepLink,
  parseRemoteConnectDeepLink,
  stripRemoteConnectQuery,
  type DenAuthDeepLink,
  type RemoteWorkspaceDefaults,
 } from "./lib/openwork-links";

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

export default function App() {
  const { resetSessionDisplayPreferences } = useSessionDisplayPreferences();
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
  const [sessionViewLockUntil] = createSignal(0);
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
    if (next === "settings" && Date.now() < sessionViewLockUntil()) {
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

  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:4096");
  const [clientDirectory, setClientDirectory] = createSignal("");

  const [openworkServerSettings, setOpenworkServerSettings] = createSignal<OpenworkServerSettings>({});
  const [shareRemoteAccessBusy, setShareRemoteAccessBusy] = createSignal(false);
  const [shareRemoteAccessError, setShareRemoteAccessError] = createSignal<string | null>(null);
  const [openworkServerUrl, setOpenworkServerUrl] = createSignal("");
  const [openworkServerStatus, setOpenworkServerStatus] = createSignal<OpenworkServerStatus>("disconnected");
  const [openworkServerCapabilities, setOpenworkServerCapabilities] = createSignal<OpenworkServerCapabilities | null>(null);
  const [, setOpenworkServerCheckedAt] = createSignal<number | null>(null);
  const [openworkServerHostInfo, setOpenworkServerHostInfo] = createSignal<OpenworkServerInfo | null>(null);
  const [openworkServerDiagnostics, setOpenworkServerDiagnostics] = createSignal<OpenworkServerDiagnostics | null>(null);
  const [openworkReconnectBusy, setOpenworkReconnectBusy] = createSignal(false);
  const [opencodeRouterInfoState, setOpenCodeRouterInfoState] = createSignal<OpenCodeRouterInfo | null>(null);
  const [orchestratorStatusState, setOrchestratorStatusState] = createSignal<OrchestratorStatus | null>(null);
  const [openworkAuditEntries, setOpenworkAuditEntries] = createSignal<OpenworkAuditEntry[]>([]);
  const [openworkAuditStatus, setOpenworkAuditStatus] = createSignal<"idle" | "loading" | "error">("idle");
  const [openworkAuditError, setOpenworkAuditError] = createSignal<string | null>(null);
  const [devtoolsWorkspaceId, setDevtoolsWorkspaceId] = createSignal<string | null>(null);

  const openworkServerBaseUrl = createMemo(() => {
    const pref = startupPreference();
    const hostInfo = openworkServerHostInfo();
    const settingsUrl = normalizeOpenworkServerUrl(openworkServerSettings().urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  });

  const openworkServerAuth = createMemo(
    () => {
      const pref = startupPreference();
      const hostInfo = openworkServerHostInfo();
      const settingsToken = openworkServerSettings().token?.trim() ?? "";
      const clientToken = hostInfo?.clientToken?.trim() ?? "";
      const hostToken = hostInfo?.hostToken?.trim() ?? "";

      if (pref === "local") {
        return { token: clientToken || undefined, hostToken: hostToken || undefined };
      }
      if (pref === "server") {
        return { token: settingsToken || undefined, hostToken: undefined };
      }
      if (hostInfo?.baseUrl) {
        return { token: clientToken || undefined, hostToken: hostToken || undefined };
      }
      return { token: settingsToken || undefined, hostToken: undefined };
    },
    undefined,
    {
      equals: (prev, next) => prev?.token === next.token && prev?.hostToken === next.hostToken,
    },
  );

  const openworkServerClient = createMemo(() => {
    const baseUrl = openworkServerBaseUrl().trim();
    if (!baseUrl) return null;
    const auth = openworkServerAuth();
    return createOpenworkServerClient({ baseUrl, token: auth.token, hostToken: auth.hostToken });
  });

  const devtoolsOpenworkClient = createMemo(() => openworkServerClient());

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
      setPendingRemoteConnectDeepLink({
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
    const pref = startupPreference();
    const info = openworkServerHostInfo();
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeOpenworkServerUrl(openworkServerSettings().urlOverride ?? "") ?? "";

    if (pref === "local") {
      setOpenworkServerUrl(hostUrl);
      return;
    }
    if (pref === "server") {
      setOpenworkServerUrl(settingsUrl);
      return;
    }
    setOpenworkServerUrl(hostUrl || settingsUrl);
  });

  const checkOpenworkServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createOpenworkServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      if (error instanceof OpenworkServerError && (error.status === 401 || error.status === 403)) {
        return { status: "limited" as OpenworkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenworkServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as OpenworkServerStatus, capabilities: null };
    }

    try {
      const caps = await client.capabilities();
      return { status: "connected" as OpenworkServerStatus, capabilities: caps };
    } catch (error) {
      if (error instanceof OpenworkServerError && (error.status === 401 || error.status === 403)) {
        return { status: "limited" as OpenworkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenworkServerStatus, capabilities: null };
    }
  };

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!documentVisible()) return;
    const url = openworkServerBaseUrl().trim();
    const auth = openworkServerAuth();
    const token = auth.token;
    const hostToken = auth.hostToken;

    if (!url) {
      setOpenworkServerStatus("disconnected");
      setOpenworkServerCapabilities(null);
      setOpenworkServerCheckedAt(Date.now());
      return;
    }

    let active = true;
    let busy = false;
    let timeoutId: number | undefined;
    let delayMs = 10_000;

    const scheduleNext = () => {
      if (!active) return;
      timeoutId = window.setTimeout(run, delayMs);
    };

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await checkOpenworkServer(url, token, hostToken);
        if (!active) return;
        setOpenworkServerStatus(result.status);
        setOpenworkServerCapabilities(result.capabilities);
        delayMs =
          result.status === "connected" || result.status === "limited"
            ? 10_000
            : Math.min(delayMs * 2, 60_000);
      } catch {
        delayMs = Math.min(delayMs * 2, 60_000);
      } finally {
        if (!active) return;
        setOpenworkServerCheckedAt(Date.now());
        busy = false;
        scheduleNext();
      }
    };

    run();
    onCleanup(() => {
      active = false;
      if (timeoutId) window.clearTimeout(timeoutId);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!documentVisible()) return;
    let active = true;

    const run = async () => {
      try {
        const info = await openworkServerInfo();
        if (active) setOpenworkServerHostInfo(info);
      } catch {
        if (active) setOpenworkServerHostInfo(null);
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
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

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!documentVisible()) return;
    if (!developerMode()) {
      setOpenworkServerDiagnostics(null);
      return;
    }

    const client = openworkServerClient();
    if (!client || openworkServerStatus() === "disconnected") {
      setOpenworkServerDiagnostics(null);
      return;
    }

    let active = true;
    let busy = false;

    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        const status = await client.status();
        if (active) setOpenworkServerDiagnostics(status);
      } catch {
        if (active) setOpenworkServerDiagnostics(null);
      } finally {
        busy = false;
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) return;
    if (!documentVisible()) return;

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

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) {
      setOpenCodeRouterInfoState(null);
      return;
    }
    if (!documentVisible()) return;

    let active = true;

    const run = async () => {
      try {
        const info = await opencodeRouterInfo();
        if (active) setOpenCodeRouterInfoState(info);
      } catch {
        if (active) setOpenCodeRouterInfoState(null);
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
      window.clearInterval(interval);
    });
  });

  createEffect(() => {
    if (!isTauriRuntime()) return;
    if (!developerMode()) {
      setOrchestratorStatusState(null);
      return;
    }
    if (!documentVisible()) return;

    let active = true;

    const run = async () => {
      try {
        const status = await orchestratorStatus();
        if (active) setOrchestratorStatusState(status);
      } catch {
        if (active) setOrchestratorStatusState(null);
      }
    };

    run();
    const interval = window.setInterval(run, 10_000);
    onCleanup(() => {
      active = false;
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
  const [, setLastKnownConfigSnapshot] = createSignal("");
  const [developerMode, setDeveloperMode] = createSignal(false);
  const [documentVisible, setDocumentVisible] = createSignal(true);

  createEffect(() => {
    if (developerMode()) return;
    clearPerfLogs();
  });

  const [selectedSessionId, setSelectedSessionId] = createSignal<string | null>(
    null
  );
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
  const [workspaceDefaultModelReady, setWorkspaceDefaultModelReady] = createSignal(false);
  const [legacyDefaultModel, setLegacyDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const [defaultModelExplicit, setDefaultModelExplicit] = createSignal(false);
  const [pendingDefaultModelByWorkspace, setPendingDefaultModelByWorkspace] = createSignal<
    Record<string, string>
  >({});
  const [autoCompactContextReady, setAutoCompactContextReady] = createSignal(false);
  const [autoCompactContextDirty, setAutoCompactContextDirty] = createSignal(false);
  const [autoCompactContextApplied, setAutoCompactContextApplied] = createSignal(true);
  const [autoCompactContextSaving, setAutoCompactContextSaving] = createSignal(false);
  type PromptFocusReturnTarget = "none" | "composer";

  const [sessionAgentById, setSessionAgentById] = createSignal<Record<string, string>>({});
  const modelConfig = createModelConfigStore();

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

  const mapLegacySurfaceToSettingsTab = (surface: string): SettingsTab => {
    switch (surface) {
      case "scheduled":
        return "automations";
      case "skills":
        return "skills";
      case "plugins":
      case "mcp":
        return "extensions";
      case "identities":
        return "messaging";
      case "config":
        return "advanced";
      case "settings":
      default:
        return "general";
    }
  };

  let markReloadRequiredHandler: ((reason: ReloadReason, trigger?: ReloadTrigger) => void) | undefined;
  const markReloadRequired = (reason: ReloadReason, trigger?: ReloadTrigger) => {
    markReloadRequiredHandler?.(reason, trigger);
  };

  const sessionStore = createSessionStore({
    client,
    selectedWorkspaceRoot: () => workspaceStore.selectedWorkspaceRoot().trim(),
    selectedSessionId,
    setSelectedSessionId,
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
    selectedSession,
    selectedSessionStatus,
    selectedSessionCompactionState,
    messages,
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

  const [prompt, setPrompt] = createSignal("");
  const [lastPromptSent, setLastPromptSent] = createSignal("");

  type PartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

  const attachmentToFilePart = async (attachment: ComposerAttachment): Promise<FilePartInput> => ({
    type: "file",
    url: await fileToDataUrl(attachment.file),
    filename: attachment.name,
    mime: attachment.mimeType,
  });

  const buildPromptParts = async (draft: ComposerDraft): Promise<PartInput[]> => {
    const parts: PartInput[] = [];
    const text = draft.resolvedText ?? draft.text;
    parts.push({ type: "text", text } as TextPartInput);

    const root = workspaceProjectDir().trim();
    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      // Windows absolute path, e.g. C:\foo\bar
      if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
      // Without a workspace root, we cannot safely resolve relative paths.
      // Returning "" avoids emitting invalid file:// URLs.
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };
    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name } as AgentPartInput);
        continue;
      }
      if (part.type === "file") {
        const absolute = toAbsolutePath(part.path);
        if (!absolute) continue;
        parts.push({
          type: "file",
          mime: "text/plain",
          url: `file://${absolute}`,
          filename: filenameFromPath(part.path),
        } as FilePartInput);
      }
    }

    parts.push(...(await Promise.all(draft.attachments.map(attachmentToFilePart))));

    return parts;
  };

  const buildCommandFileParts = async (draft: ComposerDraft): Promise<FilePartInput[]> => {
    const parts: FilePartInput[] = [];
    const root = workspaceProjectDir().trim();

    const toAbsolutePath = (path: string) => {
      const trimmed = path.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("/")) return trimmed;
      if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
      if (!root) return "";
      return (root + "/" + trimmed).replace("//", "/");
    };

    const filenameFromPath = (path: string) => {
      const normalized = path.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? "file";
    };

    for (const part of draft.parts) {
      if (part.type !== "file") continue;
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${absolute}`,
        filename: filenameFromPath(part.path),
      } as FilePartInput);
    }

    parts.push(...(await Promise.all(draft.attachments.map(attachmentToFilePart))));

    return parts;
  };

  const assertNoClientError = (result: unknown) => {
    const maybe = result as { error?: unknown } | null | undefined;
    if (!maybe || maybe.error === undefined) return;
    throw new Error(describeProviderError(maybe.error, "Request failed"));
  };

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

  async function sendPrompt(draft?: ComposerDraft) {
    const hasExplicitDraft = Boolean(draft);
    const fallbackText = prompt().trim();
    const resolvedDraft: ComposerDraft = draft ?? {
      mode: "prompt",
      parts: fallbackText ? [{ type: "text", text: fallbackText } as ComposerPart] : [],
      attachments: [] as ComposerAttachment[],
      text: fallbackText,
    };
    const content = (resolvedDraft.resolvedText ?? resolvedDraft.text).trim();
    if (!content && !resolvedDraft.attachments.length) return;

    const ready = await ensureSelectedWorkspaceRuntime();
    if (!ready) return;

    const c = client();
    if (!c) return;

    const compactShortcut = /^\/compact(?:\s+.*)?$/i.test(content);
    const compactCommand = resolvedDraft.command?.name === "compact" || compactShortcut;
    const commandName = compactCommand ? "compact" : (resolvedDraft.command?.name ?? null);
    if (compactCommand && !selectedSessionId()) {
      setError("Select a session with messages before running /compact.");
      return;
    }

    let sessionID = selectedSessionId();
    if (!sessionID) {
      await createSessionAndOpen();
      sessionID = selectedSessionId();
    }
    if (!sessionID) return;

    setBusy(true);
    setBusyLabel("status.running");
    setBusyStartedAt(Date.now());
    setError(null);

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const visible = messages();
    const visibleParts = visible.reduce((total, message) => total + message.parts.length, 0);
    recordPerfLog(perfEnabled, "session.prompt", "start", {
      sessionID,
      mode: resolvedDraft.mode,
      command: commandName,
      charCount: content.length,
      attachmentCount: resolvedDraft.attachments.length,
      messageCount: visible.length,
      partCount: visibleParts,
    });

    try {
      if (!compactCommand) {
        setLastPromptSent(content);
      }
      if (!hasExplicitDraft) {
        setPrompt("");
      }

      const model = selectedSessionModel();
      const agent = selectedSessionAgent();
      const parts = await buildPromptParts(resolvedDraft);
      const selectedVariant = sanitizeModelVariantForRef(model, modelVariant()) ?? undefined;
      const reasoningEffort = resolveCodexReasoningEffort(model.modelID, selectedVariant ?? null);
      const requestVariant = reasoningEffort ? undefined : selectedVariant;
      const promptOverrides = reasoningEffort
        ? ({ reasoning_effort: reasoningEffort } as const)
        : undefined;

      if (resolvedDraft.mode === "shell") {
        await shellInSession(c, sessionID, content);
      } else if (resolvedDraft.command || compactCommand) {
        if (compactCommand) {
          await compactCurrentSession(sessionID);
          finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
            sessionID,
            mode: resolvedDraft.mode,
            command: commandName,
          });
          return;
        }

        const command = resolvedDraft.command;
        if (!command) {
          throw new Error("Command was not resolved.");
        }

        // Slash command: route through session.command() API
        const modelString = `${model.providerID}/${model.modelID}`;
        const files = await buildCommandFileParts(resolvedDraft);

        // session.command() expects `model` as a provider/model string and only supports file parts.
        unwrap(
          await c.session.command({
            sessionID,
            command: command.name,
            arguments: command.arguments,
            agent: agent ?? undefined,
            model: modelString,
            variant: requestVariant,
            ...(promptOverrides ?? {}),
            parts: files.length ? files : undefined,
          }),
        );

      } else {
        const result = await c.session.promptAsync({
          sessionID,
          model,
          agent: agent ?? undefined,
          variant: requestVariant,
          ...(promptOverrides ?? {}),
          parts,
        });
        assertNoClientError(result);

        modelConfig.setSessionModelById((current) => ({
          ...current,
          [sessionID]: model,
        }));

        modelConfig.clearSessionModelOverride(sessionID);
      }

      finishPerf(perfEnabled, "session.prompt", "done", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
      });
    } catch (e) {
      finishPerf(perfEnabled, "session.prompt", "error", startedAt, {
        sessionID,
        mode: resolvedDraft.mode,
        command: commandName,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message = e instanceof Error ? e.message : safeStringify(e);
      sessionStore.appendSessionErrorTurn(sessionID, addOpencodeCacheHint(message));
    } finally {
      setBusy(false);
      setBusyLabel(null);
      setBusyStartedAt(null);
    }
  }

  async function abortSession(sessionID?: string) {
    const c = client();
    if (!c) return;
    const id = (sessionID ?? selectedSessionId() ?? "").trim();
    if (!id) return;
    // OpenCode exposes session.abort which interrupts the active prompt/run.
    // We intentionally don't mutate global busy state here; the SessionView
    // provides local UX (button disabled + toast) for cancellation.
    await abortSessionTyped(c, id);
  }

  function retryLastPrompt() {
    const text = lastPromptSent().trim();
    if (!text) return;
    void sendPrompt({
      mode: "prompt",
      text,
      parts: [{ type: "text", text }],
      attachments: [],
    });
  }

  async function compactCurrentSession(sessionIdOverride?: string) {
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const sessionID = (sessionIdOverride ?? selectedSessionId() ?? "").trim();
    if (!sessionID) {
      throw new Error("Select a session before compacting.");
    }

    const visible = messages();
    if (!visible.length) {
      throw new Error("Nothing to compact yet.");
    }

    const model = selectedSessionModel();
    const startedAt = perfNow();
    const modelLabel = `${model.providerID}/${model.modelID}`;
    recordPerfLog(developerMode(), "session.compact", "start", {
      sessionID,
      messageCount: visible.length,
      model: modelLabel,
      variant: sanitizeModelVariantForRef(model, modelVariant()) ?? null,
    });

    try {
      await compactSessionTyped(c, sessionID, model, {
        directory: workspaceProjectDir().trim() || undefined,
      });
      finishPerf(developerMode(), "session.compact", "done", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
      });
    } catch (error) {
      finishPerf(developerMode(), "session.compact", "error", startedAt, {
        sessionID,
        messageCount: visible.length,
        model: modelLabel,
        error: error instanceof Error ? error.message : safeStringify(error),
      });
      throw error;
    }
  }

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

  const upsertLocalSession = (next: Session | null | undefined) => {
    const id = (next as { id?: string } | null)?.id ?? "";
    if (!id) return;

    const current = sessions();
    const index = current.findIndex((session) => session.id === id);
    if (index === -1) {
      setSessions([...current, next as Session]);
      return;
    }
    const copy = current.slice();
    copy[index] = next as Session;
    setSessions(copy);
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

  const restorePromptFromUserMessage = (message: MessageWithParts) => {
    const text = message.parts
      .filter(isVisibleTextPart)
      .map((part) => String((part as { text?: string }).text ?? ""))
      .join("");
    setPrompt(text);
  };

  async function undoLastUserMessage() {
    const c = client();
    const sessionID = (selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    // Revert is rejected while the session is busy. We *usually* have an accurate
    // session status via SSE, but to be resilient to transient desync we attempt
    // an abort even when we think we're idle.
    await abortSessionSafe(c, sessionID);

    const revertMessageID = selectedSession()?.revert?.messageID ?? null;
    const users = messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    let target: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (!id) continue;
      if (!revertMessageID || id < revertMessageID) {
        target = candidate;
        break;
      }
    }

    if (!target) return;
    const messageID = messageIdFromInfo(target);
    if (!messageID) return;

    const next = await revertSession(c, sessionID, messageID);
    upsertLocalSession(next);
    restorePromptFromUserMessage(target);
  }

  async function redoLastUserMessage() {
    const c = client();
    const sessionID = (selectedSessionId() ?? "").trim();
    if (!c || !sessionID) return;

    await abortSessionSafe(c, sessionID);

    const revertMessageID = selectedSession()?.revert?.messageID ?? null;
    if (!revertMessageID) return;

    const users = messages().filter((message) => {
      const role = (message.info as { role?: string }).role;
      return role === "user";
    });

    const next = users.find((message) => {
      const id = messageIdFromInfo(message);
      return Boolean(id) && id > revertMessageID;
    });

    if (!next) {
      const session = await unrevertSession(c, sessionID);
      upsertLocalSession(session);
      setPrompt("");
      return;
    }

    const messageID = messageIdFromInfo(next);
    if (!messageID) return;

    const nextSession = await revertSession(c, sessionID, messageID);
    upsertLocalSession(nextSession);

    let prior: MessageWithParts | null = null;
    for (let idx = users.length - 1; idx >= 0; idx -= 1) {
      const candidate = users[idx];
      const id = messageIdFromInfo(candidate);
      if (id && id < messageID) {
        prior = candidate;
        break;
      }
    }

    if (prior) {
      restorePromptFromUserMessage(prior);
      return;
    }

    setPrompt("");
  }

  async function renameSessionTitle(sessionID: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session name is required");
    }
    
    await renameSession(sessionID, trimmed);
    await refreshSidebarWorkspaceSessions(workspaceStore.selectedWorkspaceId()).catch(() => undefined);
  }

  async function deleteSessionById(sessionID: string) {
    const trimmed = sessionID.trim();
    if (!trimmed) return;
    const c = client();
    if (!c) {
      throw new Error("Not connected to a server");
    }

    const root = workspaceStore.selectedWorkspaceRoot().trim();
    const directory = toSessionTransportDirectory(root);
    const params = directory ? { sessionID: trimmed, directory } : { sessionID: trimmed };
    unwrap(await c.session.delete(params));

    // Remove the deleted session from the store locally, then refetch the
    // workspace-scoped sidebar session list from the server source of truth.
    setSessions(sessions().filter((s) => s.id !== trimmed));
    const activeWsId = workspaceStore.selectedWorkspaceId();
    await refreshSidebarWorkspaceSessions(activeWsId).catch(() => undefined);

    // If we're currently routed to the deleted session, navigate away immediately.
    // (Otherwise the route effect can try to re-select a session that no longer exists.)
    try {
      const path = location.pathname.toLowerCase();
      if (path === `/session/${trimmed.toLowerCase()}`) {
        navigate("/session", { replace: true });
      }
    } catch {
      // ignore
    }

    // If the deleted session was selected, clear selection so routing can fall back cleanly.
    if (selectedSessionId() === trimmed) {
      setSelectedSessionId(null);
      const activeWorkspace = workspaceStore.selectedWorkspaceId().trim();
      if (activeWorkspace) {
        const map = readSessionByWorkspace();
        if (map[activeWorkspace] === trimmed) {
          const next = { ...map };
          delete next[activeWorkspace];
          writeSessionByWorkspace(next);
        }
      }
    }

    const nextStatus = { ...sessionStatusById() };
    if (nextStatus[trimmed]) {
      delete nextStatus[trimmed];
      setSessionStatusById(nextStatus);
    }
  }


  async function listAgents(): Promise<Agent[]> {
    const c = client();
    if (!c) return [];
    const list = unwrap(await c.app.agents());
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }

  const BUILTIN_COMPACT_COMMAND = {
    id: "builtin:compact",
    name: "compact",
    description: "Summarize this session to reduce context size.",
    source: "command" as const,
  };

  async function listCommands(): Promise<{ id: string; name: string; description?: string; source?: "command" | "mcp" | "skill" }[]> {
    const c = client();
    if (!c) return [];
    const list = await listCommandsTyped(c, workspaceStore.selectedWorkspaceRoot().trim() || undefined);
    if (list.some((entry) => entry.name === "compact")) {
      return list;
    }
    return [BUILTIN_COMPACT_COMMAND, ...list];
  }

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
    openworkServerClient,
    openworkServerStatus,
    openworkServerCapabilities,
    openworkServerBaseUrl,
    openworkServerAuthToken: () => openworkServerAuth().token,
    runtimeWorkspaceId: () => workspaceStore?.runtimeWorkspaceId?.() ?? null,
    ensureRuntimeWorkspaceId: () => workspaceStore?.ensureRuntimeWorkspaceId?.(),
    setProjectDir: (value: string) => workspaceStore?.setProjectDir?.(value),
    developerMode,
    markReloadRequired,
  });

  const { refreshMcpServers } = connectionsStore;

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

  const [defaultModel, setDefaultModel] = createSignal<ModelRef>(DEFAULT_MODEL);
  const parseDefaultModelFromConfig = (content: string | null) => {
    if (!content) return null;
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      const rawModel = typeof parsed?.model === "string" ? parsed.model : null;
      return parseModelRef(rawModel);
    } catch {
      return null;
    }
  };

  const formatConfigWithDefaultModel = (content: string | null, model: ModelRef) => {
    let config: Record<string, unknown> = {};
    if (content?.trim()) {
      try {
        const parsed = parse(content) as Record<string, unknown> | undefined;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = { ...parsed };
        }
      } catch {
        config = {};
      }
    }

    if (!config["$schema"]) {
      config["$schema"] = "https://opencode.ai/config.json";
    }

    config.model = formatModelRef(model);
    return `${JSON.stringify(config, null, 2)}\n`;
  };

  const parseAutoCompactContextFromConfig = (content: string | null) => {
    if (!content) return null;
    try {
      const parsed = parse(content) as Record<string, unknown> | undefined;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const compaction = parsed.compaction;
      if (!compaction || typeof compaction !== "object" || Array.isArray(compaction)) {
        return null;
      }
      return typeof (compaction as Record<string, unknown>).auto === "boolean"
        ? ((compaction as Record<string, unknown>).auto as boolean)
        : null;
    } catch {
      return null;
    }
  };

  const formatConfigWithAutoCompactContext = (content: string | null, enabled: boolean) => {
    let config: Record<string, unknown> = {};
    if (content?.trim()) {
      try {
        const parsed = parse(content) as Record<string, unknown> | undefined;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = { ...parsed };
        }
      } catch {
        config = {};
      }
    }

    if (!config["$schema"]) {
      config["$schema"] = "https://opencode.ai/config.json";
    }

    const compaction =
      typeof config.compaction === "object" && config.compaction && !Array.isArray(config.compaction)
        ? { ...(config.compaction as Record<string, unknown>) }
        : {};

    compaction.auto = enabled;
    config.compaction = compaction;
    return `${JSON.stringify(config, null, 2)}\n`;
  };

  const getConfigSnapshot = (content: string | null) => {
    if (!content?.trim()) return "";
    try {
      const parsed = parse(content) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const copy = { ...parsed };
        delete copy.model;
        return JSON.stringify(copy);
      }
      return content;
    } catch {
      return content;
    }
  };

  const ensureRecord = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  };

  const readAutoCompactContextFromRecord = (value: unknown) => {
    const compaction = ensureRecord(ensureRecord(value).compaction);
    return typeof compaction.auto === "boolean" ? compaction.auto : null;
  };

  const [modelPickerOpen, setModelPickerOpen] = createSignal(false);
  const [modelPickerTarget, setModelPickerTarget] = createSignal<
    "session" | "default"
  >("session");
  const [modelPickerQuery, setModelPickerQuery] = createSignal("");
  const [modelPickerReturnFocusTarget, setModelPickerReturnFocusTarget] =
    createSignal<PromptFocusReturnTarget>("none");

  const [autoCompactContext, setAutoCompactContext] = createSignal(true);
  const [hideTitlebar, setHideTitlebar] = createSignal(false);
  const modelVariant = () => modelConfig.getVariantFor(selectedSessionModel(), selectedSessionId());
  const toggleAutoCompactContext = () => {
    if (autoCompactContextSaving()) return;
    setAutoCompactContext((value) => !value);
    setAutoCompactContextDirty(true);
  };
  const resolveCodexReasoningEffort = (modelID: string, variant: string | null) => {
    if (!modelID.trim().toLowerCase().includes("codex")) return undefined;
    const normalized = normalizeModelBehaviorValue(variant);
    if (!normalized || normalized === "none") return undefined;
    if (normalized === "minimal") return "low";
    if (normalized === "xhigh" || normalized === "max") return "high";
    if (!["low", "medium", "high"].includes(normalized)) return undefined;
    return normalized;
  };

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
    setSettingsTab,
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

  const {
    providerAuthModalOpen,
    providerAuthBusy,
    providerAuthError,
    providerAuthMethods,
    providerAuthPreferredProviderId,
    providerAuthWorkerType,
    startProviderAuth,
    refreshProviders,
    completeProviderAuthOAuth,
    submitProviderApiKey,
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
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setDisabledProviders: (value) => globalSync.set("config", "disabled_providers", value),
    markOpencodeConfigReloadRequired: () => markOpencodeConfigReloadRequired(),
    focusPromptSoon: focusSessionPromptSoon,
  });

  const runtimeWorkspaceId = createMemo(() => workspaceStore.runtimeWorkspaceId());
  const activeWorkspaceServerConfig = createMemo(() => workspaceStore.runtimeWorkspaceConfig());
  const bundlesStore = createBundlesStore({
    booting,
    startupPreference,
    openworkServerClient,
    openworkServerStatus,
    openworkServerHostInfo,
    openworkServerSettings,
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
  });

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
  const resolvedOpenworkCapabilities = createMemo(() => openworkServerCapabilities());
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
  const [, setAutoConnectRemoteWorkspaceOverlayOpen] = createSignal(false);
  const [pendingDenAuthDeepLink, setPendingDenAuthDeepLink] = createSignal<DenAuthDeepLink | null>(null);
  const [processingDenAuthDeepLink, setProcessingDenAuthDeepLink] = createSignal(false);
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
    const bundleStripped = stripBundleQuery(remoteStripped) ?? remoteStripped;
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
      const matchedBundle = !matchedDen && !matchedRemote && bundlesStore.queueBundleLink(url);
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
    setView("settings");
    if (parsed.kind === "bundle") {
      return bundlesStore.openDebugBundleRequest(parsed.link);
    }
    if (parsed.kind === "auth") {
      setPendingDenAuthDeepLink(parsed.link);
      return { ok: true, message: "Queued the Cloud auth deep link for OpenWork." };
    }

    setPendingRemoteConnectDeepLink(parsed.kind === "remote" ? parsed.link : null);
    setSettingsTab("automations");
    return { ok: true, message: "Queued remote worker link. OpenWork should move into the connect flow." };
  };

  createEffect(() => {
    const pending = pendingDenAuthDeepLink();
    if (!pending || booting() || processingDenAuthDeepLink()) {
      return;
    }

    setProcessingDenAuthDeepLink(true);
    setPendingDenAuthDeepLink(null);
    setView("settings");
    setSettingsTab("den");
    goToSettings("den");

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
      setView("settings");
      setSettingsTab("automations");
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
    setSettingsTab("advanced");
    setView("settings");
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
      if (typeof window !== "undefined") {
        try {
          const sessionOverridePrefix = `${SESSION_MODEL_PREF_KEY}.`;
          const workspaceVariantPrefix = `${VARIANT_PREF_KEY}.`;
          const keysToRemove: string[] = [];
          for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (!key) continue;
            if (key.startsWith(sessionOverridePrefix) || key.startsWith(workspaceVariantPrefix) || key === VARIANT_PREF_KEY) {
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
      resetSessionDisplayPreferences();
      setHideTitlebar(false);
      setAutoCompactContext(false);
      modelConfig.clearPendingSessionChoice();
      modelConfig.setSessionChoiceOverrideById({});
      modelConfig.setWorkspaceVariantMap({});
      setUpdateAutoCheck(true);
      setUpdateAutoDownload(false);
      setUpdateStatus({ state: "idle", lastCheckedAt: null });
      setDeveloperMode(false);

      clearStartupPreference();
      setStartupPreference(null);
      setRememberStartupChoice(false);

      clearOpenworkServerSettings();
      setOpenworkServerSettings(readOpenworkServerSettings());

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
    await reloadWorkspaceEngineAndResume();
  };

  onMount(() => {
    // OpenCode hot reload drives freshness now; OpenWork no longer listens for
    // legacy reload-required events.
  });

  const {
    projectDir: workspaceProjectDir,
    stopHost,
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

  const activeAuthorizedDirs = createMemo(() => workspaceStore.authorizedDirs());
  const selectedWorkspaceDisplay = createMemo(() => workspaceStore.selectedWorkspaceDisplay());
  const resolvedActiveWorkspaceConfig = createMemo(
    () => activeWorkspaceServerConfig() ?? workspaceStore.workspaceConfig(),
  );
  const refreshActiveWorkspaceServerConfig = workspaceStore.refreshRuntimeWorkspaceConfig;
  const activePermissionMemo = createMemo(() => activePermission());

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

  const selectedSessionModel = createMemo<ModelRef>(() => {
    const id = selectedSessionId();
    const pendingChoice = modelConfig.pendingSessionChoice();
    if (!id) return pendingChoice?.model ?? defaultModel();

    const override = modelConfig.sessionChoiceOverrideById()[id]?.model;
    if (override) return override;

    const known = modelConfig.sessionModelById()[id];
    if (known) return known;

    const fromMessages = lastUserModelFromMessages(messages());
    if (fromMessages) return fromMessages;

    return defaultModel();
  });

  const selectedSessionAgent = createMemo(() => {
    const id = selectedSessionId();
    if (!id) return null;
    return sessionAgentById()[id] ?? null;
  });

  const selectedSessionModelLabel = createMemo(() =>
    formatModelLabel(selectedSessionModel(), providers())
  );

  const findProviderModel = (ref: ModelRef) => {
    const provider = providers().find((entry) => entry.id === ref.providerID);
    return provider?.models?.[ref.modelID] ?? null;
  };

  const sanitizeModelVariantForRef = (ref: ModelRef, value: string | null) => {
    const modelInfo = findProviderModel(ref);
    if (!modelInfo) return normalizeModelBehaviorValue(value);
    return sanitizeModelBehaviorValue(ref.providerID, modelInfo, value);
  };

  const getModelBehaviorCopy = (ref: ModelRef, value: string | null) => {
    const modelInfo = findProviderModel(ref);
    if (!modelInfo) {
      return {
        title: "Model behavior",
        label: formatGenericBehaviorLabel(value),
        description: "Choose the model first to see provider-specific behavior controls.",
        options: [],
      };
    }
    return getModelBehaviorSummary(ref.providerID, modelInfo, value);
  };

  const modelPickerCurrent = createMemo(() =>
    modelPickerTarget() === "default" ? defaultModel() : selectedSessionModel()
  );

  const isHeroModel = (id: string) => {
    const check = id.toLowerCase();
    if (check.includes("gpt-5")) return true;
    return false;
  };

  const modelOptions = createMemo<ModelOption[]>(() => {
    const allProviders = providers();
    const defaults = providerDefaults();
    const currentDefault = defaultModel();

    if (!allProviders.length) {
      const behavior = getModelBehaviorCopy(DEFAULT_MODEL, modelConfig.getWorkspaceVariantFor(DEFAULT_MODEL));
      return [
        {
          providerID: DEFAULT_MODEL.providerID,
          modelID: DEFAULT_MODEL.modelID,
          title: DEFAULT_MODEL.modelID,
          description: DEFAULT_MODEL.providerID,
          footer: t("settings.model_fallback", currentLocale()),
          behaviorTitle: behavior.title,
          behaviorLabel: behavior.label,
          behaviorDescription: behavior.description,
          behaviorValue: normalizeModelBehaviorValue(modelConfig.getWorkspaceVariantFor(DEFAULT_MODEL)),
          behaviorOptions: behavior.options,
          isFree: true,
          isConnected: false,
        },
      ];
    }

    const sortedProviders = allProviders.slice().sort(compareProviders);

    const next: ModelOption[] = [];

    for (const provider of sortedProviders) {
      const defaultModelID = defaults[provider.id];
      const isConnected = providerConnectedIds().includes(provider.id);
      const models = Object.values(provider.models ?? {}).filter(
        (m) => m.status !== "deprecated"
      );

      models.sort((a, b) => {
        const aFree = a.cost?.input === 0 && a.cost?.output === 0;
        const bFree = b.cost?.input === 0 && b.cost?.output === 0;
        if (aFree !== bFree) return aFree ? -1 : 1;
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
      });

      for (const model of models) {
        const isFree = model.cost?.input === 0 && model.cost?.output === 0;
        const isDefault =
          provider.id === currentDefault.providerID && model.id === currentDefault.modelID;
        const ref = { providerID: provider.id, modelID: model.id };
        const activeVariant =
          modelPickerTarget() === "session" && modelEquals(ref, selectedSessionModel())
            ? modelVariant()
            : modelConfig.getWorkspaceVariantFor(ref);
        const behavior = getModelBehaviorSummary(provider.id, model, activeVariant);
        const behaviorValue = sanitizeModelBehaviorValue(provider.id, model, activeVariant);
        const footerBits: string[] = [];
        if (defaultModelID === model.id || isDefault) {
          footerBits.push(t("settings.model_default", currentLocale()));
        }
        if (model.reasoning) footerBits.push(t("settings.model_reasoning", currentLocale()));

        next.push({
          providerID: provider.id,
          modelID: model.id,
          title: model.name ?? model.id,
          description: provider.name,
          footer: footerBits.length
            ? footerBits.slice(0, 2).join(" · ")
            : undefined,
          behaviorTitle: behavior.title,
          behaviorLabel: behavior.label,
          behaviorDescription: behavior.description,
          behaviorValue,
          behaviorOptions: behavior.options,
          disabled: !isConnected,
          isFree,
          isConnected,
          isRecommended: isHeroModel(model.id),
        });
      }
    }

    next.sort((a, b) => {
      if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
      if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
      const providerRankDiff =
        providerPriorityRank(a.providerID) - providerPriorityRank(b.providerID);
      if (providerRankDiff !== 0) return providerRankDiff;
      return a.title.localeCompare(b.title);
    });

    return next;
  });

  const filteredModelOptions = createMemo(() => {
    const q = modelPickerQuery().trim().toLowerCase();
    const options = modelOptions();
    if (!q) return options;

    return options.filter((opt) => {
      const haystack = [
        opt.title,
        opt.description ?? "",
        opt.footer ?? "",
        opt.behaviorTitle,
        opt.behaviorLabel,
        opt.behaviorDescription,
        `${opt.providerID}/${opt.modelID}`,
        opt.isConnected ? "connected" : "disconnected",
        opt.isFree ? "free" : "paid",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  function closeModelPicker(options?: { restorePromptFocus?: boolean }) {
    const shouldFocusPrompt =
      options?.restorePromptFocus ??
      modelPickerReturnFocusTarget() === "composer";
    setModelPickerOpen(false);
    setModelPickerReturnFocusTarget("none");
    if (shouldFocusPrompt) {
      focusSessionPromptSoon();
    }
  }

  function openSessionModelPicker(options?: {
    returnFocusTarget?: PromptFocusReturnTarget;
  }) {
    setModelPickerTarget("session");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget(options?.returnFocusTarget ?? "composer");
    setModelPickerOpen(true);
  }

  function openDefaultModelPicker() {
    setModelPickerTarget("default");
    setModelPickerQuery("");
    setModelPickerReturnFocusTarget("none");
    setModelPickerOpen(true);
  }

  function setPendingDefaultModelForWorkspace(workspaceId: string, model: ModelRef | null) {
    const id = workspaceId.trim();
    if (!id) return;
    setPendingDefaultModelByWorkspace((current) => {
      const next = { ...current };
      if (model) {
        next[id] = formatModelRef(model);
      } else {
        delete next[id];
      }
      return next;
    });
  }

  function pendingDefaultModelForWorkspace(workspaceId: string) {
    const id = workspaceId.trim();
    if (!id) return null;
    return pendingDefaultModelByWorkspace()[id] ?? null;
  }

  function applyDefaultModelChoice(next: ModelRef) {
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    if (workspaceId) {
      setPendingDefaultModelForWorkspace(workspaceId, next);
    }
    setDefaultModelExplicit(true);
    setDefaultModel(next);
    setLegacyDefaultModel(next);
  }

  function applyModelSelection(next: ModelRef) {
    const target = modelPickerTarget();
    const restorePromptFocus = target === "session";

    if (target === "default") {
      applyDefaultModelChoice(next);
      closeModelPicker({ restorePromptFocus: false });
      return;
    }

    const id = selectedSessionId();
    if (!id) {
      modelConfig.setPendingSessionModel(next);
      closeModelPicker({ restorePromptFocus });
      return;
    }

    modelConfig.setSessionModelOverride(id, next);
    closeModelPicker({ restorePromptFocus });
  }

  function openSettingsFromModelPicker() {
    setSettingsTab("general");
    setView("settings");
  }

  async function createSessionAndOpen() {
    const ready = await ensureSelectedWorkspaceRuntime();
    if (!ready) {
      return;
    }

    const c = client();
    if (!c) {
      return;
    }

    const perfEnabled = developerMode();
    const startedAt = perfNow();
    const runId = (() => {
      const key = "__openwork_create_session_run__";
      const w = window as typeof window & { [key]?: number };
      w[key] = (w[key] ?? 0) + 1;
      return w[key];
    })();

    const mark = (event: string, payload?: Record<string, unknown>) => {
      const elapsed = Math.round((perfNow() - startedAt) * 100) / 100;
      recordPerfLog(perfEnabled, "session.create", event, {
        runId,
        elapsedMs: elapsed,
        ...(payload ?? {}),
      });
    };

    mark("start", {
      baseUrl: baseUrl(),
      workspace: workspaceStore.selectedWorkspaceRoot().trim() || null,
    });

    // Abort any in-flight refresh operations to free up connection resources
    abortRefreshes();

    // Small delay to allow pending requests to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    setBusy(true);
    setBusyLabel("status.creating_task");
    setBusyStartedAt(Date.now());
    setError(null);
    setCreatingSession(true);

    const withTimeout = async <T,>(
      promise: Promise<T>,
      ms: number,
      label: string
    ) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          ms
        );
      });
      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    };

    try {
      // Quick health check to detect stale connection
      mark("health:start");
      try {
        await withTimeout(c.global.health(), 3_000, "health");
        mark("health:ok");
      } catch (healthErr) {
        mark("health:error", {
          error: healthErr instanceof Error ? healthErr.message : safeStringify(healthErr),
        });
        throw new Error(t("app.connection_lost", currentLocale()));
      }

      let rawResult: Awaited<ReturnType<typeof c.session.create>>;
      try {
        const directory = toSessionTransportDirectory(workspaceStore.selectedWorkspaceRoot().trim()) || undefined;
        logWorkspaceScopeSnapshot("session:create:scope", {
          transportDirectory: directory ?? null,
          transportScope: describeDirectoryScope(directory ?? null),
        });
        mark("session:create:start");
        rawResult = await c.session.create({
          directory,
        });
        mark("session:create:ok");
      } catch (createErr) {
        mark("session:create:error", {
          error: createErr instanceof Error ? createErr.message : safeStringify(createErr),
        });
        throw createErr;
      }

      const session = unwrap(rawResult);
      // Immediately select and show the new session before background list refresh.
      setBusyLabel("status.loading_session");
      mark("session:select:start", { sessionID: session.id });
      await selectSession(session.id);
      mark("session:select:ok", { sessionID: session.id });

      modelConfig.applyPendingSessionChoice(session.id);

      // Inject the new session into the reactive sessions() store so
      // the createEffect bridge (sessions → sidebar) will always include it,
      // even if the background loadSessionsWithReady hasn't returned yet.
      const currentStoreSessions = sessions();
      if (!currentStoreSessions.some((s) => s.id === session.id)) {
        setSessions([session, ...currentStoreSessions]);
      }

      const wsId = workspaceStore.selectedWorkspaceId().trim();
      if (wsId) {
        await refreshSidebarWorkspaceSessions(wsId).catch(() => undefined);
      }

      // setSessionViewLockUntil(Date.now() + 1200);
      goToSession(session.id);

      // The new session is already in the sessions() store (injected above).
      // Sidebar state now refreshes from the server-scoped workspace list.
      finishPerf(perfEnabled, "session.create", "done", startedAt, {
        runId,
        sessionID: session.id,
      });
      return session.id;
    } catch (e) {
      finishPerf(perfEnabled, "session.create", "error", startedAt, {
        runId,
        error: e instanceof Error ? e.message : safeStringify(e),
      });
      const message = e instanceof Error ? e.message : t("app.unknown_error", currentLocale());
      setError(addOpencodeCacheHint(message));
      return undefined;
    } finally {
      setCreatingSession(false);
      setBusy(false);
    }
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

        const storedDefaultModel = window.localStorage.getItem(MODEL_PREF_KEY);
        const parsedDefaultModel = parseModelRef(storedDefaultModel);
        if (parsedDefaultModel) {
          setDefaultModel(parsedDefaultModel);
          setLegacyDefaultModel(parsedDefaultModel);
        } else {
          setDefaultModel(DEFAULT_MODEL);
          setLegacyDefaultModel(DEFAULT_MODEL);
          try {
            window.localStorage.setItem(
              MODEL_PREF_KEY,
              formatModelRef(DEFAULT_MODEL)
            );
          } catch {
            // ignore
          }
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
        consumeDeepLinks(detail?.urls ?? []);
      };

      consumeDeepLinks(drainPendingDeepLinks(window));
      window.addEventListener(deepLinkBridgeEvent, handleDeepLinkEvent as EventListener);
      onCleanup(() => {
        window.removeEventListener(deepLinkBridgeEvent, handleDeepLinkEvent as EventListener);
      });
    }

    void workspaceStore.bootstrapOnboarding().finally(() => setBooting(false));
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.selectedWorkspaceId();
    if (!workspaceId) return;

    modelConfig.setSessionModelOverridesReady(false);
    const raw = window.localStorage.getItem(sessionModelOverridesKey(workspaceId));
    modelConfig.setSessionChoiceOverrideById(parseSessionChoiceOverrides(raw));
    modelConfig.setSessionModelOverridesReady(true);
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!modelConfig.sessionModelOverridesReady()) return;
    const workspaceId = workspaceStore.selectedWorkspaceId();
    if (!workspaceId) return;

    const payload = serializeSessionChoiceOverrides(modelConfig.sessionChoiceOverrideById());
    try {
      if (payload) {
        window.localStorage.setItem(sessionModelOverridesKey(workspaceId), payload);
      } else {
        window.localStorage.removeItem(sessionModelOverridesKey(workspaceId));
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    if (!workspaceId) {
      modelConfig.setWorkspaceVariantMap({});
      return;
    }

    const scopedRaw = window.localStorage.getItem(workspaceModelVariantsKey(workspaceId));
    const legacyRaw = scopedRaw == null ? window.localStorage.getItem(VARIANT_PREF_KEY) : null;
    modelConfig.setWorkspaceVariantMap(
      parseWorkspaceModelVariants(scopedRaw ?? legacyRaw, defaultModel()),
    );
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    if (!workspaceId) return;

    try {
      const map = modelConfig.workspaceVariantMap();
      const key = workspaceModelVariantsKey(workspaceId);
      if (Object.keys(map).length > 0) {
        window.localStorage.setItem(key, JSON.stringify(map));
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // ignore
    }
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const workspaceId = workspaceStore.selectedWorkspaceId();
    if (!workspaceId) return;

    setWorkspaceDefaultModelReady(false);
    const workspaceType = workspaceStore.selectedWorkspaceDisplay().workspaceType;
    const workspaceRoot = workspaceStore.selectedWorkspacePath().trim();
    const activeClient = client();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

    let cancelled = false;

    const applyDefault = async () => {
      let configDefault: ModelRef | null = null;
      let configFileContent: string | null = null;

      if (workspaceType === "local" && workspaceRoot) {
        if (canUseOpenworkServer) {
          try {
            const config = await openworkClient.getConfig(openworkWorkspaceId);
            const model = typeof config.opencode?.model === "string" ? config.opencode.model : null;
            configDefault = parseModelRef(model);
          } catch {
            // ignore
          }
        } else if (isTauriRuntime()) {
          try {
            const configFile = await readOpencodeConfig("project", workspaceRoot);
            configFileContent = configFile.content;
            configDefault = parseDefaultModelFromConfig(configFile.content);
          } catch {
            // ignore
          }
        }
      } else if (activeClient) {
        try {
          const config = unwrap(
            await activeClient.config.get({ directory: workspaceRoot || undefined })
          );
          if (typeof config.model === "string") {
            configDefault = parseModelRef(config.model);
          }
        } catch {
          // ignore
        }
      }

      const pendingModelRef = pendingDefaultModelForWorkspace(workspaceId);
      const loadedModelRef = configDefault ? formatModelRef(configDefault) : null;

      if (pendingModelRef && pendingModelRef !== loadedModelRef) {
        if (workspaceType === "local" && workspaceRoot) {
          setLastKnownConfigSnapshot(getConfigSnapshot(configFileContent));
        }

        if (!cancelled) {
          setWorkspaceDefaultModelReady(true);
        }
        return;
      }

      if (pendingModelRef && loadedModelRef === pendingModelRef) {
        setPendingDefaultModelForWorkspace(workspaceId, null);
      }

      setDefaultModelExplicit(Boolean(configDefault));
      const nextDefault = configDefault ?? legacyDefaultModel();
      const currentDefault = untrack(defaultModel);
      if (nextDefault && !modelEquals(currentDefault, nextDefault)) {
        setDefaultModel(nextDefault);
      }
      const currentLegacyDefault = untrack(legacyDefaultModel);
      if (nextDefault && !modelEquals(currentLegacyDefault, nextDefault)) {
        setLegacyDefaultModel(nextDefault);
      }

      if (workspaceType === "local" && workspaceRoot) {
        setLastKnownConfigSnapshot(getConfigSnapshot(configFileContent));
      }

      if (!cancelled) {
        setWorkspaceDefaultModelReady(true);
      }
    };

    void applyDefault();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!workspaceDefaultModelReady()) return;
    if (!isTauriRuntime()) return;
    if (!defaultModelExplicit()) return;

    const workspace = workspaceStore.selectedWorkspaceDisplay();
    const workspaceId = workspaceStore.selectedWorkspaceId().trim();
    if (workspace.workspaceType !== "local") return;

    const root = workspaceStore.selectedWorkspacePath().trim();
    if (!root) return;
    const nextModel = defaultModel();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;
    let cancelled = false;

    const writeConfig = async () => {
      try {
        if (canUseOpenworkServer) {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          const currentModel = typeof config.opencode?.model === "string" ? parseModelRef(config.opencode.model) : null;
          if (currentModel && modelEquals(currentModel, nextModel)) {
            if (workspaceId) {
              setPendingDefaultModelForWorkspace(workspaceId, null);
            }
            return;
          }

          await openworkClient.patchConfig(openworkWorkspaceId, {
            opencode: { model: formatModelRef(nextModel) },
          });
          if (workspaceId) {
            setPendingDefaultModelForWorkspace(workspaceId, null);
          }
          markOpencodeConfigReloadRequired();
          return;
        }

        const configFile = await readOpencodeConfig("project", root);
        const existingModel = parseDefaultModelFromConfig(configFile.content);
        if (existingModel && modelEquals(existingModel, nextModel)) {
          if (workspaceId) {
            setPendingDefaultModelForWorkspace(workspaceId, null);
          }
          return;
        }

        const content = formatConfigWithDefaultModel(configFile.content, nextModel);
        const result = await writeOpencodeConfig("project", root, content);
        if (!result.ok) {
          throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
        }
        setLastKnownConfigSnapshot(getConfigSnapshot(content));
        if (workspaceId) {
          setPendingDefaultModelForWorkspace(workspaceId, null);
        }
        markOpencodeConfigReloadRequired();
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      }
    };

    void writeConfig();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    const workspaceId = workspaceStore.selectedWorkspaceId();
    if (!workspaceId) {
      setAutoCompactContext(true);
      setAutoCompactContextApplied(true);
      setAutoCompactContextDirty(false);
      setAutoCompactContextReady(false);
      setAutoCompactContextSaving(false);
      return;
    }

    const workspace = workspaceStore.selectedWorkspaceDisplay();
    const root = workspaceStore.selectedWorkspacePath().trim();
    const activeClient = client();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.read;

    let cancelled = false;
    setAutoCompactContextReady(false);
    setAutoCompactContextDirty(false);

    const loadAutoCompactContext = async () => {
      let nextValue = true;

      if (canUseOpenworkServer) {
        try {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          nextValue = readAutoCompactContextFromRecord(config.opencode) ?? true;
        } catch {
          // ignore
        }
      } else if (workspace.workspaceType === "local" && root && isTauriRuntime()) {
        try {
          const configFile = await readOpencodeConfig("project", root);
          nextValue = parseAutoCompactContextFromConfig(configFile.content) ?? true;
        } catch {
          // ignore
        }
      } else if (activeClient) {
        try {
          const config = unwrap(await activeClient.config.get({ directory: root || undefined }));
          nextValue = readAutoCompactContextFromRecord(config) ?? true;
        } catch {
          // ignore
        }
      }

      if (cancelled) return;
      setAutoCompactContext(nextValue);
      setAutoCompactContextApplied(nextValue);
      setAutoCompactContextReady(true);
    };

    void loadAutoCompactContext();

    onCleanup(() => {
      cancelled = true;
    });
  });

  createEffect(() => {
    if (!autoCompactContextReady()) return;
    if (!autoCompactContextDirty()) return;

    const nextValue = autoCompactContext();
    const appliedValue = autoCompactContextApplied();
    const workspace = workspaceStore.selectedWorkspaceDisplay();
    const root = workspaceStore.selectedWorkspacePath().trim();
    const openworkClient = openworkServerClient();
    const openworkWorkspaceId = runtimeWorkspaceId();
    const openworkCapabilities = resolvedOpenworkCapabilities();
    const canUseOpenworkServer =
      openworkServerStatus() === "connected" &&
      openworkClient &&
      openworkWorkspaceId &&
      openworkCapabilities?.config?.write;

    let cancelled = false;
    setAutoCompactContextSaving(true);

    const persistAutoCompactContext = async () => {
      try {
        if (canUseOpenworkServer) {
          const config = await openworkClient.getConfig(openworkWorkspaceId);
          const currentValue = readAutoCompactContextFromRecord(config.opencode) ?? true;
          if (currentValue !== nextValue) {
            await openworkClient.patchConfig(openworkWorkspaceId, {
              opencode: {
                compaction: {
                  auto: nextValue,
                },
              },
            });
            markOpencodeConfigReloadRequired();
          }
          if (cancelled) return;
          setAutoCompactContextApplied(nextValue);
          setAutoCompactContextDirty(false);
          return;
        }

        if (workspace.workspaceType !== "local" || !root || !isTauriRuntime()) {
          throw new Error(
            "Auto context compaction can only be changed for a local workspace or a writable OpenWork server workspace.",
          );
        }

        const configFile = await readOpencodeConfig("project", root);
        const currentValue = parseAutoCompactContextFromConfig(configFile.content) ?? true;
        if (currentValue !== nextValue) {
          const content = formatConfigWithAutoCompactContext(configFile.content, nextValue);
          const result = await writeOpencodeConfig("project", root, content);
          if (!result.ok) {
            throw new Error(result.stderr || result.stdout || "Failed to update opencode.json");
          }
          setLastKnownConfigSnapshot(getConfigSnapshot(content));
          markOpencodeConfigReloadRequired();
        }

        if (cancelled) return;
        setAutoCompactContextApplied(nextValue);
        setAutoCompactContextDirty(false);
      } catch (error) {
        if (cancelled) return;
        setAutoCompactContext(appliedValue);
        setAutoCompactContextDirty(false);
        const message = error instanceof Error ? error.message : safeStringify(error);
        setError(addOpencodeCacheHint(message));
      } finally {
        setAutoCompactContextSaving(false);
      }
    };

    void persistAutoCompactContext();

    onCleanup(() => {
      cancelled = true;
    });
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
        MODEL_PREF_KEY,
        formatModelRef(defaultModel())
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
        ? "OpenWork server unavailable. Add the server URL/token in Advanced to manage skills."
        : openworkStatus === "limited"
          ? "OpenWork server needs a host token to install/update skills. Add it in Advanced and reconnect."
          : openworkServerCanWriteSkills()
            ? null
            : "OpenWork server is read-only for skills. Add a host token in Advanced to enable installs."
      : null;
    const pluginsAccessHint = isRemoteWorkspace
      ? openworkStatus === "disconnected"
        ? "OpenWork server unavailable. Plugins are read-only."
        : openworkStatus === "limited"
          ? "OpenWork server needs a token to edit plugins."
          : openworkServerCanWritePlugins()
            ? null
            : "OpenWork server is read-only for plugins."
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
      providerAuthPreferredProviderId: providerAuthPreferredProviderId(),
      providerAuthWorkerType: providerAuthWorkerType(),
      openProviderAuthModal,
      disconnectProvider,
      closeProviderAuthModal,
      startProviderAuth,
      completeProviderAuthOAuth,
      refreshProviders,
      submitProviderApiKey,
      view: currentView(),
      setView,
      toggleSettings: () => toggleSettingsView("general"),
      startupPreference: startupPreference(),
      baseUrl: baseUrl(),
      clientConnected: Boolean(client()),
      busy: busy(),
      busyHint: busyHint(),
      busyLabel: busyLabel(),
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
      openworkServerCapabilities: devtoolsCapabilities(),
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
      reloadWorkspaceEngine: reloadWorkspaceEngineAndResume,
      reloadBusy: reloadBusy(),
      reloadError: reloadError(),
      workspaceAutoReloadAvailable: workspaceAutoReloadAvailable(),
      workspaceAutoReloadEnabled: workspaceAutoReloadEnabled(),
      setWorkspaceAutoReloadEnabled,
      workspaceAutoReloadResumeEnabled: workspaceAutoReloadResumeEnabled(),
      setWorkspaceAutoReloadResumeEnabled,
      selectedWorkspaceDisplay: selectedWorkspaceDisplay(),
      workspaces: workspaceStore.workspaces(),
      selectedWorkspaceId: workspaceStore.selectedWorkspaceId(),
      connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
      workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
      switchWorkspace: workspaceStore.switchWorkspace,
      testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
      recoverWorkspace: workspaceStore.recoverWorkspace,
      openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
      pickFolderWorkspace: workspaceStore.createWorkspaceFromPickedFolder,
      openCreateRemoteWorkspace: () => workspaceStore.setCreateRemoteWorkspaceOpen(true),
      connectRemoteWorkspace: workspaceStore.createRemoteWorkspaceFlow,
      openTeamBundle: bundlesStore.openTeamBundle,
      importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
      importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
      exportWorkspaceConfig: workspaceStore.exportWorkspaceConfig,
      exportWorkspaceBusy: workspaceStore.exportingWorkspaceConfig(),
      createWorkspaceOpen: workspaceStore.createWorkspaceOpen(),
      setCreateWorkspaceOpen: workspaceStore.setCreateWorkspaceOpen,
      createWorkspaceFlow: workspaceStore.createWorkspaceFlow,
      pickWorkspaceFolder: workspaceStore.pickWorkspaceFolder,
      workspaceSessionGroups: sidebarWorkspaceGroups(),
      selectedSessionId: activeSessionId(),
      openRenameWorkspace,
      editWorkspaceConnection: openWorkspaceConnectionSettings,
      forgetWorkspace: workspaceStore.forgetWorkspace,
      stopSandbox: workspaceStore.stopSandbox,
      schedulerPluginInstalled: schedulerPluginInstalled(),
      selectedWorkspaceRoot: workspaceStore.selectedWorkspaceRoot().trim(),
      isRemoteWorkspace: workspaceStore.selectedWorkspaceDisplay().workspaceType === "remote",
      skillsAccessHint,
      canInstallSkillCreator,
      canUseDesktopTools,
      pluginsAccessHint,
      canEditPlugins,
      canUseGlobalPluginScope,
      suggestedPlugins: SUGGESTED_PLUGINS,
      addPlugin,
      createSessionAndOpen,
      setPrompt,
      selectSession: selectSession,
      defaultModelLabel: formatModelLabel(defaultModel(), providers()),
      defaultModelRef: formatModelRef(defaultModel()),
      openDefaultModelPicker,
      autoCompactContext: autoCompactContext(),
      toggleAutoCompactContext,
      autoCompactContextBusy: autoCompactContextSaving(),
      hideTitlebar: hideTitlebar(),
      toggleHideTitlebar: () => setHideTitlebar((v) => !v),
      modelVariantLabel: getModelBehaviorCopy(defaultModel(), modelConfig.getWorkspaceVariantFor(defaultModel())).label,
      editModelVariant: openDefaultModelPicker,
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
      openDebugDeepLink,
      language: currentLocale(),
      setLanguage: setLocale,
    };
  };

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

  const sessionProps = () => ({
    providerAuthWorkerType: providerAuthWorkerType(),
    selectedSessionId: activeSessionId(),
    setView,
    settingsTab: settingsTab(),
    setSettingsTab,
    toggleSettings: () => toggleSettingsView("general"),
    selectedWorkspaceDisplay: selectedWorkspaceDisplay(),
    selectedWorkspaceRoot: workspaceStore.selectedWorkspaceRoot().trim(),
    activeWorkspaceConfig: resolvedActiveWorkspaceConfig(),
    workspaces: workspaceStore.workspaces(),
    selectedWorkspaceId: workspaceStore.selectedWorkspaceId(),
    connectingWorkspaceId: workspaceStore.connectingWorkspaceId(),
    workspaceConnectionStateById: workspaceStore.workspaceConnectionStateById(),
    switchWorkspace: workspaceStore.switchWorkspace,
    testWorkspaceConnection: workspaceStore.testWorkspaceConnection,
    recoverWorkspace: workspaceStore.recoverWorkspace,
    editWorkspaceConnection: openWorkspaceConnectionSettings,
    forgetWorkspace: workspaceStore.forgetWorkspace,
    openCreateWorkspace: () => workspaceStore.setCreateWorkspaceOpen(true),
    pickFolderWorkspace: workspaceStore.createWorkspaceFromPickedFolder,
    openCreateRemoteWorkspace: () => workspaceStore.setCreateRemoteWorkspaceOpen(true),
    importWorkspaceConfig: workspaceStore.importWorkspaceConfig,
    importingWorkspaceConfig: workspaceStore.importingWorkspaceConfig(),
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
    stopHost,
    headerStatus: headerStatus(),
    busyHint: busyHint(),
    updateStatus: updateStatus(),
    updateEnv: updateEnv(),
    anyActiveRuns: anyActiveRuns(),
    installUpdateAndRestart,
    selectedSessionModelLabel: selectedSessionModelLabel(),
    openSessionModelPicker: openSessionModelPicker,
    modelVariantLabel: getModelBehaviorCopy(selectedSessionModel(), modelVariant()).label,
    modelVariant: modelVariant(),
    modelBehaviorOptions: getModelBehaviorCopy(selectedSessionModel(), modelVariant()).options,
    setModelVariant: (value: string | null) => {
      const sessionId = selectedSessionId();
      if (sessionId) {
        modelConfig.setSessionVariantOverride(sessionId, sanitizeModelVariantForRef(selectedSessionModel(), value));
        return;
      }
      modelConfig.setPendingSessionVariant(sanitizeModelVariantForRef(selectedSessionModel(), value));
    },
    activePlugins: sidebarPluginList(),
    activePluginStatus: sidebarPluginStatus(),
    skills: skills(),
    skillsStatus: skillsStatus(),
    createSessionAndOpen: createSessionAndOpen,
    sendPromptAsync: sendPrompt,
    abortSession: abortSession,
    sessionRevertMessageId: selectedSession()?.revert?.messageID ?? null,
    undoLastUserMessage: undoLastUserMessage,
    redoLastUserMessage: redoLastUserMessage,
    compactSession: compactCurrentSession,
    lastPromptSent: lastPromptSent(),
    retryLastPrompt: retryLastPrompt,
    newTaskDisabled: newTaskDisabled(),
    workspaceSessionGroups: sidebarWorkspaceGroups(),
    openRenameWorkspace,
    selectSession: selectSession,
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
    expandedSidebarSections: expandedSidebarSections(),
    setExpandedSidebarSections: setExpandedSidebarSections,
    workingFiles: activeWorkingFiles(),
    authorizedDirs: activeAuthorizedDirs(),
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
    openProviderAuthModal: openProviderAuthModal,
    closeProviderAuthModal: closeProviderAuthModal,
    providerAuthModalOpen: providerAuthModalOpen(),
    providerAuthBusy: providerAuthBusy(),
    providerAuthError: providerAuthError(),
    providerAuthMethods: providerAuthMethods(),
    providerAuthPreferredProviderId: providerAuthPreferredProviderId(),
    providers: providers(),
    providerConnectedIds: providerConnectedIds(),
    listAgents: listAgents,
    listCommands: listCommands,
    selectedSessionAgent: selectedSessionAgent(),
    setSessionAgent: setSessionAgent,
    sessionStatusById: activeSessionStatusById(),
    hasEarlierMessages: selectedSessionHasEarlierMessages(),
    loadingEarlierMessages: selectedSessionLoadingEarlierMessages(),
    loadEarlierMessages,
    searchFiles: searchWorkspaceFiles,
    deleteSession: deleteSessionById,
    sessionStatus: selectedSessionStatus(),
    renameSession: renameSessionTitle,
    error: error(),
  });

  const settingsTabs = new Set<SettingsTab>([
    "general",
    "den",
    "model",
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
      goToSettings(mapLegacySurfaceToSettingsTab(tabSegment ?? "settings"), { replace: true });
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

    if (path.startsWith("/proto-v1-ux") || path.startsWith("/proto")) {
      if (isTauriRuntime()) {
        navigate("/settings/automations", { replace: true });
        return;
      }

      navigate("/settings/automations", { replace: true });
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
    <ConnectionsProvider store={connectionsStore}>
      <ExtensionsProvider store={extensionsStore}>
        <AutomationsProvider store={automationsStore}>
          <Switch>
            <Match when={booting()}>
              <BootShell />
            </Match>
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
        onBehaviorChange={(model, value) => {
          const nextValue = sanitizeModelVariantForRef(model, value);
          if (modelPickerTarget() === "default") {
            modelConfig.setWorkspaceVariant(model, nextValue);
            return;
          }

          const sessionId = selectedSessionId();
          if (sessionId) {
            modelConfig.setSessionVariantOverride(sessionId, nextValue);
            return;
          }

          modelConfig.setPendingSessionVariant(nextValue);
        }}
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
        onReloadEngine={() => reloadWorkspaceEngineAndResume()}
      />

      <BundleImportModal
        open={Boolean(bundlesStore.bundleImportChoice())}
        title={bundlesStore.bundleImportSummary()?.title ?? "Import bundle"}
        description={bundlesStore.bundleImportSummary()?.description ?? "Choose how to import this bundle."}
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
          setDeepLinkRemoteWorkspaceDefaults(null);
        }}
        onConfirm={(input) => workspaceStore.createRemoteWorkspaceFlow(input)}
        initialValues={deepLinkRemoteWorkspaceDefaults() ?? undefined}
        submitting={
          busy() &&
          (busyLabel() === "status.creating_workspace" || busyLabel() === "status.connecting")
        }
      />

      <div class="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(24rem,calc(100vw-1.5rem))] max-w-full flex-col gap-3 sm:right-6 sm:top-6">
        <div class="pointer-events-auto">
          <ReloadWorkspaceToast
            open={reloadRequired("config", "mcp", "plugin", "skill", "agent", "command")}
            title={reloadCopy().title}
            description={reloadCopy().body}
            trigger={reloadTrigger()}
            error={reloadError()}
            reloadLabel={activeReloadBlockingSessions().length > 0 ? "Reload & Stop Tasks" : "Reload now"}
            dismissLabel="Later"
            busy={reloadBusy()}
            canReload={canReloadWorkspace()}
            hasActiveRuns={activeReloadBlockingSessions().length > 0}
            onReload={() => {
              void (activeReloadBlockingSessions().length > 0
                ? forceStopActiveSessionsAndReload()
                : reloadWorkspaceEngineAndResume());
            }}
            onDismiss={clearReloadRequired}
          />
        </div>

        <div class="pointer-events-auto">
          <StatusToast
            open={Boolean(bundlesStore.skillSuccessToast())}
            tone="success"
            title={bundlesStore.skillSuccessToast()?.title ?? "Skill added"}
            description={bundlesStore.skillSuccessToast()?.description ?? null}
            dismissLabel="Dismiss"
            onDismiss={bundlesStore.clearSkillSuccessToast}
          />
        </div>

      </div>

      <RenameWorkspaceModal
        open={renameWorkspaceOpen()}
        title={renameWorkspaceName()}
        busy={renameWorkspaceBusy()}
        canSave={renameWorkspaceName().trim().length > 0 && !renameWorkspaceBusy()}
        onClose={closeRenameWorkspace}
        onSave={saveRenameWorkspace}
        onTitleChange={setRenameWorkspaceName}
      />

      <CreateRemoteWorkspaceModal
        open={editRemoteWorkspaceOpen()}
        onClose={() => {
          setEditRemoteWorkspaceOpen(false);
          setEditRemoteWorkspaceId(null);
          setEditRemoteWorkspaceError(null);
        }}
        onConfirm={(input) => {
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
        }}
        initialValues={editRemoteWorkspaceDefaults() ?? undefined}
        submitting={busy() && busyLabel() === "status.connecting"}
        error={editRemoteWorkspaceError()}
        title={t("dashboard.edit_remote_workspace_title", currentLocale())}
        subtitle={t("dashboard.edit_remote_workspace_subtitle", currentLocale())}
        confirmLabel={t("dashboard.edit_remote_workspace_confirm", currentLocale())}
      />
        </AutomationsProvider>
      </ExtensionsProvider>
    </ConnectionsProvider>
  );
}
