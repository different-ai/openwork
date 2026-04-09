import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import { t, currentLocale } from "../../i18n";
import type { StartupPreference, WorkspaceDisplay } from "../types";
import { isTauriRuntime } from "../utils";
import {
  openworkServerInfo,
  openworkServerRestart,
  opencodeRouterInfo,
  orchestratorStatus,
  type OpenCodeRouterInfo,
  type OpenworkServerInfo,
  type OrchestratorStatus,
} from "../lib/tauri";
import {
  clearOpenworkServerSettings,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  writeOpenworkServerSettings,
  type OpenworkAuditEntry,
  type OpenworkServerCapabilities,
  type OpenworkServerClient,
  type OpenworkServerDiagnostics,
  type OpenworkServerError,
  type OpenworkServerSettings,
  type OpenworkServerStatus,
} from "../lib/openwork-server";

export type OpenworkServerStore = ReturnType<typeof createOpenworkServerStore>;

type RemoteWorkspaceInput = {
  openworkHostUrl: string;
  openworkToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
};

export function createOpenworkServerStore(options: {
  startupPreference: Accessor<StartupPreference | null>;
  documentVisible: Accessor<boolean>;
  developerMode: Accessor<boolean>;
  runtimeWorkspaceId: Accessor<string | null>;
  activeClient: Accessor<unknown | null>;
  selectedWorkspaceDisplay: Accessor<WorkspaceDisplay>;
  restartLocalServer: () => Promise<boolean>;
  createRemoteWorkspaceFlow: (input: RemoteWorkspaceInput) => Promise<boolean>;
}) {
  const bootStartedAt = Date.now();
  const [openworkServerSettings, setOpenworkServerSettings] = createSignal<OpenworkServerSettings>({});
  const [shareRemoteAccessBusy, setShareRemoteAccessBusy] = createSignal(false);
  const [shareRemoteAccessError, setShareRemoteAccessError] = createSignal<string | null>(null);
  const [openworkServerUrl, setOpenworkServerUrl] = createSignal("");
  const [openworkServerStatus, setOpenworkServerStatus] = createSignal<OpenworkServerStatus>("disconnected");
  const [openworkServerCapabilities, setOpenworkServerCapabilities] =
    createSignal<OpenworkServerCapabilities | null>(null);
  const [, setOpenworkServerCheckedAt] = createSignal<number | null>(null);
  const [openworkServerHostInfo, setOpenworkServerHostInfo] = createSignal<OpenworkServerInfo | null>(null);
  const [openworkServerHostInfoReady, setOpenworkServerHostInfoReady] = createSignal(!isTauriRuntime());
  const [openworkServerDiagnostics, setOpenworkServerDiagnostics] =
    createSignal<OpenworkServerDiagnostics | null>(null);
  const [openworkReconnectBusy, setOpenworkReconnectBusy] = createSignal(false);
  const [opencodeRouterInfoState, setOpenCodeRouterInfoState] =
    createSignal<OpenCodeRouterInfo | null>(null);
  const [orchestratorStatusState, setOrchestratorStatusState] =
    createSignal<OrchestratorStatus | null>(null);
  const [openworkAuditEntries, setOpenworkAuditEntries] = createSignal<OpenworkAuditEntry[]>([]);
  const [openworkAuditStatus, setOpenworkAuditStatus] = createSignal<"idle" | "loading" | "error">("idle");
  const [openworkAuditError, setOpenworkAuditError] = createSignal<string | null>(null);
  const [devtoolsWorkspaceId, setDevtoolsWorkspaceId] = createSignal<string | null>(null);

  const openworkServerBaseUrl = createMemo(() => {
    const pref = options.startupPreference();
    const hostInfo = openworkServerHostInfo();
    const settingsUrl = normalizeOpenworkServerUrl(openworkServerSettings().urlOverride ?? "") ?? "";

    if (pref === "local") return hostInfo?.baseUrl ?? "";
    if (pref === "server") return settingsUrl;
    return hostInfo?.baseUrl ?? settingsUrl;
  });

  const openworkServerAuth = createMemo(
    () => {
      const pref = options.startupPreference();
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

  const openworkServerReady = createMemo(() => openworkServerStatus() === "connected");
  const openworkServerWorkspaceReady = createMemo(() => Boolean(options.runtimeWorkspaceId()));
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

  const updateOpenworkServerSettings = (next: OpenworkServerSettings) => {
    const stored = writeOpenworkServerSettings(next);
    setOpenworkServerSettings(stored);
  };

  const resetOpenworkServerSettings = () => {
    clearOpenworkServerSettings();
    setOpenworkServerSettings({});
  };

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
      const caps = await client.capabilities();
      return { status: "connected" as OpenworkServerStatus, capabilities: caps };
    } catch (error) {
      const resolved = error as OpenworkServerError | Error;
      if ("status" in resolved && (resolved.status === 401 || resolved.status === 403)) {
        return { status: "limited" as OpenworkServerStatus, capabilities: null };
      }
      return { status: "disconnected" as OpenworkServerStatus, capabilities: null };
    }
  };

  const shouldWaitForLocalHostInfo = () =>
    isTauriRuntime() &&
    options.startupPreference() !== "server" &&
    !openworkServerHostInfoReady();

  const shouldRetryStartupCheck = (status: OpenworkServerStatus) =>
    status !== "connected" &&
    isTauriRuntime() &&
    options.startupPreference() !== "server" &&
    Date.now() - bootStartedAt < 5_000;

  createEffect(() => {
    const pref = options.startupPreference();
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

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (!options.documentVisible()) return;
    if (shouldWaitForLocalHostInfo()) return;
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
        let result = await checkOpenworkServer(url, token, hostToken);

        if (shouldRetryStartupCheck(result.status)) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          if (!active) return;

          try {
            const info = await openworkServerInfo();
            if (!active) return;

            setOpenworkServerHostInfo(info);
            setOpenworkServerHostInfoReady(true);

            const retryUrl = info.baseUrl?.trim() ?? "";
            const retryToken = info.clientToken?.trim() || undefined;
            const retryHostToken = info.hostToken?.trim() || undefined;
            if (retryUrl) {
              result = await checkOpenworkServer(retryUrl, retryToken, retryHostToken);
            }
          } catch {
            // ignore retry failures and surface the original result below
          }
        }

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
    if (!options.documentVisible()) return;
    let active = true;

    const run = async () => {
      try {
        const info = await openworkServerInfo();
        if (active) setOpenworkServerHostInfo(info);
      } catch {
        if (active) setOpenworkServerHostInfo(null);
      } finally {
        if (active) setOpenworkServerHostInfoReady(true);
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
    if (!options.documentVisible()) return;
    if (!options.developerMode()) {
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
    if (!options.developerMode()) {
      setOpenCodeRouterInfoState(null);
      return;
    }
    if (!options.documentVisible()) return;

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
    if (!options.developerMode()) {
      setOrchestratorStatusState(null);
      return;
    }
    if (!options.documentVisible()) return;

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

  createEffect(() => {
    if (!options.developerMode()) {
      setDevtoolsWorkspaceId(null);
      return;
    }
    if (!options.documentVisible()) return;

    const client = openworkServerClient();
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
    if (!options.developerMode()) {
      setOpenworkAuditEntries([]);
      setOpenworkAuditStatus("idle");
      setOpenworkAuditError(null);
      return;
    }
    if (!options.documentVisible()) return;

    const client = openworkServerClient();
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
        setOpenworkAuditError(error instanceof Error ? error.message : t("app.error_audit_load", currentLocale()));
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

  const testOpenworkServerConnection = async (next: OpenworkServerSettings) => {
    const derived = normalizeOpenworkServerUrl(next.urlOverride ?? "");
    if (!derived) {
      setOpenworkServerStatus("disconnected");
      setOpenworkServerCapabilities(null);
      setOpenworkServerCheckedAt(Date.now());
      return false;
    }

    const result = await checkOpenworkServer(derived, next.token);
    setOpenworkServerStatus(result.status);
    setOpenworkServerCapabilities(result.capabilities);
    setOpenworkServerCheckedAt(Date.now());

    const ok = result.status === "connected" || result.status === "limited";
    if (ok && !isTauriRuntime()) {
      const active = options.selectedWorkspaceDisplay();
      const shouldAttach = !options.activeClient() || active.workspaceType !== "remote" || active.remoteType !== "openwork";
      if (shouldAttach) {
        await options.createRemoteWorkspaceFlow({
          openworkHostUrl: derived,
          openworkToken: next.token ?? null,
        }).catch(() => undefined);
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

      if (hostInfo?.clientToken?.trim() && options.startupPreference() !== "server") {
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
        if (options.startupPreference() !== "server") {
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
      if (isTauriRuntime() && options.selectedWorkspaceDisplay().workspaceType === "local") {
        const restarted = await options.restartLocalServer();
        if (!restarted) {
          throw new Error(t("app.error_restart_local_worker", currentLocale()));
        }
        await reconnectOpenworkServer();
      }
    } catch (error) {
      updateOpenworkServerSettings(previous);
      setShareRemoteAccessError(
        error instanceof Error
          ? error.message
          : t("app.error_remote_access", currentLocale()),
      );
      return;
    } finally {
      setShareRemoteAccessBusy(false);
    }
  };

  return {
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
    devtoolsWorkspaceId,
    checkOpenworkServer,
    testOpenworkServerConnection,
    reconnectOpenworkServer,
    ensureLocalOpenworkServerClient,
  };
}
