/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";

import { SUGGESTED_PLUGINS } from "../../app/constants";
import { createClient } from "../../app/lib/opencode";
import {
  createOpenworkServerClient,
  isLoopbackOpenworkServerUrl,
  readOpenworkServerSettings,
  type OpenworkServerCapabilities,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "../../app/lib/openwork-server";
import { resolveWorkspaceEndpoint } from "../../app/lib/workspace-endpoint";
import { buildOpenworkEnvRuntimeKey } from "../../app/lib/openwork-env-runtime";
import type {
  Client,
  ProviderListItem,
  SettingsTab,
  WorkspaceConnectionState,
  WorkspaceDisplay,
  WorkspacePreset,
  WorkspaceSessionGroup,
} from "../../app/types";
import { getWorkspaceTaskLoadErrorDisplay, isSandboxWorkspace } from "../../app/utils";
import { currentLocale, t, setLocale, type Language } from "../../i18n";
import { createConnectionsStore, useConnectionsStoreSnapshot } from "../domains/connections/store";
import { createOpenworkServerStore, useOpenworkServerStoreSnapshot } from "../domains/connections/openwork-server-store";
import { createProviderAuthStore, useProviderAuthStoreSnapshot } from "../domains/connections/provider-auth/store";
import ProviderAuthModal from "../domains/connections/provider-auth/provider-auth-modal";
import ConnectionsModals from "../domains/connections/modals";
import { GeneralSettingsView } from "../domains/settings/pages/general-view";
import { AdvancedView } from "../domains/settings/pages/advanced-view";
import { AppearanceView } from "../domains/settings/pages/appearance-view";
import { DebugView } from "../domains/settings/pages/debug-view";
import { DenView } from "../domains/settings/pages/den-view";
import { EnvironmentView } from "../domains/settings/pages/environment-view";
import { ExtensionsView } from "../domains/settings/pages/extensions-view";
import { McpView } from "../domains/settings/pages/mcp-view";
import { RecoveryView } from "../domains/settings/pages/recovery-view";
import { MessagingView } from "../domains/settings/pages/messaging-view";
import { SkillsView } from "../domains/settings/pages/skills-view";
import { UpdatesView } from "../domains/settings/pages/updates-view";
import { useDebugViewModel } from "../domains/settings/state/debug-view-model";
import { useMessagingViewProps } from "../domains/settings/state/messaging-view-state";
import { useElectronUpdaterState } from "../domains/settings/state/electron-updater-state";
import { useBootState } from "./boot-state";
import { SettingsShell } from "../domains/settings/shell/settings-shell";
import { createExtensionsStore, useExtensionsStoreSnapshot } from "../domains/settings/state/extensions-store";
import { usePlatform } from "../kernel/platform";
import { useLocal } from "../kernel/local-provider";
import {
  openworkServerInfo,
  openworkServerRestart,
  engineStart,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceExportConfig,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  workspaceUpdateDisplayName,
  type WorkspaceInfo,
  revealDesktopItemInDir,
} from "../../app/lib/desktop";
import { isDesktopProviderBlocked } from "../../app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction, useDesktopConfig } from "../domains/cloud/desktop-config-provider";
import { useCloudProviderAutoSync } from "../domains/cloud/use-cloud-provider-auto-sync";
import { isDesktopRuntime, isElectronRuntime, isMacPlatform, normalizeDirectoryPath, safeStringify } from "../../app/utils";
import { CreateRemoteWorkspaceModal } from "../domains/workspace/create-remote-workspace-modal";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import { RenameWorkspaceModal } from "../domains/workspace/rename-workspace-modal";
import { ShareWorkspaceModal } from "../domains/workspace/share-workspace-modal";
import { useShareWorkspaceState } from "../domains/workspace/share-workspace-state";
import { useRemoteWorkspaceConnectionEditor } from "../domains/workspace/use-remote-workspace-connection-editor";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "../domains/workspace/remote-workspace-diagnostics";
import { ModelPickerModal } from "../domains/session/modals/model-picker-modal";
import type { ModelOption, ModelRef } from "../../app/types";
import { workspaceSwatchColor } from "../domains/session/sidebar/utils";
import { recordInspectorEvent } from "./app-inspector";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import { abortSessionSafe } from "../../app/lib/opencode-session";
import { useReloadCoordinator } from "./reload-coordinator";
import { buildFeedbackUrl } from "../../app/lib/feedback";
import { readActiveWorkspaceId, writeActiveWorkspaceId } from "./session-memory";
import { workspaceSessionRoute, workspaceSettingsRoute } from "./workspace-routes";

type RouteWorkspace = OpenworkWorkspaceInfo & {
  displayNameResolved: string;
};

const ROUTE_OPENWORK_CAPABILITIES: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
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

function describeRouteError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : t("app.unknown_error");
}

