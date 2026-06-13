/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { toast } from "@/components/ui/sonner";

import { SUGGESTED_PLUGINS } from "@/app/constants";
import type { EnablementContext } from "@/app/enablement";
import { createClient } from "@/app/lib/opencode";
import {
  createOpenworkServerClient,
  isLoopbackOpenworkServerUrl,
  readOpenworkServerSettings,
  type OpenworkServerCapabilities,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "@/app/lib/openwork-server";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { buildOpenworkEnvRuntimeKey } from "@/app/lib/openwork-env-runtime";
import {
  getInitialThemeMode,
  setThemeMode as setAppThemeMode,
  type ThemeMode,
} from "@/app/theme";
import type {
  Client,
  ProviderListItem,
  SettingsTab,
  WorkspaceConnectionState,
  WorkspaceDisplay,
  WorkspacePreset,
  WorkspaceSessionGroup,
} from "@/app/types";
import { getWorkspaceTaskLoadErrorDisplay } from "@/app/utils";
import { currentLocale, t, setLocale, type Language } from "@/i18n";
import { useModelPicker } from "@/react-app/domains/session/modals/use-model-picker";
import {
  type RouteWorkspace,
  type RouteSession,
  describeRouteError,
  describeWorkspaceCreateError,
  downloadWorkspaceJson,
  folderNameFromPath,
  getSessionStatus,
  isActiveSessionStatus,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  toSessionGroups,
  workspaceExportFilename,
  workspaceLabel,
} from "@/react-app/shell/route-workspaces";
import { createConnectionsStore, useConnectionsStoreSnapshot } from "@/react-app/domains/connections/store";
import { createOpenworkServerStore, useOpenworkServerStoreSnapshot } from "@/react-app/domains/connections/openwork-server-store";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "@/react-app/domains/connections/provider-auth/store";
import ProviderAuthModal from "@/react-app/domains/connections/provider-auth/provider-auth-modal";
import ConnectionsModals from "@/react-app/domains/connections/modals";
import { AiSettingsView } from "@/react-app/domains/settings/pages/ai-view";
// Side-effect imports: register extension config components into the registry.
import "@/react-app/domains/settings/openai-image-gen-config";
import "@/react-app/domains/settings/ollama-config";
import "@/react-app/domains/settings/computer-use-config";
import "@/react-app/domains/settings/browser-extension-config";
import "@/react-app/domains/settings/openwork-voice-config";
import "@/react-app/domains/settings/google-workspace-config";
import { useSettingsExtensionController } from "@/react-app/domains/settings/settings-extension-controller";
import { buildExtensionItems } from "@/react-app/domains/settings/extension-items";
import { isOpenWorkExtensionEnabled, OPENWORK_EXTENSION_STATE_CHANGED, setOpenWorkExtensionEnabled } from "@/react-app/domains/settings/extension-state";
import { PreferencesView } from "@/react-app/domains/settings/pages/preferences-view";
import { ShellCustomizationView } from "@/react-app/domains/settings/pages/shell-view";
import { GeneralSettingsView } from "@/react-app/domains/settings/pages/general-view";
import { AuthorizedFoldersPanel } from "@/react-app/domains/settings/panels/authorized-folders-panel";
import { SettingsStack } from "@/react-app/domains/settings/settings-section";
import { AdvancedView } from "@/react-app/domains/settings/pages/advanced-view";
import { AppearanceView } from "@/react-app/domains/settings/pages/appearance-view";
import { CloudAccountView } from "@/react-app/domains/settings/pages/cloud-account-view";
import { CloudMarketplacesView } from "@/react-app/domains/settings/pages/cloud-marketplaces-view";
import { CloudProvidersView } from "@/react-app/domains/settings/pages/cloud-providers-view";
import { CloudWorkersView } from "@/react-app/domains/settings/pages/cloud-workers-view";
import { DebugView } from "@/react-app/domains/settings/pages/debug-view";
import { EnvironmentView } from "@/react-app/domains/settings/pages/environment-view";
import { ExtensionsView } from "@/react-app/domains/settings/pages/extensions-view";
import { McpView } from "@/react-app/domains/settings/pages/mcp-view";
import { RecoveryView } from "@/react-app/domains/settings/pages/recovery-view";
import { MessagingView } from "@/react-app/domains/settings/pages/messaging-view";
import { SkillsView } from "@/react-app/domains/settings/pages/skills-view";
import { UpdatesView } from "@/react-app/domains/settings/pages/updates-view";
import { useDebugViewModel } from "@/react-app/domains/settings/state/debug-view-model";
import { useMessagingViewProps } from "@/react-app/domains/settings/state/messaging-view-state";
import { useElectronUpdaterState } from "@/react-app/domains/settings/state/electron-updater-state";
import { CloudSessionProvider, useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { useDenSession } from "@/react-app/domains/settings/cloud/use-den-session";
import { useBootState } from "./boot-state";
import { SettingsShell } from "@/react-app/domains/settings/shell/settings-shell";
import { createExtensionsStore, useExtensionsStoreSnapshot } from "@/react-app/domains/settings/state/extensions-store";
import { usePlatform } from "@/react-app/kernel/platform";
import { useLocal } from "@/react-app/kernel/local-provider";
import {
  openworkServerInfo,
  openworkServerRestart,
  engineStart,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  desktopBridge,
  type WorkspaceInfo,
  type WorkspaceList,
  revealDesktopItemInDir,
} from "@/app/lib/desktop";
import { isDesktopProviderBlocked } from "@/app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction, useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "@/react-app/domains/cloud/restriction-notice-provider";
import { useCloudProviderAutoSync } from "@/react-app/domains/cloud/use-cloud-provider-auto-sync";
import {
  hasOpenWorkModelsProvider,
  hideOpenWorkModelsPromo,
  isOpenWorkModelsPromoHidden,
  openWorkModelsPromoChangedEvent,
} from "@/react-app/domains/cloud/openwork-models-promo";
import {
  isDesktopRuntime,
  isElectronRuntime,
  isMacPlatform,
  normalizeDirectoryPath,
  resolveModelDisplayName,
  resolveProviderDisplayName,
  safeStringify,
} from "@/app/utils";
import { CreateRemoteWorkspaceModal } from "@/react-app/domains/workspace/create-remote-workspace-modal";
import { CreateWorkspaceModal } from "@/react-app/domains/workspace/create-workspace-modal";
import { RenameWorkspaceModal } from "@/react-app/domains/workspace/rename-workspace-modal";
import { ShareWorkspaceModal } from "@/react-app/domains/workspace/share-workspace-modal";
import { useShareWorkspaceState } from "@/react-app/domains/workspace/share-workspace-state";
import { useRemoteWorkspaceConnectionEditor } from "@/react-app/domains/workspace/use-remote-workspace-connection-editor";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { ModelPickerModal } from "@/react-app/domains/session/modals/model-picker-modal";
import type { ModelRef } from "@/app/types";
import { workspaceSwatchColor } from "@/react-app/domains/session/sidebar/utils";
import { recordInspectorEvent } from "../../app/lib/app-inspector";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import { abortSessionSafe } from "@/app/lib/opencode-session";
import { notifyAlert } from "./notifications";
import { useReloadCoordinator } from "./reload-coordinator";
import { buildFeedbackUrl } from "@/app/lib/feedback";
import { getDenInferenceUrl } from "@/app/lib/den";
import { readActiveWorkspaceId, writeActiveWorkspaceId } from "./session-memory";
import { workspaceSessionRoute, workspaceSettingsRoute } from "./workspace-routes";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { refreshProviderListQueries } from "@/react-app/infra/provider-list-query";
import {
  OPENAI_IMAGE_EXTENSION_ID,
  OPENAI_IMAGE_MODEL,
} from "@/react-app/domains/settings/openai-image-extension";
import { OLLAMA_PROVIDER_CONFIG, type LocalProviderInstallInput } from "@/react-app/domains/settings/openai-image-extension";

const ROUTE_OPENWORK_CAPABILITIES: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

function isOpenWorkCloudProvider(provider: {
  providerId?: string | null;
  source?: string | null;
  sourceProviderId?: string | null;
}) {
  return [provider.providerId, provider.source, provider.sourceProviderId].some(
    (value) => value?.trim().toLowerCase() === "openwork",
  );
}

function normalizeComputerUsePermissions(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  return {
    accessibility: "accessibility" in value && value.accessibility === true,
    screenRecording: "screenRecording" in value && value.screenRecording === true,
  };
}

function reconcileSelectedWorkspaceId(
  currentId: string,
  serverList: { activeId?: string | null },
  desktopList: WorkspaceList | null,
  workspaces: RouteWorkspace[],
) {
  const current = currentId.trim();
  const serverIds = new Set(workspaces.map((workspace) => workspace.id));
  if (current && serverIds.has(current)) return current;

  const desktopSelectedId = resolveWorkspaceListSelectedId(desktopList);
  const desktopSelected = desktopSelectedId
    ? desktopList?.workspaces?.find((workspace) => workspace.id === desktopSelectedId)
    : null;
  const currentDesktop = current
    ? desktopList?.workspaces?.find((workspace) => workspace.id === current)
    : null;
  const selectedPath = normalizeDirectoryPath((currentDesktop ?? desktopSelected)?.path ?? "");

  if (selectedPath) {
    const pathMatch = workspaces.find(
      (workspace) => normalizeDirectoryPath(workspace.path ?? "") === selectedPath,
    );
    if (pathMatch) return pathMatch.id;
  }

  return serverList.activeId?.trim() || desktopSelectedId || workspaces[0]?.id || "";
}

const SETTINGS_HIDE_TITLEBAR_KEY = "openwork.react.settings.hide-titlebar";
const SETTINGS_UPDATE_AUTO_CHECK_KEY = "openwork.react.settings.update-auto-check";
const SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY = "openwork.react.settings.update-auto-download";

function parseSettingsPath(pathname: string): {
  tab: SettingsTab;
  redirectPath: string | null;
  extensionsSection?: "all" | "mcp" | "plugins";
} {
  const trimmed = pathname
    .replace(/^\/workspace\/[^/]+\/settings\/?/, "")
    .replace(/^\/settings\/?/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return { tab: "general", redirectPath: "general" };
  }

  const [head, tail] = trimmed.split("/");
  switch (head) {
    case "general":
    case "ai":
    case "preferences":
    case "permissions":
    case "shell":
    case "advanced":
    case "appearance":
    case "environment":
    case "updates":
    case "recovery":
    case "debug":
      return { tab: head, redirectPath: null };
    case "cloud-account":
    case "cloud-marketplaces":
    case "cloud-workers":
    case "cloud-providers":
      return { tab: head, redirectPath: null };
    case "den":
      return { tab: "cloud-account", redirectPath: "cloud-account" };
    case "extensions":
      if (tail === "mcp") return { tab: "extensions", redirectPath: null, extensionsSection: "mcp" };
      if (tail === "skills") return { tab: "extensions", redirectPath: null, extensionsSection: "all" };
      if (tail === "plugins") return { tab: "extensions", redirectPath: null, extensionsSection: "plugins" };
      return { tab: "extensions", redirectPath: null, extensionsSection: "all" };
    default:
      return { tab: "general", redirectPath: "general" };
  }
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore persistence failures
  }
}

function readNavigationWorkspaceId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { workspaceId?: unknown }).workspaceId;
  return typeof value === "string" ? value.trim() || null : null;
}

