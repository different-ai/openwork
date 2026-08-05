import { useSyncExternalStore } from "react";

import { t } from "../../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../../../app/types";
import { isDesktopRuntime } from "../../../app/utils";
import {
  micxServerInfo,
  micxServerRestart,
  type MicxServerInfo,
} from "../../../app/lib/desktop";
import {
  getMicxGatewayOrigin,
  readMicxGatewayDenToken,
} from "../../../app/lib/gateway-runtime";
import {
  clearMicxServerSettings,
  createMicxServerClient,
  isLoopbackMicxServerUrl,
  normalizeMicxServerUrl,
  readMicxServerSettings,
  writeMicxServerSettings,
  type MicxAuditEntry,
  type MicxServerCapabilities,
  type MicxServerClient,
  type MicxServerDiagnostics,
  type MicxServerError,
  type MicxServerSettings,
  type MicxServerStatus,
} from "../../../app/lib/micx-server";

type SetStateAction<T> = T | ((current: T) => T);

type RemoteWorkspaceInput = {
  micxHostUrl: string;
  micxToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export type MicxServerStoreSnapshot = {
  micxServerSettings: MicxServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  micxServerUrl: string;
  micxServerBaseUrl: string;
  micxServerAuth: { token?: string; hostToken?: string };
  micxServerClient: MicxServerClient | null;
  micxServerStatus: MicxServerStatus;
  micxServerCapabilities: MicxServerCapabilities | null;
  micxServerReady: boolean;
  micxServerWorkspaceReady: boolean;
  resolvedMicxCapabilities: MicxServerCapabilities | null;
  micxServerCanWriteSkills: boolean;
  micxServerCanWritePlugins: boolean;
  micxServerHostInfo: MicxServerInfo | null;
  micxServerDiagnostics: MicxServerDiagnostics | null;
  micxReconnectBusy: boolean;
  micxAuditEntries: MicxAuditEntry[];
  micxAuditStatus: "idle" | "loading" | "error";
  micxAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

export type MicxServerStore = ReturnType<typeof createMicxServerStore>;

type CreateMicxServerStoreOptions = {
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
  micxServerSettings: MicxServerSettings;
  shareRemoteAccessBusy: boolean;
  shareRemoteAccessError: string | null;
  micxServerUrl: string;
  micxServerStatus: MicxServerStatus;
  micxServerCapabilities: MicxServerCapabilities | null;
  micxServerCheckedAt: number | null;
  micxServerHostInfo: MicxServerInfo | null;
  micxServerHostInfoReady: boolean;
  micxServerDiagnostics: MicxServerDiagnostics | null;
  micxReconnectBusy: boolean;
  micxAuditEntries: MicxAuditEntry[];
  micxAuditStatus: "idle" | "loading" | "error";
  micxAuditError: string | null;
  devtoolsWorkspaceId: string | null;
};

const applyStateAction = <T,>(current: T, next: SetStateAction<T>) =>
  typeof next === "function" ? (next as (value: T) => T)(current) : next;

export function createMicxServerStore(options: CreateMicxServerStoreOptions) {
  const bootStartedAt = Date.now();
  const listeners = new Set<() => void>();
  const intervals = new Map<string, number>();

  let clientCacheKey = "";
  let clientCacheValue: MicxServerClient | null = null;
  let started = false;
  let disposed = false;
  let healthTimeoutId: number | null = null;
  let healthBusy = false;
  let healthDelayMs = 10_000;
  let consecutiveHealthFailures = 0;
  let visibilityChangeHandler: (() => void) | null = null;
  let snapshot: MicxServerStoreSnapshot;

  let state: MutableState = {
    micxServerSettings: readMicxServerSettings(),
    shareRemoteAccessBusy: false,
    shareRemoteAccessError: null,
    micxServerUrl: "",
    micxServerStatus: "disconnected",
    micxServerCapabilities: null,
    micxServerCheckedAt: null,
    micxServerHostInfo: null,
    micxServerHostInfoReady: !isDesktopRuntime(),
    micxServerDiagnostics: null,
    micxReconnectBusy: false,
    micxAuditEntries: [],
    micxAuditStatus: "idle",
    micxAuditError: null,
    devtoolsWorkspaceId: null,
  };

  const emitChange = () => {
    for (const listener of listeners) listener();
  };

  const getBaseUrl = () => {
    const gatewayOrigin = getMicxGatewayOrigin();
    if (gatewayOrigin) return normalizeMicxServerUrl(gatewayOrigin) ?? "";

    const pref = options.startupPreference();
    const hostInfo = state.micxServerHostInfo;
    const settingsUrl = normalizeMicxServerUrl(state.micxServerSettings.urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server" && settingsUrl && isLoopbackMicxServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return hostInfo.baseUrl;
    }
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  };

  const getAuth = () => {
    const gatewayOrigin = getMicxGatewayOrigin();
    if (gatewayOrigin) {
      const token = readMicxGatewayDenToken().trim();
      return { token: token || undefined, hostToken: undefined };
    }

    const pref = options.startupPreference();
    const hostInfo = state.micxServerHostInfo;
    const settingsUrl = normalizeMicxServerUrl(state.micxServerSettings.urlOverride ?? "") ?? "";
    const settingsToken = state.micxServerSettings.token?.trim() ?? "";
    const settingsHostToken = state.micxServerSettings.hostToken?.trim() ?? "";
    const clientToken = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";

    if (pref === "local") {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    if (pref === "server" && settingsUrl && isLoopbackMicxServerUrl(settingsUrl) && hostInfo?.baseUrl) {
      return {
        token: clientToken || settingsToken || undefined,
        hostToken: hostToken || settingsHostToken || undefined,
      };
    }
    if (pref === "server") {
      return {
        token: settingsToken || undefined,
        hostToken: settingsUrl && isLoopbackMicxServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
      };
    }
    if (hostInfo?.baseUrl) {
      return { token: clientToken || undefined, hostToken: hostToken || undefined };
    }
    return {
      token: settingsToken || undefined,
      hostToken: settingsUrl && isLoopbackMicxServerUrl(settingsUrl) ? settingsHostToken || undefined : undefined,
    };
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
      clientCacheValue = createMicxServerClient({
        baseUrl,
        token: auth.token,
        hostToken: auth.hostToken,
      });
    }
    return clientCacheValue;
  };

  const refreshSnapshot = () => {
    const micxServerBaseUrl = getBaseUrl().trim();
    const micxServerAuth = getAuth();
    const micxServerClient = getClient();
    const micxServerReady = state.micxServerStatus === "connected";
    const micxServerWorkspaceReady = Boolean(options.runtimeWorkspaceId());
    const resolvedMicxCapabilities = state.micxServerCapabilities;

    const pref = options.startupPreference();
    const info = state.micxServerHostInfo;
    const hostUrl = info?.connectUrl ?? info?.lanUrl ?? info?.mdnsUrl ?? info?.baseUrl ?? "";
    const settingsUrl = normalizeMicxServerUrl(state.micxServerSettings.urlOverride ?? "") ?? "";

    let micxServerUrl = hostUrl || settingsUrl;
    if (pref === "local") micxServerUrl = hostUrl;
    if (pref === "server") micxServerUrl = settingsUrl;
    state.micxServerUrl = micxServerUrl;

    snapshot = {
      micxServerSettings: state.micxServerSettings,
      shareRemoteAccessBusy: state.shareRemoteAccessBusy,
      shareRemoteAccessError: state.shareRemoteAccessError,
      micxServerUrl,
      micxServerBaseUrl,
      micxServerAuth,
      micxServerClient,
      micxServerStatus: state.micxServerStatus,
      micxServerCapabilities: state.micxServerCapabilities,
      micxServerReady,
      micxServerWorkspaceReady,
      resolvedMicxCapabilities,
      micxServerCanWriteSkills:
        micxServerReady &&
        (resolvedMicxCapabilities?.skills?.write ?? false),
      micxServerCanWritePlugins:
        micxServerReady &&
        (resolvedMicxCapabilities?.plugins?.write ?? false),
      micxServerHostInfo: state.micxServerHostInfo,
      micxServerDiagnostics: state.micxServerDiagnostics,
      micxReconnectBusy: state.micxReconnectBusy,
      micxAuditEntries: state.micxAuditEntries,
      micxAuditStatus: state.micxAuditStatus,
      micxAuditError: state.micxAuditError,
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

  const setMicxServerSettings = (next: SetStateAction<MicxServerSettings>) => {
    const resolved = applyStateAction(state.micxServerSettings, next);
    mutateState((current) => ({ ...current, micxServerSettings: resolved }));
    queueHealthCheck(0);
  };

  const updateMicxServerSettings = (next: MicxServerSettings) => {
    const stored = writeMicxServerSettings(next);
    mutateState((current) => ({ ...current, micxServerSettings: stored }));
    queueHealthCheck(0);
  };

  const resetMicxServerSettings = () => {
    clearMicxServerSettings();
    mutateState((current) => ({ ...current, micxServerSettings: {} }));
    queueHealthCheck(0);
  };

  const shouldWaitForLocalHostInfo = () =>
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    !state.micxServerHostInfoReady;

  const shouldRetryStartupCheck = (status: MicxServerStatus) =>
    status !== "connected" &&
    isDesktopRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  const checkMicxServer = async (url: string, token?: string, hostToken?: string) => {
    const client = createMicxServerClient({ baseUrl: url, token, hostToken });
    try {
      await client.health();
    } catch (error) {
      const resolved = error as MicxServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as MicxServerStatus, capabilities: null };
      }
      return { status: "disconnected" as MicxServerStatus, capabilities: null };
    }

    if (!token) {
      return { status: "limited" as MicxServerStatus, capabilities: null };
    }

    try {
      const capabilities = await client.capabilities();
      return { status: "connected" as MicxServerStatus, capabilities };
    } catch (error) {
      const resolved = error as MicxServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as MicxServerStatus, capabilities: null };
      }
      return { status: "disconnected" as MicxServerStatus, capabilities: null };
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
    if (!options.documentVisible()) {
      queueHealthCheck(healthDelayMs);
      return;
    }
    if (shouldWaitForLocalHostInfo()) {
      queueHealthCheck(250);
      return;
    }
    if (healthBusy) return;

    const url = getBaseUrl().trim();
    const auth = getAuth();
    if (!url) {
      consecutiveHealthFailures = 0;
      mutateState((current) => ({
        ...current,
        micxServerStatus: "disconnected",
        micxServerCapabilities: null,
        micxServerCheckedAt: Date.now(),
      }));
      return;
    }

    healthBusy = true;
    try {
      let result = await checkMicxServer(url, auth.token, auth.hostToken);

      if (shouldRetryStartupCheck(result.status)) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        if (disposed) return;

        try {
          const info = await micxServerInfo() as MicxServerInfo;
          if (disposed) return;

          mutateState((current) => ({
            ...current,
            micxServerHostInfo: info,
            micxServerHostInfoReady: true,
          }));

          const retryUrl = info.baseUrl?.trim() ?? "";
          const retryToken = info.clientToken?.trim() || undefined;
          const retryHostToken = info.hostToken?.trim() || undefined;
          if (retryUrl) {
            result = await checkMicxServer(retryUrl, retryToken, retryHostToken);
          }
        } catch {
          // Preserve the original check result when the retry probe fails.
        }
      }

      if (disposed) return;
      const previousStatus = state.micxServerStatus;
      const previousCapabilities = state.micxServerCapabilities;
      const healthy = result.status === "connected" || result.status === "limited";
      if (healthy) {
        consecutiveHealthFailures = 0;
        healthDelayMs = 10_000;
      } else {
        consecutiveHealthFailures += 1;
        healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      }

      const preservePrevious =
        !healthy &&
        consecutiveHealthFailures < 3 &&
        (previousStatus === "connected" || previousStatus === "limited");

      mutateState((current) => ({
        ...current,
        micxServerStatus: preservePrevious ? previousStatus : result.status,
        micxServerCapabilities: preservePrevious ? previousCapabilities : result.capabilities,
        micxServerCheckedAt: Date.now(),
      }));
    } catch {
      healthDelayMs = Math.min(healthDelayMs * 2, 60_000);
      mutateState((current) => ({
        ...current,
        micxServerCheckedAt: Date.now(),
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
    const port = state.micxServerHostInfo?.port;
    if (!port) return;
    if (state.micxServerSettings.portOverride === port) return;

    updateMicxServerSettings({
      ...state.micxServerSettings,
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
    visibilityChangeHandler = () => {
      if (!options.documentVisible()) return;
      consecutiveHealthFailures = 0;
      queueHealthCheck(0);
    };
    window.addEventListener("visibilitychange", visibilityChangeHandler);

    const refreshHostInfo = () => {
      if (!isDesktopRuntime()) return;
      if (!options.documentVisible()) return;
      void (async () => {
        try {
          const info = await micxServerInfo() as MicxServerInfo;
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            micxServerHostInfo: info,
            micxServerHostInfoReady: true,
          }));
        } catch {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            micxServerHostInfo: null,
            micxServerHostInfoReady: true,
          }));
        }
      })();
    };
    refreshHostInfo();
    startInterval("hostInfo", refreshHostInfo, 10_000);

    const refreshDiagnostics = () => {
      if (!options.documentVisible()) return;
      if (!options.developerMode()) {
        setStateField("micxServerDiagnostics", null);
        return;
      }

      const client = getClient();
      if (!client || state.micxServerStatus === "disconnected") {
        setStateField("micxServerDiagnostics", null);
        return;
      }

      void (async () => {
        try {
          const status = await client.status();
          if (!disposed) setStateField("micxServerDiagnostics", status);
        } catch {
          if (!disposed) setStateField("micxServerDiagnostics", null);
        }
      })();
    };
    refreshDiagnostics();
    startInterval("diagnostics", refreshDiagnostics, 10_000);

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
          micxAuditEntries: [],
          micxAuditStatus: "idle",
          micxAuditError: null,
        }));
        return;
      }

      const client = getClient();
      const workspaceId = state.devtoolsWorkspaceId;
      if (!client || !workspaceId) {
        mutateState((current) => ({
          ...current,
          micxAuditEntries: [],
          micxAuditStatus: "idle",
          micxAuditError: null,
        }));
        return;
      }

      mutateState((current) => ({
        ...current,
        micxAuditStatus: "loading",
        micxAuditError: null,
      }));

      void (async () => {
        try {
          const result = await client.listAudit(workspaceId, 50);
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            micxAuditEntries: Array.isArray(result.items) ? result.items : [],
            micxAuditStatus: "idle",
          }));
        } catch (error) {
          if (disposed) return;
          mutateState((current) => ({
            ...current,
            micxAuditEntries: [],
            micxAuditStatus: "error",
            micxAuditError:
              error instanceof Error
                ? error.message
                : t("app.error_audit_load"),
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
    if (visibilityChangeHandler && typeof window !== "undefined") {
      window.removeEventListener("visibilitychange", visibilityChangeHandler);
      visibilityChangeHandler = null;
    }
    for (const key of [...intervals.keys()]) stopInterval(key);
  };

  const testMicxServerConnection = async (next: MicxServerSettings) => {
    const derived = normalizeMicxServerUrl(next.urlOverride ?? "");
    if (!derived) {
      mutateState((current) => ({
        ...current,
        micxServerStatus: "disconnected",
        micxServerCapabilities: null,
        micxServerCheckedAt: Date.now(),
      }));
      return false;
    }

    const result = await checkMicxServer(derived, next.token);
    consecutiveHealthFailures = result.status === "disconnected" ? consecutiveHealthFailures + 1 : 0;
    mutateState((current) => ({
      ...current,
      micxServerStatus: result.status,
      micxServerCapabilities: result.capabilities,
      micxServerCheckedAt: Date.now(),
    }));

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isDesktopRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach =
        !options.activeClient() ||
        active.workspaceType !== "remote" ||
        active.remoteType !== "micx";
      if (shouldAttach) {
        await options
          .createRemoteWorkspaceFlow({
            micxHostUrl: derived,
            micxToken: next.token ?? null,
          })
          .catch(() => undefined);
      }
    }
    return ok;
  };

  const reconnectMicxServer = async () => {
    if (state.micxReconnectBusy) return false;
    setStateField("micxReconnectBusy", true);

    try {
      let hostInfo = state.micxServerHostInfo;
      if (isDesktopRuntime()) {
        try {
          hostInfo = await micxServerInfo() as MicxServerInfo;
          mutateState((current) => ({ ...current, micxServerHostInfo: hostInfo }));
        } catch {
          hostInfo = null;
          setStateField("micxServerHostInfo", null);
        }
      }

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
        const liveToken = hostInfo.clientToken.trim();
        const settings = state.micxServerSettings;
        if ((settings.token?.trim() ?? "") !== liveToken) {
          updateMicxServerSettings({ ...settings, token: liveToken });
        }
      }

      const url = getBaseUrl().trim();
      const auth = getAuth();
      if (!url) {
        mutateState((current) => ({
          ...current,
          micxServerStatus: "disconnected",
          micxServerCapabilities: null,
          micxServerCheckedAt: Date.now(),
        }));
        return false;
      }

      const result = await checkMicxServer(url, auth.token, auth.hostToken);
      mutateState((current) => ({
        ...current,
        micxServerStatus: result.status,
        micxServerCapabilities: result.capabilities,
        micxServerCheckedAt: Date.now(),
      }));
      return result.status === "connected" || result.status === "limited";
    } finally {
      setStateField("micxReconnectBusy", false);
    }
  };

  async function ensureLocalMicxServerClient(): Promise<MicxServerClient | null> {
    let hostInfo = state.micxServerHostInfo;
    if (hostInfo?.baseUrl?.trim() && hostInfo.clientToken?.trim()) {
      const existing = createMicxServerClient({
        baseUrl: hostInfo.baseUrl.trim(),
        token: hostInfo.clientToken.trim(),
        hostToken: hostInfo.hostToken?.trim() || undefined,
      });
      try {
        await existing.health();
        if (options.startupPreference() !== "server") {
          await reconnectMicxServer();
        }
        return existing;
      } catch {
        // Fall through to a local restart.
      }
    }

    if (!isDesktopRuntime()) return null;

    try {
      hostInfo = await micxServerRestart({
        remoteAccessEnabled: state.micxServerSettings.remoteAccessEnabled === true,
      }) as MicxServerInfo;
      mutateState((current) => ({ ...current, micxServerHostInfo: hostInfo }));
    } catch {
      return null;
    }

    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    const hostToken = hostInfo?.hostToken?.trim() ?? "";
    if (!baseUrl || !token) return null;

    if (options.startupPreference() !== "server") {
      await reconnectMicxServer();
    }

    return createMicxServerClient({
      baseUrl,
      token,
      hostToken: hostToken || undefined,
    });
  }

  const saveShareRemoteAccess = async (enabled: boolean) => {
    if (state.shareRemoteAccessBusy) return;
    const previous = state.micxServerSettings;
    const next: MicxServerSettings = {
      ...previous,
      remoteAccessEnabled: enabled,
    };

    mutateState((current) => ({
      ...current,
      shareRemoteAccessBusy: true,
      shareRemoteAccessError: null,
    }));
    updateMicxServerSettings(next);

    try {
      if (isDesktopRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker"));
        }
        await reconnectMicxServer();
      }
    } catch (error) {
      updateMicxServerSettings(previous);
      mutateState((current) => ({
        ...current,
        shareRemoteAccessError:
          error instanceof Error
            ? error.message
            : t("app.error_remote_access"),
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
    setMicxServerSettings,
    updateMicxServerSettings,
    resetMicxServerSettings,
    saveShareRemoteAccess,
    checkMicxServer,
    testMicxServerConnection,
    reconnectMicxServer,
    ensureLocalMicxServerClient,
  };
}

export function useMicxServerStoreSnapshot(store: MicxServerStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
