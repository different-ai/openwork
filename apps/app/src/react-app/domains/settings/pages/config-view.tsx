/** @jsxImportSource react */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { buildDiagnosticsBundleJson } from "../../../../app/lib/diagnostics-bundle";
import {
  buildMicxWorkspaceBaseUrl,
  parseMicxWorkspaceIdFromUrl,
  type MicxServerSettings,
  type MicxServerStatus,
} from "../../../../app/lib/micx-server";
import type { MicxServerInfo } from "../../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import {
  ConfigDiagnosticsSection,
  ConfigEngineReloadSection,
  ConfigServerConnectionSection,
  ConfigServerSharingSection,
  ConfigWorkspaceSummary,
} from "./config-view-sections";
import { configLocalReducer, initialConfigLocalState } from "./config-view-state";

export type ConfigViewProps = {
  busy: boolean;
  clientConnected: boolean;
  anyActiveRuns: boolean;

  micxServerStatus: MicxServerStatus;
  micxServerUrl: string;
  micxServerSettings: MicxServerSettings;
  micxServerHostInfo: MicxServerInfo | null;
  runtimeWorkspaceId: string | null;

  updateMicxServerSettings: (next: MicxServerSettings) => void;
  resetMicxServerSettings: () => void;
  testMicxServerConnection: (
    next: MicxServerSettings,
  ) => Promise<boolean>;

  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;

  developerMode: boolean;
};

