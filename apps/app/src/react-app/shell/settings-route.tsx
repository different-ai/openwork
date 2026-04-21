/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { SUGGESTED_PLUGINS } from "../../app/constants";
import { createClient } from "../../app/lib/opencode";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  type OpenworkServerCapabilities,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "../../app/lib/openwork-server";
import type { Client, ProviderListItem, SettingsTab, WorkspaceDisplay, WorkspacePreset, WorkspaceSessionGroup } from "../../app/types";
import { isSandboxWorkspace } from "../../app/utils";
import { currentLocale, t, setLocale, type Language } from "../../i18n";
import { createConnectionsStore, useConnectionsStoreSnapshot } from "../domains/connections/store";
import { createOpenworkServerStore, useOpenworkServerStoreSnapshot } from "../domains/connections/openwork-server-store";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "../domains/connections/provider-auth/store";
import ProviderAuthModal from "../domains/connections/provider-auth/provider-auth-modal";
import ConnectionsModals from "../domains/connections/modals";
import { GeneralSettingsView } from "../domains/settings/pages/general-view";
import { AdvancedView } from "../domains/settings/pages/advanced-view";
import { AppearanceView } from "../domains/settings/pages/appearance-view";
import { AutomationsView } from "../domains/settings/pages/automations-view";
import { DebugView } from "../domains/settings/pages/debug-view";
import { DenView } from "../domains/settings/pages/den-view";
import { ExtensionsView } from "../domains/settings/pages/extensions-view";
import { McpView } from "../domains/settings/pages/mcp-view";
import { RecoveryView } from "../domains/settings/pages/recovery-view";
import { SkillsView } from "../domains/settings/pages/skills-view";
import { UpdatesView } from "../domains/settings/pages/updates-view";
import { useDebugViewModel } from "../domains/settings/state/debug-view-model";
import { useBootState } from "./boot-state";
import { SettingsShell } from "../domains/settings/shell/settings-shell";
import { createAutomationsStore, useAutomationsStoreSnapshot } from "../domains/settings/state/automations-store";
import { createExtensionsStore, useExtensionsStoreSnapshot } from "../domains/settings/state/extensions-store";
import { usePlatform } from "../kernel/platform";
import { useLocal } from "../kernel/local-provider";
import {
  DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  useWorkspaceShellLayout,
} from "./workspace-shell-layout";
import {
  openworkServerInfo,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type WorkspaceInfo,
} from "../../app/lib/tauri";
import { isDesktopProviderBlocked } from "../../app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction } from "../domains/cloud/desktop-config-provider";
import { useCloudProviderAutoSync } from "../domains/cloud/use-cloud-provider-auto-sync";
import { isMacPlatform, isTauriRuntime, normalizeDirectoryPath } from "../../app/utils";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import { ModelPickerModal } from "../domains/session/modals/model-picker-modal";
import type { ModelOption, ModelRef } from "../../app/types";

type RouteWorkspace = OpenworkWorkspaceInfo & {
  displayNameResolved: string;
};

function mapDesktopWorkspace(workspace: WorkspaceInfo): RouteWorkspace {
  return {
    ...workspace,
    displayNameResolved:
      workspace.displayName?.trim() ||
      workspace.name?.trim() ||
      workspace.path?.trim() ||
      t("session.workspace_fallback"),
  };
}

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

async function resolveRouteOpenworkConnection() {
  const settings = readOpenworkServerSettings();
  let normalizedBaseUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
  let resolvedToken = settings.token?.trim() ?? "";

  if ((!normalizedBaseUrl || !resolvedToken) && isTauriRuntime()) {
    try {
      const info = await openworkServerInfo();
      normalizedBaseUrl =
        normalizeOpenworkServerUrl(info.connectUrl ?? info.baseUrl ?? info.lanUrl ?? info.mdnsUrl ?? "") ??
        normalizedBaseUrl;
      resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || resolvedToken;
    } catch {
      // ignore and fall back to stored settings only
    }
  }

  return { normalizedBaseUrl, resolvedToken };
}

type PersistedThemeMode = "light" | "dark" | "system";

