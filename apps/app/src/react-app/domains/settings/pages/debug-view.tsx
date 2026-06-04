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
import type { SandboxDebugProbeResult } from "../../../../app/lib/desktop";
import type {
  OpencodeConnectStatus,
  ReleaseChannel,
  StartupPreference,
} from "../../../../app/types";
import type { OpencodeExecutionSnapshot } from "../../../../app/lib/desktop-types";
import { formatRelativeTime, isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";

const sectionHeaderClass = "flex flex-col gap-1 pb-2";
const sectionTitleClass = "text-[15px] font-semibold tracking-[-0.2px] text-dls-text";
const sectionDescClass = "text-[12px] text-dls-secondary";
const cardClass =
  "rounded-2xl border border-dls-border bg-dls-surface/95 p-5 space-y-4";
const subCardClass = "rounded-xl border border-dls-border bg-dls-sidebar/40 p-4 space-y-3";
const monoPreClass =
  "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dls-border bg-dls-sidebar/40 p-3 text-[11px] font-mono text-dls-text";
const miniPreClass =
  "max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-dls-border bg-dls-sidebar/30 p-2 text-[11px] font-mono text-dls-text";
const compactDangerActionClass =
  "inline-flex h-9 items-center gap-2 rounded-xl border border-red-7/40 bg-red-9 px-4 text-xs font-medium text-white transition-colors hover:bg-red-10 disabled:cursor-not-allowed disabled:opacity-60";

type RuntimeSummary = {
  appVersionLabel: string;
  appCommitLabel: string;
  opencodeVersionLabel: string;
  openworkServerVersionLabel: string;
};

type StatusPill = {
  label: string;
  className: string;
};

type RuntimeServiceCard = StatusPill & {
  lines: string[];
  stdout?: string | null;
  stderr?: string | null;
  execution?: OpencodeExecutionSnapshot | null;
  error?: string | null;
};

type OpenCodeConnectDebugCard = StatusPill & {
  lines: string[];
  metricsLines: string[];
  error?: string | null;
};

type ServiceStatus = { tone: "success" | "error"; message: string } | null;

export type DebugViewProps = {
  developerMode: boolean;
  busy: boolean;
  anyActiveRuns: boolean;
  startupPreference: StartupPreference | null;
  startupLabel: string;
  startupStatus: string | null;
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
  electronMigrationSha512: string;
  electronMigrationArtifactLabel: string | null;
  electronMigrationBusy: boolean;
  electronMigrationStatus: string | null;
  electronPreviewReleaseUrl: string;
  onSetElectronMigrationUrl: (value: string) => void;
  onSetElectronMigrationSha256: (value: string) => void;
  onSetElectronMigrationSha512: (value: string) => void;
  onOpenElectronPreviewRelease: () => void | Promise<void>;
  onResolveElectronAlphaArtifact: () => void | Promise<void>;
  onRevealElectronMigrationBackup: () => void | Promise<void>;
  onPrepareElectronMigrationSnapshot: () => void | Promise<void>;
  onInstallElectronPreviewFromTauri: () => void | Promise<void>;
  electronAlphaUpdaterAvailable: boolean;
  electronAlphaUpdaterBusy: boolean;
  electronAlphaUpdaterStatus: string | null;
  electronAlphaUpdaterChannel: ReleaseChannel;
  onSetElectronAlphaUpdaterChannel: (channel: ReleaseChannel) => void | Promise<void>;
  onCheckElectronAlphaUpdates: () => void | Promise<void>;
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
  onOpenResetModal: (mode: "onboarding" | "all") => void;
  resetModalBusy: boolean;
  resetStatus: string | null;
  opencodeRestarting: boolean;
  openworkServerRestarting: boolean;
  opencodeServiceStatus: ServiceStatus;
  openworkServiceStatus: ServiceStatus;
  opencodeLogStatus: string | null;
  openworkLogStatus: string | null;
  onCopyOpencodeLogs: () => void | Promise<void>;
  onExportOpencodeLogs: () => void | Promise<void>;
  onCopyOpenworkLogs: () => void | Promise<void>;
  onExportOpenworkLogs: () => void | Promise<void>;
  serviceRestartError: string | null;
  onRestartOpencode: () => void | Promise<void>;
  onRestartOpenworkServer: () => void | Promise<void>;
  engineCard: RuntimeServiceCard;
  opencodeConnectCard: OpenCodeConnectDebugCard;
  openworkCard: RuntimeServiceCard;
  openworkServerDiagnostics: OpenworkServerDiagnostics | null;
  runtimeWorkspaceId: string | null;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  pendingPermissions: unknown;
  events: unknown;
  workspaceDebugEvents: unknown;
  workspaceDebugEventsStatus: string | null;
  safeStringify: (value: unknown) => string;
  onClearWorkspaceDebugEvents: () => void | Promise<void>;
  openworkAuditEntries: OpenworkAuditEntry[];
  openworkAuditStatus: StatusPill;
  openworkAuditError: string | null;
  opencodeConnectStatus: OpencodeConnectStatus | null;
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

function DebugLines(props: { lines: string[] }) {
  let offset = 0;
  return props.lines.map((line) => (
    (() => {
      const key = `${offset}:${line}`;
      offset += line.length + 1;
      return (
        <div key={key} className="truncate text-[11px] font-mono text-dls-secondary">
          {line}
        </div>
      );
    })()
  ));
}

function StatusBanner(props: { tone: "success" | "error" | "info"; message: string }) {
  const cls =
    props.tone === "success"
      ? "border-green-6 bg-green-3/40 text-green-11"
      : props.tone === "error"
        ? "border-red-6 bg-red-3/40 text-red-11"
        : "border-dls-border bg-dls-sidebar/40 text-dls-secondary";
  return (
    <div className={`rounded-lg border px-3 py-2 text-[11px] ${cls}`}>{props.message}</div>
  );
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_/:=.,@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function formatExecutionCommand(execution: OpencodeExecutionSnapshot) {
  return [execution.command, ...execution.args].map(shellQuote).join(" ");
}

function ExecutionDetails(props: { execution: OpencodeExecutionSnapshot }) {
  return (
    <div className="rounded-xl border border-blue-6/30 bg-blue-3/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-11">OpenCode execution</div>
          <div className="text-[11px] text-dls-secondary">Command, working directory, and OpenWork-injected environment.</div>
        </div>
        <div className="shrink-0 rounded-full border border-blue-7/30 bg-blue-7/10 px-2 py-1 text-[10px] font-medium text-blue-11">
          redacted
        </div>
      </div>
      <div className="space-y-3">
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-dls-secondary">Command</div>
          <pre className={miniPreClass}>{formatExecutionCommand(props.execution)}</pre>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-dls-secondary">Working directory</div>
          <pre className={miniPreClass}>{props.execution.cwd}</pre>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-dls-secondary">Injected environment</div>
          <div className="max-h-64 overflow-auto rounded-lg border border-dls-border bg-dls-sidebar/30">
            {props.execution.env.length > 0 ? props.execution.env.map((entry) => (
              <div key={entry.name} className="grid gap-2 border-b border-dls-border/50 p-2 last:border-b-0 md:grid-cols-[180px_minmax(0,1fr)]">
                <div className="font-mono text-[11px] font-semibold text-dls-text">{entry.name}</div>
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-dls-secondary">{entry.value}</pre>
              </div>
            )) : (
              <div className="p-2 text-[11px] text-dls-secondary">No injected environment captured.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type ServiceCardProps = {
  title: string;
  description: string;
  pill: StatusPill;
  lines: string[];
  stdout?: string | null;
  stderr?: string | null;
  execution?: OpencodeExecutionSnapshot | null;
  error?: string | null;
  restarting: boolean;
  restartLabel: string;
  onRestart: () => void | Promise<void>;
  serviceStatus: ServiceStatus;
  logStatus: string | null;
  onCopyLogs: () => void | Promise<void>;
  onExportLogs: () => void | Promise<void>;
  isDesktop: boolean;
};

function ServiceCard(props: ServiceCardProps) {
  const restartDisabled = props.restarting || !props.isDesktop;
  return (
    <div className={subCardClass}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-[-0.1px] text-dls-text">{props.title}</div>
          <div className="text-[12px] text-dls-secondary">{props.description}</div>
        </div>
        <div className={`rounded-full border px-2 py-1 text-[11px] font-medium ${props.pill.className}`}>
          {props.pill.label}
        </div>
      </div>

      <div className="space-y-1"><DebugLines lines={props.lines} /></div>

      {props.execution ? <ExecutionDetails execution={props.execution} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => void props.onRestart()}
          disabled={restartDisabled}
          size="sm"
          title={!props.isDesktop ? t("settings.sandbox_requires_desktop") : ""}
        >
          <RefreshCcw className={`mr-1.5 h-3.5 w-3.5 ${props.restarting ? "animate-spin" : ""}`} />
          {props.restarting ? t("settings.restarting") : props.restartLabel}
        </Button>
        <Button
          variant="outline"
          onClick={() => void props.onCopyLogs()}
          size="sm"
        >
          <Copy size={13} className="mr-1.5" />
          {t("settings.copy_logs")}
        </Button>
        <Button
          variant="outline"
          onClick={() => void props.onExportLogs()}
          size="sm"
        >
          <Download size={13} className="mr-1.5" />
          {t("settings.export_log_button")}
        </Button>
      </div>

      {props.serviceStatus ? (
        <StatusBanner tone={props.serviceStatus.tone} message={props.serviceStatus.message} />
      ) : null}
      {props.logStatus ? <StatusBanner tone="info" message={props.logStatus} /> : null}

      <details className="group">
        <summary className="cursor-pointer select-none text-[11px] font-medium uppercase tracking-wider text-dls-secondary">
          {t("settings.last_stdout")} / {t("settings.last_stderr")}
        </summary>
        <div className="mt-2 grid gap-2">
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-dls-secondary">
              {t("settings.last_stdout")}
            </div>
            <pre className={miniPreClass}>{props.stdout || t("settings.no_logs_captured")}</pre>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-dls-secondary">
              {t("settings.last_stderr")}
            </div>
            <pre className={miniPreClass}>{props.stderr || t("settings.no_logs_captured")}</pre>
          </div>
          {props.error ? (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-dls-secondary">
                {t("settings.last_error")}
              </div>
              <pre className={miniPreClass}>{props.error}</pre>
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
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
    <section className="space-y-6 max-w-3xl w-full">
      {/* Section: Runtime overview */}
      <div className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={sectionTitleClass}>{t("settings.runtime_debug_title")}</div>
            <div className={sectionDescClass}>{t("settings.runtime_debug_desc")}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void props.onCopyRuntimeDebugReport()}
            >
              <Copy size={13} className="mr-1.5" />
              {t("settings.copy_json")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void props.onExportRuntimeDebugReport()}
            >
              <Download size={13} className="mr-1.5" />
              {t("settings.export")}
            </Button>
          </div>
        </div>
        <div className="grid gap-2 text-[12px] text-dls-secondary md:grid-cols-2">
          <div>{t("settings.debug_desktop_app", { version: props.runtimeSummary.appVersionLabel })}</div>
          <div>{t("settings.debug_commit", { commit: props.runtimeSummary.appCommitLabel })}</div>
          <div>
            {t("settings.debug_opencode_version", { version: props.runtimeSummary.opencodeVersionLabel })}
          </div>
          <div>
            {t("settings.debug_openwork_server_version", {
              version: props.runtimeSummary.openworkServerVersionLabel,
            })}
          </div>
        </div>
        {props.runtimeDebugStatus ? <StatusBanner tone="info" message={props.runtimeDebugStatus} /> : null}
        <details className="group">
          <summary className="cursor-pointer select-none text-[11px] font-medium uppercase tracking-wider text-dls-secondary">
            JSON
          </summary>
          <pre className={`${monoPreClass} mt-2`}>{props.runtimeDebugReportJson}</pre>
        </details>
      </div>

      {/* Section: Services */}
      <div className={cardClass}>
        <div className={sectionHeaderClass}>
          <div className={sectionTitleClass}>{t("settings.services_section_title")}</div>
          <div className={sectionDescClass}>{t("settings.services_section_desc")}</div>
        </div>

        <div className="grid gap-3 grid-cols-1 lg:grid-cols-2">
          <ServiceCard
            title={t("settings.openwork_server_label")}
            description={t("settings.openwork_config_sidecar_desc")}
            pill={props.openworkCard}
            lines={props.openworkCard.lines}
            stdout={props.openworkCard.stdout ?? null}
            stderr={props.openworkCard.stderr ?? null}
            execution={props.openworkCard.execution ?? null}
            error={props.openworkCard.error ?? null}
            restarting={props.openworkServerRestarting}
            restartLabel={t("settings.restart_openwork_server")}
            onRestart={props.onRestartOpenworkServer}
            serviceStatus={props.openworkServiceStatus}
            logStatus={props.openworkLogStatus}
            onCopyLogs={props.onCopyOpenworkLogs}
            onExportLogs={props.onExportOpenworkLogs}
            isDesktop={isDesktop}
          />

          <ServiceCard
            title={t("settings.opencode_engine_sidecar")}
            description={t("settings.opencode_engine_sidecar_desc")}
            pill={props.engineCard}
            lines={props.engineCard.lines}
            stdout={props.engineCard.stdout ?? null}
            stderr={props.engineCard.stderr ?? null}
            execution={props.engineCard.execution ?? null}
            error={props.engineCard.error ?? null}
            restarting={props.opencodeRestarting}
            restartLabel={t("settings.restart_opencode")}
            onRestart={props.onRestartOpencode}
            serviceStatus={props.opencodeServiceStatus}
            logStatus={props.opencodeLogStatus}
            onCopyLogs={props.onCopyOpencodeLogs}
            onExportLogs={props.onExportOpencodeLogs}
            isDesktop={isDesktop}
          />
        </div>

        <div className={subCardClass}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold tracking-[-0.1px] text-dls-text">
                {t("settings.opencode_sdk_title")}
              </div>
              <div className="text-[12px] text-dls-secondary">{t("settings.opencode_sdk_desc")}</div>
            </div>
            <div className={`rounded-full border px-2 py-1 text-[11px] font-medium ${props.opencodeConnectCard.className}`}>
              {props.opencodeConnectCard.label}
            </div>
          </div>
          <div className="space-y-1"><DebugLines lines={props.opencodeConnectCard.lines} /></div>
          {props.opencodeConnectCard.metricsLines.length > 0 ? (
            <div className="space-y-1 border-t border-dls-border/60 pt-1">
              <DebugLines lines={props.opencodeConnectCard.metricsLines} />
            </div>
          ) : null}
          {props.opencodeConnectCard.error ? (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-dls-secondary">
                {t("settings.last_error")}
              </div>
              <pre className={miniPreClass}>{props.opencodeConnectCard.error}</pre>
            </div>
          ) : null}
        </div>

        {props.serviceRestartError ? (
          <StatusBanner tone="error" message={props.serviceRestartError} />
        ) : null}
      </div>

      {/* Section: Diagnostics */}
      <div className={cardClass}>
        <div className={sectionHeaderClass}>
          <div className={sectionTitleClass}>{t("settings.openwork_diagnostics_title")}</div>
          <div className={sectionDescClass}>
            <span className="font-mono text-[11px] text-dls-secondary">
              {props.openworkServerDiagnostics?.version ?? "—"}
            </span>
          </div>
        </div>

        {props.openworkServerDiagnostics ? (
          <div className="grid gap-2 text-[12px] text-dls-secondary md:grid-cols-2">
            <div>{t("settings.diag_started", { time: formatUptime(props.openworkServerDiagnostics.uptimeMs) })}</div>
            <div>
              {t("settings.diag_read_only", {
                value: props.openworkServerDiagnostics.readOnly ? "true" : "false",
              })}
            </div>
            <div>
              {t("settings.diag_approval", {
                mode: props.openworkServerDiagnostics.approval.mode,
                ms: String(props.openworkServerDiagnostics.approval.timeoutMs),
              })}
            </div>
            <div>{t("settings.diag_workspaces", { count: String(props.openworkServerDiagnostics.workspaceCount) })}</div>
            <div>
              {t("settings.diag_selected_workspace", {
                id: props.openworkServerDiagnostics.selectedWorkspaceId ?? "—",
              })}
            </div>
            <div>
              {t("settings.diag_runtime_workspace", {
                id: props.openworkServerDiagnostics.activeWorkspaceId ?? "—",
              })}
            </div>
            <div>
              {t("settings.diag_config_path", {
                path: props.openworkServerDiagnostics.server.configPath ?? t("settings.diag_default"),
              })}
            </div>
            <div>
              {t("settings.diag_token_source", {
                source: props.openworkServerDiagnostics.tokenSource.client,
              })}
            </div>
            <div>
              {t("settings.diag_host_token_source", {
                source: props.openworkServerDiagnostics.tokenSource.host,
              })}
            </div>
          </div>
        ) : (
          <div className="text-[12px] text-dls-secondary">{t("settings.diagnostics_unavailable")}</div>
        )}

        <div className={subCardClass}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold tracking-[-0.1px] text-dls-text">
              {t("settings.capabilities_title")}
            </div>
            <div className="truncate font-mono text-[11px] text-dls-secondary">
              {props.runtimeWorkspaceId
                ? t("settings.worker_id_label", { id: props.runtimeWorkspaceId })
                : t("settings.worker_unresolved")}
            </div>
          </div>
          {props.openworkServerCapabilities ? (
            <div className="grid gap-2 text-[12px] text-dls-secondary md:grid-cols-2">
              <div>{t("settings.cap_skills", { value: formatCapability(props.openworkServerCapabilities.skills) })}</div>
              <div>{t("settings.cap_plugins", { value: formatCapability(props.openworkServerCapabilities.plugins) })}</div>
              <div>{t("settings.cap_mcp", { value: formatCapability(props.openworkServerCapabilities.mcp) })}</div>
              <div>{t("settings.cap_commands", { value: formatCapability(props.openworkServerCapabilities.commands) })}</div>
              <div>{t("settings.cap_config", { value: formatCapability(props.openworkServerCapabilities.config) })}</div>
              <div>
                {t("settings.cap_browser_tools", {
                  value: (() => {
                    const browser = props.openworkServerCapabilities.toolProviders?.browser;
                    if (!browser?.enabled) return t("settings.disabled");
                    return `${browser.mode} · ${browser.placement}`;
                  })(),
                })}
              </div>
              <div>
                {t("settings.cap_file_tools", {
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
                {t("settings.cap_sandbox", {
                  value: props.openworkServerCapabilities.sandbox
                    ? `${props.openworkServerCapabilities.sandbox.backend} (${props.openworkServerCapabilities.sandbox.enabled ? t("settings.on") : t("settings.off")})`
                    : t("config.unavailable"),
                })}
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-dls-secondary">{t("settings.capabilities_unavailable")}</div>
          )}
        </div>
      </div>

      {/* Section: Activity */}
      <div className={cardClass}>
        <div className={sectionHeaderClass}>
          <div className={sectionTitleClass}>{t("settings.activity_section_title")}</div>
          <div className={sectionDescClass}>{t("settings.activity_section_desc")}</div>
        </div>

        <div className={subCardClass}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold tracking-[-0.1px] text-dls-text">
              {t("settings.audit_log_title")}
            </div>
            <div className={`rounded-full border px-2 py-1 text-[11px] font-medium ${props.openworkAuditStatus.className}`}>
              {props.openworkAuditStatus.label}
            </div>
          </div>
          {props.openworkAuditError ? <StatusBanner tone="error" message={props.openworkAuditError} /> : null}
          {props.openworkAuditEntries.length > 0 ? (
            <div className="divide-y divide-dls-border/60">
              {props.openworkAuditEntries.map((entry) => (
                <div key={entry.id} className="flex items-start justify-between gap-4 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm text-dls-text">{entry.summary}</div>
                    <div className="truncate text-[11px] text-dls-secondary">
                      {entry.action} · {entry.target} · {formatActor(entry)}
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-[11px] text-dls-secondary">
                    {entry.timestamp ? formatRelativeTime(entry.timestamp) : "—"}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-dls-secondary">{t("settings.no_audit_entries")}</div>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className={subCardClass}>
            <div className="text-[11px] font-medium uppercase tracking-wider text-dls-secondary">
              {t("settings.pending_permissions")}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono text-dls-text">
              {props.safeStringify(props.pendingPermissions)}
            </pre>
          </div>
          <div className={subCardClass}>
            <div className="text-[11px] font-medium uppercase tracking-wider text-dls-secondary">
              {t("settings.recent_events")}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono text-dls-text">
              {props.safeStringify(props.events)}
            </pre>
          </div>
        </div>

        <div className={subCardClass}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-dls-secondary">
              {t("settings.workspace_debug_events_label")}
            </div>
            <Button
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => void props.onClearWorkspaceDebugEvents()}
              disabled={props.busy}
            >
              {t("settings.clear_button")}
            </Button>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] font-mono text-dls-text">
            {props.safeStringify(props.workspaceDebugEvents)}
          </pre>
          {props.workspaceDebugEventsStatus ? (
            <StatusBanner tone="info" message={props.workspaceDebugEventsStatus} />
          ) : null}
        </div>
      </div>

      {/* Section: Developer log stream */}
      <div className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={sectionTitleClass}>{t("settings.developer_log_title")}</div>
            <div className={sectionDescClass}>{t("settings.developer_log_desc")}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void props.onClearDeveloperLog()}>
              {t("settings.clear_button")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void props.onCopyDeveloperLog()}>
              <Copy size={13} className="mr-1.5" />
              {t("settings.copy_log_button")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void props.onExportDeveloperLog()}>
              <Download size={13} className="mr-1.5" />
              {t("settings.export_log_button")}
            </Button>
          </div>
        </div>
        <div className="text-[11px] text-dls-secondary">
          {t("settings.developer_log_count", { count: String(props.developerLogRecordCount) })}
        </div>
        <pre className={monoPreClass}>{props.developerLogText || t("settings.developer_log_empty")}</pre>
        {props.developerLogStatus ? <StatusBanner tone="info" message={props.developerLogStatus} /> : null}
      </div>

      {/* Section: Tools */}
      <div className={cardClass}>
        <div className={sectionHeaderClass}>
          <div className={sectionTitleClass}>{t("settings.tools_section_title")}</div>
          <div className={sectionDescClass}>{t("settings.tools_section_desc")}</div>
        </div>

        <div className={subCardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold tracking-[-0.1px] text-dls-text">
                {t("settings.sandbox_probe_title")}
              </div>
              <div className="text-[12px] text-dls-secondary">{t("settings.sandbox_probe_desc")}</div>
            </div>
            <Button
              size="sm"
              onClick={() => void props.onRunSandboxDebugProbe()}
              disabled={sandboxProbeDisabled}
              title={sandboxProbeTitle}
            >
              {props.sandboxProbeBusy ? t("settings.running_probe") : t("settings.run_sandbox_probe")}
            </Button>
          </div>
          {props.sandboxProbeResult ? (
            <div className="space-y-1 text-[12px] text-dls-secondary">
              <div>{t("settings.sandbox_run_id", { id: props.sandboxProbeResult.runId ?? "—" })}</div>
              <div>
                {t("settings.sandbox_result", {
                  status: props.sandboxProbeResult.ready ? t("settings.sandbox_ready") : t("settings.sandbox_error"),
                })}
              </div>
              {props.sandboxProbeResult.error ? (
                <div className="text-red-11">{props.sandboxProbeResult.error}</div>
              ) : null}
            </div>
          ) : null}
          {props.sandboxProbeStatus ? <StatusBanner tone="info" message={props.sandboxProbeStatus} /> : null}
          <div className="text-[11px] text-dls-secondary">{t("settings.sandbox_export_hint")}</div>
        </div>

        {isDesktop && (isLocalPreference || props.developerMode) ? (
          <div className={subCardClass}>
            <div>
              <div className="text-sm font-semibold tracking-[-0.1px] text-dls-text">{t("settings.engine_title")}</div>
              <div className="text-[12px] text-dls-secondary">{t("settings.engine_desc")}</div>
            </div>

            {!isLocalPreference ? (
              <StatusBanner tone="info" message={t("settings.startup_remote_warning")} />
            ) : null}

            <div className="space-y-3">
              <div className="text-[12px] text-dls-secondary">{t("settings.engine_source_debug")}</div>
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
              <div className="text-[11px] text-dls-secondary">{t("settings.engine_bundled_hint")}</div>
            </div>

            {props.developerMode && props.engineSource === "custom" ? (
              <div className="space-y-2">
                <div className="text-[12px] text-dls-secondary">{t("settings.custom_binary_label")}</div>
                <div className="flex items-center gap-2">
                  <div
                    className="min-w-0 flex-1 truncate rounded-xl border border-dls-border bg-dls-surface p-3 font-mono text-[11px] text-dls-secondary"
                    title={props.engineCustomBinPathLabel}
                  >
                    {props.engineCustomBinPathLabel}
                  </div>
                  <Button
                    variant="outline"
                    className="shrink-0"
                    onClick={() => void props.onPickEngineBinary()}
                    disabled={props.busy}
                  >
                    {t("settings.choose")}
                  </Button>
                  <Button
                    variant="outline"
                    className="shrink-0"
                    onClick={props.onClearEngineCustomBinPath}
                    disabled={props.busy || !props.engineCustomBinPath.trim()}
                    title={!props.engineCustomBinPath.trim() ? t("settings.no_custom_path_set") : t("settings.clear")}
                  >
                    {t("settings.clear")}
                  </Button>
                </div>
                <div className="text-[11px] text-dls-secondary">{t("settings.custom_binary_hint")}</div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={subCardClass}>
          <div className="text-sm font-semibold tracking-[-0.1px] text-dls-text">
            {t("settings.startup_title")}
          </div>

          <div className="flex items-center justify-between rounded-xl border border-dls-border bg-dls-surface p-3">
            <div className="flex items-center gap-3">
              <div
                className={`rounded-lg p-2 ${
                  isLocalPreference ? "bg-indigo-7/10 text-indigo-11" : "bg-green-7/10 text-green-11"
                }`}
              >
                {isLocalPreference ? <HardDrive size={18} /> : <Smartphone size={18} />}
              </div>
              <span className="text-sm font-medium text-dls-text">{props.startupLabel}</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void props.onStopHost()}
              disabled={props.busy}
            >
              {t("settings.switch")}
            </Button>
          </div>

          <Button
            variant="outline"
            className="group w-full justify-between"
            onClick={() => void props.onResetStartupPreference()}
          >
            <span>{t("settings.reset_startup_pref")}</span>
            <RefreshCcw size={14} className="opacity-80 transition-transform group-hover:rotate-180" />
          </Button>

          <p className="text-[11px] text-dls-secondary">{t("settings.startup_reset_hint")}</p>
          {props.startupStatus ? <StatusBanner tone="info" message={props.startupStatus} /> : null}
        </div>
      </div>

      {/* Section: Reset & recovery */}
      <div className={cardClass}>
        <div className={sectionHeaderClass}>
          <div className={sectionTitleClass}>{t("settings.recovery_section_title")}</div>
          <div className={sectionDescClass}>{t("settings.recovery_section_desc")}</div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-dls-border bg-dls-surface p-3">
          <div className="min-w-0">
            <div className="text-sm text-dls-text">{t("settings.reset_onboarding_title")}</div>
            <div className="text-[12px] text-dls-secondary">{t("settings.reset_onboarding_description")}</div>
          </div>
          <Button
            variant="outline"
            size="sm" className="shrink-0"
            onClick={() => props.onOpenResetModal("onboarding")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? t("settings.stop_runs_to_reset") : ""}
          >
            {t("settings.reset_button")}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-dls-border bg-dls-surface p-3">
          <div className="min-w-0">
            <div className="text-sm text-dls-text">{t("settings.reset_app_data_title")}</div>
            <div className="text-[12px] text-dls-secondary">{t("settings.reset_app_data_description")}</div>
          </div>
          <Button
            variant="destructive"
            size="sm" className="shrink-0"
            onClick={() => props.onOpenResetModal("all")}
            disabled={props.busy || props.resetModalBusy || props.anyActiveRuns}
            title={props.anyActiveRuns ? t("settings.stop_runs_to_reset") : ""}
          >
            {t("settings.reset_button")}
          </Button>
        </div>

        <div className="text-[11px] text-dls-secondary">{t("settings.reset_requires_confirm")}</div>
        {props.resetStatus ? <StatusBanner tone="info" message={props.resetStatus} /> : null}
      </div>

      {/* Section: Electron alpha migration (debug only) */}
      {props.electronMigrationAvailable ? (
        <div className={cardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={sectionTitleClass}>Electron alpha migration</div>
              <div className={sectionDescClass}>
                Debug-only Tauri controls. Preparing migration data is non-destructive; installing requires a URL and two
                confirmations.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm" className="shrink-0"
              onClick={() => void props.onOpenElectronPreviewRelease()}
            >
              <ExternalLink size={13} className="mr-1.5" />
              Alpha release
            </Button>
          </div>

          <div className="rounded-xl border border-green-7/25 bg-green-3/10 px-3 py-2 text-[12px] leading-relaxed text-green-11">
            Safe default: use <strong>Prepare migration data</strong> first. It writes the Electron snapshot only and does
            not replace, quit, or delete the Tauri app. The install handoff keeps rollback backup at{" "}
            <code className="font-mono">OpenWork.app.migrate-bak</code>.
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void props.onResolveElectronAlphaArtifact()}
              disabled={props.electronMigrationBusy}
            >
              {props.electronMigrationBusy ? "Resolving…" : "Resolve latest Electron alpha"}
            </Button>
            {props.electronMigrationArtifactLabel ? (
              <div className="min-w-0 flex-1 truncate text-[11px] text-dls-secondary">
                {props.electronMigrationArtifactLabel}
              </div>
            ) : (
              <div className="text-[11px] text-dls-secondary">Uses latest-mac.yml from the rolling alpha release.</div>
            )}
          </div>

          <details className="rounded-xl border border-dls-border bg-dls-sidebar/30 p-3">
            <summary className="cursor-pointer select-none text-[11px] font-medium uppercase tracking-wider text-dls-secondary">
              Advanced manual artifact override
            </summary>
            <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
              <label className="space-y-1 text-[12px] text-dls-secondary">
                <span>Electron artifact URL</span>
                <input
                  type="url"
                  value={props.electronMigrationUrl}
                  onChange={(event) => props.onSetElectronMigrationUrl(event.currentTarget.value)}
                  placeholder="Paste a trusted Electron .zip/.exe/AppImage URL"
                  className="h-10 w-full rounded-xl border border-dls-border bg-dls-surface px-3 font-mono text-[11px] text-dls-text outline-none transition-colors placeholder:text-dls-secondary focus:border-dls-accent"
                />
              </label>
              <label className="space-y-1 text-[12px] text-dls-secondary">
                <span>sha512 from latest-mac.yml</span>
                <input
                  type="text"
                  value={props.electronMigrationSha512}
                  onChange={(event) => props.onSetElectronMigrationSha512(event.currentTarget.value)}
                  placeholder="recommended"
                  className="h-10 w-full rounded-xl border border-dls-border bg-dls-surface px-3 font-mono text-[11px] text-dls-text outline-none transition-colors placeholder:text-dls-secondary focus:border-dls-accent"
                />
              </label>
              <label className="space-y-1 text-[12px] text-dls-secondary md:col-span-2">
                <span>sha256 override (legacy optional)</span>
                <input
                  type="text"
                  value={props.electronMigrationSha256}
                  onChange={(event) => props.onSetElectronMigrationSha256(event.currentTarget.value)}
                  placeholder="Only needed when the artifact provider gives sha256 instead of latest-mac.yml sha512"
                  className="h-10 w-full rounded-xl border border-dls-border bg-dls-surface px-3 font-mono text-[11px] text-dls-text outline-none transition-colors placeholder:text-dls-secondary focus:border-dls-accent"
                />
              </label>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void props.onPrepareElectronMigrationSnapshot()}
              disabled={props.electronMigrationBusy}
            >
              {props.electronMigrationBusy ? "Preparing…" : "Prepare migration data"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void props.onInstallElectronPreviewFromTauri()}
              disabled={props.electronMigrationBusy || !props.electronMigrationUrl.trim()}
              title="Requires a trusted artifact URL. macOS keeps OpenWork.app.migrate-bak for rollback."
            >
              Start install handoff…
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void props.onRevealElectronMigrationBackup()}
              disabled={props.electronMigrationBusy}
            >
              Open backup in Finder
            </Button>
            <div className="text-[11px] text-dls-secondary">
              Release page: <span className="font-mono">{props.electronPreviewReleaseUrl}</span>
            </div>
          </div>

          {props.electronMigrationStatus ? (
            <StatusBanner tone="info" message={props.electronMigrationStatus} />
          ) : null}
        </div>
      ) : null}

      {/* Section: Electron alpha updater (debug only) */}
      {props.electronAlphaUpdaterAvailable ? (
        <div className={cardClass}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={sectionTitleClass}>Electron alpha channel</div>
              <div className={sectionDescClass}>
                Debug-only controls for migrated Electron users. Stable updates remain the default in Settings → Updates.
              </div>
            </div>
            <div className="rounded-full border border-dls-border bg-dls-sidebar/50 px-2.5 py-1 text-[11px] font-medium text-dls-secondary">
              {props.electronAlphaUpdaterChannel === "alpha" ? "Alpha" : "Stable"}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={props.electronAlphaUpdaterChannel === "alpha" ? "secondary" : "outline"}
              size="sm"
              onClick={() => void props.onSetElectronAlphaUpdaterChannel("alpha")}
              disabled={props.electronAlphaUpdaterBusy}
            >
              Use alpha feed
            </Button>
            <Button
              variant={props.electronAlphaUpdaterChannel === "stable" ? "secondary" : "outline"}
              size="sm"
              onClick={() => void props.onSetElectronAlphaUpdaterChannel("stable")}
              disabled={props.electronAlphaUpdaterBusy}
            >
              Return to stable
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void props.onCheckElectronAlphaUpdates()}
              disabled={props.electronAlphaUpdaterBusy}
            >
              {props.electronAlphaUpdaterBusy ? "Checking…" : "Check selected feed"}
            </Button>
          </div>

          <div className="text-[11px] text-dls-secondary">
            Alpha feed: <span className="font-mono">alpha-macos-latest/latest-mac.yml</span>. Stable feed:{" "}
            <span className="font-mono">releases/latest/download/latest-mac.yml</span>.
          </div>

          {props.electronAlphaUpdaterStatus ? (
            <StatusBanner tone="info" message={props.electronAlphaUpdaterStatus} />
          ) : null}
        </div>
      ) : null}

      {/* Section: Danger zone */}
      {isDesktop ? (
        <div className="space-y-3 rounded-2xl border border-red-7/30 bg-red-3/10 p-5">
          <div className={sectionHeaderClass}>
            <div className="text-[15px] font-semibold tracking-[-0.2px] text-red-11">
              {t("settings.danger_section_title")}
            </div>
            <div className={sectionDescClass}>{t("settings.danger_section_desc")}</div>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold tracking-[-0.1px] text-dls-text">
                {t("settings.reset_openwork_title")}
              </div>
              <div className="text-[12px] text-dls-secondary">
                {props.opencodeDevModeEnabled
                  ? t("settings.reset_openwork_desc_dev")
                  : t("settings.reset_openwork_desc_prod")}
              </div>
            </div>
            <div
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                props.opencodeDevModeEnabled
                  ? "border-blue-7/35 bg-blue-3/25 text-blue-11"
                  : "border-dls-border bg-dls-sidebar/50 text-dls-secondary"
              }`}
            >
              {props.opencodeDevModeEnabled
                ? t("settings.dev_mode_badge")
                : t("settings.production_mode_badge")}
            </div>
          </div>

          <div className="text-[11px] text-dls-secondary">{t("settings.quit_hint")}</div>

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
            <div className="text-[12px] text-dls-secondary">{t("settings.nuke_hint")}</div>
          </div>

          {props.nukeConfigStatus ? <StatusBanner tone="error" message={props.nukeConfigStatus} /> : null}
        </div>
      ) : null}
    </section>
  );
}
