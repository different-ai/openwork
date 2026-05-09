/** @jsxImportSource react */
import type { ReactNode } from "react";
import { CircleAlert, Cpu, RefreshCcw, Server, Zap } from "lucide-react";

import type { OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import type { EngineInfo } from "../../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
const settingsPanelSoftClass = "rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4";

type RuntimeStatusCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
  statusLabel: string;
  statusStyle: string;
  statusDot: string;
  detailLines?: string[];
};

function RuntimeStatusCard(props: RuntimeStatusCardProps) {
  return (
    <div className={`${settingsPanelSoftClass} space-y-3`}>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
          {props.icon}
        </div>
        <div>
          <div className="text-sm font-medium text-gray-12">{props.title}</div>
          <div className="text-xs text-gray-9">{props.description}</div>
        </div>
      </div>
      <div
        className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-medium ${props.statusStyle}`}
      >
        <span className={`size-2 rounded-full ${props.statusDot}`} />
        {props.statusLabel}
      </div>
      {props.detailLines?.length ? (
        <div className="space-y-1 border-t border-gray-6/50 pt-2 text-[11px] text-gray-9">
          {props.detailLines.map((line) => (
            <div key={line} className="truncate" title={line}>
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatOpencodeBinary(info: EngineInfo | null) {
  const binary = info?.opencodeBinPath?.trim();
  if (!binary) return "—";
  const source = info?.opencodeBinSource?.trim();
  return source ? `${binary} (${source})` : binary;
}

export function AdvancedRuntimeSection(props: {
  engineInfo: EngineInfo | null;
  clientStatusLabel: string;
  clientStatusStyle: string;
  clientStatusDot: string;
  openworkStatusLabel: string;
  openworkStatusStyle: string;
  openworkStatusDot: string;
}) {
  return (
    <div className={`${settingsPanelClass} space-y-4`}>
      <div>
        <div className="text-sm font-medium text-gray-12">{t("settings.runtime_title")}</div>
        <div className="text-xs text-gray-9">{t("settings.runtime_desc")}</div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <RuntimeStatusCard
          icon={<Cpu size={18} />}
          title={t("settings.opencode_engine_label")}
          description={t("settings.opencode_engine_desc")}
          statusLabel={props.clientStatusLabel}
          statusStyle={props.clientStatusStyle}
          statusDot={props.clientStatusDot}
          detailLines={[
            t("settings.diag_opencode_binary", undefined, {
              binary: formatOpencodeBinary(props.engineInfo),
            }),
          ]}
        />
        <RuntimeStatusCard
          icon={<Server size={18} />}
          title={t("settings.openwork_server_label")}
          description={t("settings.openwork_server_desc")}
          statusLabel={props.openworkStatusLabel}
          statusStyle={props.openworkStatusStyle}
          statusDot={props.openworkStatusDot}
        />
      </div>
    </div>
  );
}

export function AdvancedOpencodeSection(props: { busy: boolean; enabled: boolean; onToggle: () => void }) {
  return (
    <div className={`${settingsPanelClass} space-y-3`}>
      <div>
        <div className="text-sm font-medium text-gray-12">{t("settings.opencode_section_label")}</div>
        <div className="text-xs text-gray-9">{t("settings.opencode_engine_desc")}</div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
        <div className="min-w-0">
          <div className="text-sm text-gray-12">{t("settings.enable_exa")}</div>
          <div className="text-xs text-gray-7">{t("settings.enable_exa_desc")}</div>
        </div>
        <Button variant="outline" className="h-8 shrink-0 px-3 py-0 text-xs" onClick={props.onToggle} disabled={props.busy}>
          {props.enabled ? t("settings.on") : t("settings.off")}
        </Button>
      </div>

      <div className="text-[11px] text-gray-7">{t("settings.exa_restart_hint")}</div>
    </div>
  );
}

export function AdvancedFeatureFlagsSection(props: {
  busy: boolean;
  microsandboxCreateSandboxEnabled: boolean;
  onToggleMicrosandboxCreateSandbox: () => void;
}) {
  return (
    <div className={`${settingsPanelClass} space-y-3`}>
      <div>
        <div className="text-sm font-medium text-gray-12">Feature flags</div>
        <div className="text-xs text-gray-9">Experimental controls for sandbox and workspace behaviors.</div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
        <div className="min-w-0">
          <div className="text-sm text-gray-12">Create Sandbox uses microsandbox image</div>
          <div className="text-xs text-gray-7">
            When enabled, Create Sandbox launches the detached worker with the microsandbox image flow instead of the default Docker image flow.
          </div>
        </div>
        <Button
          variant="outline"
          className="h-8 shrink-0 px-3 py-0 text-xs"
          onClick={props.onToggleMicrosandboxCreateSandbox}
          disabled={props.busy || !isDesktopRuntime()}
        >
          {props.microsandboxCreateSandboxEnabled ? "On" : "Off"}
        </Button>
      </div>
    </div>
  );
}

export function AdvancedDeveloperSection(props: {
  busy: boolean;
  developerMode: boolean;
  opencodeDevModeEnabled: boolean;
  deepLinkOpen: boolean;
  deepLinkInput: string;
  deepLinkBusy: boolean;
  deepLinkStatus: string | null;
  onToggleDeveloperMode: () => void;
  onToggleDeepLink: () => void;
  onDeepLinkInput: (input: string) => void;
  onSubmitDeepLink: () => Promise<void>;
}) {
  return (
    <div className={`${settingsPanelClass} space-y-3`}>
      <div className="text-sm font-medium text-gray-12">{t("settings.developer_mode_title")}</div>
      <div className="text-xs text-gray-9">{t("settings.developer_mode_desc")}</div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium shadow-sm transition-colors duration-150 focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${
            props.developerMode
              ? "border-blue-7/35 bg-blue-3/20 text-blue-11 hover:bg-blue-3/35 hover:text-blue-11 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)]"
              : "border-dls-border bg-dls-surface text-dls-secondary hover:bg-dls-hover hover:text-dls-text focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)]"
          }`}
          onClick={props.onToggleDeveloperMode}
        >
          <Zap size={14} className={props.developerMode ? "text-blue-10" : "text-dls-secondary"} />
          {props.developerMode ? t("settings.disable_developer_mode") : t("settings.enable_developer_mode")}
        </button>
        <div className="text-xs text-gray-10">
          {props.developerMode ? t("settings.developer_panel_enabled") : t("settings.developer_panel_disabled")}
        </div>
      </div>

      {isDesktopRuntime() && props.opencodeDevModeEnabled && props.developerMode ? (
        <div className={`${settingsPanelSoftClass} space-y-3`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-12">{t("settings.open_deeplink_title")}</div>
              <div className="text-xs text-gray-9">{t("settings.open_deeplink_desc")}</div>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={props.onToggleDeepLink}
              disabled={props.busy || props.deepLinkBusy}
            >
              {props.deepLinkOpen ? t("common.hide") : t("settings.open_deeplink_button")}
            </button>
          </div>

          {props.deepLinkOpen ? (
            <div className="space-y-3">
              <textarea
                value={props.deepLinkInput}
                onChange={(event) => props.onDeepLinkInput(event.currentTarget.value)}
                rows={3}
                placeholder="openwork://..."
                className="w-full rounded-xl border border-gray-6 bg-gray-1 px-3 py-2 text-xs font-mono text-gray-12 outline-none transition focus:border-blue-8"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  className="h-8 px-3 py-0 text-xs"
                  onClick={() => void props.onSubmitDeepLink()}
                  disabled={props.busy || props.deepLinkBusy || !props.deepLinkInput.trim()}
                >
                  {props.deepLinkBusy ? t("settings.opening") : t("settings.open_deeplink_action")}
                </Button>
                <div className="text-[11px] text-gray-8">{t("settings.deeplink_hint")}</div>
              </div>
            </div>
          ) : null}

          {props.deepLinkStatus ? <div className="text-xs text-gray-10">{props.deepLinkStatus}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AdvancedConnectionSection(props: {
  busy: boolean;
  headerStatus: string;
  baseUrl: string;
  openworkServerUrl: string;
  openworkServerStatus: OpenworkServerStatus;
  openworkReconnectBusy: boolean;
  isLocalEngineRunning: boolean;
  restartBusy: boolean;
  reconnectStatus: string | null;
  reconnectError: string | null;
  restartStatus: string | null;
  restartError: string | null;
  onReconnect: () => Promise<void>;
  onRestart: () => Promise<void>;
  onStopHost: () => void;
}) {
  return (
    <div className={`${settingsPanelClass} space-y-3`}>
      <div className="text-sm font-medium text-gray-12">{t("settings.connection_title")}</div>
      <div className="text-xs text-gray-9">{props.headerStatus}</div>
      <div className="break-all font-mono text-xs text-gray-8">{props.baseUrl}</div>
      <div className="flex flex-wrap gap-2 pt-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
          onClick={() => void props.onReconnect()}
          disabled={props.busy || props.openworkReconnectBusy || !props.openworkServerUrl.trim()}
        >
          <RefreshCcw size={14} className={`text-dls-secondary ${props.openworkReconnectBusy ? "animate-spin" : ""}`} />
          {props.openworkReconnectBusy ? t("settings.reconnecting") : t("settings.reconnect_server")}
        </button>

        {props.isLocalEngineRunning ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void props.onRestart()}
            disabled={props.busy || props.restartBusy}
          >
            <RefreshCcw size={14} className={`text-dls-secondary ${props.restartBusy ? "animate-spin" : ""}`} />
            {props.restartBusy ? t("settings.restarting") : t("settings.restart_openwork_server")}
          </button>
        ) : null}

        {props.isLocalEngineRunning ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-red-7/35 bg-red-3/25 px-3 py-1.5 text-xs font-medium text-red-11 transition-colors duration-150 hover:border-red-7/50 hover:bg-red-3/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-7/35 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={props.onStopHost}
            disabled={props.busy}
          >
            <CircleAlert size={14} />
            {t("settings.stop_local_server")}
          </button>
        ) : null}

        {!props.isLocalEngineRunning && props.openworkServerStatus === "connected" ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={props.onStopHost}
            disabled={props.busy}
          >
            {t("settings.disconnect_server")}
          </button>
        ) : null}
      </div>

      {props.reconnectStatus ? <div className="text-xs text-gray-10">{props.reconnectStatus}</div> : null}
      {props.reconnectError ? <div className="text-xs text-red-11">{props.reconnectError}</div> : null}
      {props.restartStatus ? <div className="text-xs text-gray-10">{props.restartStatus}</div> : null}
      {props.restartError ? <div className="text-xs text-red-11">{props.restartError}</div> : null}
    </div>
  );
}
