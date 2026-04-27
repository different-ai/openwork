/** @jsxImportSource react */
import {
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  HardDrive,
  RefreshCcw,
  Smartphone,
} from "lucide-react";

import type {
  OpenworkAuditEntry,
  OpenworkServerCapabilities,
  OpenworkServerDiagnostics,
} from "../../../../app/lib/openwork-server";
import type {
  OrchestratorStatus,
  SandboxDebugProbeResult,
} from "../../../../app/lib/desktop";
import type {
  OpencodeConnectStatus,
  StartupPreference,
} from "../../../../app/types";
import { formatRelativeTime, isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";

const settingsCardClass =
  "rounded-2xl border border-gray-6/50 bg-gray-2/30 p-5 space-y-3";
const settingsSoftCardClass =
  "rounded-xl border border-gray-6 bg-gray-1 p-4";
const settingsMonoPreClass =
  "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-6 bg-gray-1 p-3 text-xs text-gray-12";
const settingsMiniPreClass =
  "max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-gray-6 bg-gray-2/50 p-2 text-xs text-gray-12";
const compactDangerActionClass =
  "inline-flex h-9 items-center gap-2 rounded-xl border border-red-7/40 bg-red-9 px-4 text-xs font-medium text-white transition-colors hover:bg-red-10 disabled:cursor-not-allowed disabled:opacity-60";

type RuntimeSummary = {
  appVersionLabel: string;
  appCommitLabel: string;
  orchestratorVersionLabel: string;
  opencodeVersionLabel: string;
  openworkServerVersionLabel: string;
  opencodeRouterVersionLabel: string;
};

type StatusPill = {
  label: string;
  className: string;
};

type RuntimeServiceCard = StatusPill & {
  lines: string[];
  stdout?: string | null;
  stderr?: string | null;
  error?: string | null;
};

type OrchestratorDebugCard = StatusPill & {
  lines: string[];
  binaryTitle?: string | null;
  error?: string | null;
};

type OpenCodeConnectDebugCard = StatusPill & {
  lines: string[];
  metricsLines: string[];
  error?: string | null;
};

export type DebugViewProps = {
  developerMode: boolean;
  busy: boolean;
  anyActiveRuns: boolean;
  startupPreference: StartupPreference | null;
  startupLabel: string;
  runtimeSummary: RuntimeSummary;
  runtimeDebugReportJson: string;
  runtimeDebugStatus: string | null;
  onCopyRuntimeDebugReport: () => void | Promise<void>;
  onExportRuntimeDebugReport: () => void | Promise<void>;
  developerLogRecordCount: number;
  developerLogText: string;
  developerLogStatus: string | null;
  onClearDeveloperLog: () => void | Promise<void>;
  onCopyDeveloperLog: () => void | Promise<void>;
  onExportDeveloperLog: () => void | Promise<void>;
  electronMigrationAvailable: boolean;
  electronMigrationUrl: string;
  electronMigrationSha256: string;
  electronMigrationBusy: boolean;
  electronMigrationStatus: string | null;
  electronPreviewReleaseUrl: string;
  onSetElectronMigrationUrl: (value: string) => void;
  onSetElectronMigrationSha256: (value: string) => void;
  onOpenElectronPreviewRelease: () => void | Promise<void>;
  onPrepareElectronMigrationSnapshot: () => void | Promise<void>;
  onInstallElectronPreviewFromTauri: () => void | Promise<void>;
  sandboxProbeBusy: boolean;
  sandboxProbeResult: SandboxDebugProbeResult | null;
  sandboxProbeStatus: string | null;
  onRunSandboxDebugProbe: () => void | Promise<void>;
  onStopHost: () => void | Promise<void>;
  onResetStartupPreference: () => void | Promise<void>;
  engineSource: "path" | "sidecar" | "custom";
  onSetEngineSource: (value: "path" | "sidecar" | "custom") => void;
  engineCustomBinPath: string;
  engineCustomBinPathLabel: string;
  onPickEngineBinary: () => void | Promise<void>;
  onClearEngineCustomBinPath: () => void;
  engineRuntime: "direct" | "openwork-orchestrator";
  onSetEngineRuntime: (value: "direct" | "openwork-orchestrator") => void;
  onOpenResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  openworkRestartBusy: boolean;
  opencodeRestarting: boolean;
  openworkServerRestarting: boolean;
  opencodeRouterRestarting: boolean;
  openworkRestartStatus: string | null;
  serviceRestartError: string | null;
  onRestartLocalServer: () => void | Promise<void>;
  onRestartOpencode: () => void | Promise<void>;
  onRestartOpenworkServer: () => void | Promise<void>;
  onRestartOpencodeRouter: () => void | Promise<void>;
  engineCard: RuntimeServiceCard;
  orchestratorCard: OrchestratorDebugCard;
  opencodeConnectCard: OpenCodeConnectDebugCard;
  openworkCard: RuntimeServiceCard;
  opencodeRouterCard: RuntimeServiceCard & { running?: boolean };
  onStopOpencodeRouter: () => void | Promise<void>;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  runtimeWorkspaceId: string | null;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  pendingPermissions: unknown;
  events: unknown;
  workspaceDebugEvents: unknown;
  safeStringify: (value: unknown) => string;
  onClearWorkspaceDebugEvents: () => void | Promise<void>;
  openworkAuditEntries: OpenworkAuditEntry[];
  openworkAuditStatus: StatusPill;
  openworkAuditError: string | null;
  opencodeConnectStatus: OpencodeConnectStatus | null;
  orchestratorStatus: OrchestratorStatus | null;
  opencodeDevModeEnabled: boolean;
  nukeConfigBusy: boolean;
  nukeConfigStatus: string | null;
  onNukeOpenworkAndOpencodeConfig: () => void | Promise<void>;
};

function formatActor(entry: OpenworkAuditEntry) {
  if (entry.actor.type === "host") return t("settings.audit_actor_host");
  if (entry.actor.clientId) return entry.actor.clientId;
  if (entry.actor.tokenHash) return entry.actor.tokenHash;
  return t("settings.audit_actor_remote");
}

function formatCapability(value: { read: boolean; write: boolean }) {
  if (value.read && value.write) return t("settings.cap_read_write");
  if (value.read) return t("settings.cap_read_only");
  if (value.write) return t("settings.cap_write_only");
  return t("settings.disabled");
}

function formatUptime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function renderLines(lines: string[]) {
  return lines.map((line, index) => (
    <div key={`${line}-${index}`} className="text-[11px] font-mono text-gray-7 truncate">
      {line}
    </div>
  ));
}

export function DebugView(props: DebugViewProps) {
  if (!props.developerMode) return null;

  const isDesktop = isDesktopRuntime();
  const isLocalPreference = props.startupPreference !== "server";
  const sandboxProbeDisabled = !isDesktop || props.sandboxProbeBusy || props.anyActiveRuns;
  const sandboxProbeTitle = !isDesktop
    ? t("settings.sandbox_requires_desktop")
    : props.anyActiveRuns
      ? t("settings.sandbox_stop_runs_hint")
      : "";

  return (
    <section>
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-gray-11">
        {t("settings.debug_section_title")}
      </h3>

      <div className="space-y-4">
        <div className={settingsCardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-12">{t("settings.runtime_debug_title")}</div>
              <div className="text-xs text-gray-10">{t("settings.runtime_debug_desc")}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" className="h-8 px-3 py-0 text-xs" onClick={() => void props.onCopyRuntimeDebugReport()}>
                <Copy size={13} className="mr-1.5" />
                {t("settings.copy_json")}
              </Button>
              <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={() => void props.onExportRuntimeDebugReport()}>
                <Download size={13} className="mr-1.5" />
                {t("settings.export")}
              </Button>
            </div>
          </div>
          <div className="grid gap-2 text-xs text-gray-11 md:grid-cols-2">
            <div>{t("settings.debug_desktop_app", undefined, { version: props.runtimeSummary.appVersionLabel })}</div>
            <div>{t("settings.debug_commit", undefined, { commit: props.runtimeSummary.appCommitLabel })}</div>
            <div>
              {t("settings.debug_orchestrator_version", undefined, {
                version: props.runtimeSummary.orchestratorVersionLabel,
              })}
            </div>
            <div>{t("settings.debug_opencode_version", undefined, { version: props.runtimeSummary.opencodeVersionLabel })}</div>
            <div>
              {t("settings.debug_openwork_server_version", undefined, {
                version: props.runtimeSummary.openworkServerVersionLabel,
              })}
            </div>
            <div>
              {t("settings.debug_opencode_router_version", undefined, {
                version: props.runtimeSummary.opencodeRouterVersionLabel,
              })}
            </div>
          </div>
          <pre className={settingsMonoPreClass}>{props.runtimeDebugReportJson}</pre>
          {props.runtimeDebugStatus ? <div className="text-xs text-gray-10">{props.runtimeDebugStatus}</div> : null}
        </div>

        <div className={settingsCardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-12">Developer log stream</div>
              <div className="text-xs text-gray-10">
                Captures dev-mode app, workspace, session, and perf logs while Developer Mode is enabled.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="outline" className="h-8 px-3 py-0 text-xs" onClick={() => void props.onClearDeveloperLog()}>
                Clear
              </Button>
              <Button variant="outline" className="h-8 px-3 py-0 text-xs" onClick={() => void props.onCopyDeveloperLog()}>
                <Copy size={13} className="mr-1.5" />
                Copy log
              </Button>
              <Button variant="secondary" className="h-8 px-3 py-0 text-xs" onClick={() => void props.onExportDeveloperLog()}>
                <Download size={13} className="mr-1.5" />
                Export .log
              </Button>
            </div>
          </div>
          <div className="text-[11px] text-gray-8">
            Showing the latest {props.developerLogRecordCount} retained records.
          </div>
          <pre className={settingsMonoPreClass}>{props.developerLogText || "No developer logs captured yet."}</pre>
          {props.developerLogStatus ? <div className="text-xs text-gray-10">{props.developerLogStatus}</div> : null}
        </div>

        {props.electronMigrationAvailable ? (
          <div className={settingsCardClass}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-12">Electron preview migration</div>
                <div className="text-xs text-gray-10">
                  Debug-only Tauri controls. Preparing migration data is non-destructive; installing requires a URL and two confirmations.
                </div>
              </div>
              <Button
                variant="outline"
                className="h-8 shrink-0 px-3 py-0 text-xs"
                onClick={() => void props.onOpenElectronPreviewRelease()}
              >
                <ExternalLink size={13} className="mr-1.5" />
                Preview release
              </Button>
            </div>

            <div className="rounded-xl border border-green-7/25 bg-green-3/10 px-3 py-2 text-xs leading-relaxed text-green-11">
              Safe default: use <strong>Prepare migration data</strong> first. It writes the Electron snapshot only and does not replace, quit, or delete the Tauri app.
            </div>

            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px]">
              <label className="space-y-1 text-xs text-gray-10">
                <span>Electron artifact URL</span>
                <input
                  type="url"
                  value={props.electronMigrationUrl}
                  onChange={(event) => props.onSetElectronMigrationUrl(event.currentTarget.value)}
                  placeholder="Paste a trusted Electron .zip/.exe/AppImage URL"
                  className="h-10 w-full rounded-xl border border-gray-6 bg-gray-1 px-3 font-mono text-xs text-gray-12 outline-none transition-colors placeholder:text-gray-7 focus:border-gray-8"
                />
              </label>
              <label className="space-y-1 text-xs text-gray-10">
                <span>sha256 (optional)</span>
                <input
                  type="text"
                  value={props.electronMigrationSha256}
                  onChange={(event) => props.onSetElectronMigrationSha256(event.currentTarget.value)}
                  placeholder="recommended"
                  className="h-10 w-full rounded-xl border border-gray-6 bg-gray-1 px-3 font-mono text-xs text-gray-12 outline-none transition-colors placeholder:text-gray-7 focus:border-gray-8"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                className="h-9 px-3 py-0 text-xs"
                onClick={() => void props.onPrepareElectronMigrationSnapshot()}
                disabled={props.electronMigrationBusy}
              >
                {props.electronMigrationBusy ? "Preparing…" : "Prepare migration data"}
              </Button>
              <Button
                variant="outline"
                className="h-9 border-amber-7/50 px-3 py-0 text-xs text-amber-11 hover:bg-amber-3/40"
                onClick={() => void props.onInstallElectronPreviewFromTauri()}
                disabled={props.electronMigrationBusy || !props.electronMigrationUrl.trim()}
                title="Requires a trusted artifact URL. macOS keeps OpenWork.app.migrate-bak for rollback."
              >
                Start install handoff…
              </Button>
              <div className="text-[11px] text-gray-7">
                Release page: <span className="font-mono">{props.electronPreviewReleaseUrl}</span>
              </div>
            </div>

            {props.electronMigrationStatus ? (
              <div className="rounded-lg border border-gray-6 bg-gray-1/60 px-3 py-2 text-xs text-gray-11">
                {props.electronMigrationStatus}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={settingsCardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-12">{t("settings.sandbox_probe_title")}</div>
              <div className="text-xs text-gray-10">{t("settings.sandbox_probe_desc")}</div>
            </div>
            <Button
              variant="secondary"
              className="h-8 px-3 py-0 text-xs"
              onClick={() => void props.onRunSandboxDebugProbe()}
              disabled={sandboxProbeDisabled}
              title={sandboxProbeTitle}
            >
              {props.sandboxProbeBusy ? t("settings.running_probe") : t("settings.run_sandbox_probe")}
            </Button>
          </div>
          {props.sandboxProbeResult ? (
            <div className="space-y-1 text-xs text-gray-11">
              <div>{t("settings.sandbox_run_id", undefined, { id: props.sandboxProbeResult.runId ?? "—" })}</div>
              <div>
                {t("settings.sandbox_result", undefined, {
                  status: props.sandboxProbeResult.ready ? t("settings.sandbox_ready") : t("settings.sandbox_error"),
                })}
              </div>
              {props.sandboxProbeResult.error ? (
                <div className="text-red-11">{props.sandboxProbeResult.error}</div>
              ) : null}
            </div>
          ) : null}
          {props.sandboxProbeStatus ? <div className="text-xs text-gray-10">{props.sandboxProbeStatus}</div> : null}
          <div className="text-[11px] text-gray-7">{t("settings.sandbox_export_hint")}</div>
        </div>

        <div className={settingsCardClass}>
          <div className="text-sm font-medium text-gray-12">{t("settings.startup_title")}</div>

          <div className="flex items-center justify-between rounded-xl border border-gray-6 bg-gray-1 p-3">
            <div className="flex items-center gap-3">
              <div
                className={`rounded-lg p-2 ${
                  isLocalPreference ? "bg-indigo-7/10 text-indigo-11" : "bg-green-7/10 text-green-11"
                }`}
              >
                {isLocalPreference ? <HardDrive size={18} /> : <Smartphone size={18} />}
              </div>
              <span className="text-sm font-medium text-gray-12">{props.startupLabel}</span>
            </div>
            <Button
              variant="outline"
              className="h-8 px-3 py-0 text-xs"
              onClick={() => void props.onStopHost()}
              disabled={props.busy}
            >
              {t("settings.switch")}
            </Button>
          </div>

          <Button variant="secondary" className="group w-full justify-between" onClick={() => void props.onResetStartupPreference()}>
            <span>{t("settings.reset_startup_pref")}</span>
            <RefreshCcw size={14} className="opacity-80 transition-transform group-hover:rotate-180" />
          </Button>

          <p className="text-xs text-gray-7">{t("settings.startup_reset_hint")}</p>
        </div>

        {isDesktop && (isLocalPreference || props.developerMode) ? (
          <div className={settingsCardClass}>
            <div>
              <div className="text-sm font-medium text-gray-12">{t("settings.engine_title")}</div>
              <div className="text-xs text-gray-10">{t("settings.engine_desc")}</div>
            </div>

            {!isLocalPreference ? (
              <div className="rounded-lg border border-amber-7/40 bg-amber-3/40 px-3 py-2 text-[11px] text-amber-11">
                {t("settings.startup_remote_warning")}
              </div>
            ) : null}

            <div className="space-y-3">
              <div className="text-xs text-gray-10">{t("settings.engine_source_debug")}</div>
              <div className={props.developerMode ? "grid grid-cols-3 gap-2" : "grid grid-cols-2 gap-2"}>
                <Button
                  variant={props.engineSource === "sidecar" ? "secondary" : "outline"}
                  onClick={() => props.onSetEngineSource("sidecar")}
                  disabled={props.busy}
                >
                  {t("settings.engine_bundled")}
                </Button>
                <Button
                  variant={props.engineSource === "path" ? "secondary" : "outline"}
                  onClick={() => props.onSetEngineSource("path")}
                  disabled={props.busy}
                >
                  {t("settings.engine_system_path")}
                </Button>
                {props.developerMode ? (
                  <Button
                    variant={props.engineSource === "custom" ? "secondary" : "outline"}
                    onClick={() => props.onSetEngineSource("custom")}
                    disabled={props.busy}
                  >
                    {t("settings.engine_custom_binary")}
                  </Button>
                ) : null}
              </div>
              <div className="text-[11px] text-gray-7">{t("settings.engine_bundled_hint")}</div>
            </div>

            {props.developerMode && props.engineSource === "custom" ? (
              <div className="space-y-2">
                <div className="text-xs text-gray-10">{t("settings.custom_binary_label")}</div>
                <div className="flex items-center gap-2">
                  <div
                    className="min-w-0 flex-1 truncate rounded-xl border border-gray-6 bg-gray-1 p-3 font-mono text-[11px] text-gray-7"
                    title={props.engineCustomBinPathLabel}
                  >
                    {props.engineCustomBinPathLabel}
                  </div>
                  <Button
                    variant="outline"
                    className="h-10 shrink-0 px-3 text-xs"
                    onClick={() => void props.onPickEngineBinary()}
                    disabled={props.busy}
                  >
                    {t("settings.choose")}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-10 shrink-0 px-3 text-xs"
                    onClick={props.onClearEngineCustomBinPath}
                    disabled={props.busy || !props.engineCustomBinPath.trim()}
                    title={!props.engineCustomBinPath.trim() ? t("settings.no_custom_path_set") : t("settings.clear")}
                  >
                    {t("settings.clear")}
                  </Button>
                </div>
                <div className="text-[11px] text-gray-7">{t("settings.custom_binary_hint")}</div>
              </div>
            ) : null}

            {props.developerMode ? (
              <div className="space-y-3">
                <div className="text-xs text-gray-10">{t("settings.engine_runtime_label")}</div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={props.engineRuntime === "direct" ? "secondary" : "outline"}
                    onClick={() => props.onSetEngineRuntime("direct")}
                    disabled={props.busy}
                  >
                    {t("settings.runtime_direct")}
                  </Button>
                  <Button
                    variant={props.engineRuntime === "openwork-orchestrator" ? "secondary" : "outline"}
                    onClick={() => props.onSetEngineRuntime("openwork-orchestrator")}
                    disabled={props.busy}
                  >
                    {t("settings.runtime_orchestrator")}
                  </Button>
                </div>
                <div className="text-[11px] text-gray-7">{t("settings.runtime_applies_hint")}</div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={settingsCardClass}>
          <div>
            <div className="text-sm font-medium text-gray-12">{t("settings.reset_recovery_title")}</div>
            <div className="text-xs text-gray-10">{t("settings.reset_recovery_desc")}</div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
            <div className="min-w-0">
              <div className="text-sm text-gray-12">{t("settings.reset_onboarding_title")}</div>
              <div className="text-xs text-gray-7">{t("settings.reset_onboarding_description")}</div>
            </div>
            <Button
              variant="outline"
              className="h-8 shrink-0 px-3 py-0 text-xs"
              onClick={() => props.onOpenResetModal("onboarding")}
              disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
              title={props.anyActiveRuns ? t("settings.stop_runs_to_reset") : ""}
            >
              {t("settings.reset_button")}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
            <div className="min-w-0">
              <div className="text-sm text-gray-12">{t("settings.reset_app_data_title")}</div>
              <div className="text-xs text-gray-7">{t("settings.reset_app_data_description")}</div>
            </div>
            <Button
              variant="danger"
              className="h-8 shrink-0 px-3 py-0 text-xs"
              onClick={() => props.onOpenResetModal("all")}
              disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
              title={props.anyActiveRuns ? t("settings.stop_runs_to_reset") : ""}
            >
              {t("settings.reset_button")}
            </Button>
          </div>

          <div className="text-xs text-gray-7">{t("settings.reset_requires_confirm")}</div>
        </div>

        <div className={settingsCardClass}>
          <div>
            <div className="text-sm font-medium text-gray-12">{t("settings.devtools_title")}</div>
            <div className="text-xs text-gray-10">{t("settings.devtools_desc")}</div>
          </div>

          <div className={`${settingsSoftCardClass} space-y-3`}>
            <div>
              <div className="text-sm font-medium text-gray-12">{t("settings.service_restarts_title")}</div>
              <div className="text-xs text-gray-10">{t("settings.service_restarts_desc")}</div>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <Button
                variant="secondary"
                onClick={() => void props.onRestartLocalServer()}
                disabled={props.busy || props.openworkRestartBusy || !isDesktop}
                className="justify-center px-3 py-1.5 text-xs"
              >
                <RefreshCcw className={`mr-1.5 h-3.5 w-3.5 ${props.openworkRestartBusy ? "animate-spin" : ""}`} />
                {props.openworkRestartBusy ? t("settings.restarting") : t("settings.restart_orchestrator")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void props.onRestartOpencode()}
                disabled={props.opencodeRestarting || !isDesktop}
                className="justify-center px-3 py-1.5 text-xs"
              >
                <RefreshCcw className={`mr-1.5 h-3.5 w-3.5 ${props.opencodeRestarting ? "animate-spin" : ""}`} />
                {props.opencodeRestarting ? t("settings.restarting") : t("settings.restart_opencode")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void props.onRestartOpenworkServer()}
                disabled={props.openworkServerRestarting || !isDesktop}
                className="justify-center px-3 py-1.5 text-xs"
              >
                <RefreshCcw className={`mr-1.5 h-3.5 w-3.5 ${props.openworkServerRestarting ? "animate-spin" : ""}`} />
                {props.openworkServerRestarting ? t("settings.restarting") : t("settings.restart_openwork_server")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void props.onRestartOpencodeRouter()}
                disabled={props.opencodeRouterRestarting || !isDesktop}
                className="justify-center px-3 py-1.5 text-xs"
              >
                <RefreshCcw className={`mr-1.5 h-3.5 w-3.5 ${props.opencodeRouterRestarting ? "animate-spin" : ""}`} />
                {props.opencodeRouterRestarting ? t("settings.restarting") : t("settings.restart_opencode_router")}
              </Button>
            </div>
            {props.openworkRestartStatus ? (
              <div className="rounded-lg border border-green-6 bg-green-3/50 p-2 text-xs text-green-11">
                {props.openworkRestartStatus}
              </div>
            ) : null}
            {props.serviceRestartError ? (
              <div className="rounded-lg border border-red-6 bg-red-3/50 p-2 text-xs text-red-11">
                {props.serviceRestartError}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className={`${settingsSoftCardClass} space-y-3`}>
              <div>
                <div className="text-sm font-medium text-gray-12">{t("settings.versions_title")}</div>
                <div className="text-xs text-gray-10">{t("settings.versions_desc")}</div>
              </div>
              <div className="space-y-1">{renderLines([
                t("settings.debug_desktop_app", undefined, { version: props.runtimeSummary.appVersionLabel }),
                t("settings.debug_commit", undefined, { commit: props.runtimeSummary.appCommitLabel }),
                t("settings.debug_orchestrator_version", undefined, { version: props.runtimeSummary.orchestratorVersionLabel }),
                t("settings.debug_opencode_version", undefined, { version: props.runtimeSummary.opencodeVersionLabel }),
                t("settings.debug_openwork_server_version", undefined, { version: props.runtimeSummary.openworkServerVersionLabel }),
                t("settings.debug_opencode_router_version", undefined, { version: props.runtimeSummary.opencodeRouterVersionLabel }),
              ])}</div>
            </div>

            <div className={`${settingsSoftCardClass} space-y-3`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-12">{t("settings.opencode_engine_sidecar")}</div>
                  <div className="text-xs text-gray-10">{t("settings.opencode_engine_sidecar_desc")}</div>
                </div>
                <div className={`rounded-full border px-2 py-1 text-xs ${props.engineCard.className}`}>
                  {props.engineCard.label}
                </div>
              </div>
              <div className="space-y-1">{renderLines(props.engineCard.lines)}</div>
              <div className="grid gap-2">
                <div>
                  <div className="mb-1 text-[11px] text-gray-9">{t("settings.last_stdout")}</div>
                  <pre className={settingsMiniPreClass}>{props.engineCard.stdout || "—"}</pre>
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-gray-9">{t("settings.last_stderr")}</div>
                  <pre className={settingsMiniPreClass}>{props.engineCard.stderr || "—"}</pre>
                </div>
              </div>
            </div>

            <div className={`${settingsSoftCardClass} space-y-3`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-12">{t("settings.orchestrator_daemon_title")}</div>
                  <div className="text-xs text-gray-10">{t("settings.orchestrator_daemon_layer_desc")}</div>
                </div>
                <div className={`rounded-full border px-2 py-1 text-xs ${props.orchestratorCard.className}`}>
                  {props.orchestratorCard.label}
                </div>
              </div>
              <div className="space-y-1">{renderLines(props.orchestratorCard.lines)}</div>
              {props.orchestratorCard.error ? (
                <div>
                  <div className="mb-1 text-[11px] text-gray-9">{t("settings.last_error")}</div>
                  <pre className={settingsMiniPreClass}>{props.orchestratorCard.error}</pre>
                </div>
              ) : null}
            </div>

            <div className={`${settingsSoftCardClass} space-y-3`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-12">{t("settings.opencode_sdk_title")}</div>
                  <div className="text-xs text-gray-10">{t("settings.opencode_sdk_desc")}</div>
                </div>
                <div className={`rounded-full border px-2 py-1 text-xs ${props.opencodeConnectCard.className}`}>
                  {props.opencodeConnectCard.label}
                </div>
              </div>
              <div className="space-y-1">{renderLines(props.opencodeConnectCard.lines)}</div>
              {props.opencodeConnectCard.metricsLines.length > 0 ? (
                <div className="space-y-1 border-t border-gray-6/50 pt-1">
                  {renderLines(props.opencodeConnectCard.metricsLines)}
                </div>
              ) : null}
              {props.opencodeConnectCard.error ? (
                <div>
                  <div className="mb-1 text-[11px] text-gray-9">{t("settings.last_error")}</div>
                  <pre className={settingsMiniPreClass}>{props.opencodeConnectCard.error}</pre>
                </div>
              ) : null}
            </div>

            <div className={`${settingsSoftCardClass} space-y-3`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-12">{t("settings.openwork_server_label")}</div>
                  <div className="text-xs text-gray-10">{t("settings.openwork_config_sidecar_desc")}</div>
                </div>
                <div className={`rounded-full border px-2 py-1 text-xs ${props.openworkCard.className}`}>
                  {props.openworkCard.label}
                </div>
              </div>
              <div className="space-y-1">{renderLines(props.openworkCard.lines)}</div>
              <div className="grid gap-2">
                <div>
                  <div className="mb-1 text-[11px] text-gray-9">{t("settings.last_stdout")}</div>
                  <pre className={settingsMiniPreClass}>{props.openworkCard.stdout || "—"}</pre>
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-gray-9">{t("settings.last_stderr")}</div>
                  <pre className={settingsMiniPreClass}>{props.openworkCard.stderr || "—"}</pre>
                </div>
              </div>
            </div>

            <div className={`${settingsSoftCardClass} space-y-3`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-12">{t("settings.opencode_router_sidecar")}</div>
                  <div className="text-xs text-gray-10">{t("settings.messaging_bridge_service")}</div>
                </div>
                <div className={`rounded-full border px-2 py-1 text-xs ${props.opencodeRouterCard.className}`}>
                  {props.opencodeRouterCard.label}
                </div>
              </div>
              <div className="space-y-1">{renderLines(props.opencodeRouterCard.lines)}</div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void props.onRestartOpencodeRouter()}
                  disabled={props.opencodeRouterRestarting || !isDesktop}
                  className="px-3 py-1.5 text-xs"
                >
                  <RefreshCcw className={`mr-1.5 h-3.5 w-3.5 ${props.opencodeRouterRestarting ? "animate-spin" : ""}`} />
                  {props.opencodeRouterRestarting ? t("settings.restarting") : t("settings.restart_opencode_router")}
                </Button>
                {props.opencodeRouterCard.running ? (
                  <Button
                    variant="ghost"
                    onClick={() => void props.onStopOpencodeRouter()}
                    disabled={props.opencodeRouterRestarting}
                    className="px-3 py-1.5 text-xs"
                  >
                    {t("settings.stop_local_server")}
                  </Button>
                ) : null}
              </div>
              {props.opencodeRouterCard.error ? (
                <div className="rounded-lg border border-red-6 bg-red-3/50 p-2 text-xs text-red-11">
                  {props.opencodeRouterCard.error}
                </div>
              ) : null}
              <div className="grid gap-2">
                <div>
                  <div className="mb-1 text-[11px] text-gray-9">{t("settings.last_stdout")}</div>
                  <pre className={settingsMiniPreClass}>{props.opencodeRouterCard.stdout || "—"}</pre>
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-gray-9">{t("settings.last_stderr")}</div>
                  <pre className={settingsMiniPreClass}>{props.opencodeRouterCard.stderr || "—"}</pre>
                </div>
              </div>
            </div>
          </div>

          <div className={`${settingsSoftCardClass} space-y-3`}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-gray-12">{t("settings.openwork_diagnostics_title")}</div>
              <div className="truncate font-mono text-[11px] text-gray-8">
                {props.openworkServerDiagnostics?.version ?? "—"}
              </div>
            </div>
            {props.openworkServerDiagnostics ? (
              <div className="grid gap-2 text-xs text-gray-11 md:grid-cols-2">
                <div>{t("settings.diag_started", undefined, { time: formatUptime(props.openworkServerDiagnostics.uptimeMs) })}</div>
                <div>
                  {t("settings.diag_read_only", undefined, {
                    value: props.openworkServerDiagnostics.readOnly ? "true" : "false",
                  })}
                </div>
                <div>
                  {t("settings.diag_approval", undefined, {
                    mode: props.openworkServerDiagnostics.approval.mode,
                    ms: String(props.openworkServerDiagnostics.approval.timeoutMs),
                  })}
                </div>
                <div>{t("settings.diag_workspaces", undefined, { count: String(props.openworkServerDiagnostics.workspaceCount) })}</div>
                <div>
                  {t("settings.diag_selected_workspace", undefined, {
                    id: props.openworkServerDiagnostics.selectedWorkspaceId ?? "—",
                  })}
                </div>
                <div>
                  {t("settings.diag_runtime_workspace", undefined, {
                    id: props.openworkServerDiagnostics.activeWorkspaceId ?? "—",
                  })}
                </div>
                <div>
                  {t("settings.diag_config_path", undefined, {
                    path: props.openworkServerDiagnostics.server.configPath ?? t("settings.diag_default"),
                  })}
                </div>
                <div>
                  {t("settings.diag_token_source", undefined, {
                    source: props.openworkServerDiagnostics.tokenSource.client,
                  })}
                </div>
                <div>
                  {t("settings.diag_host_token_source", undefined, {
                    source: props.openworkServerDiagnostics.tokenSource.host,
                  })}
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-9">{t("settings.diagnostics_unavailable")}</div>
            )}
          </div>

          <div className={`${settingsSoftCardClass} space-y-3`}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-gray-12">{t("settings.capabilities_title")}</div>
              <div className="truncate font-mono text-[11px] text-gray-8">
                {props.runtimeWorkspaceId
                  ? t("settings.worker_id_label", undefined, { id: props.runtimeWorkspaceId })
                  : t("settings.worker_unresolved")}
              </div>
            </div>
            {props.openworkServerCapabilities ? (
              <div className="grid gap-2 text-xs text-gray-11 md:grid-cols-2">
                <div>{t("settings.cap_skills", undefined, { value: formatCapability(props.openworkServerCapabilities.skills) })}</div>
                <div>{t("settings.cap_plugins", undefined, { value: formatCapability(props.openworkServerCapabilities.plugins) })}</div>
                <div>{t("settings.cap_mcp", undefined, { value: formatCapability(props.openworkServerCapabilities.mcp) })}</div>
                <div>{t("settings.cap_commands", undefined, { value: formatCapability(props.openworkServerCapabilities.commands) })}</div>
                <div>{t("settings.cap_config", undefined, { value: formatCapability(props.openworkServerCapabilities.config) })}</div>
                <div>
                  {t("settings.cap_proxy", undefined, {
                    value: props.openworkServerCapabilities.proxy?.opencodeRouter
                      ? t("settings.enabled")
                      : t("settings.disabled"),
                  })}
                </div>
                <div>
                  {t("settings.cap_browser_tools", undefined, {
                    value: (() => {
                      const browser = props.openworkServerCapabilities.toolProviders?.browser;
                      if (!browser?.enabled) return t("settings.disabled");
                      return `${browser.mode} · ${browser.placement}`;
                    })(),
                  })}
                </div>
                <div>
                  {t("settings.cap_file_tools", undefined, {
                    value: (() => {
                      const files = props.openworkServerCapabilities.toolProviders?.files;
                      if (!files) return t("config.unavailable");
                      return [
                        files.injection ? t("settings.cap_inbox_on") : t("settings.cap_inbox_off"),
                        files.outbox ? t("settings.cap_outbox_on") : t("settings.cap_outbox_off"),
                      ].join(" · ");
                    })(),
                  })}
                </div>
                <div>
                  {t("settings.cap_sandbox", undefined, {
                    value: props.openworkServerCapabilities.sandbox
                      ? `${props.openworkServerCapabilities.sandbox.backend} (${props.openworkServerCapabilities.sandbox.enabled ? t("settings.on") : t("settings.off")})`
                      : t("config.unavailable"),
                  })}
                </div>
              </div>
            ) : (
              <div className="text-xs text-gray-9">{t("settings.capabilities_unavailable")}</div>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className={settingsSoftCardClass}>
              <div className="mb-2 text-xs text-gray-10">{t("settings.pending_permissions")}</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-12">
                {props.safeStringify(props.pendingPermissions)}
              </pre>
            </div>
            <div className={settingsSoftCardClass}>
              <div className="mb-2 text-xs text-gray-10">{t("settings.recent_events")}</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-12">
                {props.safeStringify(props.events)}
              </pre>
            </div>
          </div>

          <div className={settingsSoftCardClass}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs text-gray-10">{t("settings.workspace_debug_events_label")}</div>
              <Button
                variant="outline"
                className="h-7 shrink-0 px-2 py-0 text-xs"
                onClick={() => void props.onClearWorkspaceDebugEvents()}
                disabled={props.busy}
              >
                {t("settings.clear")}
              </Button>
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-12">
              {props.safeStringify(props.workspaceDebugEvents)}
            </pre>
          </div>

          <div className={`${settingsSoftCardClass} space-y-3`}>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-gray-12">{t("settings.audit_log_title")}</div>
              <div className={`rounded-full border px-2 py-1 text-xs ${props.openworkAuditStatus.className}`}>
                {props.openworkAuditStatus.label}
              </div>
            </div>
            {props.openworkAuditError ? <div className="text-xs text-red-11">{props.openworkAuditError}</div> : null}
            {props.openworkAuditEntries.length > 0 ? (
              <div className="divide-y divide-gray-6/50">
                {props.openworkAuditEntries.map((entry) => (
                  <div key={entry.id} className="flex items-start justify-between gap-4 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-gray-12">{entry.summary}</div>
                      <div className="truncate text-[11px] text-gray-9">
                        {entry.action} · {entry.target} · {formatActor(entry)}
                      </div>
                    </div>
                    <div className="whitespace-nowrap text-[11px] text-gray-9">
                      {entry.timestamp ? formatRelativeTime(entry.timestamp) : "—"}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-gray-9">{t("settings.no_audit_entries")}</div>
            )}
          </div>
        </div>

        {isDesktop ? (
          <div className="space-y-4 rounded-2xl border border-red-7/30 bg-red-3/10 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-12">{t("settings.reset_openwork_title")}</div>
                <div className="text-xs text-gray-10">
                  {props.opencodeDevModeEnabled
                    ? t("settings.reset_openwork_desc_dev")
                    : t("settings.reset_openwork_desc_prod")}
                </div>
              </div>
              <div
                className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  props.opencodeDevModeEnabled
                    ? "border-blue-7/35 bg-blue-3/25 text-blue-11"
                    : "border-gray-6 bg-gray-2 text-gray-10"
                }`}
              >
                {props.opencodeDevModeEnabled
                  ? t("settings.dev_mode_badge")
                  : t("settings.production_mode_badge")}
              </div>
            </div>

            <div className="text-[11px] text-gray-8">{t("settings.quit_hint")}</div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={compactDangerActionClass}
                onClick={() => void props.onNukeOpenworkAndOpencodeConfig()}
                disabled={props.busy || props.nukeConfigBusy}
              >
                <CircleAlert size={14} />
                {props.nukeConfigBusy
                  ? t("settings.removing_local_state")
                  : t("settings.delete_local_config")}
              </button>
              <div className="text-xs text-gray-10">{t("settings.nuke_hint")}</div>
            </div>

            {props.nukeConfigStatus ? <div className="text-xs text-red-11">{props.nukeConfigStatus}</div> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
