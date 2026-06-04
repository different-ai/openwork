/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  appBuildInfo as appBuildInfoCmd,
  engineInfo as engineInfoCmd,
  engineStart as engineStartCmd,
  nukeOpenworkAndOpencodeConfigAndExit,
  openDesktopUrl,
  openworkServerInfo as openworkServerInfoCmd,
  openworkServerRestart as openworkServerRestartCmd,
  pickFile,
  revealDesktopItemInDir,
  resetOpenworkState,
  sandboxDebugProbe as sandboxDebugProbeCmd,
  updaterEnvironment as updaterEnvironmentCmd,
  workspaceBootstrap as workspaceBootstrapCmd,
  type AppBuildInfo,
  type EngineInfo,
  type OpenworkServerInfo,
  type SandboxDebugProbeResult,
} from "../../../../app/lib/desktop";
import {
  ELECTRON_ALPHA_RELEASE_PAGE_URL,
  type ElectronAlphaArtifact,
} from "../../../../app/lib/electron-alpha";

import {
  writeOpenworkServerSettings,
} from "../../../../app/lib/openwork-server";
import {
  clearStartupPreference,
  isDesktopRuntime,
  isElectronRuntime,
  isMacPlatform,
  safeStringify,
} from "../../../../app/utils";
import { t } from "../../../../i18n";
import type { DebugViewProps } from "../pages/debug-view";
import type { ReleaseChannel } from "../../../../app/types";
import type { OpenworkServerStore, OpenworkServerStoreSnapshot } from "../../connections/openwork-server-store";

const STARTUP_PREFERENCE_KEY = "openwork.startupPreference";
const ENGINE_SOURCE_KEY = "openwork.engineSource";
const ENGINE_CUSTOM_BIN_KEY = "openwork.engineCustomBinPath";
const OPENCODE_ENABLE_EXA_KEY = "openwork.opencodeEnableExa";

type ResetModalMode = "onboarding" | "all";

const ONBOARDING_LOCAL_STORAGE_KEYS = [
  "openwork.acknowledgedProviders",
  "openwork.orgOnboardingSeen",
  "openwork.reloadAfterOrgOnboarding",
  "openwork.seenProviderIds",
];

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

