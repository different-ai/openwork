/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  appBuildInfo as appBuildInfoCmd,
  engineInfo as engineInfoCmd,
  engineStart as engineStartCmd,
  nukeOpenworkAndOpencodeConfigAndExit,
  openworkServerInfo as openworkServerInfoCmd,
  openworkServerRestart as openworkServerRestartCmd,
  opencodeRouterInfo as opencodeRouterInfoCmd,
  opencodeRouterRestart as opencodeRouterRestartCmd,
  opencodeRouterStop as opencodeRouterStopCmd,
  orchestratorStatus as orchestratorStatusCmd,
  resetOpenworkState,
  sandboxDebugProbe as sandboxDebugProbeCmd,
  workspaceBootstrap as workspaceBootstrapCmd,
  type AppBuildInfo,
  type EngineInfo,
  type OpenCodeRouterInfo,
  type OpenworkServerInfo,
  type OrchestratorStatus,
  type SandboxDebugProbeResult,
} from "../../../../app/lib/tauri";
import {
  writeOpenworkServerSettings,
} from "../../../../app/lib/openwork-server";
import {
  clearStartupPreference,
  isTauriRuntime,
  safeStringify,
} from "../../../../app/utils";
import { t } from "../../../../i18n";
import type { DebugViewProps } from "../pages/debug-view";
import type { OpenworkServerStore, OpenworkServerStoreSnapshot } from "../../connections/openwork-server-store";

const STARTUP_PREFERENCE_KEY = "openwork.startupPreference";
const ENGINE_SOURCE_KEY = "openwork.engineSource";
const ENGINE_RUNTIME_KEY = "openwork.engineRuntime";
const ENGINE_CUSTOM_BIN_KEY = "openwork.engineCustomBinPath";
const OPENCODE_ENABLE_EXA_KEY = "openwork.opencodeEnableExa";

type ResetModalMode = "onboarding" | "all";

type UseDebugViewModelOptions = {
  developerMode: boolean;
  openworkServerStore: OpenworkServerStore;
  openworkServerSnapshot: OpenworkServerStoreSnapshot;
  runtimeWorkspaceId: string | null;
  selectedWorkspaceRoot: string;
  setRouteError: (value: string | null) => void;
};

function readStoredString(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStoredString(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore persistence failures
  }
}

function clearStoredString(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore persistence failures
  }
}

function downloadTextAsFile(filename: string, content: string, mimeType: string) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readEngineSource(): "path" | "sidecar" | "custom" {
  const raw = readStoredString(ENGINE_SOURCE_KEY, "sidecar");
  return raw === "path" || raw === "sidecar" || raw === "custom" ? raw : "sidecar";
}

function readEngineRuntime(): "direct" | "openwork-orchestrator" {
  const raw = readStoredString(ENGINE_RUNTIME_KEY, "openwork-orchestrator");
  return raw === "direct" ? "direct" : "openwork-orchestrator";
}

function readOpencodeEnableExa(): boolean {
  return readStoredString(OPENCODE_ENABLE_EXA_KEY, "0") === "1";
}

function statusPill(
  running: boolean,
  connectedLabel?: string,
  disconnectedLabel?: string,
): { label: string; className: string } {
  return running
    ? {
        label: connectedLabel ?? t("status.connected"),
        className: "border-green-7/30 bg-green-7/10 text-green-11",
      }
    : {
        label: disconnectedLabel ?? t("status.disconnected_label"),
        className: "border-gray-7/30 bg-gray-4/50 text-gray-11",
      };
}

function auditStatusPill(status: "idle" | "loading" | "error"): {
  label: string;
  className: string;
} {
  if (status === "loading") {
    return {
      label: t("settings.loading"),
      className: "border-blue-7/30 bg-blue-7/10 text-blue-11",
    };
  }
  if (status === "error") {
    return {
      label: t("settings.error"),
      className: "border-red-7/30 bg-red-7/10 text-red-11",
    };
  }
  return {
    label: t("settings.idle"),
    className: "border-gray-7/30 bg-gray-4/50 text-gray-11",
  };
}

