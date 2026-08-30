/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "@/components/ui/sonner";

import {
  SUGGESTED_PLUGINS,
  filterOpenWorkExtensionCatalogForPlatform,
  resolveOpenWorkExtensionCatalogPlatform,
} from "@/app/constants";
import type { EnablementContext } from "@/app/enablement";
import { createClient, unwrap } from "@/app/lib/opencode";
import {
  createOpenworkServerClient,
  isLoopbackOpenworkServerUrl,
  readOpenworkServerSettings,
  type OpenworkCloudMcpHealth,
  type OpenworkCloudMcpProviderModelContext,
  type OpenworkServerCapabilities,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "@/app/lib/openwork-server";
import { buildOpenworkEnvRuntimeKey } from "@/app/lib/openwork-env-runtime";
import {
  collectAgentContextDiagnosticObservations,
  isAgentContextDiagnosticsWorkspaceAllowed,
  resolveOrganizationConnectionsProbe,
} from "@/app/lib/agent-context-diagnostics";
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
  WorkspaceSessionGroup,
} from "@/app/types";
import { getWorkspaceTaskLoadErrorDisplay } from "@/app/utils";
import { currentLocale, t, setLocale, type Language } from "@/i18n";
import { useModelPicker } from "@/react-app/domains/session/modals/use-model-picker";
import {
  type RouteWorkspace,
  type RouteSession,
  describeRouteError,
  downloadWorkspaceJson,
  getSessionStatus,
  isActiveSessionStatus,
  listRouteSessions,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  readRouteSessionsWithRetry,
  toSessionGroups,
  workspaceExportFilename,
  workspaceLabel,
} from "@/react-app/shell/route-workspaces";
import {
  commitRouteWorkspaceSelection,
  createRouteRefreshLifecycle,
  mapRouteWorkspaceLoads,
  routeWorkspaceSelectionCommitter,
} from "@/react-app/shell/route-refresh-control";
import { createConnectionsStore, useConnectionsStoreSnapshot } from "@/react-app/domains/connections/store";
import { cleanupOpenworkCloudMcpAfterSignOut } from "@/react-app/domains/connections/cloud-mcp-reconciler";
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections";
import { createOpenworkServerStore, useOpenworkServerStoreSnapshot } from "@/react-app/domains/connections/openwork-server-store";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "@/react-app/domains/connections/provider-auth/store";
import ProviderAuthModal from "@/react-app/domains/connections/provider-auth/provider-auth-modal";
import ConnectionsModals from "@/react-app/domains/connections/modals";
import { AiSettingsView } from "@/react-app/domains/settings/pages/ai-view";
// Side-effect imports: register extension config components into the registry.
import "@/react-app/domains/settings/ollama-config";
import "@/react-app/domains/settings/computer-use-config";
import "@/react-app/domains/settings/browser-extension-config";
import "@/react-app/domains/settings/openwork-voice-config";
import { useSettingsExtensionController } from "@/react-app/domains/settings/settings-extension-controller";
import { buildExtensionItems } from "@/react-app/domains/settings/extension-items";
import { isOpenWorkExtensionEnabled, OPENWORK_EXTENSION_STATE_CHANGED } from "@/react-app/domains/settings/extension-state";
import { PreferencesView } from "@/react-app/domains/settings/pages/preferences-view";
import { GeneralSettingsView } from "@/react-app/domains/settings/pages/general-view";
import { AuthorizedFoldersPanel } from "@/react-app/domains/settings/panels/authorized-folders-panel";
import { SettingsStack } from "@/react-app/domains/settings/settings-section";
import { AdvancedView } from "@/react-app/domains/settings/pages/advanced-view";
import { AppearanceView } from "@/react-app/domains/settings/pages/appearance-view";
import { CloudAccountView } from "@/react-app/domains/settings/pages/cloud-account-view";
import {
  connectPluginsForComposer,
  EMPTY_CONNECT_CAPABILITY_INVENTORY,
  type ConnectCapabilityInventory,
} from "@/react-app/domains/session/surface/connect-capability-inventory";
import {
  loadConnectCapabilities,
  readCachedConnectCapabilities,
} from "@/react-app/domains/connections/cloud-inventory-cache";
import { createOpaqueDiagnosticsScopeKey } from "@/react-app/domains/settings/pages/agent-context-diagnostics-section";
import { CloudProvidersView } from "@/react-app/domains/settings/pages/cloud-providers-view";
import { MemoryView } from "@/react-app/domains/settings/pages/memory-view";
import { useFeatureFlagsPreferences } from "@/react-app/domains/settings/state/feature-flags-preferences";
import { DebugView } from "@/react-app/domains/settings/pages/debug-view";
import { EnvironmentView } from "@/react-app/domains/settings/pages/environment-view";
import { ExtensionsView, type ExtensionsSection } from "@/react-app/domains/settings/pages/extensions-view";
import { McpView } from "@/react-app/domains/settings/pages/mcp-view";
import { RecoveryView } from "@/react-app/domains/settings/pages/recovery-view";
import { UpdatesView } from "@/react-app/domains/settings/pages/updates-view";
import { useDebugViewModel } from "@/react-app/domains/settings/state/debug-view-model";
import { useElectronUpdaterState } from "@/react-app/domains/settings/state/electron-updater-state";
import { CloudSessionProvider, useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { useDenSession } from "@/react-app/domains/settings/cloud/use-den-session";
import { useControlAction, type OpenworkControlAction } from "./control/control-provider";
import { useBootState } from "./boot-state";
import { SettingsShell } from "@/react-app/domains/settings/shell/settings-shell";
import { SettingsContent } from "@/react-app/domains/settings/shell/panel";
import { createExtensionsStore, useExtensionsStoreSnapshot } from "@/react-app/domains/settings/state/extensions-store";
import { usePlatform } from "@/react-app/kernel/platform";
import { useLocal } from "@/react-app/kernel/local-provider";
import {
  openworkServerInfo,
  openworkServerRestart,
  engineStart,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  desktopBridge,
  readDesktopDistributionInfo,
  type WorkspaceInfo,
  type WorkspaceList,
  revealDesktopItemInDir,
} from "@/app/lib/desktop";
import { isDesktopProviderBlocked } from "@/app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction, useDesktopConfig } from "@/react-app/domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "@/react-app/domains/cloud/restriction-notice-provider";
import { useCloudProviderAutoSync } from "@/react-app/domains/cloud/use-cloud-provider-auto-sync";
import {
  hasOpenWorkModelsAvailable,
  hideOpenWorkModelsPromo,
  useOpenWorkModelsPromoEligibility,
  isOpenWorkModelsPromoHidden,
  openWorkModelsPromoChangedEvent,
  shouldShowOpenWorkModelsSyncing,
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
import {
  ensureDesktopLocalOpenworkConnection,
  shouldAttemptDesktopLocalReconnect,
} from "./desktop-local-openwork";
import { reloadEngineWithDesktopFallback } from "./engine-reload-escalation";
import { resolveOpenworkConnection } from "./openwork-connection";
import { abortSessionSafe, listCommands } from "@/app/lib/opencode-session";
import { notifyAlert } from "./notifications";
import { useReloadCoordinator } from "./reload-coordinator";
import { CommandPalette, type PaletteItem } from "./command-palette";
import { buildCommandPaletteSessions } from "./command-palette-sessions";
import { useCommandPaletteShortcut } from "./use-shell-shortcuts";
import { buildFeedbackUrl } from "@/app/lib/feedback";
import { getDenInferenceUrl, type DenSettings } from "@/app/lib/den";
import { readActiveWorkspaceId, writeActiveWorkspaceId } from "./session-memory";
import {
  globalExtensionsRoute,
  workspaceExtensionsRoute,
  workspaceSessionRoute,
  workspaceSettingsRoute,
} from "./workspace-routes";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { refreshProviderListQueries } from "@/react-app/infra/provider-list-query";
import {
  createWorkspaceServerClientResolver,
  useWorkspaceServerClient,
} from "@/react-app/infra/workspace-server-client";
import {
  buildLocalProviderConfig,
  OPENAI_IMAGE_EXTENSION_ID,
  OPENAI_IMAGE_MODEL,
  type LocalProviderInstallInput,
} from "@/react-app/domains/settings/openai-image-extension";
import {
  libraryAgentsFromOpencode,
  libraryCommandsFromSlashOptions,
  type LibraryAgentItem,
  type LibraryCommandItem,
} from "@/react-app/domains/settings/library";

const ROUTE_OPENWORK_CAPABILITIES: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

async function reloadEngineOrRestartDesktop(
  client: Pick<OpenworkServerClient, "reloadEngine">,
  workspaceId: string,
  afterRestart?: () => Promise<void>,
): Promise<void> {
  const { restartedEngine } = await reloadEngineWithDesktopFallback(client, workspaceId);
  if (restartedEngine) {
    await afterRestart?.();
  }
}

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

export function parseSettingsPath(pathname: string): {
  tab: SettingsTab;
  redirectPath: string | null;
  extensionsSection?: ExtensionsSection;
  extensionDetailId?: string;
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
    case "advanced":
    case "appearance":
    case "environment":
    case "updates":
    case "recovery":
    case "debug":
      return { tab: head, redirectPath: null };
    case "cloud-account":
    case "cloud-providers":
    case "memory":
      return { tab: head, redirectPath: null };
    case "connect":
      return { tab: "extensions", redirectPath: "extensions", extensionsSection: "all" };
    case "skills":
      return { tab: "extensions", redirectPath: "extensions/skills", extensionsSection: "skills" };
    case "mcp":
      return { tab: "extensions", redirectPath: "extensions/mcps", extensionsSection: "mcps" };
    case "cloud-marketplaces":
      return { tab: "extensions", redirectPath: "extensions", extensionsSection: "all" };
    case "den":
    case "cloud-workers":
      return { tab: "cloud-account", redirectPath: "cloud-account" };
    case "extensions":
      if (tail === "mcp") return { tab: "extensions", redirectPath: "extensions/mcps", extensionsSection: "mcps" };
      if (
        tail === "apps"
        || tail === "connections"
        || tail === "mcps"
        || tail === "skills"
        || tail === "commands"
        || tail === "agents"
        || tail === "plugins"
        || tail === "needs-sign-in"
        || tail === "needs-admin-setup"
        || tail === "ready"
      ) {
        return { tab: "extensions", redirectPath: null, extensionsSection: tail };
      }
      if (tail) {
        return {
          tab: "extensions",
          redirectPath: null,
          extensionsSection: "all",
          extensionDetailId: decodeURIComponent(tail),
        };
      }
      return { tab: "extensions", redirectPath: null, extensionsSection: "all" };
    default:
      return { tab: "general", redirectPath: "general" };
  }
}

export function parseExtensionsPath(pathname: string): ReturnType<typeof parseSettingsPath> {
  const extensionPath = pathname
    .replace(/^\/workspace\/[^/]+\/extensions\/?/, "")
    .replace(/^\/extensions\/?/, "")
    .replace(/^\/+|\/+$/g, "");
  return parseSettingsPath(`/settings/extensions${extensionPath ? `/${extensionPath}` : ""}`);
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

export function settingsReturnRoute(
  selectedWorkspaceId: string,
  navigationWorkspaceId: string | null,
  navigationSessionId: string | null,
) {
  if (!selectedWorkspaceId) return "/session";
  const returnSessionId = navigationWorkspaceId === selectedWorkspaceId
    ? navigationSessionId
    : null;
  return workspaceSessionRoute(selectedWorkspaceId, returnSessionId);
}

export function settingsDeveloperModePaletteItem(
  developerMode: boolean,
  action: () => void,
): PaletteItem {
  return {
    id: "developer-mode.toggle",
    title: developerMode ? t("settings.disable_developer_mode") : t("settings.enable_developer_mode"),
    detail: t("settings.developer_mode_desc"),
    meta: developerMode ? "On" : "Off",
    searchText: "developer dev mode debug diagnostics toggle enable disable",
    action,
  };
}

function findSessionWorkspaceId(
  sessionId: string | null,
  entries: Array<{ workspaceId: string; sessions: any[] }>,
) {
  const id = sessionId?.trim();
  if (!id) return null;
  return entries.find((entry) => entry.sessions.some((session) => session?.id === id))?.workspaceId ?? null;
}

export function settingsPathForRoute(route: ReturnType<typeof parseSettingsPath>) {
  if (route.tab === "extensions" && route.extensionDetailId) {
    return `extensions/${encodeURIComponent(route.extensionDetailId)}`;
  }
  if (route.tab === "extensions" && route.extensionsSection && route.extensionsSection !== "all") {
    return `extensions/${route.extensionsSection}`;
  }
  return route.tab;
}

export function extensionsPathForRoute(route: ReturnType<typeof parseSettingsPath>) {
  if (route.extensionDetailId) {
    return encodeURIComponent(route.extensionDetailId);
  }
  if (route.extensionsSection && route.extensionsSection !== "all") {
    return route.extensionsSection;
  }
  return "";
}

export type SettingsSurfaceProps = {
  embedded?: boolean;
  standaloneExtensions?: boolean;
  initialPath?: string;
  workspaceId?: string;
  onClose?: () => void;
};

function SettingsRouteContent(props: SettingsSurfaceProps = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ workspaceId?: string }>();
  const routeWorkspaceId = props.workspaceId?.trim() || params.workspaceId?.trim() || "";
  const routeWorkspaceIdRef = useRef(routeWorkspaceId);
  routeWorkspaceIdRef.current = routeWorkspaceId;
  const local = useLocal();
  const {
    memoryEnabled,
    toggleMemory,
  } = useFeatureFlagsPreferences();
  const platform = usePlatform();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const desktopConfig = useDesktopConfig();
  const reloadCoordinator = useReloadCoordinator();
  const [embeddedPath, setEmbeddedPath] = useState(props.initialPath ?? "general");
  const route = props.embedded
    ? parseSettingsPath(`/settings/${embeddedPath}`)
    : props.standaloneExtensions
      ? parseExtensionsPath(location.pathname)
      : parseSettingsPath(location.pathname);
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
    if (props.standaloneExtensions) {
      const extensionPath = path.replace(/^extensions\/?/, "");
      navigate(
        selectedWorkspaceId
          ? workspaceExtensionsRoute(selectedWorkspaceId, extensionPath)
          : globalExtensionsRoute(extensionPath),
        { state: location.state },
      );
      return;
    }
    navigate(
      selectedWorkspaceId ? workspaceSettingsRoute(selectedWorkspaceId, path) : `/settings/${path}`,
      { state: location.state },
    );
  }, [location.state, navigate, props.embedded, props.standaloneExtensions, selectedWorkspaceId]);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [openworkClient, setOpenworkClient] = useState<OpenworkServerClient | null>(null);
  const [activeClient, setActiveClient] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const lastRequestedRouteWorkspaceIdRef = useRef("");
  const refreshLifecycleRef = useRef(createRouteRefreshLifecycle());
  const serverActiveWorkspaceIdRef = useRef("");
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
  const toggleDeveloperMode = useCallback(() => {
    setDeveloperMode((current) => {
      const next = !current;
      try { window.localStorage.setItem("openwork.developerMode", next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);
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
  const [cloudMcpHealthResult, setCloudMcpHealthResult] = useState<{
    workspaceId: string;
    health: OpenworkCloudMcpHealth;
  } | null>(null);
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
    providerBaseUrl: "",
    selectedWorkspaceId: "",
    selectedWorkspaceRoot: "",
    selectedWorkspaceType: "local" as "local" | "remote",
    runtimeWorkspaceId: null as string | null,
    openworkServerClient: null as OpenworkServerClient | null,
    selectedWorkspaceOpenworkClient: null as OpenworkServerClient | null,
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
  const workspaceServerClientResolver = useMemo(
    () => createWorkspaceServerClientResolver({ baseUrl, token }),
    [baseUrl, token],
  );
  const workspaceSelectionCommitRef = useRef<(workspaceId: string) => Promise<void>>(async () => undefined);
  workspaceSelectionCommitRef.current = async (workspaceId) => {
    await commitRouteWorkspaceSelection({
      workspaceId,
      desktopRuntime: isDesktopRuntime(),
      setDesktopSelected: workspaceSetSelected,
      setDesktopRuntimeActive: workspaceSetRuntimeActive,
      activateWorkspace: async (selectedId) => {
        const workspace = workspacesRef.current.find((item) => item.id === selectedId) ?? null;
        const endpoint = workspaceServerClientResolver(workspace);
        if (!endpoint) throw new Error(`Workspace endpoint unavailable for ${selectedId}.`);
        if (workspace?.workspaceType === "local" && serverActiveWorkspaceIdRef.current === selectedId) return;
        await endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true });
        if (workspace?.workspaceType === "local") serverActiveWorkspaceIdRef.current = selectedId;
      },
    });
  };
  const selectedWorkspaceEndpoint = useWorkspaceServerClient(selectedWorkspace, { baseUrl, token });
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";

  routeStateRef.current = {
    activeClient,
    providerBaseUrl: opencodeBaseUrl,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    selectedWorkspaceType: selectedWorkspace?.workspaceType ?? "local",
    runtimeWorkspaceId: selectedWorkspace?.id ?? null,
    openworkServerClient: openworkClient,
    selectedWorkspaceOpenworkClient: openworkClient,
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
  // Stable identity: McpView reloads opencode.json whenever this prop changes,
  // so an inline lambda would refetch the config on every settings re-render
  // (store snapshots tick every few seconds while idle on the Library page).
  const readMcpConfigFile = useCallback(
    (scope: "project" | "global") => connectionsStore.readMcpConfigFile(scope),
    [connectionsStore],
  );
  const providerAuthStore = useMemo(
    () =>
      createProviderAuthStore({
        client: () => routeStateRef.current.activeClient,
        providers: () => routeStateRef.current.providerItems,
        providerDefaults: () => routeStateRef.current.providerDefaults,
        providerConnectedIds: () => routeStateRef.current.providerConnectedIds,
        disabledProviders: () => routeStateRef.current.disabledProviders,
        checkDesktopAppRestriction: checkDesktopRestriction,
        providerBaseUrl: () => routeStateRef.current.providerBaseUrl,
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
  const extensionsSnapshot = useExtensionsStoreSnapshot(extensionsStore);
  const orgMcpConnections = useOrgMcpConnections();

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

  useEffect(() => {
    if (openworkServerStatusForMcp !== "connected") return;
    // Same race for the Cloud Providers rows: the provider-auth store's
    // start() read fires while this store still reports "disconnected", so
    // it takes the legacy (empty) config read and the rows sit on "Syncing"
    // even though the server's /cloud-provider-sync/status already lists the
    // providers as synced. Re-derive from the server once it is reachable.
    void providerAuthStore.refreshImportedCloudProviders();
  }, [openworkServerStatusForMcp, providerAuthStore]);

  const cleanupCloudMcpForSignOut = useCallback(async (settings: DenSettings) => {
    const client = routeStateRef.current.selectedWorkspaceOpenworkClient;
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() ?? "";
    const orgId = settings.activeOrgId?.trim() ?? "";
    if (!client || !workspaceId || !orgId) return;
    // Settings only has a safe, exact OpenCode client/directory for the active
    // workspace here, so sign-out cleanup is intentionally scoped to that
    // workspace instead of guessing across every configured worker.
    await cleanupOpenworkCloudMcpAfterSignOut({
      context: {
        denBaseUrl: settings.baseUrl,
        serverBaseUrl: client.baseUrl,
        workspaceId,
        orgId,
      },
      openworkClient: client,
      opencodeClient: routeStateRef.current.activeClient,
      directory: routeStateRef.current.selectedWorkspaceRoot,
    });
    setCloudMcpHealthResult(null);
    await refreshMcpServersRef.current?.();
  }, []);
  const denSession = useDenSession({
    developerMode,
    onBeforeSignedOut: cleanupCloudMcpForSignOut,
    openLink: (url) => platform.openLink(url),
  });
  const cloudSession = useCloudSession();
  const connectScope = useMemo(
    () => ({
      baseUrl: cloudSession.baseUrl,
      organizationId: cloudSession.activeOrganization?.id?.trim() ?? "",
    }),
    [cloudSession.activeOrganization?.id, cloudSession.baseUrl],
  );
  const [connectCapabilities, setConnectCapabilities] = useState<ConnectCapabilityInventory>(
    () => readCachedConnectCapabilities(connectScope) ?? EMPTY_CONNECT_CAPABILITY_INVENTORY,
  );
  const [connectCapabilitiesLoading, setConnectCapabilitiesLoading] = useState(false);
  const connectCapabilitiesRequestRef = useRef(0);
  const refreshConnectCapabilities = useCallback(async (options?: { force?: boolean }) => {
    const requestId = connectCapabilitiesRequestRef.current + 1;
    connectCapabilitiesRequestRef.current = requestId;
    if (!cloudSession.isSignedIn || !connectScope.organizationId) {
      setConnectCapabilities(EMPTY_CONNECT_CAPABILITY_INVENTORY);
      setConnectCapabilitiesLoading(false);
      return;
    }
    // Paint what the app already fetched, then revalidate behind it.
    const cached = readCachedConnectCapabilities(connectScope);
    if (cached) setConnectCapabilities(cached);
    setConnectCapabilitiesLoading(!cached);
    try {
      const inventory = await loadConnectCapabilities({
        client: cloudSession.client,
        scope: connectScope,
        maxAgeMs: options?.force ? 0 : undefined,
      });
      if (connectCapabilitiesRequestRef.current === requestId) {
        setConnectCapabilities(inventory);
      }
    } catch {
      if (connectCapabilitiesRequestRef.current === requestId && !cached) {
        setConnectCapabilities(EMPTY_CONNECT_CAPABILITY_INVENTORY);
      }
    } finally {
      if (connectCapabilitiesRequestRef.current === requestId) setConnectCapabilitiesLoading(false);
    }
  }, [cloudSession.client, cloudSession.isSignedIn, connectScope]);

  // Not gated on the Extensions tab: the inventory should be warm before the
  // user gets there, and the fetch is deduped by the shared cloud cache.
  useEffect(() => {
    void refreshConnectCapabilities({ force: true });
  }, [refreshConnectCapabilities]);

  const hasOpenWorkCloudProvider = useMemo(
    () =>
      providerAuthSnapshot.cloudOrgProviders.some(isOpenWorkCloudProvider) ||
      Object.values(providerAuthSnapshot.importedCloudProviders ?? {}).some(isOpenWorkCloudProvider),
    [providerAuthSnapshot.cloudOrgProviders, providerAuthSnapshot.importedCloudProviders],
  );
  const [openWorkModelsPromoHidden, setOpenWorkModelsPromoHidden] = useState(isOpenWorkModelsPromoHidden);
  const openWorkModelsPromoEligible = useOpenWorkModelsPromoEligibility();
  // Entitled = Den/import says OpenWork Models is included. Available = local
  // engine actually exposes selectable openwork models.
  const openWorkModelsEntitled = cloudSession.isSignedIn && hasOpenWorkCloudProvider;
  const openWorkModelsAvailable = hasOpenWorkModelsAvailable({
    providerConnectedIds,
    providers,
  });
  const showOpenWorkModelsSyncing = shouldShowOpenWorkModelsSyncing({
    entitled: openWorkModelsEntitled,
    available: openWorkModelsAvailable,
    workspaceReady: Boolean(selectedWorkspaceId && activeClient),
    reloadPending: providerAuthSnapshot.cloudProviderServerSync?.reloadPending === true,
  });
  const showOpenWorkModelsSubscribe =
    openWorkModelsPromoEligible &&
    !openWorkModelsEntitled &&
    !openWorkModelsAvailable &&
    !openWorkModelsPromoHidden;
  const showOpenWorkModelsConnect =
    openWorkModelsPromoEligible &&
    !openWorkModelsEntitled &&
    !openWorkModelsAvailable &&
    openWorkModelsPromoHidden;

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
    if (providerAuthStore.isProviderAddRestricted()) {
      restrictionNotice.show({
        title: t("restrictions.add_custom_providers_disabled_title"),
        message: t("restrictions.add_custom_providers_disabled_message"),
      });
      return;
    }

    void providerAuthStore.openProviderAuthModal();
  }, [providerAuthStore, restrictionNotice]);

  useEffect(() => {
    if (!activeClient || !selectedWorkspaceId) return;
    // Org policy may force Zen off. Never force it back on — that races user Disconnect.
    if (!checkDesktopRestriction({ restriction: "allowZenModel" })) return;

    void providerAuthStore
      .ensureProjectProviderDisabledState("opencode", true)
      .catch((error) => {
        console.warn("[desktop-app-restrictions] failed to sync Zen restriction", error);
      });
  }, [activeClient, checkDesktopRestriction, providerAuthStore, selectedWorkspaceId, selectedWorkspaceRoot]);

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
    refreshDesktopConfig: desktopConfig.refreshFresh,
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

  const runtimeWorkspaceId = selectedWorkspaceEndpoint?.workspaceId ?? selectedWorkspace?.id ?? null;
  routeStateRef.current.runtimeWorkspaceId = runtimeWorkspaceId;
  routeStateRef.current.selectedWorkspaceOpenworkClient = selectedWorkspaceEndpoint?.client ?? openworkClient;
  const cloudMcpHealth = cloudMcpHealthResult?.workspaceId === runtimeWorkspaceId
    ? cloudMcpHealthResult.health
    : null;
  const handleCloudMcpHealthChange = useCallback((health: OpenworkCloudMcpHealth | null) => {
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    if ((routeStateRef.current.runtimeWorkspaceId?.trim() ?? "") !== workspaceId) return;
    setCloudMcpHealthResult(health && workspaceId ? { workspaceId, health } : null);
  }, [runtimeWorkspaceId]);

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

  const [libraryCommands, setLibraryCommands] = useState<LibraryCommandItem[]>([]);
  const [libraryAgents, setLibraryAgents] = useState<LibraryAgentItem[]>([]);
  const loadLibraryLists = useCallback(async () => {
    if (opencodeClient) {
      try {
        const [commands, agents] = await Promise.all([
          listCommands(opencodeClient, selectedWorkspaceRoot || undefined),
          opencodeClient.app.agents()
            .then((result) => unwrap(result))
            .catch(() => []),
        ]);
        setLibraryCommands(libraryCommandsFromSlashOptions(commands));
        setLibraryAgents(libraryAgentsFromOpencode(Array.isArray(agents) ? agents : []));
      } catch {
        setLibraryCommands([]);
        setLibraryAgents([]);
      }
    } else {
      setLibraryCommands([]);
      setLibraryAgents([]);
    }
    await refreshConnectCapabilities({ force: true });
  }, [opencodeClient, refreshConnectCapabilities, selectedWorkspaceRoot]);
  useEffect(() => {
    void loadLibraryLists();
  }, [loadLibraryLists]);

  const handleModelPickerLoadError = useCallback((error: unknown) => {
    toast.error(error instanceof Error ? error.message : t("app.unknown_error"));
  }, []);
  const handleModelPickerOpen = useCallback(() => {
    void providerAuthStore.runCloudProviderSync("model_picker_open");
  }, [providerAuthStore]);
  const modelPicker = useModelPicker({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    workspaceRoot: selectedWorkspaceRoot,
    onOpen: handleModelPickerOpen,
    onLoadError: handleModelPickerLoadError,
    cloudProvidersEnabled: cloudSession.isSignedIn,
  });
  const currentCloudMcpModel = useMemo<OpenworkCloudMcpProviderModelContext | null>(() => {
    const provider = local.prefs.defaultModel?.providerID.trim() ?? "";
    const model = local.prefs.defaultModel?.modelID.trim() ?? "";
    return provider && model ? { provider, model } : null;
  }, [local.prefs.defaultModel]);
  const refreshCloudMcpHealth = useCallback(async () => {
    const client = selectedWorkspaceEndpoint?.client ?? openworkClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    if (!client || !workspaceId) {
      setCloudMcpHealthResult(null);
      return null;
    }
    // probe: the Advanced page refresh should verify the Cloud endpoint
    // directly (outside the engine), not just report the engine's cached state.
    const health = await client.getOpenworkCloudMcpHealth(workspaceId, currentCloudMcpModel ?? undefined, { probe: true });
    if (routeStateRef.current.runtimeWorkspaceId?.trim() !== workspaceId) return null;
    setCloudMcpHealthResult({ workspaceId, health });
    return health;
  }, [currentCloudMcpModel, openworkClient, runtimeWorkspaceId, selectedWorkspaceEndpoint]);
  const { commandPaletteOpen, setCommandPaletteOpen } = useCommandPaletteShortcut(!props.embedded);
  const developerModePaletteItem = useMemo(
    () => settingsDeveloperModePaletteItem(developerMode, () => {
      setCommandPaletteOpen(false);
      toggleDeveloperMode();
    }),
    [developerMode, setCommandPaletteOpen, toggleDeveloperMode],
  );
  const paletteSessionOptions = useMemo(
    () => buildCommandPaletteSessions(workspaces, sessionsByWorkspaceId, selectedWorkspaceId),
    [sessionsByWorkspaceId, selectedWorkspaceId, workspaces],
  );
  const handleCreatePaletteSession = useCallback(async () => {
    if (!opencodeClient || !selectedWorkspaceId) {
      navigate(selectedWorkspaceId ? workspaceSessionRoute(selectedWorkspaceId) : "/session");
      return;
    }
    try {
      const session = unwrap(
        await opencodeClient.session.create({ directory: selectedWorkspaceRoot || undefined }),
      );
      navigate(workspaceSessionRoute(selectedWorkspaceId, session.id));
    } catch (error) {
      toast.error(describeRouteError(error));
    }
  }, [navigate, opencodeClient, selectedWorkspaceId, selectedWorkspaceRoot]);
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
      if (!response.ok) {
        setImageGenerationError(response.message);
        return;
      }
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
            [input.providerId]: buildLocalProviderConfig({ ...input, modelId }),
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
        await reloadEngineOrRestartDesktop(client, workspaceId);
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

  const {
    markRouteReady: markBootRouteReady,
    phase: bootPhase,
    routeReady: bootRouteReady,
  } = useBootState();
  const refreshRouteState = useMemo(() => async (options?: { supersede?: boolean }) => {
    const attempt = refreshLifecycleRef.current.begin(options);
    if (!attempt) return;
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
      if (!attempt.isCurrent()) return;

      const { normalizedBaseUrl, resolvedToken, resolvedHostToken } = await resolveOpenworkConnection();
      if (!attempt.isCurrent()) return;

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
      if (!attempt.isCurrent()) return;
      serverActiveWorkspaceIdRef.current = list.activeId ?? "";
      const serverWorkspaceIds = new Set(list.items.map((workspace) => workspace.id));
      const nextWorkspaces = mergeRouteWorkspaces(list.items, desktopWorkspaces);
      const routeWorkspaceServerClientResolver = createWorkspaceServerClientResolver({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
      });
      const routedWorkspaceId = routeWorkspaceIdRef.current;
      if (routedWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === routedWorkspaceId)) {
        // Opening Settings unmounts the session route. Join its shared
        // selection queue and commit the routed workspace before Settings
        // performs any runtime-backed reads, so an older session switch
        // cannot retake the desktop/runtime/server state underneath them.
        setLegacySelectedWorkspaceId(routedWorkspaceId);
        writeActiveWorkspaceId(routedWorkspaceId);
        lastRequestedRouteWorkspaceIdRef.current = routedWorkspaceId;
        routeWorkspaceSelectionCommitter.request(routedWorkspaceId, async (workspaceId) => {
          await commitRouteWorkspaceSelection({
            workspaceId,
            desktopRuntime: isDesktopRuntime(),
            setDesktopSelected: workspaceSetSelected,
            setDesktopRuntimeActive: workspaceSetRuntimeActive,
            activateWorkspace: async (selectedId) => {
              const workspace = nextWorkspaces.find((item) => item.id === selectedId) ?? null;
              const endpoint = routeWorkspaceServerClientResolver(workspace);
              if (!endpoint) throw new Error(`Workspace endpoint unavailable for ${selectedId}.`);
              if (workspace?.workspaceType === "local" && serverActiveWorkspaceIdRef.current === selectedId) return;
              await endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true });
              if (workspace?.workspaceType === "local") serverActiveWorkspaceIdRef.current = selectedId;
            },
          });
        });
        await routeWorkspaceSelectionCommitter.settled();
        if (!attempt.isCurrent()) return;
      }
      const sessionEntries = await mapRouteWorkspaceLoads(
        nextWorkspaces,
        async (workspace) => {
          const endpoint = routeWorkspaceServerClientResolver(workspace);
          if (!endpoint) {
            return { workspaceId: workspace.id, sessions: [], error: null as string | null };
          }
          if (!endpoint.isRemote && !serverWorkspaceIds.has(workspace.id)) {
            return { workspaceId: workspace.id, sessions: [], error: null as string | null };
          }
          try {
            const response = await readRouteSessionsWithRetry({
              load: () => listRouteSessions(endpoint),
              retryDelaysMs: [250, 750, 1_500],
            });
            const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
            const items = workspaceRoot && !endpoint.isRemote
              ? response.filter((session) =>
                  normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
                )
              : response;
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
        },
      );
      if (!attempt.isCurrent()) return;

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
        const preferred = routeWorkspaceIdRef.current || sessionWorkspaceId || navigationWorkspaceId || current || readActiveWorkspaceId() || "";
        const next = reconcileSelectedWorkspaceId(preferred, list, desktopList, nextWorkspaces);
        writeActiveWorkspaceId(next || null);
        return next;
      });
    } catch (error) {
      if (!attempt.isCurrent()) return;
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
      attempt.finish();
      if (attempt.isCurrent()) {
        setLoading(false);
        // Settings can be the first route a user lands on (direct link, deep
        // link, or after reload). Let the boot overlay dismiss once we've
        // completed our first data load.
        markBootRouteReady();
      }
    }
  }, [markBootRouteReady, navigationSessionId, navigationWorkspaceId, routeWorkspaceId]);

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    const workspaceId = routeStateRef.current.runtimeWorkspaceId?.trim() || selectedWorkspaceId.trim();
    if (!openworkClient || !workspaceId) {
      toast.error(t("app.error_connect_first"));
      return false;
    }

    await reloadEngineOrRestartDesktop(openworkClient, workspaceId, refreshRouteState);
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
  }, [openworkClient, refreshRouteState, selectedWorkspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(openworkClient && (selectedWorkspace?.id || selectedWorkspaceId)),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
      stopSession: async (sessionId) => {
        if (!activeClient) return;
        await abortSessionSafe(activeClient, sessionId, undefined, {
          source: "settings.reload_workspace.stop_session",
          initiator: "user",
          reason: "stop active session before workspace engine reload",
        });
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

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    if (!routeWorkspaceId || lastRequestedRouteWorkspaceIdRef.current === routeWorkspaceId) return;
    if (!workspaces.some((workspace) => workspace.id === routeWorkspaceId)) return;
    setLegacySelectedWorkspaceId(routeWorkspaceId);
    writeActiveWorkspaceId(routeWorkspaceId);
    lastRequestedRouteWorkspaceIdRef.current = routeWorkspaceId;
    routeWorkspaceSelectionCommitter.request(
      routeWorkspaceId,
      (workspaceId) => workspaceSelectionCommitRef.current(workspaceId),
    );
  }, [routeWorkspaceId, workspaces]);

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
    client: openworkClient,
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
    if (openworkClient) {
      reconnectAttemptedWorkspaceIdRef.current = "";
    }
    // Same gate as the session route: reconnect must not probe the local
    // server while desktop runtime bootstrap is still starting it.
    if (
      !shouldAttemptDesktopLocalReconnect({
        desktopRuntime: isDesktopRuntime(),
        bootPhase,
        bootRouteReady,
        routeLoading: loading,
        hasClient: Boolean(openworkClient),
        connectionPending: false,
        workspaceType: selectedWorkspace?.workspaceType ?? null,
      })
    ) {
      return;
    }
    if (!selectedWorkspace) return;
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
  }, [bootPhase, bootRouteReady, loading, openworkClient, selectedWorkspace, workspaces]);

  useEffect(() => {
    // A workspace-route change must invalidate the previous refresh even if
    // it is still waiting on that workspace's runtime. The superseded attempt
    // can finish its network calls, but it can no longer write Settings state.
    void refreshRouteState({ supersede: true });
    const handleSettingsChange = () => {
      void refreshRouteState({ supersede: true });
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

  const refreshMarketplaceAction = useMemo<OpenworkControlAction>(() => ({
    id: "extensions.refresh-marketplace",
    label: "Refresh marketplace extensions",
    description: "Force a fresh sync of organization marketplace plugins from the cloud.",
    sideEffect: "mutation",
    execute: async () => {
      await extensionsStore.refreshCloudOrgMarketplaces({ force: true });
      return { marketplaceCount: extensionsStore.cloudOrgMarketplaces().length };
    },
  }), [extensionsStore]);
  useControlAction(refreshMarketplaceAction);

  // Periodically reconcile workspace-imported cloud providers from Den while
  // signed in (dev #1509 "auto-sync cloud providers"). Mounted here because
  // the settings route owns the provider-auth store.
  useCloudProviderAutoSync(providerAuthStore.runCloudProviderSync);

  // Keep the Den cloud MCP configured with a fresh first-party token while
  // signed in: connects on sign-in, re-mints on org switch and before expiry.
  useCloudProviderAutoSync(() => connectionsStore.syncCloudControlMcp());

  useEffect(() => {
    if (route.tab !== "cloud-providers" && route.tab !== "ai") return;
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
  const canWriteWorkspacePlugins =
    !isRemoteWorkspace || openworkServerSnapshot.openworkServerCanWritePlugins;
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
  const disabledProviderIdSet = new Set(
    disabledProviders.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  const connectedProviders = providers.flatMap((provider) =>
    providerConnectedIdSet.has(provider.id) &&
    !disabledProviderIdSet.has(provider.id.trim().toLowerCase())
      ? [{
          id: provider.id,
          name: provider.name ?? provider.id,
          source: provider.source,
        }]
      : [],
  );
  const openworkCloudMcpUrl = connectionsSnapshot.mcpServers.find(
    (server) => server.name === "openwork-cloud",
  )?.config.url ?? null;

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
  const allowManageExtensions = !checkDesktopRestriction({ restriction: "allowManageExtensions" });
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
  const extensionCatalogPlatform = resolveOpenWorkExtensionCatalogPlatform(platform.platform, platform.os);
  const quickConnectCatalog = useMemo(
    () => filterOpenWorkExtensionCatalogForPlatform(connectionsStore.quickConnect, extensionCatalogPlatform),
    [connectionsStore.quickConnect, extensionCatalogPlatform],
  );
  const extensionItems = useMemo(
    () => buildExtensionItems({
      quickConnect: quickConnectCatalog,
      mcpServers: connectionsSnapshot.mcpServers,
      installedSkills: extensionsStore.skills(),
      importedCloudPlugins: extensionsSnapshot.importedCloudPlugins,
      pendingCloudPluginChanges: extensionsSnapshot.pendingCloudPluginChanges,
      cloudMarketplaces: extensionsSnapshot.cloudOrgMarketplaces,
      orgMcpConnections: orgMcpConnections.connections,
      enablementContext,
      isBuiltInConnected: extensionController.isConnected,
    }),
    [connectionsSnapshot.mcpServers, enablementContext, extensionController.isConnected, extensionsSnapshot, extensionsStore, orgMcpConnections.connections, quickConnectCatalog],
  );
  // Every connection the organization provisioned for this member, connected
  // or not: one that still needs the member's sign-in is the whole reason the
  // "Needs your attention" group exists, so it must not be filtered out here.
  const orgMcpConnectionItems = extensionItems.orgMcpConnectionItems;
  const librarySkills = useMemo(
    () => [
      ...extensionItems.installedSkills,
      ...connectCapabilities.skills.filter(
        (skill) => !extensionItems.installedSkills.some(
          (installed) => installed.name.toLowerCase() === skill.name.toLowerCase(),
        ),
      ),
    ],
    [connectCapabilities.skills, extensionItems.installedSkills],
  );
  const libraryConnectMcpServers = useMemo(
    () => connectCapabilities.mcpServers.filter(
      (entry) => !orgMcpConnectionItems.some((item) =>
        item.name.localeCompare(entry.name, undefined, { sensitivity: "accent" }) === 0
      ),
    ),
    [connectCapabilities.mcpServers, orgMcpConnectionItems],
  );
  const libraryConnectPlugins = useMemo(
    () => connectPluginsForComposer(connectCapabilities.plugins),
    [connectCapabilities.plugins],
  );
  const readLibrarySkill = useCallback(
    (name: string) => extensionsStore.readSkill(name),
    [extensionsStore],
  );
  const organizationConnectionsProbe = resolveOrganizationConnectionsProbe({
    signedIn: cloudSession.isSignedIn,
    activeOrganizationId: cloudSession.activeOrganization?.id,
    loading: orgMcpConnections.loading,
    loaded: orgMcpConnections.loaded,
    error: orgMcpConnections.error,
  });
  const diagnosticsClient = selectedWorkspaceEndpoint?.client ?? openworkClient;
  const diagnosticsWorkspaceAllowed = isAgentContextDiagnosticsWorkspaceAllowed(selectedWorkspace);
  const diagnosticsAvailable = Boolean(
    diagnosticsClient
    && runtimeWorkspaceId?.trim()
    && diagnosticsWorkspaceAllowed,
  );
  const diagnosticsUnavailableReason = selectedWorkspace?.workspaceType === "remote"
    && selectedWorkspace.remoteType !== "openwork"
    ? "direct-remote-opencode" as const
    : null;
  const diagnosticsWorkspaceType = selectedWorkspace?.workspaceType === "remote"
    ? selectedWorkspace.remoteType ?? "legacy-opencode"
    : "local";
  const diagnosticsScopeKey = useMemo(() => createOpaqueDiagnosticsScopeKey({
    client: diagnosticsClient,
    workspaceCredential: selectedWorkspaceEndpoint?.token ?? token,
    workspaceId: runtimeWorkspaceId?.trim() ?? "",
    workspaceType: diagnosticsWorkspaceType,
    denBaseUrl: cloudSession.baseUrl,
    denCredential: cloudSession.authToken,
    denSignedIn: cloudSession.isSignedIn,
    organizationId: cloudSession.activeOrganization?.id ?? "signed-out",
    principalId: cloudSession.user?.id ?? "signed-out",
  }), [
    cloudSession.activeOrganization?.id,
    cloudSession.authToken,
    cloudSession.baseUrl,
    cloudSession.isSignedIn,
    cloudSession.user?.id,
    diagnosticsClient,
    diagnosticsWorkspaceType,
    runtimeWorkspaceId,
    selectedWorkspaceEndpoint?.token,
    token,
  ]);
  const runAgentContextDiagnostics = useCallback(async () => {
    const client = selectedWorkspaceEndpoint?.client ?? openworkClient;
    const workspaceId = runtimeWorkspaceId?.trim() ?? "";
    if (
      !client
      || !workspaceId
      || !selectedWorkspace
      || !isAgentContextDiagnosticsWorkspaceAllowed(selectedWorkspace)
    ) {
      throw new Error("Agent diagnostics require a connected workspace.");
    }
    const observations = await collectAgentContextDiagnosticObservations({
      organizationConnections: orgMcpConnections.connections,
      organizationConnectionsProbe,
      workspaceType: selectedWorkspace.workspaceType,
    });
    return client.runAgentContextDiagnostics(workspaceId, observations);
  }, [
    openworkClient,
    organizationConnectionsProbe,
    orgMcpConnections.connections,
    runtimeWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
  ]);
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

  const handleSelectSettingsWorkspace = useCallback((workspaceId: string) => {
    if (workspaceId === selectedWorkspaceId) return;
    setLegacySelectedWorkspaceId(workspaceId);
    writeActiveWorkspaceId(workspaceId);
    lastRequestedRouteWorkspaceIdRef.current = workspaceId;
    routeWorkspaceSelectionCommitter.request(
      workspaceId,
      (selectedId) => workspaceSelectionCommitRef.current(selectedId),
    );
    navigate(
      props.standaloneExtensions
        ? workspaceExtensionsRoute(workspaceId, extensionsPathForRoute(route))
        : workspaceSettingsRoute(workspaceId, settingsPathForRoute(route)),
      { state: location.state },
    );
  }, [location, navigate, props.standaloneExtensions, route, selectedWorkspaceId]);

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
    const endpoint = workspaceServerClientResolver(workspace);
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
  }, [workspaceServerClientResolver, workspaces]);

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

  if (route.redirectPath && !props.embedded) {
    const target = props.standaloneExtensions
      ? selectedWorkspaceId
        ? workspaceExtensionsRoute(selectedWorkspaceId, extensionsPathForRoute(route))
        : globalExtensionsRoute(extensionsPathForRoute(route))
      : selectedWorkspaceId
        ? workspaceSettingsRoute(selectedWorkspaceId, route.redirectPath)
        : `/settings/${route.redirectPath}`;
    return <Navigate to={target} replace state={location.state} />;
  }

  if (!props.embedded && !routeWorkspaceId && selectedWorkspaceId) {
    const target = props.standaloneExtensions
      ? workspaceExtensionsRoute(selectedWorkspaceId, extensionsPathForRoute(route))
      : workspaceSettingsRoute(selectedWorkspaceId, settingsPathForRoute(route));
    return <Navigate to={target} replace state={location.state} />;
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
              const message = await providerAuthStore.disconnectProvider(providerId);
              if (typeof message === "string" && message.trim()) {
                setConfigActionStatus(message);
              }
            }}
            canDisconnectProvider={(provider) =>
              provider.id.trim().toLowerCase() === "opencode" || provider.source !== "env"
            }
            canAddProviders={!providerAuthStore.isProviderAddRestricted()}
            organizationName={cloudSession.activeOrgName}
            cloudProviderIds={new Set([
              ...Object.values(providerAuthSnapshot.importedCloudProviders ?? {}).map((p) => p.providerId),
              ...(openWorkModelsEntitled || openWorkModelsAvailable ? ["openwork"] : []),
            ])}
            showOpenWorkModelsSubscribe={showOpenWorkModelsSubscribe}
            showOpenWorkModelsConnect={showOpenWorkModelsConnect}
            showOpenWorkModelsSyncing={showOpenWorkModelsSyncing}
            onSubscribeOpenWorkModels={subscribeToOpenWorkModels}
            onDismissOpenWorkModels={dismissOpenWorkModelsPromo}
            cloudProvidersView={
              <CloudProvidersView
                embedded
                checkDesktopAppRestriction={checkDesktopRestriction}
                cloudOrgProviders={providerAuthSnapshot.cloudOrgProviders}
                connectCloudProvider={providerAuthStore.connectCloudProvider}
                importedCloudProviders={providerAuthSnapshot.importedCloudProviders}
                importsUnavailable={
                  openworkServerSnapshot.openworkServerCapabilities?.config?.read === false ||
                  openworkServerSnapshot.openworkServerCapabilities?.config?.write === false
                }
                lastSyncError={providerAuthSnapshot.lastSyncError}
                openworkServerAvailable={Boolean(openworkServerSnapshot.openworkServerClient)}
                onOpenAccount={openCloudAccountSettings}
                refreshCloudOrgProviders={providerAuthStore.refreshCloudOrgProviders}
                runCloudProviderSync={providerAuthStore.runCloudProviderSync}
                serverSync={providerAuthSnapshot.cloudProviderServerSync}
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
            desktopNotifications={local.prefs.desktopNotifications}
            onDesktopNotificationsChange={(desktopNotifications) => {
              local.setPrefs((previous) => ({ ...previous, desktopNotifications }));
            }}
            memoryEnabled={memoryEnabled}
            onToggleMemory={toggleMemory}
          />
        );
      case "extensions":
        return (
          <ExtensionsView
            busy={busy}
            hideDescription={props.standaloneExtensions !== true}
            selectedWorkspaceRoot={selectedWorkspaceRoot}
            isRemoteWorkspace={isRemoteWorkspace}
            canEditPlugins={canWriteWorkspacePlugins}
            canUseGlobalScope={!isRemoteWorkspace}
            accessHint={pluginsAccessHint}
            suggestedPlugins={SUGGESTED_PLUGINS}
            extensions={extensionsStore}
            initialSection={route.extensionsSection}
            detailId={route.extensionDetailId ?? null}
            onDetailIdChange={(id) => {
              navigateSettingsPath(id ? `extensions/${encodeURIComponent(id)}` : "extensions");
            }}
            setSectionRoute={(section) => {
              const path = section === "all" ? "extensions" : `extensions/${section}`;
              navigateSettingsPath(path);
            }}
            onRefresh={() => {
              // Force-sync the cloud MCP first (re-mint token + rewrite
              // config, bypassing the freshness marker) so Refresh really
              // means "make everything current now", then refresh the rest.
              void connectionsStore.syncCloudControlMcp({ force: true }).then(() => {
                void connectionsStore.refreshMcpServers();
              });
              void extensionsStore.refreshPlugins();
              void extensionsStore.refreshCloudOrgMarketplaces({ force: true });
              void orgMcpConnections.refresh();
              void refreshConnectCapabilities({ force: true });
            }}
            mcpView={({ initialFilter, onFilterChange, initialState, onStateChange, detailId, onDetailIdChange, onRefresh }) => (
              <McpView
                busy={busy}
                selectedWorkspaceRoot={selectedWorkspaceRoot}
                isRemoteWorkspace={isRemoteWorkspace}
                mcpServers={connectionsSnapshot.mcpServers}
                mcpStatus={connectionsSnapshot.mcpStatus}
                mcpLastUpdatedAt={connectionsSnapshot.mcpLastUpdatedAt}
                mcpStatuses={connectionsSnapshot.mcpStatuses}
                managedOAuthAvailable={connectionsSnapshot.managedOAuthAvailable}
                mcpConnectingName={connectionsSnapshot.mcpConnectingName}
                allowManageExtensions={allowManageExtensions}
                selectedMcp={connectionsSnapshot.selectedMcp}
                setSelectedMcp={(name) => connectionsStore.setSelectedMcp(name)}
                quickConnect={extensionItems.quickConnectEntries}
                enablementContext={enablementContext}
                builtInExtensionsDisabled={builtInExtensionsDisabled}
                connectMcp={(entry) => {
                  return connectionsStore.connectMcp(entry);
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
                readConfigFile={readMcpConfigFile}
                installedSkills={librarySkills}
                installedCommands={libraryCommands}
                installedAgents={libraryAgents}
                availableConnectMcpServers={libraryConnectMcpServers}
                availableConnectMcpStatuses={connectCapabilities.mcpStatuses}
                inventoryLoading={connectCapabilitiesLoading || (orgMcpConnections.loading && !orgMcpConnections.loaded)}
                installedPlugins={libraryConnectPlugins}
                orgMcpItems={orgMcpConnectionItems}
                organizationName={cloudSession.activeOrgName}
                orgMcpError={orgMcpConnections.error}
                uninstallSkill={(name) => { void extensionsStore.uninstallSkill(name); }}
                removeCloudPlugin={(pluginId) => { void extensionsStore.removeCloudOrgPlugin(pluginId); }}
                orgMcpConnectingId={orgMcpConnections.connectingId}
                connectOrgMcp={(connectionId) => { void orgMcpConnections.connect(connectionId); }}
                reconnectOrgMcp={(connectionId) => { void orgMcpConnections.connect(connectionId, { forceFreshAuthorization: true }); }}
                orgMcpDisconnectingId={orgMcpConnections.disconnectingId}
                disconnectOrgMcp={(connectionId) => { void orgMcpConnections.disconnect(connectionId); }}
                readSkill={readLibrarySkill}
                previewClaudePlugin={(url) => extensionsStore.previewClaudePlugin(url)}
                installClaudePlugin={(url) => extensionsStore.installClaudePlugin(url)}
                createLibraryItem={(kind, input) => extensionsStore.createLibraryItem(kind, input)}
                onLibraryListsRefresh={loadLibraryLists}
                initialFilter={initialFilter}
                onFilterChange={onFilterChange}
                initialState={initialState}
                onStateChange={onStateChange}
                detailId={detailId}
                onDetailIdChange={onDetailIdChange}
                onRefresh={onRefresh}
              />
            )}

          />
        );
      case "cloud-account":
        return (
          <CloudAccountView
            developerMode={developerMode}
            session={denSession}
          />
        );
      case "memory":
        return <MemoryView onOpenAccount={openCloudAccountSettings} />;
      case "cloud-providers":
        return (
          <CloudProvidersView
            checkDesktopAppRestriction={checkDesktopRestriction}
            cloudOrgProviders={providerAuthSnapshot.cloudOrgProviders}
            connectCloudProvider={providerAuthStore.connectCloudProvider}
            importedCloudProviders={providerAuthSnapshot.importedCloudProviders}
            importsUnavailable={
              openworkServerSnapshot.openworkServerCapabilities?.config?.read === false ||
              openworkServerSnapshot.openworkServerCapabilities?.config?.write === false
            }
            lastSyncError={providerAuthSnapshot.lastSyncError}
            openworkServerAvailable={Boolean(openworkServerSnapshot.openworkServerClient)}
            onOpenAccount={openCloudAccountSettings}
            refreshCloudOrgProviders={providerAuthStore.refreshCloudOrgProviders}
            runCloudProviderSync={providerAuthStore.runCloudProviderSync}
            serverSync={providerAuthSnapshot.cloudProviderServerSync}
          />
        );
      case "advanced":
        return (
          <AdvancedView
            key={runtimeWorkspaceId ?? selectedWorkspaceId}
            busy={busy}
            clientConnected={Boolean(opencodeClient)}
            opencodeConnectStatus={null}
            openworkServerStatus={openworkServerSnapshot.openworkServerStatus}
            developerMode={developerMode}
            toggleDeveloperMode={toggleDeveloperMode}
            opencodeDevModeEnabled={false}
            openDebugDeepLink={async () => ({ ok: false, message: "Debug deep links are not wired into the React settings route yet." })}
            cloudMcpUrl={openworkCloudMcpUrl}
            canInspectRuntimeConfig={Boolean(openworkClient && selectedWorkspaceId)}
            getRuntimeConfigStatus={async () => {
              if (!openworkClient || !selectedWorkspaceId) {
                throw new Error("Select a workspace to inspect runtime config.");
              }
              return openworkClient.getRuntimeConfigStatus(selectedWorkspaceId);
            }}
            cloudMcpHealth={cloudMcpHealth}
            refreshCloudMcpHealth={refreshCloudMcpHealth}
            organizationServer={denSession}
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
            alphaChannelSupported={
              isElectronRuntime() &&
              isMacPlatform() &&
              readDesktopDistributionInfo().flavor === "public" &&
              desktopConfig.config.allowAlphaUpdates !== false
            }
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
        return (
          <DebugView
            key={runtimeWorkspaceId ?? selectedWorkspaceId}
            {...debugViewProps}
            agentAccess={{
              client: selectedWorkspaceEndpoint?.client ?? openworkClient,
              workspaceId: runtimeWorkspaceId,
              currentModel: currentCloudMcpModel,
              onHealthChange: handleCloudMcpHealthChange,
            }}
            agentContextDiagnostics={{
              scopeKey: diagnosticsScopeKey,
              available: diagnosticsAvailable,
              unavailableReason: diagnosticsUnavailableReason,
              onRun: runAgentContextDiagnostics,
            }}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <>
      {props.standaloneExtensions ? (
        <div data-extensions-main-surface className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
          <SettingsContent>{settingsView}</SettingsContent>
        </div>
      ) : (
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
          onClose={props.onClose ?? (() => navigate(settingsReturnRoute(
            selectedWorkspaceId,
            navigationWorkspaceId,
            navigationSessionId,
          )))}
          compact={props.embedded}
        >
          {settingsView}
        </SettingsShell>
      )}

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onCreateNewSession={() => void handleCreatePaletteSession()}
        onOpenSession={(workspaceId, sessionId) => {
          navigate(workspaceSessionRoute(workspaceId, sessionId));
        }}
        onOpenSettings={(path = "/settings/general") => {
          const settingsPath = path.replace(/^\/settings\//, "");
          if (props.standaloneExtensions) {
            navigate(
              selectedWorkspaceId
                ? workspaceSettingsRoute(selectedWorkspaceId, settingsPath)
                : `/settings/${settingsPath}`,
            );
            return;
          }
          navigateSettingsPath(settingsPath);
        }}
        onOpenExtensions={() => {
          const target = selectedWorkspaceId
            ? workspaceExtensionsRoute(selectedWorkspaceId)
            : globalExtensionsRoute();
          navigate(target);
        }}
        onOpenModelPicker={() => {
          modelPicker.setQuery("");
          modelPicker.setRecentProviderIds(new Set());
          window.requestAnimationFrame(() => modelPicker.setOpen(true));
        }}
        selectedModelLabel={defaultModelLabel}
        sessions={paletteSessionOptions}
        extraItems={[developerModePaletteItem]}
      />

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
        onSubmitOAuth={providerAuthStore.completeProviderAuthOAuth}
        onRefreshProviders={providerAuthStore.refreshProviders}
        showOpenWorkModelsSubscribe={showOpenWorkModelsSubscribe}
        onSubscribeOpenWorkModels={subscribeToOpenWorkModels}
        onClose={() => providerAuthStore.closeProviderAuthModal()}
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
          await abortSessionSafe(activeClient, sessionId, undefined, {
            source: "settings.connections.force_stop_session",
            initiator: "user",
            reason: "force stop active session from connections modal",
          });
        }}
        onReloadEngine={reloadCoordinator.reloadWorkspaceEngine}
        modalState={{
          mcpAuthModalOpen: connectionsSnapshot.mcpAuthModalOpen,
          mcpAuthEntry: connectionsSnapshot.mcpAuthEntry,
          mcpAuthNeedsReload: connectionsSnapshot.mcpAuthNeedsReload,
        }}
        onCloseMcpAuthModal={() => connectionsStore.closeMcpAuthModal()}
        onMcpAuthenticated={(name) => connectionsStore.recordMcpAuthenticated(name)}
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