function clearOpenworkLocalStorageForReset(mode: ResetModalMode): void {
  if (typeof window === "undefined") return;
  try {
    if (mode === "all") {
      window.localStorage.clear();
      return;
    }
    for (const key of ONBOARDING_LOCAL_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
    const raw = window.localStorage.getItem("openwork.preferences");
    if (raw) {
      const prefs = JSON.parse(raw);
      prefs.hasCompletedOnboarding = false;
      window.localStorage.setItem("openwork.preferences", JSON.stringify(prefs));
    }
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

function readOpencodeEnableExa(): boolean {
  return readStoredString(OPENCODE_ENABLE_EXA_KEY, "1") === "1";
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
      t("settings.debug_base_url", { url: info?.baseUrl ?? "—" }),
      t("settings.debug_runtime", { runtime: info?.runtime ?? "—" }),
      t("settings.diag_opencode_binary", { binary: formatOpencodeBinary(info) }),
      t("settings.debug_pid", { pid: info?.pid ? String(info.pid) : "—" }),
      t("settings.debug_hostname", { hostname: info?.hostname ?? "—" }),
      t("settings.debug_port", { port: info?.port ? String(info.port) : "—" }),
    ],
    stdout: info?.lastStdout ?? null,
    stderr: info?.lastStderr ?? null,
    execution: info?.execution ?? null,
    error: null as string | null,
  };
}

function formatOpencodeBinary(info: EngineInfo | null) {
  return formatBinaryWithSource(info?.opencodeBinPath, info?.opencodeBinSource);
}

function formatManagedOpencodeBinary(info: OpenworkServerInfo | null) {
  return formatBinaryWithSource(
    info?.managedOpencodeBinPath,
    info?.managedOpencodeBinSource,
  );
}

function formatBinaryWithSource(path: string | null | undefined, source: string | null | undefined) {
  const binary = path?.trim();
  if (!binary) return "—";
  const sourceLabel = source?.trim();
  return sourceLabel ? `${binary} (${sourceLabel})` : binary;
}

function describeOpenworkServer(info: OpenworkServerInfo | null) {
  const running = Boolean(info?.running);
  return {
    ...statusPill(running),
    lines: [
      t("settings.debug_base_url", { url: info?.baseUrl ?? "—" }),
      t("settings.diag_opencode_binary", { binary: formatManagedOpencodeBinary(info) }),
      t("settings.debug_connect_url", { url: info?.connectUrl ?? "—" }),
      t("settings.debug_lan_url", { url: info?.lanUrl ?? "—" }),
      t("settings.debug_mdns_url", { url: info?.mdnsUrl ?? "—" }),
      t("settings.debug_pid", { pid: info?.pid ? String(info.pid) : "—" }),
      t("settings.debug_remote_access", {
        value: info?.remoteAccessEnabled ? t("settings.on") : t("settings.off"),
      }),
    ],
    stdout: info?.lastStdout ?? null,
    stderr: info?.lastStderr ?? null,
    execution: info?.managedOpencodeExecution ?? null,
    error: null as string | null,
  };
}

function describeOpencodeConnect(engine: EngineInfo | null) {
  const running = Boolean(engine?.baseUrl);
  return {
    ...statusPill(running),
    lines: [
      t("settings.debug_base_url", { url: engine?.baseUrl ?? "—" }),
      t("settings.debug_project_dir", { path: engine?.projectDir ?? "—" }),
      t("settings.debug_runtime", { runtime: engine?.runtime ?? "—" }),
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
  const [opencodeRestarting, setOpencodeRestarting] = useState(false);
  const [openworkServerRestarting, setOpenworkServerRestarting] = useState(false);
  const [opencodeServiceStatus, setOpencodeServiceStatus] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [openworkServiceStatus, setOpenworkServiceStatus] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [opencodeLogStatus, setOpencodeLogStatus] = useState<string | null>(null);
  const [openworkLogStatus, setOpenworkLogStatus] = useState<string | null>(null);
  const [serviceRestartError, setServiceRestartError] = useState<string | null>(null);
  const [resetModalBusy, setResetModalBusy] = useState(false);
  const [nukeConfigBusy, setNukeConfigBusy] = useState(false);
  const [nukeConfigStatus, setNukeConfigStatus] = useState<string | null>(null);
  const [engineSource, setEngineSourceState] = useState<"path" | "sidecar" | "custom">(readEngineSource);
  const [engineCustomBinPath, setEngineCustomBinPath] = useState<string>(() =>
    readStoredString(ENGINE_CUSTOM_BIN_KEY, ""),
  );
  const [developerLog, setDeveloperLog] = useState<string[]>([]);
  const [developerLogStatus, setDeveloperLogStatus] = useState<string | null>(null);
  const [electronMigrationUrl, setElectronMigrationUrl] = useState("");
  const [electronMigrationSha256, setElectronMigrationSha256] = useState("");
  const [electronMigrationSha512, setElectronMigrationSha512] = useState("");
  const [electronMigrationArtifact, setElectronMigrationArtifact] = useState<ElectronAlphaArtifact | null>(null);
  const [electronMigrationBusy] = useState(false);
  const [electronMigrationStatus, setElectronMigrationStatus] = useState<string | null>(null);
  const [electronAlphaUpdaterBusy, setElectronAlphaUpdaterBusy] = useState(false);
  const [electronAlphaUpdaterStatus, setElectronAlphaUpdaterStatus] = useState<string | null>(null);
  const [electronAlphaUpdaterChannel, setElectronAlphaUpdaterChannel] = useState<ReleaseChannel>("stable");

  const refreshEngineInfo = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      const info = await engineInfoCmd() as EngineInfo | null;
      setEngineInfoState(info);
    } catch {
      setEngineInfoState(null);
    }
  }, []);

  useEffect(() => {
    if (!developerMode) return;
    void (async () => {
      if (!isDesktopRuntime()) return;
      try {
        const build = await appBuildInfoCmd() as AppBuildInfo | null;
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
      opencodeVersionLabel: engineInfoState?.baseUrl ? "managed" : "—",
      openworkServerVersionLabel: openworkServerSnapshot.openworkServerDiagnostics?.version ?? "—",
    }),
    [
      appBuild?.gitSha,
      appBuild?.version,
      engineInfoState?.baseUrl,
      openworkServerSnapshot.openworkServerDiagnostics?.version,
    ],
  );

  const runtimeDebugReport = useMemo(() => {
    return {
      collectedAt: new Date().toISOString(),
      app: appBuild ?? null,
      engine: engineInfoState,
      openworkServer: {
        hostInfo: openworkServerSnapshot.openworkServerHostInfo,
        diagnostics: openworkServerSnapshot.openworkServerDiagnostics,
        capabilities: openworkServerSnapshot.openworkServerCapabilities,
        settings: openworkServerSnapshot.openworkServerSettings,
        status: openworkServerSnapshot.openworkServerStatus,
        url: openworkServerSnapshot.openworkServerUrl,
      },
      runtimeWorkspaceId,
      selectedWorkspaceRoot,
    };
  }, [
    appBuild,
    engineInfoState,
    openworkServerSnapshot.openworkServerCapabilities,
    openworkServerSnapshot.openworkServerDiagnostics,
    openworkServerSnapshot.openworkServerHostInfo,
    openworkServerSnapshot.openworkServerSettings,
    openworkServerSnapshot.openworkServerStatus,
    openworkServerSnapshot.openworkServerUrl,
    runtimeWorkspaceId,
    selectedWorkspaceRoot,
  ]);

  const runtimeDebugReportJson = useMemo(
    () => safeStringify(runtimeDebugReport),
    [runtimeDebugReport],
  );

  const engineCard = useMemo(() => describeEngine(engineInfoState), [engineInfoState]);
  const openworkCard = useMemo(
    () => describeOpenworkServer(openworkServerSnapshot.openworkServerHostInfo),
    [openworkServerSnapshot.openworkServerHostInfo],
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

  const onOpenElectronPreviewRelease = useCallback(async () => {
    try {
      await openDesktopUrl(ELECTRON_ALPHA_RELEASE_PAGE_URL);
      setElectronMigrationStatus("Opened the rolling Electron alpha release. Download links live there after dev builds finish.");
    } catch (error) {
      setElectronMigrationStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, []);

  const onSetElectronMigrationUrl = useCallback((value: string) => {
    setElectronMigrationUrl(value);
    setElectronMigrationArtifact(null);
  }, []);

  const onSetElectronMigrationSha512 = useCallback((value: string) => {
    setElectronMigrationSha512(value);
    setElectronMigrationArtifact(null);
  }, []);

  const electronMigrationArtifactLabel = useMemo(() => {
    if (!electronMigrationArtifact) return null;
    return `Resolved v${electronMigrationArtifact.version} (${electronMigrationArtifact.arch}) · ${electronMigrationArtifact.path}`;
  }, [electronMigrationArtifact]);

  const onResolveElectronAlphaArtifact = useCallback(async () => {
    setElectronMigrationStatus("Tauri → Electron migration controls were removed after Electron became the desktop runtime.");
  }, []);

  const onRevealElectronMigrationBackup = useCallback(async () => {
    if (!isElectronRuntime()) {
      setElectronMigrationStatus("Migration backup reveal is available only in the desktop app.");
      return;
    }
    try {
      const env = await updaterEnvironmentCmd() as { appBundlePath?: string };
      const appBundlePath = env.appBundlePath?.trim();
      if (!appBundlePath) {
        setElectronMigrationStatus("Could not resolve the current OpenWork.app bundle path.");
        return;
      }
      await revealDesktopItemInDir(`${appBundlePath}.migrate-bak`);
      setElectronMigrationStatus("Requested Finder reveal for OpenWork.app.migrate-bak. The backup exists after an install handoff completes.");
    } catch (error) {
      setElectronMigrationStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, []);

  const onPrepareElectronMigrationSnapshot = useCallback(async () => {
    setElectronMigrationStatus("Tauri migration snapshots are no longer available because Tauri has been removed.");
  }, []);

  const onInstallElectronPreviewFromTauri = useCallback(async () => {
    setElectronMigrationStatus("Tauri → Electron install handoff is no longer available because Electron is now the desktop runtime.");
  }, []);

  useEffect(() => {
    if (!developerMode || !isElectronRuntime()) return;
    const bridge = window.__OPENWORK_ELECTRON__?.updater;
    if (!bridge?.getChannel) return;
    let cancelled = false;
    void bridge.getChannel()
      .then((state) => {
        if (cancelled) return;
        setElectronAlphaUpdaterChannel(state.channel ?? "stable");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [developerMode]);

  const onSetElectronAlphaUpdaterChannel = useCallback(async (channel: ReleaseChannel) => {
    if (!isElectronRuntime()) {
      setElectronAlphaUpdaterStatus("Electron updater channels are available only in the Electron desktop app.");
      return;
    }
    if (channel === "alpha" && !isMacPlatform()) {
      setElectronAlphaUpdaterStatus("Electron alpha updates are macOS-only for now.");
      return;
    }
    const bridge = window.__OPENWORK_ELECTRON__?.updater;
    if (!bridge?.setChannel) {
      setElectronAlphaUpdaterStatus("Electron updater bridge is unavailable.");
      return;
    }
    setElectronAlphaUpdaterBusy(true);
    setElectronAlphaUpdaterStatus(null);
    try {
      const state = await bridge.setChannel(channel);
      setElectronAlphaUpdaterChannel(state.channel ?? channel);
      setElectronAlphaUpdaterStatus(
        `Subscribed Electron updater to ${state.channel ?? channel} (${state.feedUrl}).`,
      );
      pushDeveloperLog(`set Electron updater channel=${state.channel ?? channel}`);
    } catch (error) {
      setElectronAlphaUpdaterStatus(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setElectronAlphaUpdaterBusy(false);
    }
  }, [pushDeveloperLog]);

  const onCheckElectronAlphaUpdates = useCallback(async () => {
    if (!isElectronRuntime()) {
      setElectronAlphaUpdaterStatus("Electron update checks are available only in the Electron desktop app.");
      return;
    }
    const bridge = window.__OPENWORK_ELECTRON__?.updater;
    if (!bridge?.check) {
      setElectronAlphaUpdaterStatus("Electron updater bridge is unavailable.");
      return;
    }
    setElectronAlphaUpdaterBusy(true);
    setElectronAlphaUpdaterStatus(null);
    try {
      const result = await bridge.check();
      if (result.channel) setElectronAlphaUpdaterChannel(result.channel);
      if (result.reason === "unavailable") {
        setElectronAlphaUpdaterStatus("Electron updater is available only in packaged Electron builds.");
        return;
      }
      if (result.reason) {
        setElectronAlphaUpdaterStatus(result.reason);
        return;
      }
      setElectronAlphaUpdaterStatus(
        result.available
          ? `Update available: v${result.latestVersion ?? "unknown"} on ${result.channel ?? electronAlphaUpdaterChannel}. Use Settings → Updates to download and install.`
          : `No Electron update available on ${result.channel ?? electronAlphaUpdaterChannel}.`,
      );
    } catch (error) {
      setElectronAlphaUpdaterStatus(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setElectronAlphaUpdaterBusy(false);
    }
  }, [electronAlphaUpdaterChannel]);

  const onRunSandboxDebugProbe = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    setSandboxProbeBusy(true);
    setSandboxProbeStatus(null);
    try {
      const result = (await sandboxDebugProbeCmd()) as SandboxDebugProbeResult | null;
      setSandboxProbeResult(result);
      setSandboxProbeStatus(
        result!.ready
          ? t("settings.sandbox_probe_success")
          : (result!.error ?? t("settings.sandbox_error")),
      );
      pushDeveloperLog(`sandbox probe ready=${String(result!.ready)}`);
    } catch (error) {
      setSandboxProbeStatus(error instanceof Error ? error.message : safeStringify(error));
    } finally {
      setSandboxProbeBusy(false);
    }
  }, [pushDeveloperLog]);

  const [startupStatus, setStartupStatus] = useState<string | null>(null);

  const onStopHost = useCallback(async () => {
    clearStartupPreference();
    setStartupStatus(t("settings.startup_reset_hint"));
  }, []);

  const onResetStartupPreference = useCallback(async () => {
    clearStartupPreference();
    setStartupStatus(t("settings.startup_reset_hint"));
  }, []);

  const onSetEngineSource = useCallback((value: "path" | "sidecar" | "custom") => {
    setEngineSourceState(value);
    writeStoredString(ENGINE_SOURCE_KEY, value);
  }, []);

  const onPickEngineBinary = useCallback(async () => {
    if (!isDesktopRuntime()) {
      setServiceRestartError(t("settings.sandbox_requires_desktop"));
      return;
    }
    try {
      const target = await pickFile({ title: t("settings.custom_binary_label"), multiple: false });
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
        "Select a local workspace before starting the local server/engine.",
      );
    }

    // Collect ALL local workspace paths so openwork-server is started with
    // --workspace <path> for every registered local workspace. Mirrors the
    // Solid reference (context/workspace.ts::resolveWorkspacePaths) so that
    // `client.listWorkspaces()` later returns the full set, not just the
    // active one.
    const workspacePaths = [workspacePath];
    const workspacePathSet = new Set(workspacePaths);
    try {
      const list = (await workspaceBootstrapCmd()) as { workspaces?: Array<{ workspaceType?: string; path?: string }> } | null;
      for (const entry of list?.workspaces ?? []) {
        if (entry.workspaceType === "remote") continue;
        const path = entry.path?.trim() ?? "";
        if (path && !workspacePathSet.has(path)) {
          workspacePaths.push(path);
          workspacePathSet.add(path);
        }
      }
    } catch {
      // best-effort: fall back to just the active workspace path
    }

    const info = await engineStartCmd(workspacePath, {
      runtime: "direct",
      workspacePaths,
      opencodeEnableExa: readOpencodeEnableExa(),
      openworkRemoteAccess:
        optionsRef.current.openworkServerSnapshot.openworkServerSettings
          .remoteAccessEnabled === true,
    });

    // engine_start restarts openwork-server on a NEW port and lets that server
    // manage OpenCode. Re-read host info and persist the fresh URL/token.
    try {
      const hostInfo = (await openworkServerInfoCmd()) as {
        baseUrl?: string;
        ownerToken?: string;
        clientToken?: string;
        hostToken?: string;
        port?: number;
        remoteAccessEnabled?: boolean;
      } | null;
      if (hostInfo?.baseUrl) {
        writeOpenworkServerSettings({
          urlOverride: hostInfo.baseUrl,
          token: hostInfo.ownerToken?.trim() || hostInfo.clientToken?.trim() || undefined,
          hostToken: hostInfo.hostToken?.trim() || undefined,
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

  const onRestartOpencode = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    setOpencodeRestarting(true);
    setOpencodeServiceStatus(null);
    setServiceRestartError(null);
    try {
      await bootFullEngineStack();
      setOpencodeServiceStatus({
        tone: "success",
        message: t("settings.restart_succeeded_template", { service: "OpenCode" }),
      });
      pushDeveloperLog("Restarted OpenCode via engine_start");
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setOpencodeServiceStatus({
        tone: "error",
        message: `${t("settings.restart_failed_template", { service: "OpenCode" })} ${message}`,
      });
      setServiceRestartError(message);
    } finally {
      setOpencodeRestarting(false);
    }
  }, [bootFullEngineStack, pushDeveloperLog]);

  const onRestartOpenworkServer = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    setOpenworkServerRestarting(true);
    setOpenworkServiceStatus(null);
    setServiceRestartError(null);
    try {
      await openworkServerRestartCmd({
        remoteAccessEnabled: openworkServerSnapshot.openworkServerSettings.remoteAccessEnabled === true,
      });
      setOpenworkServiceStatus({
        tone: "success",
        message: t("settings.restart_succeeded_template", { service: "OpenWork server" }),
      });
      pushDeveloperLog("Restarted openwork-server");
      await openworkServerStore.reconnectOpenworkServer();
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setOpenworkServiceStatus({
        tone: "error",
        message: `${t("settings.restart_failed_template", { service: "OpenWork server" })} ${message}`,
      });
      setServiceRestartError(message);
    } finally {
      setOpenworkServerRestarting(false);
    }
  }, [
    openworkServerSnapshot.openworkServerSettings.remoteAccessEnabled,
    openworkServerStore,
    pushDeveloperLog,
  ]);

  const formatServiceLogs = useCallback(
    (stdout: string | null | undefined, stderr: string | null | undefined): string => {
      const out = (stdout ?? "").toString().trim();
      const err = (stderr ?? "").toString().trim();
      const sections: string[] = [];
      if (out) sections.push(`# stdout\n${out}`);
      if (err) sections.push(`# stderr\n${err}`);
      return sections.join("\n\n");
    },
    [],
  );

  const onCopyOpencodeLogs = useCallback(async () => {
    const text = formatServiceLogs(engineInfoState?.lastStdout, engineInfoState?.lastStderr);
    if (!text) {
      setOpencodeLogStatus(t("settings.no_logs_captured"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setOpencodeLogStatus(t("settings.copied_service_logs", { service: "OpenCode" }));
    } catch (error) {
      setOpencodeLogStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [engineInfoState?.lastStderr, engineInfoState?.lastStdout, formatServiceLogs]);

  const onExportOpencodeLogs = useCallback(async () => {
    const text = formatServiceLogs(engineInfoState?.lastStdout, engineInfoState?.lastStderr);
    if (!text) {
      setOpencodeLogStatus(t("settings.no_logs_captured"));
      return;
    }
    try {
      downloadTextAsFile(
        `openwork-opencode-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
        text,
        "text/plain",
      );
      setOpencodeLogStatus(t("settings.exported_developer_log"));
    } catch (error) {
      setOpencodeLogStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [engineInfoState?.lastStderr, engineInfoState?.lastStdout, formatServiceLogs]);

  const onCopyOpenworkLogs = useCallback(async () => {
    const info = openworkServerSnapshot.openworkServerHostInfo;
    const text = formatServiceLogs(info?.lastStdout, info?.lastStderr);
    if (!text) {
      setOpenworkLogStatus(t("settings.no_logs_captured"));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setOpenworkLogStatus(t("settings.copied_service_logs", { service: "OpenWork server" }));
    } catch (error) {
      setOpenworkLogStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [formatServiceLogs, openworkServerSnapshot.openworkServerHostInfo]);

  const onExportOpenworkLogs = useCallback(async () => {
    const info = openworkServerSnapshot.openworkServerHostInfo;
    const text = formatServiceLogs(info?.lastStdout, info?.lastStderr);
    if (!text) {
      setOpenworkLogStatus(t("settings.no_logs_captured"));
      return;
    }
    try {
      downloadTextAsFile(
        `openwork-server-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
        text,
        "text/plain",
      );
      setOpenworkLogStatus(t("settings.exported_developer_log"));
    } catch (error) {
      setOpenworkLogStatus(error instanceof Error ? error.message : safeStringify(error));
    }
  }, [formatServiceLogs, openworkServerSnapshot.openworkServerHostInfo]);

  const [resetStatus, setResetStatus] = useState<string | null>(null);

  const onOpenResetModal = useCallback(
    (mode: ResetModalMode) => {
      if (!isDesktopRuntime()) return;
      const message =
        mode === "all"
          ? "Reset ALL OpenWork app data? Open sessions and workspaces will be removed."
          : "Reset onboarding state only?";
      if (typeof window !== "undefined" && !window.confirm(message)) {
        return;
      }
      setResetModalBusy(true);
      setResetStatus(null);
      void resetOpenworkState(mode)
        .then(async () => {
          clearOpenworkLocalStorageForReset(mode);
          setResetStatus(
            mode === "all"
              ? "Reset OpenWork state. Restart the app to see changes."
              : "Reset onboarding state. Restart the app to see changes.",
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
    if (!isDesktopRuntime()) return;
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

  const [workspaceDebugEventsStatus, setWorkspaceDebugEventsStatus] = useState<string | null>(null);
  const onClearWorkspaceDebugEvents = useCallback(async () => {
    setWorkspaceDebugEventsStatus("Workspace debug events are not retained in the React route yet.");
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
      electronMigrationAvailable: false,
      electronMigrationUrl,
      electronMigrationSha256,
      electronMigrationSha512,
      electronMigrationArtifactLabel,
      electronMigrationBusy,
      electronMigrationStatus,
      electronPreviewReleaseUrl: ELECTRON_ALPHA_RELEASE_PAGE_URL,
      onSetElectronMigrationUrl,
      onSetElectronMigrationSha256: setElectronMigrationSha256,
      onSetElectronMigrationSha512,
      onOpenElectronPreviewRelease,
      onResolveElectronAlphaArtifact,
      onRevealElectronMigrationBackup,
      onPrepareElectronMigrationSnapshot,
      onInstallElectronPreviewFromTauri,
      electronAlphaUpdaterAvailable: isElectronRuntime() && isMacPlatform(),
      electronAlphaUpdaterBusy,
      electronAlphaUpdaterStatus,
      electronAlphaUpdaterChannel,
      onSetElectronAlphaUpdaterChannel,
      onCheckElectronAlphaUpdates,
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
      onOpenResetModal,
      resetModalBusy,
      resetStatus,
      startupStatus,
      workspaceDebugEventsStatus,
      opencodeRestarting,
      openworkServerRestarting,
      opencodeServiceStatus,
      openworkServiceStatus,
      opencodeLogStatus,
      openworkLogStatus,
      onCopyOpencodeLogs,
      onExportOpencodeLogs,
      onCopyOpenworkLogs,
      onExportOpenworkLogs,
      serviceRestartError,
      onRestartOpencode,
      onRestartOpenworkServer,
      engineCard,
      opencodeConnectCard,
      openworkCard,
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
      electronMigrationBusy,
      electronMigrationArtifactLabel,
      electronMigrationSha256,
      electronMigrationSha512,
      electronMigrationStatus,
      electronMigrationUrl,
      electronAlphaUpdaterBusy,
      electronAlphaUpdaterChannel,
      electronAlphaUpdaterStatus,
      engineCard,
      engineCustomBinPath,
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
      onInstallElectronPreviewFromTauri,
      onCheckElectronAlphaUpdates,
      onNukeOpenworkAndOpencodeConfig,
      onOpenElectronPreviewRelease,
      onOpenResetModal,
      onPrepareElectronMigrationSnapshot,
      onPickEngineBinary,
      onResolveElectronAlphaArtifact,
      onRevealElectronMigrationBackup,
      onResetStartupPreference,
      onRestartOpencode,
      onRestartOpenworkServer,
      onRunSandboxDebugProbe,
      onSetElectronAlphaUpdaterChannel,
      onSetElectronMigrationSha512,
      onSetElectronMigrationUrl,
      onSetEngineSource,
      onStopHost,
      onCopyOpencodeLogs,
      onCopyOpenworkLogs,
      onExportOpencodeLogs,
      onExportOpenworkLogs,
      opencodeConnectCard,
      opencodeLogStatus,
      opencodeRestarting,
      opencodeServiceStatus,
      openworkCard,
      openworkLogStatus,
      openworkServiceStatus,
      openworkServerRestarting,
      resetStatus,
      startupStatus,
      workspaceDebugEventsStatus,
      openworkServerSnapshot.openworkAuditEntries,
      openworkServerSnapshot.openworkAuditError,
      openworkServerSnapshot.openworkAuditStatus,
      openworkServerSnapshot.openworkServerCapabilities,
      openworkServerSnapshot.openworkServerDiagnostics,
      openworkServerSnapshot.openworkServerStatus,
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