function describeEngine(info: EngineInfo | null) {
  const running = Boolean(info?.running);
  return {
    ...statusPill(running),
    lines: [
      t("settings.debug_base_url", undefined, { url: info?.baseUrl ?? "—" }),
      t("settings.debug_runtime", undefined, { runtime: info?.runtime ?? "—" }),
      t("settings.debug_pid", undefined, { pid: info?.pid ? String(info.pid) : "—" }),
      t("settings.debug_hostname", undefined, { hostname: info?.hostname ?? "—" }),
      t("settings.debug_port", undefined, { port: info?.port ? String(info.port) : "—" }),
    ],
    stdout: info?.lastStdout ?? null,
    stderr: info?.lastStderr ?? null,
    error: null as string | null,
  };
}

function describeOrchestrator(status: OrchestratorStatus | null) {
  const running = Boolean(status?.running);
  return {
    ...statusPill(running),
    lines: [
      t("settings.debug_data_dir", undefined, { path: status?.dataDir ?? "—" }),
      t("settings.debug_daemon_url", undefined, { url: status?.daemon?.baseUrl ?? "—" }),
      t("settings.debug_daemon_pid", undefined, { pid: status?.daemon?.pid ? String(status.daemon.pid) : "—" }),
      t("settings.debug_opencode_url", undefined, { url: status?.opencode?.baseUrl ?? "—" }),
      t("settings.debug_opencode_pid", undefined, { pid: status?.opencode?.pid ? String(status.opencode.pid) : "—" }),
      t("settings.debug_cli_version", undefined, { version: status?.cliVersion ?? "—" }),
    ],
    binaryTitle: status?.binaries?.opencode?.path ?? null,
    error: status?.lastError ?? null,
  };
}

function describeOpenworkServer(info: OpenworkServerInfo | null) {
  const running = Boolean(info?.running);
  return {
    ...statusPill(running),
    lines: [
      t("settings.debug_base_url", undefined, { url: info?.baseUrl ?? "—" }),
      t("settings.debug_connect_url", undefined, { url: info?.connectUrl ?? "—" }),
      t("settings.debug_lan_url", undefined, { url: info?.lanUrl ?? "—" }),
      t("settings.debug_mdns_url", undefined, { url: info?.mdnsUrl ?? "—" }),
      t("settings.debug_pid", undefined, { pid: info?.pid ? String(info.pid) : "—" }),
      t("settings.debug_remote_access", undefined, {
        value: info?.remoteAccessEnabled ? t("settings.on") : t("settings.off"),
      }),
    ],
    stdout: info?.lastStdout ?? null,
    stderr: info?.lastStderr ?? null,
    error: null as string | null,
  };
}

function describeOpencodeRouter(info: OpenCodeRouterInfo | null) {
  const running = Boolean(info?.running);
  return {
    ...statusPill(running),
    lines: [
      t("settings.debug_workspace_path", undefined, { path: info?.workspacePath ?? "—" }),
      t("settings.debug_opencode_url", undefined, { url: info?.opencodeUrl ?? "—" }),
      t("settings.debug_health_port", undefined, {
        port: info?.healthPort ? String(info.healthPort) : "—",
      }),
      t("settings.debug_pid", undefined, { pid: info?.pid ? String(info.pid) : "—" }),
      t("settings.debug_router_version", undefined, { version: info?.version ?? "—" }),
    ],
    stdout: info?.lastStdout ?? null,
    stderr: info?.lastStderr ?? null,
    running,
    error: null as string | null,
  };
}

function describeOpencodeConnect(engine: EngineInfo | null) {
  const running = Boolean(engine?.baseUrl);
  return {
    ...statusPill(running),
    lines: [
      t("settings.debug_base_url", undefined, { url: engine?.baseUrl ?? "—" }),
      t("settings.debug_project_dir", undefined, { path: engine?.projectDir ?? "—" }),
      t("settings.debug_runtime", undefined, { runtime: engine?.runtime ?? "—" }),
    ],
    metricsLines: [] as string[],
    error: null as string | null,
  };
}

