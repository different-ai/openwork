import { useSyncExternalStore } from "react";

import { t, currentLocale } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  openworkServerInfo,
  openworkServerRestart,
  opencodeRouterInfo,
  orchestratorStatus,
  type OpenCodeRouterInfo,
  type OpenworkServerInfo,
  type OrchestratorStatus,
} from "../../../app/lib/desktop";
import {
  clearOpenworkServerSettings,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
  type OpenworkAuditEntry,
  type OpenworkServerCapabilities,
  type OpenworkServerClient,
  type OpenworkServerDiagnostics,
  type OpenworkServerError,
  type OpenworkServerSettings,
  type OpenworkServerStatus,
} from "../../../app/lib/openwork-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  openworkHostUrl: string;
  openworkToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type OpenworkServerStoreSnapshot = {
  openworkServerSettings: OpenworkServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  openworkServerUrl: string;
  openworkServerBaseUrl: string;
  openworkServerAuth: { token?: string; hostToken?: string };
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerReady: boolean;
  openworkServerWorkspaceReady: boolean;
  resolvedOpenworkCapabilities: OpenworkServerCapabilities | null;
  openworkServerCanWriteSkills: boolean;
  openworkServerCanWritePlugins: boolean;
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  openworkReconnectBusy: boolean;
  opencodeRouterInfoState: OpenCodeRouterInfo | null;
  orchestratorStatusState: OrchestratorStatus | null;
  openworkAuditEntries: OpenworkAuditEntry[];
  openworkAuditStatus: "idle" | "loading" | "error";
  openworkAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type OpenworkServerStore = ReturnType<typeof createOpenworkServerStore>;

type CreateOpenworkServerStoreOptions = {
  startupPreference: () => StartupPreference | null;
  documentVisible: () => boolean;
  developerMode: () => boolean;
  runtimeWorkspaceId: () => string | null;
  activeClient: () => unknown | null;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
};

type MutableState = {
  openworkServerSettings: OpenworkServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  openworkServerUrl: string;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerCheckedAt: number | null;
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerHostInfoReady: boolean;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  openworkReconnectBusy: boolean;
  opencodeRouterInfoState: OpenCodeRouterInfo | null;
  orchestratorStatusState: OrchestratorStatus | null;
  openworkAuditEntries: OpenworkAuditEntry[];
  openworkAuditStatus: "idle" | "loading" | "error";
  openworkAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

export function createOpenworkServerStore(options: CreateOpenworkServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: OpenworkServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let snapshot: OpenworkServerStoreSnapshot;

  let state: MutableState = {
    openworkServerSettings: readOpenworkServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    openworkServerUrl: "",
    openworkServerStatus: "disconnected",
    openworkServerCapabilities: null,
    openworkServerCheckedAt: null,
    openworkServerHostInfo: null,
    openworkServerHostInfoReady: !isDesktopRuntime(),
    openworkServerDiagnostics: null,
    openworkReconnectBusy: false,
    opencodeRouterInfoState: null,
    orchestratorStatusState: null,
    openworkAuditEntries: [],
    openworkAuditStatus: "idle",
    openworkAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const pref = options.startupPreference();
    const hostInfo = state.openworkServerHostInfo;
    const settingsUrl = normalizeOpenworkServerUrl(state.openworkServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const pref = options.startupPreference();
    const hostInfo = state.openworkServerHostInfo;
    const settingsToken = state.openworkServerSettings.token?.trim() ?? "";
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
  };

  const getClient = () => {
    const baseUrl = getBaseUrl().trim();
    if (!baseUrl) {
      clientCacheKey = "";
      clientCacheValue = null;
      return null;
    }

    const auth = getAuth();
    const key = `${baseUrl}::${auth.token ?? ""}::${auth.hostToken ?? ""}`;
    if (key !== clientCacheKey) {
      clientCacheKey = key;
      clientCacheValue = createOpenworkServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = () => {
    const openworkServerBaseUrl = getBaseUrl().trim();
    const openworkServerAuth = getAuth();
    const openworkServerClient = getClient();
    const openworkServerReady = state.openworkServerStatus === "connected";
    const openworkServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedOpenworkCapabilities = state.openworkServerCapabilities;

    const pref = options.startupPreference();
    const info = state.openworkServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeOpenworkServerUrl(state.openworkServerSettings.urlOverride ?? "") ?? "";

    let openworkServerUrl = hostUrl || settingsUrl;
    if (pref === "local") openworkServerUrl = hostUrl;
    if (pref === "server") openworkServerUrl = settingsUrl;
    state.openworkServerUrl = openworkServerUrl;

    snapshot = {
      openworkServerSettings: state.openworkServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      openworkServerUrl,
      openworkServerBaseUrl,
      openworkServerAuth,
      openworkServerClient,
      openworkServerStatus: state.openworkServerStatus,
      openworkServerCapabilities: state.openworkServerCapabilities,
      openworkServerReady,
      openworkServerWorkspaceReady,
      resolvedOpenworkCapabilities,
      openworkServerCanWriteSkills:
        openworkServerReady &&
        openworkServerWorkspaceReady &&
        (resolvedOpenworkCapabilities?.skills?.write ?? false),
      openworkServerCanWritePlugins:
        openworkServerReady &&
        openworkServerWorkspaceReady &&
        (resolvedOpenworkCapabilities?.plugins?.write ?? false),
      openworkServerHostInfo: state.openworkServerHostInfo,
      openworkServerDiagnostics: state.openworkServerDiagnostics,
      openworkReconnectBusy: state.openworkReconnectBusy,
      opencodeRouterInfoState: state.opencodeRouterInfoState,
      orchestratorStatusState: state.orchestratorStatusState,
      openworkAuditEntries: state.openworkAuditEntries,
      openworkAuditStatus: state.openworkAuditStatus,
      openworkAuditError: state.openworkAuditError,
      devtoolsWorkspaceId: state.devtoolsWorkspaceId,
    };
  };

  const mutateState = (updater: (current: MutableState) => MutableState) => {
    state = updater(state);
    refreshSnapshot();
    emitChange();
  };

  const setStateField = <K extends keyof MutableState>(key: K, value: MutableState[K]) => {
    if (Object.is(state[key], value)) return;
    mutateState((current) => ({ ...current, [key]: value }));
  };

  const setOpenworkServerSettings = (next: SetStateAction<OpenworkServerSettings>) => {
    const resolved = applyStateAction(state.openworkServerSettings, next);
    mutateState((current) => ({ ...current, openworkServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateOpenworkServerSettings = (next: OpenworkServerSettings) => {
    const stored = writeOpenworkServerSettings(next);
    mutateState((current) => ({ ...current, openworkServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetOpenworkServerSettings = () => {
    clearOpenworkServerSettings();
    mutateState((current) => ({ ...current, openworkServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.openworkServerHostInfoReady;

  const shouldRetryStartupCheck = (status: OpenworkServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkOpenworkServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createOpenworkServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as OpenworkServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OpenworkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenworkServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as OpenworkServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as OpenworkServerStatus, capabilities };
    } catch (error) {
      const resolved = error as OpenworkServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OpenworkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenworkServerStatus, capabilities: null };
    }
  };

  const clearHealthTimeout = () => {
    if (healthTimeoutId !== null) {
      window.clearTimeout(healthTimeoutId);
      healthTimeoutId = null;
    }
  };

  const queueHealthCheck = (delayMs: number) => {
    if (disposed || typeof window === "undefined") return;
    clearHealthTimeout();
    healthTimeoutId = window.setTimeout(() => {
      healthTimeoutId = null;
      void runHealthCheck();
    }, Math.max(0, delayMs));
  };

  const runHealthCheck = async () => {
    if (disposed || typeof window === "undefined") return;
    if (!options.documentVisible()) return;
    if (shouldWaitForLocalHostInfo()) return;
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      mutateState((current) => ({
        ...current,
        openworkServerStatus: "disconnected",
        openworkServerCapabilities: null,
        openworkServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkOpenworkServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await openworkServerInfo();
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            openworkServerHostInfo: info,
            openworkServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkOpenworkServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      healthDelayMs =
        result.status === "connected" || result.status === "limited"
          ? 10_000
          : Math.min(healthDelayMs * 2, 60_000);

      mutateState((current) => ({
        ...current,
        openworkServerStatus: result.status,
        openworkServerCapabilities: result.capabilities,
        openworkServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        openworkServerCheckedAt: Date.now(),
      }));
    } finally {
      healthBusy = false;
      if (!disposed) queueHealthCheck(healthDelayMs);
    }
  };

  const syncFromOptions = () => {
    refreshSnapshot();
    emitChange();

    if (!isDesktopRuntime()) return;
    const port = state.openworkServerHostInfo?.port;
    if (!port) return;
    if (state.openworkServerSettings.portOverride === port) return;

    updateOpenworkServerSettings({
      ...state.openworkServerSettings,
      portOverride: port,
    });
  };

  const startInterval = (key: string, fn: () => void, ms: number) => {
    if (typeof window === "undefined") return;
    if (intervals.has(key)) return;
    intervals.set(key, window.setInterval(fn, ms));
  };

  const stopInterval = (key: string) => {
    const id = intervals.get(key);
    if (id === undefined) return;
    window.clearInterval(id);
    intervals.delete(key);
  };

  const start = () => {
    if (typeof window === "undefined") return;
    if (started) return;
    // Allow restart after a prior dispose() (React 18 StrictMode double-mounts
    // each effect in dev: mount → dispose → re-mount). If we early-return when
    // `disposed` is true, the real mount never arms polling and the UI stays
    // on stale/empty state forever.
    disposed = false;
    started = true;

    syncFromOptions();
    queueHealthCheck(0);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await openworkServerInfo();
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            openworkServerHostInfo: info,
            openworkServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            openworkServerHostInfo: null,
            openworkServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("openworkServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.openworkServerStatus === "disconnected") {
        setStateField("openworkServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("openworkServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("openworkServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

    const refreshRouterInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("opencodeRouterInfoState", null);
        return;
      }

      void (async () => {
        try {
          const info = await opencodeRouterInfo();
          if (!disposed) setStateField("opencodeRouterInfoState", info);
        } catch {
          if (!disposed) setStateField("opencodeRouterInfoState", null);
        }
      })();
    };
    refreshRouterInfo();
    startInterval("router", refreshRouterInfo, 10_000);

    const refreshOrchestratorStatus = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("orchestratorStatusState", null);
        return;
      }

      void (async () => {
        try {
          const status = await orchestratorStatus();
          if (!disposed) setStateField("orchestratorStatusState", status);
        } catch {
          if (!disposed) setStateField("orchestratorStatusState", null);
        }
      })();
    };
    refreshOrchestratorStatus();
    startInterval("orchestrator", refreshOrchestratorStatus, 10_000);

    const refreshDevtoolsWorkspace = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      const client = getClient();
      if (!client) {
        setStateField("devtoolsWorkspaceId", null);
        return;
      }

      void (async () => {
        try {
          const response = await client.listWorkspaces();
          if (disposed) return;
          const items = Array.isArray(response.items) ? response.items : [];
          const activeMatch = response.activeId
            ? items.find((item) => item.id === response.activeId)
            : null;
          setStateField("devtoolsWorkspaceId", activeMatch?.id ?? items[0]?.id ?? null);
        } catch {
          if (!disposed) setStateField("devtoolsWorkspaceId", null);
        }
      })();
    };
    refreshDevtoolsWorkspace();
    startInterval("devtoolsWorkspace", refreshDevtoolsWorkspace, 20_000);

    const refreshAudit = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        mutateState((current) => ({
          ...current,
          openworkAuditEntries: [],
          openworkAuditStatus: "idle",
          openworkAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          openworkAuditEntries: [],
          openworkAuditStatus: "idle",
          openworkAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        openworkAuditStatus: "loading",
        openworkAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            openworkAuditEntries: Array.isArray(result.items) ? result.items : [],
            openworkAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            openworkAuditEntries: [],
            openworkAuditStatus: "error",
            openworkAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load", currentLocale()),
          }));
        }
      })();
    };
    refreshAudit();
    startInterval("audit", refreshAudit, 15_000);
  };

  const dispose = () => {
    disposed = true;
    started = false;
    clearHealthTimeout();
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testOpenworkServerConnection = async (next: OpenworkServerSettings) => {
    const derived = normalizeOpenworkServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        openworkServerStatus: "disconnected",
        openworkServerCapabilities: null,
        openworkServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkOpenworkServer(derived, next.token);
    mutateState((current) => ({
      ...current,
      openworkServerStatus: result.status,
      openworkServerCapabilities: result.capabilities,
      openworkServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "openwork";
      if (shouldAttach) {
        await options
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
    if (state.openworkReconnectBusy) return false;
    setStateField("openworkReconnectBusy", true);

    try {
      let hostInfo = state.openworkServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await openworkServerInfo();
          mutateState((current) => ({ ...current, openworkServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("openworkServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const settings = state.openworkServerSettings;
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateOpenworkServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          openworkServerStatus: "disconnected",
          openworkServerCapabilities: null,
          openworkServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkOpenworkServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        openworkServerStatus: result.status,
        openworkServerCapabilities: result.capabilities,
        openworkServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("openworkReconnectBusy", false);
    }
  };

  async function ensureLocalOpenworkServerClient(): Promise<OpenworkServerClient | null> {
    let hostInfo = state.openworkServerHostInfo;
    if (hostInfo?.baseUrl?.trim() && hostInfo.clientToken?.trim()) {
      const existing = createOpenworkServerClient({
        baseUrl: hostInfo.baseUrl.trim(),
        token: hostInfo.clientToken.trim(),
        hostToken: hostInfo.hostToken?.trim() || undefined,
      });
      try {
        await existing.health();
        if (options.startupPreference() !== "server") {
          await reconnectOpenworkServer();
        }
        return existing;
      } catch {
        // Fall through to a local restart.
      }
    }

    if (!isDesktopRuntime()) return null;

    try {
      hostInfo = await openworkServerRestart({
        remoteAccessEnabled: state.openworkServerSettings.remoteAccessEnabled === true,
      });
      mutateState((current) => ({ ...current, openworkServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectOpenworkServer();
    }

    return createOpenworkServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.openworkServerSettings;
    const next: OpenworkServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateOpenworkServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker", currentLocale()));
        }
        await reconnectOpenworkServer();
      }
    } catch (error) {
      updateOpenworkServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access", currentLocale()),
      }));
      return;
    } finally {
      setStateField("shareRemoteAccessBusy", false);
    }
  };

  refreshSnapshot();

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => snapshot;

  return {
    subscribe,
    getSnapshot,
    start,
    dispose,
    syncFromOptions,
    setOpenworkServerSettings,
    updateOpenworkServerSettings,
    resetOpenworkServerSettings,
    saveShareRemoteAccess,
    checkOpenworkServer,
    testOpenworkServerConnection,
    reconnectOpenworkServer,
    ensureLocalOpenworkServerClient,
  };
}

export function useOpenworkServerStoreSnapshot(store: OpenworkServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