export function ConfigView(props: ConfigViewProps) {
  const [localState, dispatchLocal] = useReducer(
    configLocalReducer,
    initialConfigLocalState,
  );
  const { micxConnection, tokenVisible, copyingField } = localState;
  const micxUrl = micxConnection.url;
  const micxToken = micxConnection.token;
  const micxTestState = micxConnection.testState;
  const micxTestMessage = micxConnection.testMessage;
  const copyTimeoutRef = useRef<number | undefined>(undefined);
  const [diagnosticsBundleJson, setDiagnosticsBundleJson] = useState("");

  useEffect(() => {
    dispatchLocal({
      type: "serverSettings",
      connection: {
        url: props.micxServerSettings.urlOverride ?? "",
        token: props.micxServerSettings.token ?? "",
        testState: "idle",
        testMessage: null,
      },
    });
  }, [props.micxServerSettings]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const micxStatusLabel = (() => {
    switch (props.micxServerStatus) {
      case "connected":
        return t("config.status_connected");
      case "limited":
        return t("config.status_limited");
      default:
        return t("config.status_not_connected");
    }
  })();

  const micxStatusStyle = (() => {
    switch (props.micxServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  })();

  const reloadAvailabilityReason = (() => {
    if (!props.clientConnected) return t("config.reload_connect_hint");
    if (!props.canReloadWorkspace) return t("config.reload_availability_hint");
    return null;
  })();

  const reloadButtonLabel = props.reloadBusy
    ? t("config.reloading")
    : t("config.reload_engine");
  const reloadButtonTone: "destructive" | "secondary" = props.anyActiveRuns
    ? "destructive"
    : "secondary";
  const reloadButtonDisabled =
    props.reloadBusy || Boolean(reloadAvailabilityReason);

  const buildMicxSettings = (): MicxServerSettings => ({
    ...props.micxServerSettings,
    urlOverride: micxUrl.trim() || undefined,
    token: micxToken.trim() || undefined,
  });

  const hasMicxChanges = (() => {
    const currentUrl = props.micxServerSettings.urlOverride ?? "";
    const currentToken = props.micxServerSettings.token ?? "";
    return (
      micxUrl.trim() !== currentUrl || micxToken.trim() !== currentToken
    );
  })();

  const resolvedWorkspaceId = (() => {
    const explicitId = props.runtimeWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseMicxWorkspaceIdFromUrl(micxUrl) ?? "";
  })();

  const resolvedWorkspaceUrl = (() => {
    const baseUrl = micxUrl.trim();
    if (!baseUrl) return "";
    return buildMicxWorkspaceBaseUrl(baseUrl, resolvedWorkspaceId) ?? baseUrl;
  })();

  const hostInfo = props.micxServerHostInfo;
  const hostRemoteAccessEnabled = hostInfo?.remoteAccessEnabled === true;
  const hostStatusLabel = !hostInfo?.running
    ? t("config.host_offline")
    : hostRemoteAccessEnabled
      ? t("config.host_remote_enabled")
      : t("config.host_local_only");
  const hostStatusStyle = !hostInfo?.running
    ? "bg-gray-4/60 text-gray-11 border-gray-7/50"
    : "bg-green-7/10 text-green-11 border-green-7/20";
  const hostConnectUrl =
    hostInfo?.connectUrl ??
    hostInfo?.mdnsUrl ??
    hostInfo?.lanUrl ??
    hostInfo?.baseUrl ??
    "";
  const hostConnectUrlUsesMdns = hostConnectUrl.includes(".local");

  const buildCurrentDiagnosticsBundle = useCallback(() => {
    return buildDiagnosticsBundleJson({
      anyActiveRuns: props.anyActiveRuns,
      canReloadWorkspace: props.canReloadWorkspace,
      clientConnected: props.clientConnected,
      developerMode: props.developerMode,
      hostConnectUrl,
      hostConnectUrlUsesMdns,
      hostInfo,
      micxServerStatus: props.micxServerStatus,
      micxServerUrl: props.micxServerUrl,
      runtimeWorkspaceId: props.runtimeWorkspaceId,
    });
  }, [
    hostConnectUrl,
    hostConnectUrlUsesMdns,
    hostInfo,
    props.anyActiveRuns,
    props.canReloadWorkspace,
    props.clientConnected,
    props.developerMode,
    props.micxServerSettings.hostToken,
    props.micxServerSettings.token,
    props.micxServerSettings.urlOverride,
    props.micxServerStatus,
    props.micxServerUrl,
    props.runtimeWorkspaceId,
  ]);

  useEffect(() => {
    let cancelled = false;
    void buildCurrentDiagnosticsBundle().then((json) => {
      if (!cancelled) {
        setDiagnosticsBundleJson(json);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [buildCurrentDiagnosticsBundle]);

  const handleCopy = async (value: string, field: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      dispatchLocal({ type: "copyingField", field });
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        dispatchLocal({ type: "copyingField", field: null });
        copyTimeoutRef.current = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  const handleCopyDiagnostics = async (_value: string, field: string) => {
    const json = await buildCurrentDiagnosticsBundle();
    setDiagnosticsBundleJson(json);
    await handleCopy(json, field);
  };

  const handleTestConnection = async () => {
    if (micxTestState === "testing") return;
    const next = buildMicxSettings();
    props.updateMicxServerSettings(next);
    dispatchLocal({
      type: "testState",
      testState: "testing",
      testMessage: null,
    });
    try {
      const ok = await props.testMicxServerConnection(next);
      dispatchLocal({
        type: "testState",
        testState: ok ? "success" : "error",
        testMessage: ok
          ? t("config.connection_successful")
          : t("config.connection_failed"),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("config.connection_failed_check");
      dispatchLocal({
        type: "testState",
        testState: "error",
        testMessage: message,
      });
    }
  };

  return (
    <section className="space-y-6 max-w-3xl w-full">
      <ConfigWorkspaceSummary runtimeWorkspaceId={props.runtimeWorkspaceId} />
      <ConfigEngineReloadSection
        anyActiveRuns={props.anyActiveRuns}
        reloadBusy={props.reloadBusy}
        reloadAvailabilityReason={reloadAvailabilityReason}
        reloadButtonTone={reloadButtonTone}
        reloadButtonDisabled={reloadButtonDisabled}
        reloadButtonLabel={reloadButtonLabel}
        onReload={props.reloadWorkspaceEngine}
      />
      {props.developerMode ? (
        <ConfigDiagnosticsSection
          busy={props.busy}
          diagnosticsBundleJson={diagnosticsBundleJson}
          copyingField={copyingField}
          onCopy={handleCopyDiagnostics}
        />
      ) : null}
      {hostInfo ? (
        <ConfigServerSharingSection
          hostInfo={hostInfo}
          hostConnectUrl={hostConnectUrl}
          hostRemoteAccessEnabled={hostRemoteAccessEnabled}
          hostConnectUrlUsesMdns={hostConnectUrlUsesMdns}
          hostStatusLabel={hostStatusLabel}
          hostStatusStyle={hostStatusStyle}
          tokenVisible={tokenVisible}
          copyingField={copyingField}
          onCopy={handleCopy}
          onToggleToken={(key) => dispatchLocal({ type: "toggleToken", key })}
        />
      ) : null}
      <ConfigServerConnectionSection
        busy={props.busy}
        micxUrl={micxUrl}
        micxToken={micxToken}
        tokenVisible={tokenVisible.micx}
        micxStatusLabel={micxStatusLabel}
        micxStatusStyle={micxStatusStyle}
        resolvedWorkspaceUrl={resolvedWorkspaceUrl}
        resolvedWorkspaceId={resolvedWorkspaceId}
        micxTestState={micxTestState}
        micxTestMessage={micxTestMessage}
        hasMicxChanges={hasMicxChanges}
        onUrlChange={(url) => dispatchLocal({ type: "url", url })}
        onTokenChange={(token) => dispatchLocal({ type: "token", token })}
        onToggleToken={() => dispatchLocal({ type: "toggleToken", key: "micx" })}
        onTestConnection={handleTestConnection}
        onSave={() => props.updateMicxServerSettings(buildMicxSettings())}
        onReset={props.resetMicxServerSettings}
      />
      {!isDesktopRuntime() ? <div className="text-xs text-gray-9">{t("config.desktop_only_hint")}</div> : null}
    </section>
  );
}