const SETTINGS_THEME_KEY = "openwork.react.settings.theme-mode";
const SETTINGS_HIDE_TITLEBAR_KEY = "openwork.react.settings.hide-titlebar";
const SETTINGS_UPDATE_AUTO_CHECK_KEY = "openwork.react.settings.update-auto-check";
const SETTINGS_UPDATE_AUTO_DOWNLOAD_KEY = "openwork.react.settings.update-auto-download";

function workspaceLabel(workspace: OpenworkWorkspaceInfo) {
  return (
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    t("session.workspace_fallback")
  );
}

function toSessionGroups(
  workspaces: RouteWorkspace[],
  sessionsByWorkspaceId: Record<string, any[]>,
  errorsByWorkspaceId: Record<string, string | null>,
): WorkspaceSessionGroup[] {
  return workspaces.map((workspace) => ({
    workspace,
    sessions: (sessionsByWorkspaceId[workspace.id] ?? []) as WorkspaceSessionGroup["sessions"],
    status: errorsByWorkspaceId[workspace.id] ? "error" : "ready",
    error: errorsByWorkspaceId[workspace.id],
  }));
}

function parseSettingsPath(pathname: string): {
  tab: SettingsTab;
  redirectPath: string | null;
  extensionsSection?: "all" | "mcp" | "plugins";
} {
  const trimmed = pathname.replace(/^\/settings\/?/, "").replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return { tab: "general", redirectPath: "/settings/general" };
  }

  const [head, tail] = trimmed.split("/");
  switch (head) {
    case "general":
    case "den":
    case "automations":
    case "skills":
    case "messaging":
    case "advanced":
    case "appearance":
    case "updates":
    case "recovery":
    case "debug":
      return { tab: head, redirectPath: null };
    case "extensions":
      if (tail === "mcp") return { tab: "extensions", redirectPath: null, extensionsSection: "mcp" };
      if (tail === "plugins") return { tab: "extensions", redirectPath: null, extensionsSection: "plugins" };
      return { tab: "extensions", redirectPath: null, extensionsSection: "all" };
    default:
      return { tab: "general", redirectPath: "/settings/general" };
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

function readStoredThemeMode(): PersistedThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(SETTINGS_THEME_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
  } catch {
    return "system";
  }
}

function applyThemeMode(mode: PersistedThemeMode) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const resolved = mode === "system" ? (prefersDark ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
}

function PlaceholderSettingsView(props: { title: string; detail: string }) {
  return (
    <div className="rounded-[28px] border border-dls-border bg-dls-surface p-5 text-sm text-gray-10 md:p-6">
      <div className="font-medium text-gray-12">{props.title}</div>
      <div className="mt-2 leading-relaxed">{props.detail}</div>
    </div>
  );
}