function describeWorkspaceCreateError(error: unknown) {
  const message = describeRouteError(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("operation timed out") ||
    lower.includes("os error 60") ||
    lower.includes("etimedout")
  ) {
    return `${message}\n\nOpenWork could not read the workspace config before the filesystem timed out. This often happens when the folder is still syncing from iCloud Drive or another remote folder. Wait for the folder to finish downloading, move the workspace to a local folder, or try again.`;
  }
  return message;
}

function mergeRouteWorkspaces(
  serverWorkspaces: OpenworkWorkspaceInfo[],
  desktopWorkspaces: RouteWorkspace[],
): RouteWorkspace[] {
  const desktopById = new Map(desktopWorkspaces.map((workspace) => [workspace.id, workspace]));
  const desktopByPath = new Map(
    desktopWorkspaces.flatMap((workspace) => {
      const path = normalizeDirectoryPath(workspace.path ?? "");
      return path ? [[path, workspace] as const] : [];
    }),
  );

  const mergedServer = serverWorkspaces.map((workspace) => {
    const match =
      desktopById.get(workspace.id) ??
      desktopByPath.get(normalizeDirectoryPath(workspace.path ?? ""));
    const merged = match
      ? {
          ...workspace,
          displayName: workspace.displayName?.trim()
            ? workspace.displayName
            : match.displayName,
          name: match.name?.trim() ? match.name : workspace.name,
        }
      : workspace;
    return {
      ...merged,
      displayNameResolved: workspaceLabel(merged),
    };
  });

  const mergedIds = new Set(mergedServer.map((workspace) => workspace.id));
  const mergedPaths = new Set(
    mergedServer.flatMap((workspace) => {
      const path = normalizeDirectoryPath(workspace.path ?? "");
      return path ? [path] : [];
    }),
  );

  const missingDesktop = desktopWorkspaces.filter((workspace) => {
    if (mergedIds.has(workspace.id)) return false;
    const normalizedPath = normalizeDirectoryPath(workspace.path ?? "");
    if (normalizedPath && mergedPaths.has(normalizedPath)) return false;
    return true;
  });

  return [...mergedServer, ...missingDesktop];
}

function reconcileSelectedWorkspaceId(
  currentId: string,
  serverList: { activeId?: string | null },
  desktopList: Awaited<ReturnType<typeof workspaceBootstrap>> | null,
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

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
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

function isActiveSessionStatus(status: unknown) {
  return status === "running" || status === "retry" || status === "busy";
}

function getSessionStatus(session: any) {
  return session?.status ?? session?.state ?? session?.runStatus ?? null;
}

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
    case "den":
    case "skills":
    case "advanced":
    case "appearance":
    case "environment":
    case "updates":
    case "recovery":
    case "debug":
      return { tab: head, redirectPath: null };
    case "extensions":
      if (tail === "mcp") return { tab: "extensions", redirectPath: null, extensionsSection: "mcp" };
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
  return entries.find((entry) => entry.sessions.some((session: any) => session?.id === id))?.workspaceId ?? null;
}