export function useDebugViewModel(options: UseDebugViewModelOptions) {
  const {
    developerMode,
    openworkServerStore,
    openworkServerSnapshot,
    runtimeWorkspaceId,
    selectedWorkspaceRoot,
    setRouteError,
  } = options;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [engineInfoState, setEngineInfoState] = useState<EngineInfo | null>(null);
  const [appBuild, setAppBuild] = useState<AppBuildInfo | null>(null);
  const [runtimeDebugStatus, setRuntimeDebugStatus] = useState<string | null>(null);
  const [sandboxProbeBusy, setSandboxProbeBusy] = useState(false);
  const [sandboxProbeResult, setSandboxProbeResult] = useState<SandboxDebugProbeResult | null>(null);
  const [sandboxProbeStatus, setSandboxProbeStatus] = useState<string | null>(null);
  const [openworkRestartBusy, setOpenworkRestartBusy] = useState(false);
  const [opencodeRestarting, setOpencodeRestarting] = useState(false);
  const [openworkServerRestarting, setOpenworkServerRestarting] = useState(false);
  const [opencodeRouterRestarting, setOpencodeRouterRestarting] = useState(false);
  const [openworkRestartStatus, setOpenworkRestartStatus] = useState<string | null>(null);
  const [serviceRestartError, setServiceRestartError] = useState<string | null>(null);
  const [resetModalBusy, setResetModalBusy] = useState(false);
  const [nukeConfigBusy, setNukeConfigBusy] = useState(false);
  const [nukeConfigStatus, setNukeConfigStatus] = useState<string | null>(null);
  const [engineSource, setEngineSourceState] = useState<"path" | "sidecar" | "custom">(readEngineSource);
  const [engineRuntime, setEngineRuntimeState] = useState<"direct" | "openwork-orchestrator">(readEngineRuntime);
  const [engineCustomBinPath, setEngineCustomBinPath] = useState<string>(() =>
    readStoredString(ENGINE_CUSTOM_BIN_KEY, ""),
  );
  const [developerLog, setDeveloperLog] = useState<string[]>([]);
  const [developerLogStatus, setDeveloperLogStatus] = useState<string | null>(null);

  const refreshEngineInfo = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      const info = await engineInfoCmd();
      setEngineInfoState(info);
    } catch {
      setEngineInfoState(null);
    }
  }, []);

  useEffect(() => {
    if (!developerMode) return;
    void (async () => {
      if (!isTauriRuntime()) return;
      try {
        const build = await appBuildInfoCmd();
        setAppBuild(build);
      } catch {
        setAppBuild(null);
      }
    })();
  }, [developerMode]);

  useEffect(() => {
    if (!developerMode) return;
    void refreshEngineInfo();
    const interval = window.setInterval(() => {
      void refreshEngineInfo();
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [developerMode, refreshEngineInfo]);

  const pushDeveloperLog = useCallback((message: string) => {
    const timestamp = new Date().toISOString();
    setDeveloperLog((current) => {
      const next = [...current, `${timestamp} ${message}`];
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  }, []);

  const runtimeSummary = useMemo(
    () => ({
      appVersionLabel: appBuild?.version ?? "—",
      appCommitLabel: appBuild?.gitSha ?? "—",
      orchestratorVersionLabel:
        openworkServerSnapshot.orchestratorStatusState?.cliVersion ?? "—",
      opencodeVersionLabel:
        openworkServerSnapshot.orchestratorStatusState?.binaries?.opencode?.actualVersion ?? "—",
      openworkServerVersionLabel: openworkServerSnapshot.openworkServerDiagnostics?.version ?? "—",
      opencodeRouterVersionLabel: openworkServerSnapshot.opencodeRouterInfoState?.version ?? "—",
    }),
    [
      appBuild?.gitSha,
      appBuild?.version,
      openworkServerSnapshot.opencodeRouterInfoState?.version,
      openworkServerSnapshot.openworkServerDiagnostics?.version,
      openworkServerSnapshot.orchestratorStatusState?.binaries?.opencode?.actualVersion,
      openworkServerSnapshot.orchestratorStatusState?.cliVersion,
    ],
  );

  const runtimeDebugReport = useMemo(() => {
    return {
      collectedAt: new Date().toISOString(),
      app: appBuild ?? null,
      engine: engineInfoState,
      orchestrator: openworkServerSnapshot.orchestratorStatusState,
      openworkServer: {
        hostInfo: openworkServerSnapshot.openworkServerHostInfo,
        diagnostics: openworkServerSnapshot.openworkServerDiagnostics,
        capabilities: openworkServerSnapshot.openworkServerCapabilities,
        settings: openworkServerSnapshot.openworkServerSettings,
        status: openworkServerSnapshot.openworkServerStatus,
        url: openworkServerSnapshot.openworkServerUrl,
      },
      opencodeRouter: openworkServerSnapshot.opencodeRouterInfoState,
      runtimeWorkspaceId,
      selectedWorkspaceRoot,
    };
  }, [
    appBuild,
    engineInfoState,
    openworkServerSnapshot.opencodeRouterInfoState,
    openworkServerSnapshot.openworkServerCapabilities,
    openworkServerSnapshot.openworkServerDiagnostics,
    openworkServerSnapshot.openworkServerHostInfo,
    openworkServerSnapshot.openworkServerSettings,
    openworkServerSnapshot.openworkServerStatus,
    openworkServerSnapshot.openworkServerUrl,
    openworkServerSnapshot.orchestratorStatusState,
    runtimeWorkspaceId,
    selectedWorkspaceRoot,
  ]);

  const runtimeDebugReportJson = useMemo(
    () => safeStringify(runtimeDebugReport),
    [runtimeDebugReport],
  );

  const engineCard = useMemo(() => describeEngine(engineInfoState), [engineInfoState]);
  const orchestratorCard = useMemo(
    () => describeOrchestrator(openworkServerSnapshot.orchestratorStatusState),
    [openworkServerSnapshot.orchestratorStatusState],
  );
  const openworkCard = useMemo(
    () => describeOpenworkServer(openworkServerSnapshot.openworkServerHostInfo),
    [openworkServerSnapshot.openworkServerHostInfo],
  );
  const opencodeRouterCard = useMemo(
    () => describeOpencodeRouter(openworkServerSnapshot.opencodeRouterInfoState),
    [openworkServerSnapshot.opencodeRouterInfoState],
  );
  const opencodeConnectCard = useMemo(
    () => describeOpencodeConnect(engineInfoState),
    [engineInfoState],
  );

  const onCopyRuntimeDebugReport = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(runtimeDebugReportJson);
      setRuntimeDebugStatus(t("settings.copied_debug_report"));
    } catch (error) {
      setRuntimeDebugStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [runtimeDebugReportJson]);

  const onExportRuntimeDebugReport = useCallback(async () => {
    try {
      downloadTextAsFile(
        `openwork-runtime-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        runtimeDebugReportJson,
        "application/json",
      );
      setRuntimeDebugStatus(t("settings.exported_debug_report"));
    } catch (error) {
      setRuntimeDebugStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [runtimeDebugReportJson]);

  const onClearDeveloperLog = useCallback(() => {
    setDeveloperLog([]);
    setDeveloperLogStatus("Cleared developer log.");
  }, []);

  const onCopyDeveloperLog = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(developerLog.join("\n"));
      setDeveloperLogStatus("Copied developer log to clipboard.");
    } catch (error) {
      setDeveloperLogStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [developerLog]);

  const onExportDeveloperLog = useCallback(async () => {
    try {
      downloadTextAsFile(
        `openwork-developer-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
        developerLog.join("\n"),
        "text/plain",
      );
      setDeveloperLogStatus("Exported developer log.");
    } catch (error) {
      setDeveloperLogStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [developerLog]);

  const onRunSandboxDebugProbe = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setSandboxProbeBusy(true);
    setSandboxProbeStatus(null);
    try {
      const result = await sandboxDebugProbeCmd();
      setSandboxProbeResult(result);
      setSandboxProbeStatus(
        result.ready
          ? t("settings.sandbox_probe_success")
          : (result.error ?? t("settings.sandbox_error")),
      );
      pushDeveloperLog(`sandbox probe ready=${String(result.ready)}`);
    } catch (error) {
      setSandboxProbeStatus(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setSandboxProbeBusy(false);
    }
  }, [pushDeveloperLog]);

  const onStopHost = useCallback(async () => {
    clearStartupPreference();
    setOpenworkRestartStatus(t("settings.startup_reset_hint"));
  }, []);

  const onResetStartupPreference = useCallback(async () => {
    clearStartupPreference();
    setOpenworkRestartStatus(t("settings.startup_reset_hint"));
  }, []);

  const onSetEngineSource = useCallback((value: "path" | "sidecar" | "custom") => {
    setEngineSourceState(value);
    writeStoredString(ENGINE_SOURCE_KEY, value);
  }, []);

  const onSetEngineRuntime = useCallback(
    (value: "direct" | "openwork-orchestrator") => {
      setEngineRuntimeState(value);
      writeStoredString(ENGINE_RUNTIME_KEY, value);
    },
    [],
  );

  const onPickEngineBinary = useCallback(async () => {
    if (!isTauriRuntime()) {
      setServiceRestartError(t("settings.sandbox_requires_desktop"));
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const target = await open({ title: t("settings.custom_binary_label"), multiple: false });
      if (typeof target === "string" && target.trim()) {
        setEngineCustomBinPath(target);
        writeStoredString(ENGINE_CUSTOM_BIN_KEY, target);
      }
    } catch (error) {
      setServiceRestartError(error instanceof Error ? error.message : safeStringify(error));
    }
  }, []);

  const onClearEngineCustomBinPath = useCallback(() => {
    setEngineCustomBinPath("");
    clearStoredString(ENGINE_CUSTOM_BIN_KEY);
  }, []);

  const bootFullEngineStack = useCallback(async () => {
    const workspacePath = optionsRef.current.selectedWorkspaceRoot.trim();
    if (!workspacePath) {
      throw new Error(
        "Select a local workspace before starting the orchestrator/engine.",
      );
    }

    // Collect ALL local workspace paths so openwork-server is started with
    // --workspace <path> for every registered local workspace. Mirrors the
    // Solid reference (context/workspace.ts::resolveWorkspacePaths) so that
    // `client.listWorkspaces()` later returns the full set, not just the
    // active one.
    const workspacePaths = [workspacePath];
    try {
      const list = await workspaceBootstrapCmd();
      for (const entry of list?.workspaces ?? []) {
        if (entry.workspaceType === "remote") continue;
        const path = entry.path?.trim() ?? "";
        if (path && !workspacePaths.includes(path)) workspacePaths.push(path);
      }
    } catch {
      // best-effort: fall back to just the active workspace path
    }

    const info = await engineStartCmd(workspacePath, {
      runtime: "openwork-orchestrator",
      workspacePaths,
      opencodeEnableExa: readOpencodeEnableExa(),
      openworkRemoteAccess:
        optionsRef.current.openworkServerSnapshot.openworkServerSettings
          .remoteAccessEnabled === true,
    });

    // engine_start restarts openwork-server on a NEW port with --opencode-base-url
    // attached. Re-read host info and persist the new base URL + token so the
    // React route listeners pick up the fresh connection instead of the stale one.
    try {
      const hostInfo = await openworkServerInfoCmd();
      if (hostInfo?.baseUrl) {
        writeOpenworkServerSettings({
          urlOverride: hostInfo.baseUrl,
          token: hostInfo.ownerToken?.trim() || hostInfo.clientToken?.trim() || undefined,
          portOverride: hostInfo.port ?? undefined,
          remoteAccessEnabled: hostInfo.remoteAccessEnabled === true,
        });
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
        }
      }
    } catch {
      // best-effort: if this fails, the host-info poller will catch up in ~10s.
    }

    await openworkServerStore.reconnectOpenworkServer();
    await refreshEngineInfo();
    return info;
  }, [openworkServerStore, refreshEngineInfo]);

  const onRestartLocalServer = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setOpenworkRestartBusy(true);
    setServiceRestartError(null);
    setOpenworkRestartStatus(null);
    try {
      await bootFullEngineStack();
      setOpenworkRestartStatus(t("settings.restart_orchestrator"));
      pushDeveloperLog("Started orchestrator + OpenCode stack via engine_start");
    } catch (error) {
      setServiceRestartError(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setOpenworkRestartBusy(false);
    }
  }, [bootFullEngineStack, pushDeveloperLog]);

  const onRestartOpencode = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setOpencodeRestarting(true);
    setServiceRestartError(null);
    setOpenworkRestartStatus(null);
    try {
      await bootFullEngineStack();
      setOpenworkRestartStatus(t("settings.restart_opencode"));
      pushDeveloperLog("Restarted OpenCode via engine_start");
    } catch (error) {
      setServiceRestartError(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setOpencodeRestarting(false);
    }
  }, [bootFullEngineStack, pushDeveloperLog]);

  const onRestartOpenworkServer = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setOpenworkServerRestarting(true);
    setServiceRestartError(null);
    setOpenworkRestartStatus(null);
    try {
      await openworkServerRestartCmd({
        remoteAccessEnabled: openworkServerSnapshot.openworkServerSettings.remoteAccessEnabled === true,
      });
      setOpenworkRestartStatus(t("settings.restart_openwork_server"));
      pushDeveloperLog("Restarted openwork-server");
      await openworkServerStore.reconnectOpenworkServer();
    } catch (error) {
      setServiceRestartError(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setOpenworkServerRestarting(false);
    }
  }, [
    openworkServerSnapshot.openworkServerSettings.remoteAccessEnabled,
    openworkServerStore,
    pushDeveloperLog,
  ]);

  const onRestartOpencodeRouter = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const workspacePath = optionsRef.current.selectedWorkspaceRoot.trim();
    if (!workspacePath) {
      setServiceRestartError("Select a workspace before restarting the OpenCode Router.");
      return;
    }
    setOpencodeRouterRestarting(true);
    setServiceRestartError(null);
    setOpenworkRestartStatus(null);
    try {
      const info = await opencodeRouterInfoCmd().catch(() => null);
      await opencodeRouterRestartCmd({
        workspacePath,
        opencodeUrl: info?.opencodeUrl ?? undefined,
      });
      setOpenworkRestartStatus(t("settings.restart_opencode_router"));
      pushDeveloperLog("Restarted opencode-router");
    } catch (error) {
      setServiceRestartError(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setOpencodeRouterRestarting(false);
    }
  }, [pushDeveloperLog]);

  const onStopOpencodeRouter = useCallback(async () => {
    if (!isTauriRuntime()) return;
    try {
      await opencodeRouterStopCmd();
      pushDeveloperLog("Stopped opencode-router");
    } catch (error) {
      setServiceRestartError(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [pushDeveloperLog]);

  const onOpenResetModal = useCallback(
    (mode: ResetModalMode) => {
      if (!isTauriRuntime()) return;
      const message =
        mode === "all"
          ? "Reset ALL OpenWork app data? Open sessions and workspaces will be removed."
          : "Reset onboarding state only?";
      if (typeof window !== "undefined" && !window.confirm(message)) {
        return;
      }
      setResetModalBusy(true);
      void resetOpenworkState(mode)
        .then(() => {
          setOpenworkRestartStatus(
            mode === "all"
              ? "Reset OpenWork state. Restart the app to see changes."
              : "Reset onboarding state.",
          );
          pushDeveloperLog(`reset_openwork_state mode=${mode}`);
        })
        .catch((error) => {
          setRouteError(error instanceof Error ? error.message : safeStringify(error));
        })
        .finally(() => {
          setResetModalBusy(false);
        });
    },
    [pushDeveloperLog, setRouteError],
  );

  const onNukeOpenworkAndOpencodeConfig = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const confirmed =
      typeof window === "undefined"
        ? true
        : window.confirm(
            "Delete ALL local OpenWork + OpenCode config and quit? This cannot be undone.",
          );
    if (!confirmed) return;
    setNukeConfigBusy(true);
    setNukeConfigStatus(null);
    try {
      await nukeOpenworkAndOpencodeConfigAndExit();
    } catch (error) {
      setNukeConfigStatus(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setNukeConfigBusy(false);
    }
  }, []);

  const onClearWorkspaceDebugEvents = useCallback(async () => {
    setOpenworkRestartStatus("Workspace debug events are not retained in the React route yet.");
  }, []);

  const debugProps: DebugViewProps = useMemo(
    () => ({
      developerMode,
      busy: false,
      anyActiveRuns: false,
      startupPreference: "server",
      startupLabel:
        openworkServerSnapshot.openworkServerStatus === "connected"
          ? t("settings.openwork_server_label")
          : t("status.disconnected_label"),
      runtimeSummary,
      runtimeDebugReportJson,
      runtimeDebugStatus,
      onCopyRuntimeDebugReport,
      onExportRuntimeDebugReport,
      developerLogRecordCount: developerLog.length,
      developerLogText: developerLog.join("\n"),
      developerLogStatus,
      onClearDeveloperLog,
      onCopyDeveloperLog,
      onExportDeveloperLog,
      sandboxProbeBusy,
      sandboxProbeResult,
      sandboxProbeStatus,
      onRunSandboxDebugProbe,
      onStopHost,
      onResetStartupPreference,
      engineSource,
      onSetEngineSource,
      engineCustomBinPath,
      engineCustomBinPathLabel: engineCustomBinPath.trim() || t("settings.no_custom_path_set"),
      onPickEngineBinary,
      onClearEngineCustomBinPath,
      engineRuntime,
      onSetEngineRuntime,
      onOpenResetModal,
      resetModalBusy,
      openworkRestartBusy,
      opencodeRestarting,
      openworkServerRestarting,
      opencodeRouterRestarting,
      openworkRestartStatus,
      serviceRestartError,
      onRestartLocalServer,
      onRestartOpencode,
      onRestartOpenworkServer,
      onRestartOpencodeRouter,
      engineCard,
      orchestratorCard,
      opencodeConnectCard,
      openworkCard,
      opencodeRouterCard,
      onStopOpencodeRouter,
      openworkServerDiagnostics: openworkServerSnapshot.openworkServerDiagnostics,
      runtimeWorkspaceId,
      openworkServerCapabilities: openworkServerSnapshot.openworkServerCapabilities,
      pendingPermissions: {},
      events: [],
      workspaceDebugEvents: [],
      safeStringify,
      onClearWorkspaceDebugEvents,
      openworkAuditEntries: openworkServerSnapshot.openworkAuditEntries,
      openworkAuditStatus: auditStatusPill(openworkServerSnapshot.openworkAuditStatus),
      openworkAuditError: openworkServerSnapshot.openworkAuditError,
      opencodeConnectStatus: null,
      orchestratorStatus: openworkServerSnapshot.orchestratorStatusState,
      opencodeDevModeEnabled: appBuild?.openworkDevMode === true,
      nukeConfigBusy,
      nukeConfigStatus,
      onNukeOpenworkAndOpencodeConfig,
    }),
    [
      appBuild?.openworkDevMode,
      developerLog,
      developerLogStatus,
      developerMode,
      engineCard,
      engineCustomBinPath,
      engineRuntime,
      engineSource,
      nukeConfigBusy,
      nukeConfigStatus,
      onClearDeveloperLog,
      onClearEngineCustomBinPath,
      onClearWorkspaceDebugEvents,
      onCopyDeveloperLog,
      onCopyRuntimeDebugReport,
      onExportDeveloperLog,
      onExportRuntimeDebugReport,
      onNukeOpenworkAndOpencodeConfig,
      onOpenResetModal,
      onPickEngineBinary,
      onResetStartupPreference,
      onRestartLocalServer,
      onRestartOpencode,
      onRestartOpencodeRouter,
      onRestartOpenworkServer,
      onRunSandboxDebugProbe,
      onSetEngineRuntime,
      onSetEngineSource,
      onStopHost,
      onStopOpencodeRouter,
      opencodeConnectCard,
      opencodeRestarting,
      opencodeRouterCard,
      opencodeRouterRestarting,
      openworkCard,
      openworkRestartBusy,
      openworkRestartStatus,
      openworkServerRestarting,
      openworkServerSnapshot.openworkAuditEntries,
      openworkServerSnapshot.openworkAuditError,
      openworkServerSnapshot.openworkAuditStatus,
      openworkServerSnapshot.openworkServerCapabilities,
      openworkServerSnapshot.openworkServerDiagnostics,
      openworkServerSnapshot.openworkServerStatus,
      openworkServerSnapshot.orchestratorStatusState,
      orchestratorCard,
      resetModalBusy,
      runtimeDebugReportJson,
      runtimeDebugStatus,
      runtimeSummary,
      runtimeWorkspaceId,
      sandboxProbeBusy,
      sandboxProbeResult,
      sandboxProbeStatus,
      serviceRestartError,
    ],
  );

  return debugProps;
}