function readNavigationSessionId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { sessionId?: unknown }).sessionId;
  return typeof value === "string" ? value.trim() || null : null;
}

function findSessionWorkspaceId(
  sessionId: string | null,
  entries: Array<{ workspaceId: string; sessions: any[] }>,
) {
  const id = sessionId?.trim();
  if (!id) return null;
  return entries.find((entry) => entry.sessions.some((session) => session?.id === id))?.workspaceId ?? null;
}

function settingsPathForRoute(route: ReturnType<typeof parseSettingsPath>) {
  if (route.tab === "extensions" && route.extensionsSection && route.extensionsSection !== "all") {
    return `extensions/${route.extensionsSection}`;
  }
  return route.tab;
}

export type SettingsSurfaceProps = {
  embedded?: boolean;
  initialPath?: string;
  workspaceId?: string;
  onClose?: () => void;
};

function SettingsRouteContent(props: SettingsSurfaceProps = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ workspaceId?: string }>();
  const routeWorkspaceId = props.workspaceId?.trim() || params.workspaceId?.trim() || "";
  const local = useLocal();
  const platform = usePlatform();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const desktopConfig = useDesktopConfig();
  const reloadCoordinator = useReloadCoordinator();
  const [embeddedPath, setEmbeddedPath] = useState(props.initialPath ?? "general");
  const route = props.embedded ? parseSettingsPath(`/settings/${embeddedPath}`) : parseSettingsPath(location.pathname);
  const navigationWorkspaceId = readNavigationWorkspaceId(location.state);
  const navigationSessionId = readNavigationSessionId(location.state);

  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, RouteSession[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [workspaceConnectionOverrides, setWorkspaceConnectionOverrides] = useState<Record<string, WorkspaceConnectionState>>({});
  const [legacySelectedWorkspaceId, setLegacySelectedWorkspaceId] = useState(() => navigationWorkspaceId ?? readActiveWorkspaceId() ?? "");
  const selectedWorkspaceId = routeWorkspaceId || legacySelectedWorkspaceId;

  useEffect(() => {
    if (!props.embedded || !route.redirectPath) return;
    setEmbeddedPath(route.redirectPath);
  }, [props.embedded, route.redirectPath]);

  const navigateSettingsPath = useCallback((path: string) => {
    if (props.embedded) {
      setEmbeddedPath(path);
      return;
    }
    navigate(selectedWorkspaceId ? workspaceSettingsRoute(selectedWorkspaceId, path) : `/settings/${path}`);
  }, [navigate, props.embedded, selectedWorkspaceId]);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [openworkClient, setOpenworkClient] = useState<OpenworkServerClient | null>(null);
  const [activeClient, setActiveClient] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const refreshInFlightRef = useRef(false);
  const reconnectAttemptedWorkspaceIdRef = useRef("");
  const refreshMcpServersRef = useRef<(() => void | Promise<void>) | null>(null);
  const notifyMcpReloadingRef = useRef<(() => void) | null>(null);
  const pollMcpServersAfterReloadRef = useRef<(() => void | Promise<void>) | null>(null);
  const remoteWorkspaceCheckRunRef = useRef<Record<string, string>>({});
  const remoteWorkspaceCheckRunCounterRef = useRef(0);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [developerMode, setDeveloperMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("openwork.developerMode") === "1";
  });
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getInitialThemeMode);
  const [hideTitlebar, setHideTitlebar] = useState(() => readStoredBoolean(SETTINGS_HIDE_TITLEBAR_KEY, false));
  const [updateAutoCheck, setUpdateAutoCheck] = useState(() =>
    readStoredBoolean(SETTINGS_UPDATE_AUTO_CHECK_KEY, true),
  );
  const [updateAutoDownload, setUpdateAutoDownload] = useState(() =>
    readStoredBoolean(SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY, false),
  );
  const [configActionStatus, setConfigActionStatus] = useState<string | null>(null);
  const [revealConfigBusy, setRevealConfigBusy] = useState(false);
  const [resetConfigBusy, setResetConfigBusy] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [exportWorkspaceBusy, setExportWorkspaceBusy] = useState(false);
  const [autoCompactContext, setAutoCompactContext] = useState(true);
  const [autoCompactContextBusy, setAutoCompactContextBusy] = useState(false);
  const [autoCompactContextLoaded, setAutoCompactContextLoaded] = useState(false);
  const [localProviderBusy, setLocalProviderBusy] = useState(false);
  const [localProviderStatus, setLocalProviderStatus] = useState<string | null>(null);
  const [localProviderError, setLocalProviderError] = useState<string | null>(null);
  const [googleWorkspaceConnected, setGoogleWorkspaceConnected] = useState(false);
  const [imageExtensionBusy, setImageExtensionBusy] = useState(false);
  const [imageExtensionStatus, setImageExtensionStatus] = useState<string | null>(null);
  const [imageExtensionError, setImageExtensionError] = useState<string | null>(null);
  const [computerUsePermissions, setComputerUsePermissions] = useState<{ accessibility: boolean; screenRecording: boolean } | null>(null);
  const [extensionStateVersion, setExtensionStateVersion] = useState(0);
  const [imageGenerationBusy, setImageGenerationBusy] = useState(false);
  const [imageGenerationStatus, setImageGenerationStatus] = useState<string | null>(null);
  const [imageGenerationError, setImageGenerationError] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [userEnvKeys, setUserEnvKeys] = useState<string[]>([]);
  const emptyWorkspaceDisplay = useMemo<WorkspaceDisplay>(
    () => ({
      id: "",
      name: t("session.workspace_fallback"),
      path: "",
      preset: "starter",
      workspaceType: "local",
    }),
    [],
  );

  const routeStateRef = useRef({
    activeClient: null as Client | null,
    selectedWorkspaceId: "",
    selectedWorkspaceRoot: "",
    selectedWorkspaceType: "local" as "local" | "remote",
    runtimeWorkspaceId: null as string | null,
    openworkServerClient: null as OpenworkServerClient | null,
    openworkServerStatus: "disconnected" as "connected" | "disconnected",
    openworkServerCapabilities: null as OpenworkServerCapabilities | null,
    selectedWorkspaceDisplay: emptyWorkspaceDisplay as WorkspaceDisplay,
    providerItems: [] as ProviderListItem[],
    providerDefaults: {} as Record<string, string>,
    providerConnectedIds: [] as string[],
    disabledProviders: [] as string[],
    developerMode: false,
  });

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? (selectedWorkspaceId ? null : workspaces[0] ?? null),
    [selectedWorkspaceId, workspaces],
  );
  const workspaceConnectionStateById = useMemo(() => {
    const next: Record<string, WorkspaceConnectionState> = { ...workspaceConnectionOverrides };
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") continue;
      const error = errorsByWorkspaceId[workspace.id]?.trim();
      if (!error || next[workspace.id]?.status === "connecting") continue;
      next[workspace.id] ??= {
        status: "error",
        message: getWorkspaceTaskLoadErrorDisplay(workspace, error).message || error,
        checkedAt: null,
      };
    }
    return next;
  }, [errorsByWorkspaceId, workspaceConnectionOverrides, workspaces]);
  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  const selectedWorkspaceDisplay = useMemo<WorkspaceDisplay>(
    () =>
      selectedWorkspace
        ? {
            id: selectedWorkspace.id,
            name: selectedWorkspace.name ?? selectedWorkspace.displayNameResolved,
            path: selectedWorkspace.path ?? "",
            preset: "starter",
            workspaceType: selectedWorkspace.workspaceType ?? "local",
            displayName: selectedWorkspace.displayNameResolved,
            openworkWorkspaceName: selectedWorkspace.openworkWorkspaceName,
          }
        : emptyWorkspaceDisplay,
    [emptyWorkspaceDisplay, selectedWorkspace],
  );

  routeStateRef.current = {
    activeClient,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    selectedWorkspaceType: selectedWorkspace?.workspaceType ?? "local",
    runtimeWorkspaceId: selectedWorkspace?.id ?? null,
    openworkServerClient: openworkClient,
    openworkServerStatus: openworkClient ? "connected" : "disconnected",
    openworkServerCapabilities: openworkClient ? ROUTE_OPENWORK_CAPABILITIES : null,
    selectedWorkspaceDisplay,
    providerItems: providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviders,
    developerMode,
  };

  const activeReloadBlockingSessions = useMemo(
    () =>
      Object.values(sessionsByWorkspaceId)
        .flat()
        .flatMap((session) => {
          if (!isActiveSessionStatus(getSessionStatus(session))) return [];
          const id = String(session?.id ?? "");
          if (!id) return [];
          return [{
            id,
            title:
              String(session?.title ?? session?.slug ?? session?.id ?? "").trim() ||
              t("session.untitled"),
          }];
        }),
    [sessionsByWorkspaceId],
  );

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId.trim();
    if (!openworkClient || !workspaceId) {
      toast.error(t("app.error_connect_first"));
      return false;
    }

    await openworkClient.reloadEngine(workspaceId);
    await refreshProviderListQueries(getReactQueryClient());

    try {
      window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
    } catch {
      // ignore browser event dispatch failures
    }

    // OpenCode reconnects MCPs async after dispose — the store polls until
    // statuses settle so users don't have to collapse/expand the card.
    void pollMcpServersAfterReloadRef.current?.();

    return true;
  }, [openworkClient, selectedWorkspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(openworkClient && (selectedWorkspace?.id || selectedWorkspaceId)),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
      stopSession: async (sessionId) => {
        if (!activeClient) return;
        await abortSessionSafe(activeClient, sessionId);
      },
    });
  }, [
    activeClient,
    activeReloadBlockingSessions,
    openworkClient,
    reloadCoordinator,
    reloadWorkspaceEngineFromUi,
    selectedWorkspace?.id,
    selectedWorkspaceId,
  ]);

  const openworkServerStore = useMemo(
    () =>
      createOpenworkServerStore({
        startupPreference: () => {
          // In desktop mode, loopback URLs are ephemeral local runtime details.
          // Only non-loopback stored URLs indicate an explicit remote/manual
          // server connection preference.
          if (!isDesktopRuntime()) return "server";
          const stored = readOpenworkServerSettings();
          const storedUrl = stored.urlOverride?.trim() ?? "";
          return storedUrl && !isLoopbackOpenworkServerUrl(storedUrl) ? "server" : "local";
        },
        documentVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
        developerMode: () => routeStateRef.current.developerMode,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        activeClient: () => routeStateRef.current.activeClient,
        selectedWorkspaceDisplay: () => routeStateRef.current.selectedWorkspaceDisplay,
        restartLocalServer: async () => {
          if (!isDesktopRuntime()) return false;
          try {
            await openworkServerRestart({
              remoteAccessEnabled:
                readOpenworkServerSettings().remoteAccessEnabled === true,
            });
            return true;
          } catch {
            return false;
          }
        },
        createRemoteWorkspaceFlow: async () => false,
      }),
    [],
  );
  const connectionsStore = useMemo(
    () =>
      createConnectionsStore({
        client: () => routeStateRef.current.activeClient,
        setClient: setActiveClient,
        projectDir: () => routeStateRef.current.selectedWorkspaceRoot,
        selectedWorkspaceId: () => routeStateRef.current.selectedWorkspaceId,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        workspaceType: () => routeStateRef.current.selectedWorkspaceType,
        openworkServer: openworkServerStore,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        developerMode: () => routeStateRef.current.developerMode,
        markReloadRequired: reloadCoordinator.markReloadRequired,
      }),
    [openworkServerStore, reloadCoordinator.markReloadRequired],
  );
  refreshMcpServersRef.current = connectionsStore.refreshMcpServers;
  notifyMcpReloadingRef.current = connectionsStore.notifyMcpReloading;
  pollMcpServersAfterReloadRef.current = connectionsStore.pollMcpServersAfterReload;
  const providerAuthStore = useMemo(
    () =>
      createProviderAuthStore({
        client: () => routeStateRef.current.activeClient,
        providers: () => routeStateRef.current.providerItems,
        providerDefaults: () => routeStateRef.current.providerDefaults,
        providerConnectedIds: () => routeStateRef.current.providerConnectedIds,
        disabledProviders: () => routeStateRef.current.disabledProviders,
        checkDesktopAppRestriction: checkDesktopRestriction,
        selectedWorkspaceDisplay: () => routeStateRef.current.selectedWorkspaceDisplay,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        openworkServer: openworkServerStore,
        setProviders,
        setProviderDefaults,
        setProviderConnectedIds,
        setDisabledProviders,
        markOpencodeConfigReloadRequired: () => {
          setConfigActionStatus(t("settings.config_updated"));
          reloadCoordinator.markReloadRequired("config", {
            type: "config",
            name: "opencode.json",
            action: "updated",
          });
        },
      }),
    [checkDesktopRestriction, openworkServerStore, reloadCoordinator.markReloadRequired],
  );
  const extensionsStore = useMemo(
    () =>
      createExtensionsStore({
        client: () => routeStateRef.current.activeClient,
        projectDir: () => routeStateRef.current.selectedWorkspaceRoot,
        selectedWorkspaceId: () => routeStateRef.current.selectedWorkspaceId,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        workspaceType: () => routeStateRef.current.selectedWorkspaceType,
        openworkServer: openworkServerStore,
        openworkServerConnection: () => ({
          openworkServerClient: routeStateRef.current.openworkServerClient,
          openworkServerStatus: routeStateRef.current.openworkServerStatus,
          openworkServerCapabilities: routeStateRef.current.openworkServerCapabilities,
        }),
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        ensureRuntimeWorkspaceId: async () =>
          routeStateRef.current.runtimeWorkspaceId?.trim() ||
          routeStateRef.current.selectedWorkspaceId.trim() ||
          null,
        setBusy,
        setBusyLabel,
        setBusyStartedAt: () => {},
        setError: (message) => {
          if (message) {
            toast.error(message);
          }
        },
        markReloadRequired: reloadCoordinator.markReloadRequired,
      }),
    [openworkServerStore, reloadCoordinator.markReloadRequired],
  );
  const openworkServerSnapshot = useOpenworkServerStoreSnapshot(openworkServerStore);
  const connectionsSnapshot = useConnectionsStoreSnapshot(connectionsStore);
  const providerAuthSnapshot = useProviderAuthStoreSnapshot(providerAuthStore);
  useExtensionsStoreSnapshot(extensionsStore);

  const openworkServerStatusForMcp = openworkServerSnapshot.openworkServerStatus;
  useEffect(() => {
    if (openworkServerStatusForMcp !== "connected") return;
    // The first MCP read races the openwork-server store's initial health
    // check (a fresh store always starts "disconnected"), so it falls back
    // to config files where server-runtime (config.remote) entries — notably
    // the cloud control MCP — don't exist. Without this re-read the built-in
    // cards show "Tap to connect" until the next full remount even though
    // the entries are configured and healthy.
    void connectionsStore.refreshMcpServers();
  }, [connectionsStore, openworkServerStatusForMcp]);

  const denSession = useDenSession({
    developerMode,
    openLink: (url) => platform.openLink(url),
  });
  const cloudSession = useCloudSession();

  const hasOpenWorkCloudProvider = useMemo(
    () =>
      providerAuthSnapshot.cloudOrgProviders.some(isOpenWorkCloudProvider) ||
      Object.values(providerAuthSnapshot.importedCloudProviders ?? {}).some(isOpenWorkCloudProvider),
    [providerAuthSnapshot.cloudOrgProviders, providerAuthSnapshot.importedCloudProviders],
  );
  const [openWorkModelsPromoHidden, setOpenWorkModelsPromoHidden] = useState(isOpenWorkModelsPromoHidden);
  const openWorkModelsConnected =
    (cloudSession.isSignedIn && hasOpenWorkCloudProvider) ||
    hasOpenWorkModelsProvider(providerConnectedIds);
  const showOpenWorkModelsSubscribe = !openWorkModelsConnected && !openWorkModelsPromoHidden;
  const showOpenWorkModelsConnect = !openWorkModelsConnected && openWorkModelsPromoHidden;

  useEffect(() => {
    const handlePromoChanged = () => setOpenWorkModelsPromoHidden(isOpenWorkModelsPromoHidden());
    window.addEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
    return () => window.removeEventListener(openWorkModelsPromoChangedEvent, handlePromoChanged);
  }, []);

  const dismissOpenWorkModelsPromo = useCallback(() => {
    hideOpenWorkModelsPromo();
    setOpenWorkModelsPromoHidden(true);
  }, []);

  const subscribeToOpenWorkModels = useCallback(() => {
    providerAuthStore.closeProviderAuthModal();
    const accountPath = selectedWorkspaceId
      ? workspaceSettingsRoute(selectedWorkspaceId, "cloud-account")
      : "/settings/cloud-account";
    navigate(accountPath);
    window.setTimeout(() => {
      platform.openLink(getDenInferenceUrl(cloudSession.baseUrl));
    }, 0);
  }, [cloudSession.baseUrl, navigate, platform, providerAuthStore, selectedWorkspaceId]);

  const handleOpenProviderAuth = useCallback(() => {
    if (checkDesktopRestriction({ restriction: "allowCustomProviders" })) {
      restrictionNotice.show({
        title: "Adding custom providers is disabled",
        message: "Your organization administrator has disabled adding custom providers.",
      });
      return;
    }

    void providerAuthStore.openProviderAuthModal();
  }, [checkDesktopRestriction, providerAuthStore, restrictionNotice]);

  useEffect(() => {
    if (!activeClient || !selectedWorkspaceId) return;

    void providerAuthStore
      .ensureProjectProviderDisabledState(
        "opencode",
        checkDesktopRestriction({ restriction: "allowZenModel" }),
      )
      .catch((error) => {
        console.warn("[desktop-app-restrictions] failed to sync Zen restriction", error);
      });
  }, [activeClient, checkDesktopRestriction, disabledProviders, providerAuthStore, selectedWorkspaceId, selectedWorkspaceRoot]);

  const shareWorkspaceState = useShareWorkspaceState({
    workspaces,
    openworkServerHostInfo: openworkServerSnapshot.openworkServerHostInfo,
    openworkServerSettings: openworkServerSnapshot.openworkServerSettings,
    engineInfo: null,
    exportWorkspaceBusy,
    openLink: (url) => platform.openLink(url),
    workspaceLabel,
  });

  const debugViewProps = useDebugViewModel({
    developerMode,
    openworkServerStore,
    openworkServerSnapshot,
    runtimeWorkspaceId: selectedWorkspace?.id ?? null,
    selectedWorkspaceRoot,
    setRouteError: (message) => {
      if (message) {
        toast.error(message);
      }
    },
  });
  const onReleaseChannelChange = useCallback(
    (next: "stable" | "alpha") => {
      local.setPrefs((previous) => ({ ...previous, releaseChannel: next }));
    },
    [local],
  );
  const electronUpdaterState = useElectronUpdaterState({
    releaseChannel: local.prefs.releaseChannel ?? "stable",
    onReleaseChannelChange,
    updateAutoCheck,
    updateAutoDownload,
    desktopConfig: desktopConfig.config,
    setError: (message) => {
      if (message) {
        // Auto-checks can fail without any user action; alert + log to the
        // notification center instead of a bare toast.
        notifyAlert({
          kind: "update",
          title: t("notifications.updater_error"),
          body: message,
          dedupeKey: "updater-error",
        });
      }
    },
  });

  const workspaceSessionGroups = useMemo(
    // Settings has no per-workspace loading state; the empty set keeps the
    // previous behavior (error -> "error", otherwise "ready").
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId, new Set()),
    [errorsByWorkspaceId, sessionsByWorkspaceId, workspaces],
  );

  const selectedWorkspaceEndpoint = useMemo(
    () => resolveWorkspaceEndpoint(selectedWorkspace, { baseUrl, token }),
    [baseUrl, selectedWorkspace, token],
  );
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";
  const runtimeWorkspaceId = selectedWorkspaceEndpoint?.workspaceId ?? selectedWorkspace?.id ?? null;
  routeStateRef.current.runtimeWorkspaceId = runtimeWorkspaceId;

  const opencodeClient = useMemo(() => {
    if (!selectedWorkspaceEndpoint || !selectedWorkspaceEndpoint.token) return null;
    return createClient(
      selectedWorkspaceEndpoint.opencodeBaseUrl,
      selectedWorkspaceRoot || undefined,
      {
        token: selectedWorkspaceEndpoint.token,
        mode: "openwork",
      },
    );
  }, [selectedWorkspaceEndpoint, selectedWorkspaceRoot]);

  useEffect(() => {
    setActiveClient(opencodeClient);
  }, [opencodeClient]);

  const handleModelPickerLoadError = useCallback((error: unknown) => {
    toast.error(error instanceof Error ? error.message : t("app.unknown_error"));
  }, []);
  const modelPicker = useModelPicker({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    workspaceRoot: selectedWorkspaceRoot,
    onLoadError: handleModelPickerLoadError,
  });
  // Settings refreshes provider auth whenever the picker opens (the session
  // route does not need this; its provider state is kept fresh elsewhere).
  useEffect(() => {
    if (!modelPicker.open) return;
    void providerAuthStore.refreshProviders();
  }, [modelPicker.open, providerAuthStore]);

  useEffect(() => {
    const refresh = () => setExtensionStateVersion((value) => value + 1);
    window.addEventListener(OPENWORK_EXTENSION_STATE_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(OPENWORK_EXTENSION_STATE_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime() || !isMacPlatform()) return;
    let cancelled = false;
    void desktopBridge.checkComputerUsePermissions()
      .then((result) => {
        if (cancelled) return;
        const permissions = normalizeComputerUsePermissions(result);
        if (permissions) setComputerUsePermissions(permissions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const client = selectedWorkspaceEndpoint?.client ?? openworkClient;
    if (!client) {
      setGoogleWorkspaceConnected(false);
      return;
    }

    let cancelled = false;
    void client.googleWorkspaceStatus()
      .then((result) => {
        if (!cancelled) setGoogleWorkspaceConnected(result.connected === true);
      })
      .catch(() => {
        if (!cancelled) setGoogleWorkspaceConnected(false);
      });

    return () => {
      cancelled = true;
    };
  }, [openworkClient, selectedWorkspaceEndpoint]);

  useEffect(() => {
    if (!openworkClient) {
      setUserEnvKeys([]);
      return;
    }
    let cancelled = false;
    void openworkClient.listUserEnvKeys()
      .then((response) => { if (!cancelled) setUserEnvKeys(response.keys); })
      .catch(() => { if (!cancelled) setUserEnvKeys([]); });
    return () => { cancelled = true; };
  }, [openworkClient]);

  const installOpenAiImageExtension = useCallback(async (apiKey: string) => {
    const resolvedApiKey = apiKey.trim();
    if (!openworkClient) {
      setImageExtensionError("OpenWork server is not connected.");
      return;
    }
    if (!resolvedApiKey) {
      setImageExtensionError("OpenAI API key is required.");
      return;
    }

    setImageExtensionBusy(true);
    setImageExtensionStatus(null);
    setImageExtensionError(null);
    try {
      await openworkClient.upsertUserEnv([{ key: "OPENAI_API_KEY", value: resolvedApiKey }]);
      setUserEnvKeys((current) => Array.from(new Set([...current, "OPENAI_API_KEY"])));
      setImageExtensionStatus("Saved OPENAI_API_KEY. Agents can use OpenWork extension actions for image generation.");
    } catch (error) {
      setImageExtensionError(describeRouteError(error));
    } finally {
      setImageExtensionBusy(false);
    }
  }, [openworkClient]);

  const generateOpenAiTestImage = useCallback(async (input: { apiKey: string; prompt: string }) => {
    const client = selectedWorkspaceEndpoint?.client ?? openworkClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    const apiKey = input.apiKey.trim();
    const prompt = input.prompt.trim();
    if (!client || !workspaceId) {
      setImageGenerationError("OpenWork server is not connected for this workspace.");
      return;
    }
    if (!apiKey) {
      setImageGenerationError("OpenAI API key is required.");
      return;
    }
    if (!prompt) {
      setImageGenerationError("Prompt is required.");
      return;
    }

    setImageGenerationBusy(true);
    setImageGenerationStatus(null);
    setImageGenerationError(null);
    try {
      if (openworkClient) {
        await openworkClient.upsertUserEnv([{ key: "OPENAI_API_KEY", value: apiKey }]);
        setUserEnvKeys((current) => Array.from(new Set([...current, "OPENAI_API_KEY"])));
      }
      const response = await client.callExtensionAction({
        extensionId: OPENAI_IMAGE_EXTENSION_ID,
        action: "image_generate",
        args: { prompt },
        context: { directory: selectedWorkspaceRoot || undefined },
      });
      const result = response.result;
      const path = typeof result === "object" && result !== null && "path" in result && typeof result.path === "string"
        ? result.path
        : "an artifact";
      setImageGenerationStatus(`Generated ${path} with ${OPENAI_IMAGE_MODEL}.`);
    } catch (error) {
      setImageGenerationError(describeRouteError(error));
    } finally {
      setImageGenerationBusy(false);
    }
  }, [openworkClient, runtimeWorkspaceId, selectedWorkspaceEndpoint, selectedWorkspaceRoot]);

  const saveVoiceApiKey = useCallback(async (apiKey: string) => {
    const resolvedApiKey = apiKey.trim();
    if (!openworkClient || !resolvedApiKey) {
      setVoiceError("OpenAI API key is required.");
      return;
    }
    setVoiceBusy(true);
    setVoiceStatus(null);
    setVoiceError(null);
    try {
      await openworkClient.upsertUserEnv([{ key: "OPENAI_API_KEY", value: resolvedApiKey }]);
      setUserEnvKeys((current) => Array.from(new Set([...current, "OPENAI_API_KEY"])));
      setVoiceStatus("Saved OPENAI_API_KEY for Voice Mode.");
    } catch (error) {
      setVoiceError(describeRouteError(error));
    } finally {
      setVoiceBusy(false);
    }
  }, [openworkClient]);

  const testVoiceSession = useCallback(async () => {
    if (!openworkClient) {
      setVoiceError("OpenWork server is not connected.");
      return;
    }
    setVoiceBusy(true);
    setVoiceStatus(null);
    setVoiceError(null);
    try {
      const session = await openworkClient.createVoiceRealtimeSession();
      setVoiceStatus(`Realtime ready with ${session.model} (${session.tools.length} OpenWork tools).`);
    } catch (error) {
      setVoiceError(describeRouteError(error));
    } finally {
      setVoiceBusy(false);
    }
  }, [openworkClient]);

  const installLocalProvider = useCallback(async (input: LocalProviderInstallInput) => {
    const client = selectedWorkspaceEndpoint?.client ?? openworkClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    const modelId = input.modelId.trim();
    if (!client || !workspaceId) {
      setLocalProviderError("OpenWork server is not connected for this workspace.");
      return;
    }
    if (!modelId) {
      setLocalProviderError("Model ID is required.");
      return;
    }

    setLocalProviderBusy(true);
    setLocalProviderStatus(null);
    setLocalProviderError(null);
    try {
      await client.patchConfig(workspaceId, {
        opencode: {
          provider: {
            [input.providerId]: {
              npm: "@ai-sdk/openai-compatible",
              name: input.name,
              options: { baseURL: input.baseURL },
              models: { [modelId]: { name: input.modelName.trim() || modelId } },
            },
          },
        },
      });
      if (input.setDefault) {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: { providerID: input.providerId, modelID: modelId },
          modelVariant: null,
        }));
      }
      reloadCoordinator.markReloadRequired("config", { type: "config", name: "opencode.json", action: "updated" });
      try {
        await client.reloadEngine(workspaceId);
      } catch {
        // The reload toast still lets the user retry if the immediate reload fails.
      }
      await refreshProviderListQueries(getReactQueryClient());
      try {
        window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
      } catch {
        // ignore browser event dispatch failures
      }
      setLocalProviderStatus(`Added ${input.name} with ${modelId}.`);
    } catch (error) {
      setLocalProviderError(describeRouteError(error));
    } finally {
      setLocalProviderBusy(false);
    }
  }, [local, openworkClient, reloadCoordinator, runtimeWorkspaceId, selectedWorkspaceEndpoint]);

  useEffect(() => {
    local.setUi((previous) => ({ ...previous, view: "settings", tab: route.tab }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- local is stable via context
  }, [route.tab]);

  useEffect(() => {
    setAppThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    writeStoredBoolean(SETTINGS_HIDE_TITLEBAR_KEY, hideTitlebar);
  }, [hideTitlebar]);

  useEffect(() => {
    writeStoredBoolean(SETTINGS_UPDATE_AUTO_CHECK_KEY, updateAutoCheck);
  }, [updateAutoCheck]);

  useEffect(() => {
    writeStoredBoolean(SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY, updateAutoDownload);
  }, [updateAutoDownload]);

  const { markRouteReady: markBootRouteReady } = useBootState();
  const refreshRouteState = useMemo(() => async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    let desktopList: WorkspaceList | null = null;
    let desktopWorkspaces = workspacesRef.current;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await workspaceBootstrap() as WorkspaceList;
          desktopWorkspaces = (desktopList.workspaces ?? []).map(mapDesktopWorkspace);
        } catch (error) {
          const message = describeRouteError(error);
          console.error("[settings-route] workspaceBootstrap failed", error);
          recordInspectorEvent("route.workspace_bootstrap.error", {
            route: "settings",
            message,
            preservedWorkspaceCount: workspacesRef.current.length,
          });
          desktopWorkspaces = workspacesRef.current;
        }
      }
      const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = await resolveOpenworkConnection();

      if (!normalizedBaseUrl || !resolvedToken) {
        setOpenworkClient(null);
        setBaseUrl("");
        setToken("");
        setWorkspaces(desktopWorkspaces);
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        setLegacySelectedWorkspaceId((current) => {
          const next = current || readActiveWorkspaceId() || resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "";
          writeActiveWorkspaceId(next || null);
          return next;
        });
        return;
      }

      const client = createOpenworkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken || undefined,
      });
      const list = await client.listWorkspaces();
      const serverWorkspaceIds = new Set(list.items.map((workspace) => workspace.id));
      const nextWorkspaces = mergeRouteWorkspaces(list.items, desktopWorkspaces);
      const sessionEntries = await Promise.all(
        nextWorkspaces.map(async (workspace) => {
          if (!serverWorkspaceIds.has(workspace.id)) {
            return { workspaceId: workspace.id, sessions: [], error: null as string | null };
          }
          try {
            const response = await client.listSessions(workspace.id, { limit: 200 });
            const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
            const items = workspaceRoot
              ? (response.items ?? []).filter((session) =>
                  normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
                )
              : (response.items ?? []);
            return {
              workspaceId: workspace.id,
              sessions: items,
              error: null as string | null,
              connectionState: null as WorkspaceConnectionState | null,
            };
          } catch (error) {
            const fallback = error instanceof Error ? error.message : t("app.unknown_error");
            if (workspace.workspaceType === "remote") {
              const connectionState = await diagnoseRemoteWorkspaceTaskLoadFailure(workspace, fallback);
              return {
                workspaceId: workspace.id,
                sessions: [],
                error: connectionState.message ?? "Remote worker connection failed.",
                connectionState,
              };
            }
            return {
              workspaceId: workspace.id,
              sessions: [],
              error: fallback,
              connectionState: null,
            };
          }
        }),
      );

      setOpenworkClient(client);
      setBaseUrl(normalizedBaseUrl);
      setToken(resolvedToken);
      setWorkspaces(nextWorkspaces);
      setSessionsByWorkspaceId(Object.fromEntries(sessionEntries.map((entry) => [entry.workspaceId, entry.sessions])));
      setErrorsByWorkspaceId(Object.fromEntries(sessionEntries.map((entry) => [entry.workspaceId, entry.error])));
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        for (const entry of sessionEntries) {
          if (entry.connectionState) {
            next[entry.workspaceId] = entry.connectionState;
          } else if (next[entry.workspaceId]?.status === "error") {
            delete next[entry.workspaceId];
          }
        }
        return next;
      });
      setLegacySelectedWorkspaceId((current) => {
        const sessionWorkspaceId = findSessionWorkspaceId(navigationSessionId, sessionEntries);
        const preferred = routeWorkspaceId || sessionWorkspaceId || navigationWorkspaceId || current || readActiveWorkspaceId() || "";
        const next = reconcileSelectedWorkspaceId(preferred, list, desktopList, nextWorkspaces);
        writeActiveWorkspaceId(next || null);
        return next;
      });
    } catch (error) {
      const message = describeRouteError(error);
      console.error("[settings-route] refreshRouteState failed", error);
      recordInspectorEvent("route.refresh.error", {
        route: "settings",
        message,
        preservedWorkspaceCount: desktopWorkspaces.length,
      });
      // Fires on mount/auto-refresh too, not just user actions.
      notifyAlert({
        kind: "system",
        title: t("notifications.refresh_failed"),
        body: message,
        dedupeKey: "settings-route-refresh",
      });
      if (desktopWorkspaces.length > 0) {
        setWorkspaces(desktopWorkspaces);
        setLegacySelectedWorkspaceId((current) => {
          const next = current || readActiveWorkspaceId() || resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "";
          writeActiveWorkspaceId(next || null);
          return next;
        });
      }
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
      // Settings can be the first route a user lands on (direct link, deep
      // link, or after reload). Let the boot overlay dismiss once we've
      // completed our first data load.
      markBootRouteReady();
    }
  }, [markBootRouteReady, navigationSessionId, navigationWorkspaceId, routeWorkspaceId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    const activeWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setWorkspaceConnectionOverrides((current) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [workspaceId, state] of Object.entries(current)) {
        if (activeWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [workspaces]);

  const handleRemoteWorkspaceConnectionSaved = useCallback(
    async (workspaceId: string) => {
      delete remoteWorkspaceCheckRunRef.current[workspaceId];
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      await refreshRouteState();
    },
    [refreshRouteState],
  );

  const remoteWorkspaceConnectionEditor = useRemoteWorkspaceConnectionEditor({
    workspaces,
    onSaved: handleRemoteWorkspaceConnectionSaved,
  });

  const runRemoteWorkspaceConnectionCheck = useCallback(
    async (workspaceId: string, mode: "test" | "recover") => {
      const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (!workspace || workspace.workspaceType !== "remote") return false;
      const connectionKey = getRemoteWorkspaceConnectionKey(workspace);
      remoteWorkspaceCheckRunCounterRef.current += 1;
      const runId = String(remoteWorkspaceCheckRunCounterRef.current);
      remoteWorkspaceCheckRunRef.current[workspaceId] = runId;

      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: {
          status: "connecting",
          message: t("config.testing_connection"),
          checkedAt: null,
        },
      }));

      const result = await testRemoteWorkspaceConnection(workspace);
      const currentWorkspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (
        remoteWorkspaceCheckRunRef.current[workspaceId] !== runId ||
        !currentWorkspace ||
        getRemoteWorkspaceConnectionKey(currentWorkspace) !== connectionKey
      ) {
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }
      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: result.state,
      }));

      if (!result.ok) {
        setErrorsByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: result.state.message ?? "Remote worker connection failed.",
        }));
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }

      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      if (mode === "recover") {
        await refreshRouteState();
      }
      if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
        delete remoteWorkspaceCheckRunRef.current[workspaceId];
      }
      return true;
    },
    [refreshRouteState],
  );

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    if (loading) return;
    if (openworkClient) {
      reconnectAttemptedWorkspaceIdRef.current = "";
      return;
    }
    if (!selectedWorkspace || selectedWorkspace.workspaceType !== "local") return;
    const workspaceId = selectedWorkspace.id?.trim() ?? "";
    if (!workspaceId || reconnectAttemptedWorkspaceIdRef.current === workspaceId) return;
    reconnectAttemptedWorkspaceIdRef.current = workspaceId;

    void ensureDesktopLocalOpenworkConnection({
      route: "settings",
      workspace: selectedWorkspace,
      allWorkspaces: workspaces,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : describeRouteError(error);
      // Background auto-reconnect: alert + persistent center entry.
      notifyAlert({
        kind: "system",
        title: t("notifications.reconnect_failed"),
        body: message,
        dedupeKey: "server-reconnect",
      });
    });
  }, [loading, openworkClient, selectedWorkspace, workspaces]);

  useEffect(() => {
    void refreshRouteState();
    const handleSettingsChange = () => {
      void refreshRouteState();
    };
    window.addEventListener("openwork-server-settings-changed", handleSettingsChange);
    return () => {
      window.removeEventListener("openwork-server-settings-changed", handleSettingsChange);
    };
  }, [refreshRouteState]);

  // Load auto-compaction state from OpenCode config on workspace change.
  useEffect(() => {
    if (!openworkClient || !selectedWorkspaceId) return;
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId;
    let cancelled = false;
    (async () => {
      try {
        const config = await openworkClient.getConfig(workspaceId);
        if (cancelled) return;
        const compaction = config.opencode?.compaction;
        const auto = compaction && typeof compaction === "object" && "auto" in compaction
          ? (compaction as { auto?: boolean }).auto
          : undefined;
        setAutoCompactContext(auto !== false);
        setAutoCompactContextLoaded(true);
      } catch {
        if (!cancelled) setAutoCompactContextLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [openworkClient, selectedWorkspaceId]);

  const toggleAutoCompactContext = useCallback(async () => {
    if (autoCompactContextBusy) return;
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId;
    if (!openworkClient || !workspaceId) return;
    const next = !autoCompactContext;
    setAutoCompactContext(next);
    setAutoCompactContextBusy(true);
    try {
      await openworkClient.patchConfig(workspaceId, {
        opencode: { compaction: { auto: next } },
      });
      reloadCoordinator.markReloadRequired("config", {
        type: "config",
        name: "opencode.json",
        action: "updated",
      });
    } catch {
      setAutoCompactContext(!next);
    } finally {
      setAutoCompactContextBusy(false);
    }
  }, [autoCompactContext, autoCompactContextBusy, openworkClient, reloadCoordinator, selectedWorkspaceId]);

  useEffect(() => {
    openworkServerStore.start();
    connectionsStore.start();
    providerAuthStore.start();
    extensionsStore.start();

    return () => {
      extensionsStore.dispose();
      providerAuthStore.dispose();
      connectionsStore.dispose();
      openworkServerStore.dispose();
    };
  }, [connectionsStore, extensionsStore, openworkServerStore, providerAuthStore]);

  // Periodically reconcile workspace-imported cloud providers from Den while
  // signed in (dev #1509 "auto-sync cloud providers"). Mounted here because
  // the settings route owns the provider-auth store.
  useCloudProviderAutoSync(providerAuthStore.runCloudProviderSync);

  // Keep the Den cloud MCP configured with a fresh first-party token while
  // signed in: connects on sign-in, re-mints on org switch and before expiry.
  useCloudProviderAutoSync(() => connectionsStore.syncCloudControlMcp());

  useEffect(() => {
    if (route.tab !== "cloud-providers") return;
    void providerAuthStore.runCloudProviderSync("settings_cloud_opened");
  }, [providerAuthStore, route.tab]);

  useEffect(() => {
    openworkServerStore.syncFromOptions();
    connectionsStore.syncFromOptions();
    providerAuthStore.syncFromOptions();
    extensionsStore.syncFromOptions();
  }, [
    activeClient,
    connectionsStore,
    extensionsStore,
    openworkServerStore,
    providerAuthStore,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceRoot,
  ]);

  useEffect(() => {
    if (!activeClient) {
      setProviders([]);
      setProviderDefaults({});
      setProviderConnectedIds([]);
      setDisabledProviders([]);
      return;
    }
    void providerAuthStore.refreshProviders();
    void connectionsStore.refreshMcpServers();
  }, [activeClient, connectionsStore, providerAuthStore, selectedWorkspace?.id]);

  const selectedWorkspaceName = selectedWorkspace?.displayNameResolved ?? t("session.workspace_fallback");
  const workspaceOptions = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.displayNameResolved,
    color: workspaceSwatchColor(workspace.id),
  }));
  const selectedWorkspaceColor = workspaceSwatchColor(selectedWorkspaceId);
  const workspaceType = selectedWorkspace?.workspaceType ?? "local";
  const isRemoteWorkspace = workspaceType === "remote";
  const canWriteWorkspaceSkills =
    !isRemoteWorkspace || openworkServerSnapshot.openworkServerCanWriteSkills;
  const canWriteWorkspacePlugins =
    !isRemoteWorkspace || openworkServerSnapshot.openworkServerCanWritePlugins;
  const skillsAccessHint =
    isRemoteWorkspace && !canWriteWorkspaceSkills ? t("app.skills_hint_readonly") : null;
  const pluginsAccessHint =
    isRemoteWorkspace && !canWriteWorkspacePlugins ? t("app.plugins_hint_readonly") : null;
  const defaultModelLabel = local.prefs.defaultModel
    ? (() => {
        const provider = providers.find((item) => item.id === local.prefs.defaultModel?.providerID);
        const model = provider?.models?.[local.prefs.defaultModel.modelID];
        const providerLabel = provider?.name ?? resolveProviderDisplayName(local.prefs.defaultModel.providerID);
        const modelLabel = model?.name ?? resolveModelDisplayName(local.prefs.defaultModel.modelID);
        return `${providerLabel} - ${modelLabel}`;
      })()
    : t("session.default_model");
  const defaultModelRef = local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}/${local.prefs.defaultModel.modelID}`
    : t("settings.default_label");
  const defaultModelVariantLabel = local.prefs.modelVariant ?? t("settings.default_label");
  const providerStatusLabel = providerConnectedIds.length > 0 ? t("status.connected") : t("status.disconnected_label");
  const providerStatusStyle = providerConnectedIds.length > 0
    ? "bg-green-7/10 text-green-11 border-green-7/20"
    : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  const providerSummary = providerConnectedIds.length > 0
    ? t("status.providers_connected", { count: providerConnectedIds.length })
    : t("settings.no_providers_connected");
  const providerConnectedIdSet = new Set(providerConnectedIds);
  const connectedProviders = providers.flatMap((provider) =>
    providerConnectedIdSet.has(provider.id)
      ? [{
          id: provider.id,
          name: provider.name ?? provider.id,
          source: provider.source,
        }]
      : [],
  );
  const mcpConnectedAppsCount = connectionsSnapshot.mcpServers.length;

  // Build enablement context from all available runtime state.
  const enablementContext = useMemo<EnablementContext>(() => {
    const mcpConfigured = new Set(connectionsSnapshot.mcpServers.map((s) => s.name));
    const connectedProviders = new Set(providerConnectedIds);
    const configuredEnvKeys = new Set(userEnvKeys);
    const loadedPlugins = new Set<string>();
    // Browser plugin detection: check if any configured plugin matches the chrome-devtools name.
    // For now, treat it as loaded if the plugin is in the MCP/plugin list — this will
    // be refined when we add a real plugin-loaded signal from the engine.
    const browserPluginConfigured = connectionsSnapshot.mcpServers.some(
      (s) => s.name === "opencode-chrome-devtools" || s.config.command?.some((c: string) => c.includes("chrome-devtools")),
    );
    if (browserPluginConfigured) loadedPlugins.add("opencode-chrome-devtools");

    return {
      mcpStatuses: connectionsSnapshot.mcpStatuses,
      mcpConfigured,
      loadedPlugins,
      connectedProviders,
      configuredEnvKeys,
      permissions: computerUsePermissions ?? undefined,
      // Toggle state reader for extensions with defaultEnabled / explicit toggle.
      isToggleEnabled: (ref: string) => {
        const catalog = connectionsStore.quickConnect;
        const match = catalog.find((e: { id?: string; serverName?: string }) => (e.id ?? e.serverName) === ref);
        return match ? isOpenWorkExtensionEnabled(match) : false;
      },
    };
  }, [computerUsePermissions, connectionsSnapshot, extensionStateVersion, providerConnectedIds, userEnvKeys]);
  const builtInExtensionsDisabled = checkDesktopRestriction({ restriction: "allowBuiltInExtensions" });
  const restartExtensionLocalServer = useCallback(async () => {
    if (!isDesktopRuntime()) return false;
    try {
      await openworkServerRestart({
        remoteAccessEnabled:
          readOpenworkServerSettings().remoteAccessEnabled === true,
      });
      await openworkServerStore.reconnectOpenworkServer();
      await refreshRouteState();
      return true;
    } catch {
      return false;
    }
  }, [openworkServerStore, refreshRouteState]);
  const extensionController = useSettingsExtensionController({
    openworkServerClient: selectedWorkspaceEndpoint?.client ?? openworkClient,
    hostOpenworkServerClient: openworkClient,
    enablementContext,
    mcpServers: connectionsSnapshot.mcpServers,
    mcpConnectingName: connectionsSnapshot.mcpConnectingName,
    onComputerUsePermissionsChange: setComputerUsePermissions,
    googleWorkspaceConnected,
    setGoogleWorkspaceConnected,
    restartLocalServer: restartExtensionLocalServer,
    connectMcp: async (entry) => {
      await connectionsStore.connectMcp(entry);
    },
    refreshMcpServers: () => connectionsStore.refreshMcpServers(),
    providers,
    providerConnectedIds,
    userEnvKeys,
    imageExtension: {
      busy: imageExtensionBusy || imageGenerationBusy,
      status: imageExtensionStatus ?? imageGenerationStatus,
      error: imageExtensionError ?? imageGenerationError,
      onInstall: installOpenAiImageExtension,
      onTestGenerate: generateOpenAiTestImage,
    },
    voiceExtension: {
      busy: voiceBusy,
      status: voiceStatus,
      error: voiceError,
      onSaveApiKey: saveVoiceApiKey,
      onTestSession: testVoiceSession,
    },
    localProvider: {
      busy: localProviderBusy,
      status: localProviderStatus,
      error: localProviderError,
      onInstall: installLocalProvider,
    },
  });
  const extensionItems = useMemo(
    () => buildExtensionItems({
      quickConnect: connectionsStore.quickConnect,
      mcpServers: connectionsSnapshot.mcpServers,
      installedSkills: extensionsStore.skills(),
      importedCloudPlugins: extensionsStore.importedCloudPlugins(),
      pendingCloudPluginChanges: extensionsStore.pendingCloudPluginChanges(),
      cloudMarketplaces: extensionsStore.cloudOrgMarketplaces(),
      enablementContext,
      isBuiltInConnected: extensionController.isConnected,
    }),
    [connectionsSnapshot.mcpServers, connectionsStore.quickConnect, enablementContext, extensionController, extensionsStore],
  );
  const routeOpenworkStatus = openworkClient ? "connected" : "disconnected";
  const notFoundRouteError = !loading && routeWorkspaceId && !selectedWorkspace
    ? "Workspace was not found. Select a new workspace from the sidebar."
    : null;
  useEffect(() => {
    if (notFoundRouteError) {
      notifyAlert({
        kind: "system",
        title: notFoundRouteError,
        dedupeKey: "workspace-not-found",
      });
    }
  }, [notFoundRouteError]);
  const routeOpenworkCapabilities: OpenworkServerCapabilities | null = openworkClient
    ? ROUTE_OPENWORK_CAPABILITIES
    : null;
  const environmentRuntimeKey = buildOpenworkEnvRuntimeKey({
    baseUrl: openworkServerSnapshot.openworkServerBaseUrl || openworkServerSnapshot.openworkServerUrl,
    pid: openworkServerSnapshot.openworkServerHostInfo?.pid ?? null,
    port: openworkServerSnapshot.openworkServerHostInfo?.port ?? null,
  });

  const handleApplyEnvironmentChanges = async () => {
    if (!isDesktopRuntime()) {
      throw new Error(t("settings.environment.apply_unavailable"));
    }
    if (activeReloadBlockingSessions.length > 0) {
      throw new Error(t("settings.environment.apply_blocked_active_tasks"));
    }
    if (!selectedWorkspaceRoot) {
      throw new Error(t("settings.environment.apply_no_local_workspace"));
    }
    const workspacePaths = Array.from(
      new Set(
        workspaces.flatMap((workspace) => {
          const path = workspace.workspaceType !== "remote" ? workspace.path?.trim() ?? "" : "";
          return path ? [path] : [];
        }),
      ),
    );
    const workspacePathSet = new Set(workspacePaths);
    if (!workspacePathSet.has(selectedWorkspaceRoot)) {
      workspacePaths.unshift(selectedWorkspaceRoot);
    }
    await engineStart(selectedWorkspaceRoot, {
      preferSidecar: true,
      runtime: "direct",
      workspacePaths,
      openworkRemoteAccess: openworkServerSnapshot.openworkServerSettings.remoteAccessEnabled === true,
    });
    const reconnected = await openworkServerStore.reconnectOpenworkServer();
    if (!reconnected) {
      await refreshRouteState().catch(() => {});
      return { statusMessage: t("settings.environment.apply_refresh_failed") };
    }
    await refreshRouteState();
  };

  const handleOpenCreateWorkspace = () => {
    if (
      workspaces.length > 0 &&
      checkDesktopRestriction({ restriction: "allowMultipleWorkspaces" })
    ) {
      restrictionNotice.show({
        title: "Additional workspaces are restricted",
        message:
          "Your organization administrator has restricted access to adding additional workspaces.",
      });
      return;
    }

    setCreateWorkspaceError(null);
    setCreateWorkspaceRemoteError(null);
    setCreateWorkspaceOpen(true);
  };

  const handleSelectSettingsWorkspace = useCallback((workspaceId: string) => {
    setLegacySelectedWorkspaceId(workspaceId);
    writeActiveWorkspaceId(workspaceId);
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
    const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl, token });
    if (endpoint) {
      void endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true }).catch(() => undefined);
    }
    if (isDesktopRuntime()) {
      void workspaceSetSelected(workspaceId).catch(() => undefined);
      void workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
    }
    navigate(workspaceSettingsRoute(workspaceId, settingsPathForRoute(route)), { state: location.state });
  }, [baseUrl, location, navigate, route, token, workspaces]);

  const handleOpenRenameWorkspace = useCallback((workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceTitle(workspaceLabel(workspace));
  }, [workspaces]);

  const handleSaveRenameWorkspace = useCallback(async () => {
    if (!renameWorkspaceId) return;
    const trimmed = renameWorkspaceTitle.trim();
    if (!trimmed) return;
    setRenameWorkspaceBusy(true);
    try {
      if (!openworkClient) {
        toast.error("OpenWork server is unavailable. Reconnect the server before renaming workspaces.");
        return;
      }
      await openworkClient.updateWorkspaceDisplayName(renameWorkspaceId, trimmed);
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
    } catch (error) {
      toast.error("Workspace rename failed", {
        description: describeRouteError(error),
      });
    } finally {
      setRenameWorkspaceBusy(false);
    }
  }, [openworkClient, refreshRouteState, renameWorkspaceId, renameWorkspaceTitle]);

  const handleRevealWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const path = workspace?.path?.trim();
    if (!path || !isDesktopRuntime()) return;
    await revealDesktopItemInDir(path).catch(() => undefined);
  }, [workspaces]);

  const handleExportWorkspaceConfig = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl, token });
    if (endpoint) {
      setExportWorkspaceBusy(true);
      try {
        const payload = await endpoint.client.exportWorkspace(endpoint.workspaceId);
        downloadWorkspaceJson(workspaceExportFilename(workspace), payload);
      } finally {
        setExportWorkspaceBusy(false);
      }
      return;
    }
    throw new Error("OpenWork server is unavailable. Reconnect the server before exporting workspace config.");
  }, [baseUrl, token, workspaces]);

  const handleForgetWorkspace = useCallback(async (workspaceId: string) => {
    if (typeof window !== "undefined") {
      const message = t("workspace_list.remove_confirm") || "Remove this workspace from the sidebar?";
      if (!window.confirm(message)) return;
    }
    if (openworkClient) {
      await openworkClient.deleteWorkspace(workspaceId).catch(() => undefined);
    }
    if (isDesktopRuntime()) {
      await workspaceForget(workspaceId).catch(() => undefined);
    }
    if (selectedWorkspaceId === workspaceId) {
      const nextWorkspace = workspaces.find((workspace) => workspace.id !== workspaceId);
      const nextId = nextWorkspace?.id ?? "";
      setLegacySelectedWorkspaceId(nextId);
      if (nextId) {
        await workspaceSetSelected(nextId).catch(() => undefined);
      }
    }
    await refreshRouteState();
  }, [openworkClient, refreshRouteState, selectedWorkspaceId, workspaces]);

  const handleCreateWorkspace = async (preset: WorkspacePreset, folder: string | null) => {
    if (!folder) return;
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const workspaceName = folderNameFromPath(folder);
      let list: WorkspaceList | null = null;
      if (openworkClient) {
        list = await openworkClient
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .catch(() => null);
      }
      if (!list) {
        throw new Error("OpenWork server is unavailable. Start or reconnect the server before creating a workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      await refreshRouteState();
    } catch (error) {
      setCreateWorkspaceError(describeWorkspaceCreateError(error));
    } finally {
      setCreateWorkspaceBusy(false);
    }
  };

  const handleCreateRemoteWorkspace = async (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => {
    const baseUrlValue = input.openworkHostUrl?.trim() ?? "";
    if (!baseUrlValue) return false;
    setCreateWorkspaceRemoteBusy(true);
    setCreateWorkspaceRemoteError(null);
    try {
      const remoteType: "openwork" = "openwork";
      const payload = {
        baseUrl: baseUrlValue,
        openworkHostUrl: baseUrlValue,
        openworkToken: input.openworkToken?.trim() || null,
        displayName: input.displayName?.trim() || null,
        directory: input.directory?.trim() || null,
        remoteType,
      };
      let list: WorkspaceList | null = null;
      if (openworkClient) {
        list = await openworkClient.createRemoteWorkspace(payload).catch(() => null);
      }
      if (!list) {
        throw new Error("OpenWork server is unavailable. Start or reconnect the server before connecting a remote workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      await refreshRouteState();
      return true;
    } catch (error) {
      setCreateWorkspaceRemoteError(error instanceof Error ? error.message : t("app.unknown_error"));
      return false;
    } finally {
      setCreateWorkspaceRemoteBusy(false);
    }
  };

  const handleReconnectMessagingServer = useCallback(async () => {
    const ok = await openworkServerStore.reconnectOpenworkServer();
    if (ok) {
      await refreshRouteState();
    }
    return ok;
  }, [openworkServerStore, refreshRouteState]);

  const restartOpenworkServerAndRefresh = useCallback(async () => {
    if (!isDesktopRuntime()) return false;
    try {
      await openworkServerRestart({
        remoteAccessEnabled:
          readOpenworkServerSettings().remoteAccessEnabled === true,
      });
      await openworkServerStore.reconnectOpenworkServer();
      await refreshRouteState();
      return true;
    } catch {
      return false;
    }
  }, [openworkServerStore, refreshRouteState]);

  const handleRestartLocalServer = restartOpenworkServerAndRefresh;
  const handleRestartMessagingWorker = restartOpenworkServerAndRefresh;

  const messagingViewProps = useMessagingViewProps({
    busy,
    openworkServerStatus: openworkServerSnapshot.openworkServerStatus,
    openworkServerUrl: openworkServerSnapshot.openworkServerUrl,
    openworkServerClient:
      openworkClient ?? openworkServerSnapshot.openworkServerClient,
    openworkReconnectBusy: openworkServerSnapshot.openworkReconnectBusy,
    reconnectOpenworkServer: handleReconnectMessagingServer,
    restartMessagingWorker: handleRestartMessagingWorker,
    workspaceId: runtimeWorkspaceId,
    selectedWorkspaceRoot,
  });

  if (route.redirectPath && !props.embedded) {
    const target = selectedWorkspaceId
      ? workspaceSettingsRoute(selectedWorkspaceId, route.redirectPath)
      : `/settings/${route.redirectPath}`;
    return <Navigate to={target} replace state={location.state} />;
  }

  if (!props.embedded && !routeWorkspaceId && selectedWorkspaceId) {
    return <Navigate to={workspaceSettingsRoute(selectedWorkspaceId, settingsPathForRoute(route))} replace state={location.state} />;
  }

  const openCloudAccountSettings = () => {
    navigateSettingsPath("cloud-account");
  };

  const settingsView = (() => {
    switch (route.tab) {
      case "general":
        return (
          <GeneralSettingsView
            onNavigateTab={(tab) => navigateSettingsPath(tab)}
            developerMode={developerMode}
            onSendFeedback={() => platform.openLink(buildFeedbackUrl({ entrypoint: "settings" }))}
            onJoinDiscord={() => platform.openLink("https://discord.gg/VEhNQXxYMB")}
            onReportIssue={() => platform.openLink("https://github.com/different-ai/openwork/issues/new?template=bug.yml")}
          />
        );
      case "permissions":
        return (
          <SettingsStack>
            <AuthorizedFoldersPanel
              openworkServerClient={openworkClient}
              openworkServerStatus={routeOpenworkStatus}
              openworkServerCapabilities={routeOpenworkCapabilities}
              runtimeWorkspaceId={runtimeWorkspaceId}
              selectedWorkspaceRoot={selectedWorkspaceRoot}
              activeWorkspaceType={workspaceType}
              onConfigUpdated={() => {
                setConfigActionStatus(t("settings.config_updated"));
                void providerAuthStore.refreshProviders();
                void connectionsStore.refreshMcpServers();
              }}
            />
          </SettingsStack>
        );
      case "ai":
        return (
          <AiSettingsView
            busy={busy}
            providerAuthBusy={providerAuthSnapshot.providerAuthBusy}
            providerStatusLabel={providerStatusLabel}
            providerStatusStyle={providerStatusStyle}
            providerSummary={providerSummary}
            connectedProviders={connectedProviders}
            disconnectingProviderId={null}
            providerConnectError={providerAuthSnapshot.providerAuthError}
            providerDisconnectStatus={configActionStatus}
            providerDisconnectError={null}
            onOpenProviderAuth={handleOpenProviderAuth}
            onDisconnectProvider={async (providerId) => {
              await providerAuthStore.disconnectProvider(providerId);
            }}
            canDisconnectProvider={(source) => source !== "env"}
            cloudProviderIds={new Set(
              Object.values(providerAuthSnapshot.importedCloudProviders ?? {}).map((p) => p.providerId)
            )}
            showOpenWorkModelsSubscribe={showOpenWorkModelsSubscribe}
            showOpenWorkModelsConnect={showOpenWorkModelsConnect}
            onSubscribeOpenWorkModels={subscribeToOpenWorkModels}
            onDismissOpenWorkModels={dismissOpenWorkModelsPromo}
            cloudProvidersView={
              <CloudProvidersView
                embedded
                cloudOrgProviders={providerAuthSnapshot.cloudOrgProviders}
                connectCloudProvider={providerAuthStore.connectCloudProvider}
                importedCloudProviders={providerAuthSnapshot.importedCloudProviders}
                onOpenAccount={openCloudAccountSettings}
                refreshCloudOrgProviders={providerAuthStore.refreshCloudOrgProviders}
                removeCloudProvider={providerAuthStore.removeCloudProvider}
                session={denSession}
              />
            }
          />
        );
      case "preferences":
        return (
          <PreferencesView
            busy={busy}
            showThinking={local.prefs.showThinking}
            onToggleShowThinking={() => {
              local.setPrefs((previous) => ({ ...previous, showThinking: !previous.showThinking }));
            }}
            autoCompactContext={autoCompactContext}
            autoCompactContextBusy={autoCompactContextBusy}
            onToggleAutoCompactContext={toggleAutoCompactContext}
            analyticsEnabled={local.prefs.analyticsEnabled}
            onToggleAnalytics={() => {
              local.setPrefs((previous) => ({ ...previous, analyticsEnabled: !previous.analyticsEnabled }));
            }}
          />
        );
      case "shell":
        return <ShellCustomizationView />;
      case "skills":
        return (
          <SkillsView
            workspaceName={selectedWorkspaceName}
            busy={busy}
            canInstallSkillCreator={canWriteWorkspaceSkills}
            canUseDesktopTools={!isRemoteWorkspace}
            accessHint={skillsAccessHint}
            extensions={extensionsStore}
            onOpenLink={(url) => platform.openLink(url)}
            createSessionAndOpen={async (_command?: string): Promise<string | undefined> => {
              props.onClose?.();
              navigate(selectedWorkspaceId ? workspaceSessionRoute(selectedWorkspaceId) : "/session");
              return undefined;
            }}
          />
        );
      case "extensions":
        return (
          <ExtensionsView
            busy={busy}
            selectedWorkspaceRoot={selectedWorkspaceRoot}
            isRemoteWorkspace={isRemoteWorkspace}
            canEditPlugins={canWriteWorkspacePlugins}
            canUseGlobalScope={!isRemoteWorkspace}
            accessHint={pluginsAccessHint}
            suggestedPlugins={SUGGESTED_PLUGINS}
            extensions={extensionsStore}
            mcpConnectedAppsCount={mcpConnectedAppsCount}
            initialSection={route.extensionsSection}
            setSectionRoute={(section) => {
              const path = `extensions/${section}`;
              navigateSettingsPath(path);
            }}
            onRefresh={() => {
              void connectionsStore.refreshMcpServers();
              void extensionsStore.refreshPlugins();
              void extensionsStore.refreshCloudOrgMarketplaces({ force: true });
            }}
            mcpView={
              <McpView
                busy={busy}
                selectedWorkspaceRoot={selectedWorkspaceRoot}
                isRemoteWorkspace={isRemoteWorkspace}
                mcpServers={connectionsSnapshot.mcpServers}
                mcpStatus={connectionsSnapshot.mcpStatus}
                mcpLastUpdatedAt={connectionsSnapshot.mcpLastUpdatedAt}
                mcpStatuses={connectionsSnapshot.mcpStatuses}
                mcpConnectingName={connectionsSnapshot.mcpConnectingName}
                selectedMcp={connectionsSnapshot.selectedMcp}
                setSelectedMcp={(name) => connectionsStore.setSelectedMcp(name)}
                quickConnect={extensionItems.quickConnectEntries}
                enablementContext={enablementContext}
                builtInExtensionsDisabled={builtInExtensionsDisabled}
                connectMcp={(entry) => {
                  void connectionsStore.connectMcp(entry);
                }}
                configSlotForEntry={extensionController.configSlotForEntry}
                isExtensionConnected={extensionController.isConnected}
                authorizeMcp={(entry) => {
                  void connectionsStore.authorizeMcp(entry);
                }}
                logoutMcpAuth={(name) => connectionsStore.logoutMcpAuth(name)}
                removeMcp={(name) => {
                  void connectionsStore.removeMcp(name);
                }}
                setMcpEnabled={
                  routeOpenworkStatus === "connected" && routeOpenworkCapabilities?.mcp?.write
                    ? (name, enabled) => connectionsStore.setMcpEnabled(name, enabled)
                    : undefined
                }
                readConfigFile={(scope) => connectionsStore.readMcpConfigFile(scope)}
                installedSkills={extensionItems.installedSkills}
                installedPlugins={extensionItems.installedCloudPlugins}
                uninstallSkill={(name) => { void extensionsStore.uninstallSkill(name); }}
                removeCloudPlugin={(pluginId) => { void extensionsStore.removeCloudOrgPlugin(pluginId); }}
                readSkill={(name) => extensionsStore.readSkill(name)}
                previewClaudePlugin={(url) => extensionsStore.previewClaudePlugin(url)}
                installClaudePlugin={(url) => extensionsStore.installClaudePlugin(url)}
                showHeader={false}
              />
            }

            cloudMarketplaceView={
              <CloudMarketplacesView
                embedded
                extensions={extensionsStore}
                session={denSession}
                onOpenAccount={openCloudAccountSettings}
                enablementContext={enablementContext}
                builtInExtensionsDisabled={builtInExtensionsDisabled}
                builtInConnectingName={connectionsSnapshot.mcpConnectingName}
                builtInEntries={extensionItems.builtInItems.flatMap((item) => item.builtInEntry ? [item.builtInEntry] : [])}
                configSlotForBuiltIn={extensionController.configSlotForEntry}
                isBuiltInConnected={extensionController.isConnected}
                extensionItems={extensionItems.items}
                setBuiltInEnabled={setOpenWorkExtensionEnabled}
              />
            }
          />
        );
      case "cloud-account":
        return (
          <CloudAccountView
            developerMode={developerMode}
            session={denSession}
          />
        );
      case "cloud-marketplaces":
        return (
          <CloudMarketplacesView
            extensions={extensionsStore}
            session={denSession}
            onOpenAccount={openCloudAccountSettings}
            enablementContext={enablementContext}
            builtInExtensionsDisabled={builtInExtensionsDisabled}
            builtInConnectingName={connectionsSnapshot.mcpConnectingName}
            builtInEntries={extensionItems.builtInItems.flatMap((item) => item.builtInEntry ? [item.builtInEntry] : [])}
            configSlotForBuiltIn={extensionController.configSlotForEntry}
            isBuiltInConnected={extensionController.isConnected}
            extensionItems={extensionItems.items}
            setBuiltInEnabled={setOpenWorkExtensionEnabled}
          />
        );
      case "cloud-workers":
        return (
          <CloudWorkersView
            connectRemoteWorkspace={async () => false}
            onOpenAccount={openCloudAccountSettings}
          />
        );
      case "cloud-providers":
        return (
          <CloudProvidersView
            cloudOrgProviders={providerAuthSnapshot.cloudOrgProviders}
            connectCloudProvider={providerAuthStore.connectCloudProvider}
            importedCloudProviders={providerAuthSnapshot.importedCloudProviders}
            onOpenAccount={openCloudAccountSettings}
            refreshCloudOrgProviders={providerAuthStore.refreshCloudOrgProviders}
            removeCloudProvider={providerAuthStore.removeCloudProvider}
            session={denSession}
          />
        );
      case "advanced":
        return (
          <AdvancedView
            busy={busy}
            clientConnected={Boolean(opencodeClient)}
            opencodeConnectStatus={null}
            openworkServerStatus={openworkServerSnapshot.openworkServerStatus}
            developerMode={developerMode}
            toggleDeveloperMode={() => setDeveloperMode((current) => {
              const next = !current;
              try { window.localStorage.setItem("openwork.developerMode", next ? "1" : "0"); } catch {}
              return next;
            })}
            opencodeDevModeEnabled={false}
            openDebugDeepLink={async () => ({ ok: false, message: "Debug deep links are not wired into the React settings route yet." })}
            canMigrateRuntimeConfig={Boolean(openworkClient && selectedWorkspaceId)}
            migrateRuntimeConfig={async () => {
              if (!openworkClient || !selectedWorkspaceId) {
                throw new Error("Select a workspace before migrating legacy runtime config.");
              }
              const result = await openworkClient.migrateRuntimeConfig(selectedWorkspaceId);
              if (result.migrated) {
                void connectionsStore.refreshMcpServers();
                void extensionsStore.refreshPlugins();
              }
              return { migrated: result.migrated, keys: result.keys };
            }}
            getRuntimeConfigStatus={async () => {
              if (!openworkClient || !selectedWorkspaceId) {
                throw new Error("Select a workspace to inspect runtime config.");
              }
              return openworkClient.getRuntimeConfigStatus(selectedWorkspaceId);
            }}
          />
        );
      case "appearance":
        return (
          <AppearanceView
            busy={busy}
            themeMode={themeMode}
            setThemeMode={setThemeModeState}
            language={currentLocale() as Language}
            setLanguage={setLocale}
            hideTitlebar={hideTitlebar}
            toggleHideTitlebar={() => setHideTitlebar((current) => !current)}
          />
        );
      case "updates":
        return (
          <UpdatesView
            busy={busy}
            webDeployment={platform.platform === "web"}
            appVersion={electronUpdaterState.appVersion}
            updateEnv={electronUpdaterState.updateEnv}
            updateAutoCheck={updateAutoCheck}
            toggleUpdateAutoCheck={() => setUpdateAutoCheck((current) => !current)}
            updateAutoDownload={updateAutoDownload}
            toggleUpdateAutoDownload={() => setUpdateAutoDownload((current) => !current)}
            updateStatus={electronUpdaterState.updateStatus}
            anyActiveRuns={activeReloadBlockingSessions.length > 0}
            checkForUpdates={electronUpdaterState.checkForUpdates}
            downloadUpdate={electronUpdaterState.downloadUpdate}
            installUpdateAndRestart={electronUpdaterState.installUpdateAndRestart}
            releaseChannel={local.prefs.releaseChannel ?? "stable"}
            onReleaseChannelChange={electronUpdaterState.setReleaseChannel}
            alphaChannelSupported={isElectronRuntime() && isMacPlatform()}
          />
        );
      case "recovery":
        return (
          <RecoveryView
            anyActiveRuns={false}
            workspaceConfigPath={selectedWorkspaceRoot ? `${selectedWorkspaceRoot}/.opencode/openwork.json` : ""}
            resetConfigBusy={resetConfigBusy}
            onResetAppConfigDefaults={() => {}}
            configActionStatus={configActionStatus}
            cacheRepairBusy={false}
            cacheRepairResult={null}
            onRepairOpencodeCache={() => {}}
            dockerCleanupBusy={false}
            dockerCleanupResult={null}
            onCleanupOpenworkDockerContainers={() => {}}
          />
        );
      case "environment":
        return (
          <EnvironmentView
            client={openworkServerSnapshot.openworkServerClient}
            isRemoteWorkspace={isRemoteWorkspace}
            onApplyChanges={isDesktopRuntime() && !isRemoteWorkspace ? handleApplyEnvironmentChanges : undefined}
            applyBlocked={activeReloadBlockingSessions.length > 0}
            applyBlockedReason={
              activeReloadBlockingSessions.length > 0
                ? t("settings.environment.apply_blocked_active_tasks")
                : null
            }
            runtimeKey={environmentRuntimeKey}
          />
        );
      case "debug":
        return <DebugView {...debugViewProps} />;
      default:
        return null;
    }
  })();

  return (
    <>
      <SettingsShell
        activeTab={route.tab}
        onSelectTab={(tab) => navigateSettingsPath(tab)}
        developerMode={developerMode}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedWorkspaceName={selectedWorkspaceName}
        selectedWorkspaceColor={selectedWorkspaceColor}
        workspaces={workspaceOptions}
        onSelectWorkspace={handleSelectSettingsWorkspace}
        headerStatus={routeOpenworkStatus}
        busyHint={loading ? t("session.loading_detail") : busyLabel}
        onClose={props.onClose ?? (() => navigate(selectedWorkspaceId ? workspaceSessionRoute(selectedWorkspaceId) : "/session"))}
        compact={props.embedded}
      >
        {settingsView}
      </SettingsShell>

      <ProviderAuthModal
        open={providerAuthSnapshot.providerAuthModalOpen}
        loading={false}
        submitting={providerAuthSnapshot.providerAuthBusy}
        error={providerAuthSnapshot.providerAuthError}
        preferredProviderId={providerAuthSnapshot.providerAuthPreferredProviderId}
        workerType={providerAuthSnapshot.providerAuthWorkerType}
        // Hide any provider the org blocks at the desktop layer so users
        // can't connect a forbidden one (dev #1505). Same helper covers
        // opencode-provider gating via the `allowZenModel` restriction.
        // We also strip the matching key from `authMethods` because the
        // modal builds its entry list from `Object.keys(authMethods)`,
        // not from `providers`.
        providers={providerAuthSnapshot.providerAuthProviders.filter(
          (provider) =>
            !isDesktopProviderBlocked({
              providerId: provider.id,
              checkRestriction: checkDesktopRestriction,
            }),
        )}
        connectedProviderIds={providerConnectedIds}
        authMethods={Object.fromEntries(
          Object.entries(providerAuthSnapshot.providerAuthMethods).filter(
            ([providerId]) =>
              !isDesktopProviderBlocked({
                providerId,
                checkRestriction: checkDesktopRestriction,
              }),
          ),
        )}
        onSelect={providerAuthStore.startProviderAuth}
        onSubmitApiKey={providerAuthStore.submitProviderApiKey}
        onConnectCloudProvider={providerAuthStore.connectCloudProvider}
        onSubmitOAuth={providerAuthStore.completeProviderAuthOAuth}
        onRefreshProviders={providerAuthStore.refreshProviders}
        showOpenWorkModelsSubscribe={showOpenWorkModelsSubscribe}
        onSubscribeOpenWorkModels={subscribeToOpenWorkModels}
        onClose={() => providerAuthStore.closeProviderAuthModal()}
      />
      <CreateWorkspaceModal
        open={createWorkspaceOpen}
        onClose={() => {
          setCreateWorkspaceOpen(false);
          setCreateWorkspaceError(null);
        }}
        onConfirm={handleCreateWorkspace}
        onConfirmRemote={handleCreateRemoteWorkspace}
        onPickFolder={() => pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<string | null>}
        submitting={createWorkspaceBusy}
        localError={createWorkspaceError}
        remoteSubmitting={createWorkspaceRemoteBusy}
        remoteError={createWorkspaceRemoteError}
      />
      <RenameWorkspaceModal
        open={renameWorkspaceId !== null}
        title={renameWorkspaceTitle}
        busy={renameWorkspaceBusy}
        canSave={!renameWorkspaceBusy && renameWorkspaceTitle.trim().length > 0}
        onClose={() => {
          if (renameWorkspaceBusy) return;
          setRenameWorkspaceId(null);
          setRenameWorkspaceTitle("");
        }}
        onSave={() => void handleSaveRenameWorkspace()}
        onTitleChange={setRenameWorkspaceTitle}
      />
      {shareWorkspaceState.shareWorkspaceOpen ? (
        <ShareWorkspaceModal
          open
          onClose={shareWorkspaceState.closeShareWorkspace}
          workspaceName={shareWorkspaceState.shareWorkspaceName}
          workspaceDetail={shareWorkspaceState.shareWorkspaceDetail}
          fields={shareWorkspaceState.shareFields}
          note={shareWorkspaceState.shareNote}
          onExportConfig={
            shareWorkspaceState.exportDisabledReason === null
              ? () => {
                  const id = shareWorkspaceState.shareWorkspaceId;
                  if (!id) return;
                  void handleExportWorkspaceConfig(id);
                }
              : undefined
          }
          exportDisabledReason={shareWorkspaceState.exportDisabledReason}
        />
      ) : null}
      <CreateRemoteWorkspaceModal
        open={remoteWorkspaceConnectionEditor.workspace !== null}
        onClose={remoteWorkspaceConnectionEditor.close}
        onConfirm={(input) => void remoteWorkspaceConnectionEditor.save(input)}
        initialValues={remoteWorkspaceConnectionEditor.initialValues}
        submitting={remoteWorkspaceConnectionEditor.busy}
        error={remoteWorkspaceConnectionEditor.error}
        title={t("dashboard.edit_remote_workspace_title")}
        subtitle={t("dashboard.edit_remote_workspace_subtitle")}
        confirmLabel={t("dashboard.edit_remote_workspace_confirm")}
      />
      <ConnectionsModals
        client={activeClient}
        projectDir={selectedWorkspaceRoot}
        reloadBlocked={activeReloadBlockingSessions.length > 0}
        activeSessions={activeReloadBlockingSessions}
        isRemoteWorkspace={selectedWorkspace?.workspaceType === "remote"}
        onForceStopSession={async (sessionId) => {
          if (!activeClient) return;
          await abortSessionSafe(activeClient, sessionId);
        }}
        onReloadEngine={reloadCoordinator.reloadWorkspaceEngine}
        modalState={{
          mcpAuthModalOpen: connectionsSnapshot.mcpAuthModalOpen,
          mcpAuthEntry: connectionsSnapshot.mcpAuthEntry,
          mcpAuthNeedsReload: connectionsSnapshot.mcpAuthNeedsReload,
        }}
        onCloseMcpAuthModal={() => connectionsStore.closeMcpAuthModal()}
        onCompleteMcpAuthModal={() => connectionsStore.completeMcpAuthModal()}
      />
      <ModelPickerModal
        open={modelPicker.open}
        options={modelPicker.options}
        query={modelPicker.query}
        setQuery={modelPicker.setQuery}
        target="default"
        current={
          local.prefs.defaultModel ?? { providerID: "", modelID: "" }
        }
        onSelect={(next: ModelRef) => {
          local.setPrefs((prev) => ({
            ...prev,
            defaultModel: next,
            modelVariant: prev.defaultModel?.providerID === next.providerID && prev.defaultModel.modelID === next.modelID
              ? prev.modelVariant
              : null,
          }));
          modelPicker.setOpen(false);
        }}
        onBehaviorChange={() => {}}
        onOpenSettings={() => {}}
        onClose={() => modelPicker.setOpen(false)}
      />
    </>
  );
}

export function SettingsRoute() {
  return <SettingsSurface />;
}

export function SettingsSurface(props: SettingsSurfaceProps) {
  return (
    <CloudSessionProvider>
      <SettingsRouteContent {...props} />
    </CloudSessionProvider>
  );
}