export function SettingsRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const local = useLocal();
  const platform = usePlatform();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const route = parseSettingsPath(location.pathname);

  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, any[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [openworkClient, setOpenworkClient] = useState<OpenworkServerClient | null>(null);
  const [activeClient, setActiveClient] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [developerMode, setDeveloperMode] = useState(false);
  const [themeMode, setThemeMode] = useState<PersistedThemeMode>(readStoredThemeMode);
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
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
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
    selectedWorkspaceDisplay: emptyWorkspaceDisplay as WorkspaceDisplay,
    providerItems: [] as ProviderListItem[],
    providerDefaults: {} as Record<string, string>,
    providerConnectedIds: [] as string[],
    disabledProviders: [] as string[],
    developerMode: false,
  });

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );
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
    selectedWorkspaceDisplay,
    providerItems: providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviders,
    developerMode,
  };

  const shellLayout = useWorkspaceShellLayout({
    expandedRightWidth: 320,
    defaultLeftWidth: DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    minLeftWidth: MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    maxLeftWidth: MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  });

  const openworkServerStore = useMemo(
    () =>
      createOpenworkServerStore({
        startupPreference: () => {
          // In Tauri desktop mode, prefer the embedded host server (hostInfo.baseUrl)
          // unless the user has explicitly pinned a remote urlOverride.
          if (!isTauriRuntime()) return "server";
          const stored = readOpenworkServerSettings();
          return stored.urlOverride?.trim() ? "server" : "local";
        },
        documentVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
        developerMode: () => routeStateRef.current.developerMode,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        activeClient: () => routeStateRef.current.activeClient,
        selectedWorkspaceDisplay: () => routeStateRef.current.selectedWorkspaceDisplay,
        restartLocalServer: async () => false,
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
        developerMode: () => routeStateRef.current.developerMode,
      }),
    [openworkServerStore],
  );
  const providerAuthStore = useMemo(
    () =>
      createProviderAuthStore({
        client: () => routeStateRef.current.activeClient,
        providers: () => routeStateRef.current.providerItems,
        providerDefaults: () => routeStateRef.current.providerDefaults,
        providerConnectedIds: () => routeStateRef.current.providerConnectedIds,
        disabledProviders: () => routeStateRef.current.disabledProviders,
        selectedWorkspaceDisplay: () => routeStateRef.current.selectedWorkspaceDisplay,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        openworkServer: openworkServerStore,
        setProviders,
        setProviderDefaults,
        setProviderConnectedIds,
        setDisabledProviders,
        markOpencodeConfigReloadRequired: () => {
          setConfigActionStatus(t("settings.config_updated"));
        },
      }),
    [openworkServerStore],
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
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        setBusy,
        setBusyLabel,
        setBusyStartedAt: () => {},
        setError: setRouteError,
      }),
    [openworkServerStore],
  );
  const automationsStore = useMemo(
    () =>
      createAutomationsStore({
        selectedWorkspaceId: () => routeStateRef.current.selectedWorkspaceId,
        selectedWorkspaceRoot: () => routeStateRef.current.selectedWorkspaceRoot,
        runtimeWorkspaceId: () => routeStateRef.current.runtimeWorkspaceId,
        openworkServer: openworkServerStore,
        schedulerPluginInstalled: () => false,
      }),
    [openworkServerStore],
  );

  const openworkServerSnapshot = useOpenworkServerStoreSnapshot(openworkServerStore);
  const connectionsSnapshot = useConnectionsStoreSnapshot(connectionsStore);
  const providerAuthSnapshot = useProviderAuthStoreSnapshot(providerAuthStore);
  useExtensionsStoreSnapshot(extensionsStore);
  useAutomationsStoreSnapshot(automationsStore);

  const debugViewProps = useDebugViewModel({
    developerMode,
    openworkServerStore,
    openworkServerSnapshot,
    runtimeWorkspaceId: selectedWorkspace?.id ?? null,
    selectedWorkspaceRoot,
    setRouteError,
  });

  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId),
    [errorsByWorkspaceId, sessionsByWorkspaceId, workspaces],
  );

  const opencodeBaseUrl = useMemo(() => {
    if (!selectedWorkspaceId || !baseUrl) return "";
    const mounted = buildOpenworkWorkspaceBaseUrl(baseUrl, selectedWorkspaceId) ?? baseUrl;
    return `${mounted.replace(/\/+$/, "")}/opencode`;
  }, [baseUrl, selectedWorkspaceId]);

  const opencodeClient = useMemo(
    () =>
      opencodeBaseUrl && token
        ? createClient(opencodeBaseUrl, undefined, { token, mode: "openwork" })
        : null,
    [opencodeBaseUrl, token],
  );

  useEffect(() => {
    setActiveClient(opencodeClient);
  }, [opencodeClient]);

  useEffect(() => {
    if (!modelPickerOpen || !opencodeClient) return;
    let cancelled = false;
    void providerAuthStore.refreshProviders();
    void (async () => {
      try {
        const res = await opencodeClient.config.providers({
          directory: selectedWorkspaceRoot || undefined,
        });
        const data = (res as { data?: { providers?: Array<{ id: string; name: string; source?: string; models: Record<string, { id: string; name: string }> }> } }).data;
        if (cancelled || !data?.providers) return;
        const options: ModelOption[] = [];
        for (const provider of data.providers) {
          const modelIds = Object.keys(provider.models);
          const hasModels = modelIds.length > 0;
          for (const id of modelIds) {
            const model = provider.models[id];
            options.push({
              providerID: provider.id,
              modelID: id,
              title: model.name || id,
              description: provider.name,
              behaviorTitle: "Reasoning",
              behaviorLabel: "Default",
              behaviorDescription: "",
              behaviorValue: null,
              isFree: false,
              isConnected: hasModels,
            });
          }
        }
        setModelOptions(options);
      } catch (error) {
        setRouteError(
          error instanceof Error
            ? error.message
            : t("app.unknown_error"),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelPickerOpen, opencodeClient, selectedWorkspaceRoot]);

  useEffect(() => {
    local.setUi((previous) => ({ ...previous, view: "settings", tab: route.tab }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- local is stable via context
  }, [route.tab]);

  useEffect(() => {
    applyThemeMode(themeMode);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SETTINGS_THEME_KEY, themeMode);
    }
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
    setLoading(true);
    setRouteError(null);
    try {
      const desktopList = isTauriRuntime() ? await workspaceBootstrap().catch(() => null) : null;
      const desktopWorkspaces = (desktopList?.workspaces ?? []).map(mapDesktopWorkspace);
      const { normalizedBaseUrl, resolvedToken } = await resolveRouteOpenworkConnection();

      if (!normalizedBaseUrl || !resolvedToken) {
        setOpenworkClient(null);
        setBaseUrl("");
        setToken("");
        setWorkspaces(desktopWorkspaces);
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        setSelectedWorkspaceId(resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "");
        return;
      }

      const client = createOpenworkServerClient({ baseUrl: normalizedBaseUrl, token: resolvedToken });
      const list = await client.listWorkspaces();
      const serverWorkspaces = list.items.map((workspace) => ({
        ...workspace,
        displayNameResolved: workspaceLabel(workspace),
      }));
      // Mirror Solid's `applyServerLocalWorkspaces`: prefer server-registered
      // local workspaces (their IDs are what subsequent API calls need) and
      // append any remote entries from the desktop list since the server
      // doesn't track remotes.
      const desktopRemotes = desktopWorkspaces.filter(
        (workspace) => workspace.workspaceType === "remote",
      );
      const nextWorkspaces =
        serverWorkspaces.length > 0
          ? [...serverWorkspaces, ...desktopRemotes]
          : desktopWorkspaces;
      const sessionEntries = await Promise.all(
        nextWorkspaces.map(async (workspace) => {
          try {
            const response = await client.listSessions(workspace.id, { limit: 200 });
            const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
            const items = workspaceRoot
              ? (response.items ?? []).filter((session: any) =>
                  normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
                )
              : (response.items ?? []);
            return { workspaceId: workspace.id, sessions: items, error: null as string | null };
          } catch (error) {
            return {
              workspaceId: workspace.id,
              sessions: [],
              error: error instanceof Error ? error.message : t("app.unknown_error"),
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
      setSelectedWorkspaceId((current) => current || resolveWorkspaceListSelectedId(desktopList) || list.activeId?.trim() || nextWorkspaces[0]?.id || "");
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : t("app.unknown_error"));
    } finally {
      setLoading(false);
      // Settings can be the first route a user lands on (direct link, deep
      // link, or after reload). Let the boot overlay dismiss once we've
      // completed our first data load.
      markBootRouteReady();
    }
  }, [markBootRouteReady]);

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

  useEffect(() => {
    openworkServerStore.start();
    connectionsStore.start();
    providerAuthStore.start();
    extensionsStore.start();
    automationsStore.start();

    return () => {
      automationsStore.dispose();
      extensionsStore.dispose();
      providerAuthStore.dispose();
      connectionsStore.dispose();
      openworkServerStore.dispose();
    };
  }, [automationsStore, connectionsStore, extensionsStore, openworkServerStore, providerAuthStore]);

  // Periodically refresh cloud providers from Den while signed in (dev
  // #1509 "auto-sync cloud providers"). Mounted here because the settings
  // route always owns the provider-auth store and we don't want to fire
  // the timer while the user is in an unrelated tree.
  useCloudProviderAutoSync(providerAuthStore.refreshCloudOrgProviders);

  useEffect(() => {
    openworkServerStore.syncFromOptions();
    connectionsStore.syncFromOptions();
    providerAuthStore.syncFromOptions();
    extensionsStore.syncFromOptions();
    automationsStore.syncFromOptions();
  }, [
    activeClient,
    automationsStore,
    connectionsStore,
    extensionsStore,
    openworkServerStore,
    providerAuthStore,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
    selectedWorkspaceRoot,
  ]);

  useEffect(() => {
    if (!opencodeClient) {
      setProviders([]);
      setProviderDefaults({});
      setProviderConnectedIds([]);
      setDisabledProviders([]);
      return;
    }
    void providerAuthStore.refreshProviders();
    void connectionsStore.refreshMcpServers();
  }, [connectionsStore, opencodeClient, providerAuthStore, selectedWorkspace?.id]);

  if (route.redirectPath) {
    return <Navigate to={route.redirectPath} replace />;
  }

  const selectedWorkspaceName = selectedWorkspace?.displayNameResolved ?? t("session.workspace_fallback");
  const workspaceType = selectedWorkspace?.workspaceType ?? "local";
  const isRemoteWorkspace = workspaceType === "remote";
  const defaultModelLabel = local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}/${local.prefs.defaultModel.modelID}`
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
    ? t("settings.connected_providers_count", undefined, { count: providerConnectedIds.length })
    : t("settings.no_providers_connected");
  const connectedProviders = providers
    .filter((provider) => providerConnectedIds.includes(provider.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
    }));
  const mcpConnectedAppsCount = connectionsSnapshot.mcpServers.length;
  const routeOpenworkStatus = openworkClient ? "connected" : "disconnected";
  const routeOpenworkCapabilities: OpenworkServerCapabilities | null = openworkClient
    ? {
        skills: { read: true, write: true, source: "openwork" },
        plugins: { read: true, write: true },
        mcp: { read: true, write: true },
        commands: { read: true, write: true },
        config: { read: true, write: true },
        proxy: { opencode: true, opencodeRouter: false },
      }
    : null;

  const handleOpenCreateWorkspace = () => {
    setCreateWorkspaceRemoteError(null);
    setCreateWorkspaceOpen(true);
  };

  const handleCreateWorkspace = async (preset: WorkspacePreset, folder: string | null) => {
    if (!folder) return;
    setCreateWorkspaceBusy(true);
    try {
      const list = await workspaceCreate({
        folderPath: folder,
        name: folderNameFromPath(folder),
        preset,
      });
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      await refreshRouteState();
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
      const list = await workspaceCreateRemote({
        baseUrl: baseUrlValue,
        openworkHostUrl: baseUrlValue,
        openworkToken: input.openworkToken?.trim() || null,
        displayName: input.displayName?.trim() || null,
        directory: input.directory?.trim() || null,
        remoteType: "openwork",
      });
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

  const settingsView = (() => {
    switch (route.tab) {
      case "general":
        return (
          <GeneralSettingsView
            authorizedFoldersPanel={{
              openworkServerClient: openworkClient,
              openworkServerStatus: routeOpenworkStatus,
              openworkServerCapabilities: routeOpenworkCapabilities,
              runtimeWorkspaceId: selectedWorkspace?.id ?? null,
              selectedWorkspaceRoot,
              activeWorkspaceType: workspaceType,
              onConfigUpdated: () => {
                setConfigActionStatus(t("settings.config_updated"));
                void providerAuthStore.refreshProviders();
                void connectionsStore.refreshMcpServers();
              },
            }}
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
            onOpenProviderAuth={() => providerAuthStore.openProviderAuthModal()}
            onDisconnectProvider={async (providerId) => {
              await providerAuthStore.disconnectProvider(providerId);
            }}
            canDisconnectProvider={() => true}
            defaultModelLabel={defaultModelLabel}
            defaultModelRef={defaultModelRef}
            onChangeDefaultModel={() => {
              setModelPickerQuery("");
              setModelPickerOpen(true);
            }}
            showThinking={local.prefs.showThinking}
            onToggleShowThinking={() => {
              local.setPrefs((previous) => ({ ...previous, showThinking: !previous.showThinking }));
            }}
            defaultModelVariantLabel={defaultModelVariantLabel}
            onConfigureModelBehavior={() => {
              setRouteError("Model behavior picker is not wired into the React settings route yet.");
            }}
            autoCompactContext={false}
            autoCompactContextBusy={false}
            onToggleAutoCompactContext={() => {
              setRouteError("Auto-compact controls are not wired into the React settings route yet.");
            }}
            onSendFeedback={() => platform.openLink("https://openworklabs.com/docs")}
            onJoinDiscord={() => platform.openLink("https://discord.gg/VEhNQXxYMB")}
            onReportIssue={() => platform.openLink("https://github.com/different-ai/openwork/issues/new?template=bug.yml")}
          />
        );
      case "automations":
        return (
          <AutomationsView
            automations={automationsStore}
            busy={busy}
            selectedWorkspaceRoot={selectedWorkspaceRoot}
            createSessionAndOpen={async () => undefined}
            newTaskDisabled={!opencodeClient}
            schedulerInstalled={false}
            canEditPlugins={!isRemoteWorkspace}
            addPlugin={async () => {
              setRouteError("Scheduler plugin install is not wired into the React settings route yet.");
            }}
            reloadWorkspaceEngine={async () => {
              setRouteError("Workspace reload is not wired into the React settings route yet.");
            }}
            reloadBusy={false}
            canReloadWorkspace={false}
            openLink={(url) => platform.openLink(url)}
          />
        );
      case "skills":
        return (
          <SkillsView
            workspaceName={selectedWorkspaceName}
            busy={busy}
            canInstallSkillCreator={!isRemoteWorkspace}
            canUseDesktopTools={!isRemoteWorkspace}
            accessHint={isRemoteWorkspace ? t("app.skills_hint_readonly") : null}
            extensions={extensionsStore}
            onOpenLink={(url) => platform.openLink(url)}
            createSessionAndOpen={async () => undefined}
          />
        );
      case "extensions":
        return (
          <ExtensionsView
            busy={busy}
            selectedWorkspaceRoot={selectedWorkspaceRoot}
            isRemoteWorkspace={isRemoteWorkspace}
            canEditPlugins={!isRemoteWorkspace}
            canUseGlobalScope={!isRemoteWorkspace}
            accessHint={isRemoteWorkspace ? t("app.plugins_hint_readonly") : null}
            suggestedPlugins={SUGGESTED_PLUGINS}
            extensions={extensionsStore}
            mcpConnectedAppsCount={mcpConnectedAppsCount}
            initialSection={route.extensionsSection}
            setSectionRoute={(section) => navigate(`/settings/extensions/${section}`)}
            onRefresh={() => {
              void connectionsStore.refreshMcpServers();
              void extensionsStore.refreshPlugins();
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
                quickConnect={connectionsStore.quickConnect}
                connectMcp={(entry) => {
                  void connectionsStore.connectMcp(entry);
                }}
                authorizeMcp={(entry) => {
                  void connectionsStore.authorizeMcp(entry);
                }}
                logoutMcpAuth={(name) => connectionsStore.logoutMcpAuth(name)}
                removeMcp={(name) => {
                  void connectionsStore.removeMcp(name);
                }}
                readConfigFile={(scope) => connectionsStore.readMcpConfigFile(scope)}
                showHeader={false}
              />
            }
          />
        );
      case "den":
        return (
          <DenView
            developerMode={developerMode}
            extensions={extensionsStore}
            openLink={(url) => platform.openLink(url)}
            connectRemoteWorkspace={async () => false}
            openTeamBundle={async () => {}}
            cloudOrgProviders={providerAuthSnapshot.cloudOrgProviders}
            importedCloudProviders={providerAuthSnapshot.importedCloudProviders}
            refreshCloudOrgProviders={providerAuthStore.refreshCloudOrgProviders}
            connectCloudProvider={providerAuthStore.connectCloudProvider}
            removeCloudProvider={providerAuthStore.removeCloudProvider}
          />
        );
      case "advanced":
        return (
          <AdvancedView
            busy={busy}
            baseUrl={opencodeBaseUrl}
            headerStatus={openworkServerSnapshot.openworkServerStatus}
            clientConnected={Boolean(opencodeClient)}
            opencodeConnectStatus={null}
            openworkServerStatus={openworkServerSnapshot.openworkServerStatus}
            openworkServerUrl={openworkServerSnapshot.openworkServerUrl}
            openworkReconnectBusy={openworkServerSnapshot.openworkReconnectBusy}
            reconnectOpenworkServer={openworkServerStore.reconnectOpenworkServer}
            engineInfo={null}
            restartLocalServer={async () => false}
            stopHost={() => {}}
            developerMode={developerMode}
            toggleDeveloperMode={() => setDeveloperMode((current) => !current)}
            opencodeDevModeEnabled={false}
            openDebugDeepLink={async () => ({ ok: false, message: "Debug deep links are not wired into the React settings route yet." })}
            opencodeEnableExa={false}
            toggleOpencodeEnableExa={() => {
              setRouteError("EXA controls are not wired into the React settings route yet.");
            }}
            microsandboxCreateSandboxEnabled={local.prefs.featureFlags.microsandboxCreateSandbox}
            toggleMicrosandboxCreateSandbox={() => {
              local.setPrefs((previous) => ({
                ...previous,
                featureFlags: {
                  ...previous.featureFlags,
                  microsandboxCreateSandbox: !previous.featureFlags.microsandboxCreateSandbox,
                },
              }));
            }}
            configView={{
              busy,
              clientConnected: Boolean(opencodeClient),
              anyActiveRuns: false,
              openworkServerStatus: openworkServerSnapshot.openworkServerStatus,
              openworkServerUrl: openworkServerSnapshot.openworkServerUrl,
              openworkServerSettings: openworkServerSnapshot.openworkServerSettings,
              openworkServerHostInfo: openworkServerSnapshot.openworkServerHostInfo,
              runtimeWorkspaceId: selectedWorkspace?.id ?? null,
              updateOpenworkServerSettings: openworkServerStore.updateOpenworkServerSettings,
              resetOpenworkServerSettings: openworkServerStore.resetOpenworkServerSettings,
              testOpenworkServerConnection: openworkServerStore.testOpenworkServerConnection,
              canReloadWorkspace: false,
              reloadWorkspaceEngine: async () => {
                setRouteError("Workspace reload is not wired into the React settings route yet.");
              },
              reloadBusy: false,
              reloadError: routeError,
              developerMode,
            }}
          />
        );
      case "appearance":
        return (
          <AppearanceView
            busy={busy}
            themeMode={themeMode}
            setThemeMode={setThemeMode}
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
            appVersion={null}
            updateEnv={null}
            updateAutoCheck={updateAutoCheck}
            toggleUpdateAutoCheck={() => setUpdateAutoCheck((current) => !current)}
            updateAutoDownload={updateAutoDownload}
            toggleUpdateAutoDownload={() => setUpdateAutoDownload((current) => !current)}
            updateStatus={null}
            anyActiveRuns={false}
            checkForUpdates={() => {
              setRouteError("App update checks are not wired into the React settings route yet.");
            }}
            downloadUpdate={() => {
              setRouteError("App update downloads are not wired into the React settings route yet.");
            }}
            installUpdateAndRestart={() => {
              setRouteError("App update install is not wired into the React settings route yet.");
            }}
            releaseChannel={local.prefs.releaseChannel ?? "stable"}
            onReleaseChannelChange={(next) =>
              local.setPrefs((previous) => ({ ...previous, releaseChannel: next }))
            }
            alphaChannelSupported={isTauriRuntime() && isMacPlatform()}
          />
        );
      case "recovery":
        return (
          <RecoveryView
            anyActiveRuns={false}
            workspaceConfigPath={selectedWorkspaceRoot ? `${selectedWorkspaceRoot}/opencode.json` : ""}
            revealConfigBusy={revealConfigBusy}
            onRevealWorkspaceConfig={async () => {
              setRevealConfigBusy(true);
              setConfigActionStatus("Reveal workspace config is not wired into the React settings route yet.");
              setRevealConfigBusy(false);
            }}
            resetConfigBusy={resetConfigBusy}
            onResetAppConfigDefaults={async () => {
              setResetConfigBusy(true);
              setConfigActionStatus("Reset app config defaults is not wired into the React settings route yet.");
              setResetConfigBusy(false);
            }}
            configActionStatus={configActionStatus}
            cacheRepairBusy={false}
            cacheRepairResult={null}
            onRepairOpencodeCache={() => {
              setRouteError("Cache repair is not wired into the React settings route yet.");
            }}
            dockerCleanupBusy={false}
            dockerCleanupResult={null}
            onCleanupOpenworkDockerContainers={() => {
              setRouteError("Docker cleanup is not wired into the React settings route yet.");
            }}
          />
        );
      case "messaging":
        return (
          <PlaceholderSettingsView
            title="Messaging settings are not fully ported"
            detail="The React settings route replaces the Solid bridge for the ported settings surfaces, but messaging still depends on app state that has not been moved over yet."
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
        onSelectTab={(tab) => navigate(`/settings/${tab}`)}
        developerMode={developerMode}
        selectedWorkspaceName={selectedWorkspaceName}
        headerStatus={routeOpenworkStatus}
        busyHint={loading ? t("session.loading_detail") : busyLabel}
        workspaceSessionListProps={{
          workspaceSessionGroups,
          selectedWorkspaceId,
          developerMode,
          selectedSessionId: null,
          connectingWorkspaceId: null,
          workspaceConnectionStateById: {},
          newTaskDisabled: !opencodeClient,
          onSelectWorkspace: async (workspaceId) => {
            setSelectedWorkspaceId(workspaceId);
            return true;
          },
          onOpenSession: (_workspaceId, sessionId) => navigate(`/session/${sessionId}`),
          onCreateTaskInWorkspace: () => navigate("/session"),
          onOpenRenameWorkspace: () => {},
          onShareWorkspace: () => {},
          onRevealWorkspace: () => {},
          onRecoverWorkspace: async () => true,
          onTestWorkspaceConnection: async () => true,
          onEditWorkspaceConnection: () => {},
          onForgetWorkspace: () => {},
          onOpenCreateWorkspace: handleOpenCreateWorkspace,
        }}
        onClose={() => navigate("/session")}
        sidebarWidth={shellLayout.leftSidebarWidth}
        onSidebarResizeStart={shellLayout.startLeftSidebarResize}
        error={routeError}
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
        // opencode-provider gating via the `blockZenModel` restriction.
        providers={providerAuthSnapshot.providerAuthProviders.filter(
          (provider) =>
            !isDesktopProviderBlocked({
              providerId: provider.id,
              checkRestriction: checkDesktopRestriction,
            }),
        )}
        connectedProviderIds={providerConnectedIds}
        authMethods={providerAuthSnapshot.providerAuthMethods}
        onSelect={providerAuthStore.startProviderAuth}
        onSubmitApiKey={providerAuthStore.submitProviderApiKey}
        onConnectCloudProvider={providerAuthStore.connectCloudProvider}
        onSubmitOAuth={providerAuthStore.completeProviderAuthOAuth}
        onRefreshProviders={providerAuthStore.refreshProviders}
        onClose={() => providerAuthStore.closeProviderAuthModal()}
      />
      <CreateWorkspaceModal
        open={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onConfirm={handleCreateWorkspace}
        onConfirmRemote={handleCreateRemoteWorkspace}
        onPickFolder={() => pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<string | null>}
        submitting={createWorkspaceBusy}
        remoteSubmitting={createWorkspaceRemoteBusy}
        remoteError={createWorkspaceRemoteError}
      />
      <ConnectionsModals
        client={activeClient}
        projectDir={selectedWorkspaceRoot}
        language={currentLocale() as Language}
        reloadBlocked={false}
        activeSessions={[]}
        isRemoteWorkspace={selectedWorkspace?.workspaceType === "remote"}
        onForceStopSession={() => undefined}
        onReloadEngine={() => undefined}
        modalState={{
          mcpAuthModalOpen: connectionsSnapshot.mcpAuthModalOpen,
          mcpAuthEntry: connectionsSnapshot.mcpAuthEntry,
          mcpAuthNeedsReload: connectionsSnapshot.mcpAuthNeedsReload,
        }}
        onCloseMcpAuthModal={() => connectionsStore.closeMcpAuthModal()}
        onCompleteMcpAuthModal={() => connectionsStore.completeMcpAuthModal()}
      />
      <ModelPickerModal
        open={modelPickerOpen}
        options={modelOptions}
        filteredOptions={modelOptions.filter((opt) => {
          const q = modelPickerQuery.trim().toLowerCase();
          if (!q) return true;
          return (
            opt.title.toLowerCase().includes(q) ||
            opt.providerID.toLowerCase().includes(q) ||
            opt.modelID.toLowerCase().includes(q)
          );
        })}
        query={modelPickerQuery}
        setQuery={setModelPickerQuery}
        target="default"
        current={
          local.prefs.defaultModel ?? { providerID: "", modelID: "" }
        }
        onSelect={(next: ModelRef) => {
          local.setPrefs((prev) => ({ ...prev, defaultModel: next }));
          setModelPickerOpen(false);
        }}
        onBehaviorChange={() => {}}
        onOpenSettings={() => {}}
        onClose={() => setModelPickerOpen(false)}
      />
    </>
  );
}
