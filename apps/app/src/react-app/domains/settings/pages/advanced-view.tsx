/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { CircleAlert, Cpu, RefreshCcw, Server, Zap } from "lucide-react";

import type { OpencodeConnectStatus } from "../../../../app/types";
import type { OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import type { EngineInfo } from "../../../../app/lib/tauri";
import { isTauriRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";

import { ConfigView, type ConfigViewProps } from "./config-view";

const settingsPanelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
const settingsPanelSoftClass = "rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4";

type RuntimeStatusCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
  statusLabel: string;
  statusStyle: string;
  statusDot: string;
};

export type AdvancedViewProps = {
  busy: boolean;
  baseUrl: string;
  headerStatus: string;
  clientConnected: boolean;
  opencodeConnectStatus: OpencodeConnectStatus | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkReconnectBusy: boolean;
  reconnectOpenworkServer: () => Promise<boolean>;
  engineInfo: EngineInfo | null;
  restartLocalServer: () => Promise<boolean>;
  stopHost: () => void;
  developerMode: boolean;
  toggleDeveloperMode: () => void;
  opencodeDevModeEnabled: boolean;
  openDebugDeepLink: (rawUrl: string) => Promise<{ ok: boolean; message: string }>;
  opencodeEnableExa: boolean;
  toggleOpencodeEnableExa: () => void;
  microsandboxCreateSandboxEnabled: boolean;
  toggleMicrosandboxCreateSandbox: () => void;
  configView: ConfigViewProps;
};

function RuntimeStatusCard(props: RuntimeStatusCardProps) {
  return (
    <div className={`${settingsPanelSoftClass} space-y-3`}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-6/60 bg-gray-1/70 text-gray-12">
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
        <span className={`h-2 w-2 rounded-full ${props.statusDot}`} />
        {props.statusLabel}
      </div>
    </div>
  );
}

export function AdvancedView(props: AdvancedViewProps) {
  const [openworkReconnectStatus, setOpenworkReconnectStatus] = useState<string | null>(null);
  const [openworkReconnectError, setOpenworkReconnectError] = useState<string | null>(null);
  const [openworkRestartBusy, setOpenworkRestartBusy] = useState(false);
  const [openworkRestartStatus, setOpenworkRestartStatus] = useState<string | null>(null);
  const [openworkRestartError, setOpenworkRestartError] = useState<string | null>(null);
  const [debugDeepLinkOpen, setDebugDeepLinkOpen] = useState(false);
  const [debugDeepLinkInput, setDebugDeepLinkInput] = useState("");
  const [debugDeepLinkBusy, setDebugDeepLinkBusy] = useState(false);
  const [debugDeepLinkStatus, setDebugDeepLinkStatus] = useState<string | null>(null);

  const clientStatusLabel = (() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return t("status.connecting");
    if (status === "error") return t("settings.connection_failed");
    return props.clientConnected ? t("status.connected") : t("config.status_not_connected");
  })();

  const clientStatusStyle = (() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return "bg-amber-7/10 text-amber-11 border-amber-7/20";
    if (status === "error") return "bg-red-7/10 text-red-11 border-red-7/20";
    return props.clientConnected
      ? "bg-green-7/10 text-green-11 border-green-7/20"
      : "bg-gray-4/60 text-gray-11 border-gray-7/50";
  })();

  const clientStatusDot = (() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return "bg-amber-9";
    if (status === "error") return "bg-red-9";
    return props.clientConnected ? "bg-green-9" : "bg-gray-6";
  })();

  const openworkStatusLabel = (() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return t("config.status_connected");
      case "limited":
        return t("config.status_limited");
      default:
        return t("config.status_not_connected");
    }
  })();

  const openworkStatusStyle = (() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  })();

  const openworkStatusDot = (() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "bg-green-9";
      case "limited":
        return "bg-amber-9";
      default:
        return "bg-gray-6";
    }
  })();

  const isLocalEngineRunning = Boolean(props.engineInfo?.running);

  const handleReconnectOpenworkServer = async () => {
    if (props.busy || props.openworkReconnectBusy || !props.openworkServerUrl.trim()) return;
    setOpenworkReconnectStatus(null);
    setOpenworkReconnectError(null);
    try {
      const ok = await props.reconnectOpenworkServer();
      if (!ok) {
        setOpenworkReconnectError(t("settings.reconnect_failed"));
        return;
      }
      setOpenworkReconnectStatus(t("settings.reconnected"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenworkReconnectError(message || t("settings.reconnect_server_failed"));
    }
  };

  const handleRestartLocalServer = async () => {
    if (props.busy || openworkRestartBusy) return;
    setOpenworkRestartStatus(null);
    setOpenworkRestartError(null);
    setOpenworkRestartBusy(true);
    try {
      const ok = await props.restartLocalServer();
      if (!ok) {
        setOpenworkRestartError(t("settings.restart_failed"));
        return;
      }
      setOpenworkRestartStatus(t("settings.restarted"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenworkRestartError(message || t("settings.restart_server_failed"));
    } finally {
      setOpenworkRestartBusy(false);
    }
  };

  const submitDebugDeepLink = async () => {
    const rawUrl = debugDeepLinkInput.trim();
    if (!rawUrl || props.busy || debugDeepLinkBusy) return;
    setDebugDeepLinkBusy(true);
    setDebugDeepLinkStatus(null);
    try {
      const result = await props.openDebugDeepLink(rawUrl);
      setDebugDeepLinkStatus(result.message);
      if (result.ok) {
        setDebugDeepLinkInput("");
      }
    } catch (error) {
      setDebugDeepLinkStatus(
        error instanceof Error ? error.message : t("settings.open_deeplink_failed"),
      );
    } finally {
      setDebugDeepLinkBusy(false);
    }
  };

  return (
    <div className="space-y-6">
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
            statusLabel={clientStatusLabel}
            statusStyle={clientStatusStyle}
            statusDot={clientStatusDot}
          />
          <RuntimeStatusCard
            icon={<Server size={18} />}
            title={t("settings.openwork_server_label")}
            description={t("settings.openwork_server_desc")}
            statusLabel={openworkStatusLabel}
            statusStyle={openworkStatusStyle}
            statusDot={openworkStatusDot}
          />
        </div>
      </div>

      <div className={`${settingsPanelClass} space-y-3`}>
        <div>
          <div className="text-sm font-medium text-gray-12">{t("settings.opencode_section_label")}</div>
          <div className="text-xs text-gray-9">{t("settings.opencode_runtime_desc")}</div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
          <div className="min-w-0">
            <div className="text-sm text-gray-12">{t("settings.enable_exa")}</div>
            <div className="text-xs text-gray-7">{t("settings.enable_exa_desc")}</div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.toggleOpencodeEnableExa}
            disabled={props.busy}
          >
            {props.opencodeEnableExa ? t("settings.on") : t("settings.off")}
          </Button>
        </div>

        <div className="text-[11px] text-gray-7">{t("settings.exa_restart_hint")}</div>
      </div>

      <div className={`${settingsPanelClass} space-y-3`}>
        <div>
          <div className="text-sm font-medium text-gray-12">Feature flags</div>
          <div className="text-xs text-gray-9">
            Experimental controls for sandbox and workspace behaviors.
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-6 bg-gray-1 p-3">
          <div className="min-w-0">
            <div className="text-sm text-gray-12">Create Sandbox uses microsandbox image</div>
            <div className="text-xs text-gray-7">
              When enabled, Create Sandbox launches the detached worker with the microsandbox image
              flow instead of the default Docker image flow.
            </div>
          </div>
          <Button
            variant="outline"
            className="h-8 shrink-0 px-3 py-0 text-xs"
            onClick={props.toggleMicrosandboxCreateSandbox}
            disabled={props.busy || !isTauriRuntime()}
          >
            {props.microsandboxCreateSandboxEnabled ? "On" : "Off"}
          </Button>
        </div>
      </div>

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
            onClick={props.toggleDeveloperMode}
          >
            <Zap size={14} className={props.developerMode ? "text-blue-10" : "text-dls-secondary"} />
            {props.developerMode
              ? t("settings.disable_developer_mode")
              : t("settings.enable_developer_mode")}
          </button>
          <div className="text-xs text-gray-10">
            {props.developerMode
              ? t("settings.developer_panel_enabled")
              : t("settings.developer_panel_disabled")}
          </div>
        </div>

        {isTauriRuntime() && props.opencodeDevModeEnabled && props.developerMode ? (
          <div className={`${settingsPanelSoftClass} space-y-3`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-12">{t("settings.open_deeplink_title")}</div>
                <div className="text-xs text-gray-9">{t("settings.open_deeplink_desc")}</div>
              </div>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => {
                  setDebugDeepLinkOpen((value) => !value);
                  setDebugDeepLinkStatus(null);
                }}
                disabled={props.busy || debugDeepLinkBusy}
              >
                {debugDeepLinkOpen ? t("common.hide") : t("settings.open_deeplink_button")}
              </button>
            </div>

            {debugDeepLinkOpen ? (
              <div className="space-y-3">
                <textarea
                  value={debugDeepLinkInput}
                  onChange={(event) => setDebugDeepLinkInput(event.currentTarget.value)}
                  rows={3}
                  placeholder="openwork://..."
                  className="w-full rounded-xl border border-gray-6 bg-gray-1 px-3 py-2 text-xs font-mono text-gray-12 outline-none transition focus:border-blue-8"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    className="h-8 px-3 py-0 text-xs"
                    onClick={() => void submitDebugDeepLink()}
                    disabled={props.busy || debugDeepLinkBusy || !debugDeepLinkInput.trim()}
                  >
                    {debugDeepLinkBusy ? t("settings.opening") : t("settings.open_deeplink_action")}
                  </Button>
                  <div className="text-[11px] text-gray-8">{t("settings.deeplink_hint")}</div>
                </div>
              </div>
            ) : null}

            {debugDeepLinkStatus ? <div className="text-xs text-gray-10">{debugDeepLinkStatus}</div> : null}
          </div>
        ) : null}
      </div>

      <div className={`${settingsPanelClass} space-y-3`}>
        <div className="text-sm font-medium text-gray-12">{t("settings.connection_title")}</div>
        <div className="text-xs text-gray-9">{props.headerStatus}</div>
        <div className="break-all font-mono text-xs text-gray-8">{props.baseUrl}</div>
        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void handleReconnectOpenworkServer()}
            disabled={props.busy || props.openworkReconnectBusy || !props.openworkServerUrl.trim()}
          >
            <RefreshCcw size={14} className={`text-dls-secondary ${props.openworkReconnectBusy ? "animate-spin" : ""}`} />
            {props.openworkReconnectBusy ? t("settings.reconnecting") : t("settings.reconnect_server")}
          </button>

          {isLocalEngineRunning ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handleRestartLocalServer()}
              disabled={props.busy || openworkRestartBusy}
            >
              <RefreshCcw size={14} className={`text-dls-secondary ${openworkRestartBusy ? "animate-spin" : ""}`} />
              {openworkRestartBusy ? t("settings.restarting") : t("settings.restart_local_server")}
            </button>
          ) : null}

          {isLocalEngineRunning ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-red-7/35 bg-red-3/25 px-3 py-1.5 text-xs font-medium text-red-11 transition-colors duration-150 hover:border-red-7/50 hover:bg-red-3/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-7/35 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={props.stopHost}
              disabled={props.busy}
            >
              <CircleAlert size={14} />
              {t("settings.stop_local_server")}
            </button>
          ) : null}

          {!isLocalEngineRunning && props.openworkServerStatus === "connected" ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60"
              onClick={props.stopHost}
              disabled={props.busy}
            >
              {t("settings.disconnect_server")}
            </button>
          ) : null}
        </div>

        {openworkReconnectStatus ? <div className="text-xs text-gray-10">{openworkReconnectStatus}</div> : null}
        {openworkReconnectError ? <div className="text-xs text-red-11">{openworkReconnectError}</div> : null}
        {openworkRestartStatus ? <div className="text-xs text-gray-10">{openworkRestartStatus}</div> : null}
        {openworkRestartError ? <div className="text-xs text-red-11">{openworkRestartError}</div> : null}
      </div>

      {props.developerMode ? <ConfigView {...props.configView} /> : null}
    </div>
  );
}