function settingsPathForRoute(route: ReturnType<typeof parseSettingsPath>) {
  if (route.tab === "extensions" && route.extensionsSection && route.extensionsSection !== "all") {
    return `extensions/${route.extensionsSection}`;
  }
  return route.tab;
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

export function SettingsRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ workspaceId?: string }>();
  const routeWorkspaceId = params.workspaceId?.trim() || "";
  const local = useLocal();
  const platform = usePlatform();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const desktopConfig = useDesktopConfig();
  const reloadCoordinator = useReloadCoordinator();
  const route = parseSettingsPath(location.pathname);
  const navigationWorkspaceId = readNavigationWorkspaceId(location.state);
  const navigationSessionId = readNavigationSessionId(location.state);

  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, any[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [workspaceConnectionOverrides, setWorkspaceConnectionOverrides] = useState<Record<string, WorkspaceConnectionState>>({});
  const [legacySelectedWorkspaceId, setLegacySelectedWorkspaceId] = useState(() => navigationWorkspaceId ?? readActiveWorkspaceId() ?? "");
  const selectedWorkspaceId = routeWorkspaceId || legacySelectedWorkspaceId;
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [openworkClient, setOpenworkClient] = useState<OpenworkServerClient | null>(null);
  const [activeClient, setActiveClient] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
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
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [exportWorkspaceBusy, setExportWorkspaceBusy] = useState(false);
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
        .flatMap((session: any) => {
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
      setRouteError(t("app.error_connect_first"));
      return false;
    }

    await openworkClient.reloadEngine(workspaceId);

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
          reloadCoordinator.markReloadRequired("config", {
            type: "config",
            name: "opencode.json",
            action: "updated",
          });
        },
      }),
    [openworkServerStore, reloadCoordinator.markReloadRequired],
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
        setBusy,
        setBusyLabel,
        setBusyStartedAt: () => {},
        setError: setRouteError,
        markReloadRequired: reloadCoordinator.markReloadRequired,
      }),
    [openworkServerStore, reloadCoordinator.markReloadRequired],
  );
  const openworkServerSnapshot = useOpenworkServerStoreSnapshot(openworkServerStore);
  const connectionsSnapshot = useConnectionsStoreSnapshot(connectionsStore);
  const providerAuthSnapshot = useProviderAuthStoreSnapshot(providerAuthStore);
  useExtensionsStoreSnapshot(extensionsStore);

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
    setRouteError,
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
    setError: setRouteError,
  });

  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId),
    [errorsByWorkspaceId, sessionsByWorkspaceId, workspaces],
  );

  const selectedWorkspaceEndpoint = useMemo(
    () => resolveWorkspaceEndpoint(selectedWorkspace, { baseUrl, token }),
    [baseUrl, selectedWorkspace, token],
  );
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";

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
    void window.__OPENWORK_ELECTRON__?.invokeDesktop?.("__setNativeTheme", themeMode);
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
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    setRouteError(null);
    let desktopList = null as Awaited<ReturnType<typeof workspaceBootstrap>> | null;
    let desktopWorkspaces = workspacesRef.current;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await workspaceBootstrap();
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
              ? (response.items ?? []).filter((session: any) =>
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
      setRouteError(message);
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
      setRouteError(message);
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

  useEffect(() => {
    if (route.tab !== "den") return;
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
    ? t("status.providers_connected", { count: providerConnectedIds.length })
    : t("settings.no_providers_connected");
  const providerConnectedIdSet = new Set(providerConnectedIds);
  const connectedProviders = providers.flatMap((provider) =>
    providerConnectedIdSet.has(provider.id)
      ? [{
          id: provider.id,
          name: provider.name ?? provider.id,
        }]
      : [],
  );
  const mcpConnectedAppsCount = connectionsSnapshot.mcpServers.length;
  const routeOpenworkStatus = openworkClient ? "connected" : "disconnected";
  const notFoundRouteError = !loading && routeWorkspaceId && !selectedWorkspace
    ? "Workspace was not found. Select a new workspace from the sidebar."
    : null;
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
    setCreateWorkspaceError(null);
    setCreateWorkspaceRemoteError(null);
    setCreateWorkspaceOpen(true);
  };

  const handleSelectSettingsWorkspace = useCallback((workspaceId: string) => {
    setLegacySelectedWorkspaceId(workspaceId);
    writeActiveWorkspaceId(workspaceId);
    if (isDesktopRuntime()) {
      void workspaceSetSelected(workspaceId).catch(() => undefined);
      void workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
    }
    navigate(workspaceSettingsRoute(workspaceId, settingsPathForRoute(route)), { state: location.state });
  }, [location, navigate, route]);

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
      if (isDesktopRuntime()) {
        await workspaceUpdateDisplayName({
          workspaceId: renameWorkspaceId,
          displayName: trimmed,
        }).catch(() => undefined);
      }
      if (openworkClient) {
        await openworkClient
          .updateWorkspaceDisplayName(renameWorkspaceId, trimmed)
          .catch(() => undefined);
      }
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
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
    if (!isDesktopRuntime()) return;
    const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
    if (!workspace) return;
    const outputPath = await pickDirectory({
      title: `Choose where to export ${workspaceLabel(workspace)}`,
    });
    const targetPath = Array.isArray(outputPath) ? outputPath[0] : outputPath;
    if (!targetPath) return;
    setExportWorkspaceBusy(true);
    try {
      await workspaceExportConfig({ workspaceId, outputPath: targetPath });
      await revealDesktopItemInDir(targetPath).catch(() => undefined);
    } finally {
      setExportWorkspaceBusy(false);
    }
  }, [workspaces]);

  const handleForgetWorkspace = useCallback(async (workspaceId: string) => {
    if (typeof window !== "undefined") {
      const message = t("workspace_list.remove_confirm") || "Remove this workspace from the sidebar?";
      if (!window.confirm(message)) return;
    }
    if (isDesktopRuntime()) {
      await workspaceForget(workspaceId).catch(() => undefined);
    }
    if (openworkClient) {
      await openworkClient.deleteWorkspace(workspaceId).catch(() => undefined);
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
      const list = await workspaceCreate({
        folderPath: folder,
        name: workspaceName,
        preset,
      });
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      // Register the workspace with the running openwork-server so
      // listWorkspaces() reflects it immediately. Without this the UI only
      // picks up the new workspace after an app restart (because the server
      // is launched with a fixed --workspace list at boot and the bridge
      // write only updates desktop-side state).
      if (openworkClient) {
        await openworkClient
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .catch(() => undefined);
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

  const handleReconnectMessagingServer = useCallback(async () => {
    const ok = await openworkServerStore.reconnectOpenworkServer();
    if (ok) {
      await refreshRouteState();
    }
    return ok;
  }, [openworkServerStore, refreshRouteState]);

  const handleRestartLocalServer = useCallback(async () => {
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

  const handleRestartMessagingWorker = useCallback(async () => {
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

  const messagingViewProps = useMessagingViewProps({
    busy,
    openworkServerStatus: openworkServerSnapshot.openworkServerStatus,
    openworkServerUrl: openworkServerSnapshot.openworkServerUrl,
    openworkServerClient:
      openworkClient ?? openworkServerSnapshot.openworkServerClient,
    openworkReconnectBusy: openworkServerSnapshot.openworkReconnectBusy,
    reconnectOpenworkServer: handleReconnectMessagingServer,
    restartMessagingWorker: handleRestartMessagingWorker,
    workspaceId: selectedWorkspace?.id ?? null,
    selectedWorkspaceRoot,
  });

  if (route.redirectPath) {
    const target = selectedWorkspaceId
      ? workspaceSettingsRoute(selectedWorkspaceId, route.redirectPath)
      : `/settings/${route.redirectPath}`;
    return <Navigate to={target} replace state={location.state} />;
  }

  if (!routeWorkspaceId && selectedWorkspaceId) {
    return <Navigate to={workspaceSettingsRoute(selectedWorkspaceId, settingsPathForRoute(route))} replace state={location.state} />;
  }

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
            onSendFeedback={() => platform.openLink(buildFeedbackUrl({ entrypoint: "settings" }))}
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
            canEditPlugins={canWriteWorkspacePlugins}
            addPlugin={async () => {
              setRouteError("Scheduler plugin install is not wired into the React settings route yet.");
            }}
            reloadWorkspaceEngine={reloadCoordinator.reloadWorkspaceEngine}
            reloadBusy={false}
            canReloadWorkspace={reloadCoordinator.canReloadWorkspaceEngine}
            openLink={(url) => platform.openLink(url)}
          />
        );
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
              navigate(selectedWorkspaceId ? workspaceSettingsRoute(selectedWorkspaceId, path) : `/settings/${path}`);
            }}
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
                setMcpEnabled={
                  routeOpenworkStatus === "connected" && routeOpenworkCapabilities?.mcp?.write
                    ? (name, enabled) => connectionsStore.setMcpEnabled(name, enabled)
                    : undefined
                }
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
            restartLocalServer={handleRestartLocalServer}
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
              canReloadWorkspace: reloadCoordinator.canReloadWorkspaceEngine,
              reloadWorkspaceEngine: reloadCoordinator.reloadWorkspaceEngine,
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
      case "environment":
        return (
          <EnvironmentView
            client={openworkServerSnapshot.openworkServerClient}
            isRemoteWorkspace={isRemoteWorkspace}
            onStatusMessage={setConfigActionStatus}
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
      case "messaging":
        return <MessagingView {...messagingViewProps} />;
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
        onSelectTab={(tab) => navigate(selectedWorkspaceId ? workspaceSettingsRoute(selectedWorkspaceId, tab) : `/settings/${tab}`)}
        developerMode={developerMode}
        selectedWorkspaceId={selectedWorkspaceId}
        selectedWorkspaceName={selectedWorkspaceName}
        selectedWorkspaceColor={selectedWorkspaceColor}
        workspaces={workspaceOptions}
        onSelectWorkspace={handleSelectSettingsWorkspace}
        headerStatus={routeOpenworkStatus}
        busyHint={loading ? t("session.loading_detail") : busyLabel}
        onClose={() => navigate(selectedWorkspaceId ? workspaceSessionRoute(selectedWorkspaceId) : "/session")}
        error={routeError ?? notFoundRouteError}
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
        onForceStopSession={(sessionId) => {
          if (!activeClient) return undefined;
          return abortSessionSafe(activeClient, sessionId);
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
