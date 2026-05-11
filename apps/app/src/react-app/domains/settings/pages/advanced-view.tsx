/** @jsxImportSource react */
import { useReducer } from "react";

import type { OpencodeConnectStatus } from "../../../../app/types";
import type { OpenworkServerStatus } from "../../../../app/lib/openwork-server";
import type { EngineInfo } from "../../../../app/lib/desktop";
import { t } from "../../../../i18n";

import { advancedLocalReducer, initialAdvancedLocalState } from "./advanced-view-state";
import {
  AdvancedConnectionSection,
  AdvancedDeveloperSection,
  AdvancedFeatureFlagsSection,
  AdvancedOpencodeSection,
  AdvancedRuntimeSection,
} from "./advanced-view-sections";
import { ConfigView, type ConfigViewProps } from "./config-view";

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

export function AdvancedView(props: AdvancedViewProps) {
  const [localState, dispatchLocal] = useReducer(
    advancedLocalReducer,
    initialAdvancedLocalState,
  );
  const {
    reconnectStatus: openworkReconnectStatus,
    reconnectError: openworkReconnectError,
    restartBusy: openworkRestartBusy,
    restartStatus: openworkRestartStatus,
    restartError: openworkRestartError,
    deepLinkOpen: debugDeepLinkOpen,
    deepLinkInput: debugDeepLinkInput,
    deepLinkBusy: debugDeepLinkBusy,
    deepLinkStatus: debugDeepLinkStatus,
  } = localState;

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
    dispatchLocal({ type: "reconnectStart" });
    try {
      const ok = await props.reconnectOpenworkServer();
      if (!ok) {
        dispatchLocal({ type: "reconnectError", error: t("settings.reconnect_failed") });
        return;
      }
      dispatchLocal({ type: "reconnectStatus", status: t("settings.reconnected") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchLocal({ type: "reconnectError", error: message || t("settings.reconnect_server_failed") });
    }
  };

  const handleRestartLocalServer = async () => {
    if (props.busy || openworkRestartBusy) return;
    dispatchLocal({ type: "restartStart" });
    try {
      const ok = await props.restartLocalServer();
      if (!ok) {
        dispatchLocal({ type: "restartError", error: t("settings.restart_failed") });
        return;
      }
      dispatchLocal({ type: "restartStatus", status: t("settings.restarted") });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchLocal({ type: "restartError", error: message || t("settings.restart_server_failed") });
    } finally {
      dispatchLocal({ type: "restartDone" });
    }
  };

  const submitDebugDeepLink = async () => {
    const rawUrl = debugDeepLinkInput.trim();
    if (!rawUrl || props.busy || debugDeepLinkBusy) return;
    dispatchLocal({ type: "deepLinkStart" });
    try {
      const result = await props.openDebugDeepLink(rawUrl);
      if (result.ok) {
        dispatchLocal({ type: "deepLinkSuccess", status: result.message });
      } else {
        dispatchLocal({ type: "deepLinkStatus", status: result.message });
      }
    } catch (error) {
      dispatchLocal({
        type: "deepLinkStatus",
        status: error instanceof Error ? error.message : t("settings.open_deeplink_failed"),
      });
    } finally {
      dispatchLocal({ type: "deepLinkDone" });
    }
  };

  return (
    <div className="space-y-6 max-w-3xl w-full">
      <AdvancedRuntimeSection
        engineInfo={props.engineInfo}
        clientStatusLabel={clientStatusLabel}
        clientStatusStyle={clientStatusStyle}
        clientStatusDot={clientStatusDot}
        openworkStatusLabel={openworkStatusLabel}
        openworkStatusStyle={openworkStatusStyle}
        openworkStatusDot={openworkStatusDot}
      />

      <AdvancedOpencodeSection
        busy={props.busy}
        enabled={props.opencodeEnableExa}
        onToggle={props.toggleOpencodeEnableExa}
      />

      {/* Feature flags section removed -- microsandbox is always on */}

      <AdvancedDeveloperSection
        busy={props.busy}
        developerMode={props.developerMode}
        opencodeDevModeEnabled={props.opencodeDevModeEnabled}
        deepLinkOpen={debugDeepLinkOpen}
        deepLinkInput={debugDeepLinkInput}
        deepLinkBusy={debugDeepLinkBusy}
        deepLinkStatus={debugDeepLinkStatus}
        onToggleDeveloperMode={props.toggleDeveloperMode}
        onToggleDeepLink={() => dispatchLocal({ type: "toggleDeepLink" })}
        onDeepLinkInput={(input) => dispatchLocal({ type: "deepLinkInput", input })}
        onSubmitDeepLink={submitDebugDeepLink}
      />

      <AdvancedConnectionSection
        busy={props.busy}
        headerStatus={props.headerStatus}
        baseUrl={props.baseUrl}
        openworkServerUrl={props.openworkServerUrl}
        openworkServerStatus={props.openworkServerStatus}
        openworkReconnectBusy={props.openworkReconnectBusy}
        isLocalEngineRunning={isLocalEngineRunning}
        restartBusy={openworkRestartBusy}
        reconnectStatus={openworkReconnectStatus}
        reconnectError={openworkReconnectError}
        restartStatus={openworkRestartStatus}
        restartError={openworkRestartError}
        onReconnect={handleReconnectOpenworkServer}
        onRestart={handleRestartLocalServer}
        onStopHost={props.stopHost}
      />

      {props.developerMode ? <ConfigView {...props.configView} /> : null}
    </div>
  );
}
