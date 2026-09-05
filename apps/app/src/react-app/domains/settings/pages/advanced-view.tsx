/** @jsxImportSource react */
import { useEffect, useReducer, useRef, useState } from "react";

import { useLocation } from "react-router";
import { ADVANCED_SETTINGS_SECTIONS } from "../advanced-sections";

import { Separator } from "@/components/ui/separator";

import type { OpencodeConnectStatus } from "@/app/types";
import type { EngineV2PreviewStatus, OpenworkCloudMcpHealth, OpenworkRuntimeConfigStatus, OpenworkServerStatus } from "@/app/lib/openwork-server";
import { t } from "@/i18n";
import { LayoutStack } from "../settings-layout";
import type { useDenSession } from "../cloud/use-den-session";

import { advancedLocalReducer, initialAdvancedLocalState } from "./advanced-view-state";
import {
  AdvancedDeveloperSection,
  AdvancedEngineV2PreviewSection,
  AdvancedCloudMcpDiagnosticsSection,
  AdvancedOrganizationServerSection,
  AdvancedRuntimeConfigSourcesSection,
  AdvancedRuntimeSection,
} from "./advanced-view-sections";

type AdvancedOrganizationServerSession = Pick<
  ReturnType<typeof useDenSession>,
  | "authBusy"
  | "baseUrl"
  | "baseUrlBusy"
  | "baseUrlDraft"
  | "baseUrlError"
  | "onApplyBaseUrl"
  | "onBaseUrlDraftChange"
  | "onClearServerConfiguration"
  | "onResetBaseUrlToDefault"
  | "sessionBusy"
>;

export type AdvancedViewProps = {
  sectionId?: string;
  busy: boolean;
  clientConnected: boolean;
  opencodeConnectStatus: OpencodeConnectStatus | null;
  openworkServerStatus: OpenworkServerStatus;
  developerMode: boolean;
  toggleDeveloperMode: () => void;
  opencodeDevModeEnabled: boolean;
  openDebugDeepLink: (rawUrl: string) => Promise<{ ok: boolean; message: string }>;
  canInspectRuntimeConfig: boolean;
  getRuntimeConfigStatus: () => Promise<OpenworkRuntimeConfigStatus>;
  organizationServer: AdvancedOrganizationServerSession;
  cloudMcpUrl: string | null;
  cloudMcpHealth: OpenworkCloudMcpHealth | null;
  refreshCloudMcpHealth: () => Promise<OpenworkCloudMcpHealth | null>;
  getEngineV2PreviewStatus: () => Promise<EngineV2PreviewStatus>;
  setEngineV2PreviewEnabled: (enabled: boolean) => Promise<EngineV2PreviewStatus>;
  setEngineV2PreviewChatRouting: (enabled: boolean) => Promise<EngineV2PreviewStatus>;
};

type AdvancedStatusTone = "ready" | "warning" | "error" | "neutral";

export function AdvancedView(props: AdvancedViewProps) {
  const location = useLocation();
  const viewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sectionId = props.sectionId;
    if (!ADVANCED_SETTINGS_SECTIONS.some((section) => section.id === sectionId)) return;
    const frame = requestAnimationFrame(() => {
      const section = viewRef.current?.querySelector<HTMLElement>(`#advanced-${sectionId}`);
      section?.scrollIntoView({ block: "start" });
      section?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.key, props.sectionId]);
  const [localState, dispatchLocal] = useReducer(
    advancedLocalReducer,
    initialAdvancedLocalState,
  );
  const [configStatus, setConfigStatus] = useState<OpenworkRuntimeConfigStatus | null>(null);
  const [configStatusBusy, setConfigStatusBusy] = useState(false);
  const [configStatusError, setConfigStatusError] = useState<string | null>(null);
  const {
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

  const clientTone: AdvancedStatusTone = (() => {
    const status = props.opencodeConnectStatus?.status;
    if (status === "connecting") return "warning";
    if (status === "error") return "error";
    return props.clientConnected ? "ready" : "neutral";
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

  const openworkTone: AdvancedStatusTone = (() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "ready";
      case "limited":
        return "warning";
      default:
        return "neutral";
    }
  })();

  const clientDetailLines = props.clientConnected
    ? ["Chat and task creation can use the OpenCode engine for this workspace."]
    : [
        "Chat and task creation may fail until OpenCode restarts.",
        "OpenWork server config sources below can still be inspected.",
      ];

  const openworkDetailLines = props.openworkServerStatus === "connected"
    ? ["Runtime DB, workspace config, and migration diagnostics are available."]
    : ["Runtime config diagnostics need the OpenWork server connection."];

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

  const refreshRuntimeConfigStatus = async () => {
    if (!props.canInspectRuntimeConfig) {
      setConfigStatus(null);
      return;
    }
    setConfigStatusBusy(true);
    setConfigStatusError(null);
    try {
      setConfigStatus(await props.getRuntimeConfigStatus());
    } catch (error) {
      setConfigStatusError(error instanceof Error ? error.message : "Failed to load runtime config status.");
    } finally {
      setConfigStatusBusy(false);
    }
  };

  useEffect(() => {
    void refreshRuntimeConfigStatus();
  }, [props.canInspectRuntimeConfig]);

  return (
    <div ref={viewRef}>
    <LayoutStack>
      <AdvancedOrganizationServerSection
        authBusy={props.organizationServer.authBusy}
        baseUrl={props.organizationServer.baseUrl}
        baseUrlBusy={props.organizationServer.baseUrlBusy}
        baseUrlDraft={props.organizationServer.baseUrlDraft}
        baseUrlError={props.organizationServer.baseUrlError}
        onApplyBaseUrl={props.organizationServer.onApplyBaseUrl}
        onBaseUrlDraftChange={props.organizationServer.onBaseUrlDraftChange}
        onClearServerConfiguration={props.organizationServer.onClearServerConfiguration}
        onResetBaseUrlToDefault={props.organizationServer.onResetBaseUrlToDefault}
        sessionBusy={props.organizationServer.sessionBusy}
        cloudMcpUrl={props.cloudMcpUrl}
      />

      <AdvancedRuntimeSection
        clientStatusLabel={clientStatusLabel}
        clientTone={clientTone}
        clientDetailLines={clientDetailLines}
        openworkStatusLabel={openworkStatusLabel}
        openworkTone={openworkTone}
        openworkDetailLines={openworkDetailLines}
      />

      <AdvancedCloudMcpDiagnosticsSection
        cloudMcpHealth={props.cloudMcpHealth}
        onRefresh={props.refreshCloudMcpHealth}
      />

      <AdvancedRuntimeConfigSourcesSection
        busy={props.busy}
        canInspect={props.canInspectRuntimeConfig}
        configStatus={configStatus}
        configStatusBusy={configStatusBusy}
        configStatusError={configStatusError}
        onRefresh={refreshRuntimeConfigStatus}
      />

      <AdvancedEngineV2PreviewSection
        getStatus={props.getEngineV2PreviewStatus}
        setEnabled={props.setEngineV2PreviewEnabled}
        setChatRouting={props.setEngineV2PreviewChatRouting}
      />

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
    </LayoutStack>
    </div>
  );
}
