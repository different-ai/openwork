/** @jsxImportSource react */
import { useEffect, useMemo, useReducer, useRef } from "react";
import { RefreshCcw } from "lucide-react";

import { readDevLogs } from "../../../../app/lib/dev-log";
import { readPerfLogs } from "../../../../app/lib/perf-log";
import {
  buildOpenworkWorkspaceBaseUrl,
  parseOpenworkWorkspaceIdFromUrl,
  type OpenworkServerSettings,
  type OpenworkServerStatus,
} from "../../../../app/lib/openwork-server";
import type { OpenworkServerInfo } from "../../../../app/lib/desktop";
import { isDesktopRuntime } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";

export type ConfigViewProps = {
  busy: boolean;
  clientConnected: boolean;
  anyActiveRuns: boolean;

  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerHostInfo: OpenworkServerInfo | null;
  runtimeWorkspaceId: string | null;

  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  resetOpenworkServerSettings: () => void;
  testOpenworkServerConnection: (
    next: OpenworkServerSettings,
  ) => Promise<boolean>;

  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;

  developerMode: boolean;
};

type OpenworkTestState = "idle" | "testing" | "success" | "error";

type OpenworkConnectionState = {
  url: string;
  token: string;
  testState: OpenworkTestState;
  testMessage: string | null;
};

type TokenVisibilityKey = "openwork" | "client" | "owner" | "host";

type ConfigLocalState = {
  openworkConnection: OpenworkConnectionState;
  tokenVisible: Record<TokenVisibilityKey, boolean>;
  copyingField: string | null;
};

type ConfigLocalAction =
  | { type: "serverSettings"; connection: OpenworkConnectionState }
  | { type: "url"; url: string }
  | { type: "token"; token: string }
  | { type: "testState"; testState: OpenworkTestState; testMessage: string | null }
  | { type: "toggleToken"; key: TokenVisibilityKey }
  | { type: "copyingField"; field: string | null };

const initialConfigLocalState: ConfigLocalState = {
  openworkConnection: {
    url: "",
    token: "",
    testState: "idle",
    testMessage: null,
  },
  tokenVisible: {
    openwork: false,
    client: false,
    owner: false,
    host: false,
  },
  copyingField: null,
};

function configLocalReducer(
  state: ConfigLocalState,
  action: ConfigLocalAction,
): ConfigLocalState {
  switch (action.type) {
    case "serverSettings":
      return { ...state, openworkConnection: action.connection };
    case "url":
      return {
        ...state,
        openworkConnection: {
          ...state.openworkConnection,
          url: action.url,
          testState: "idle",
          testMessage: null,
        },
      };
    case "token":
      return {
        ...state,
        openworkConnection: {
          ...state.openworkConnection,
          token: action.token,
          testState: "idle",
          testMessage: null,
        },
      };
    case "testState":
      return {
        ...state,
        openworkConnection: {
          ...state.openworkConnection,
          testState: action.testState,
          testMessage: action.testMessage,
        },
      };
    case "toggleToken":
      return {
        ...state,
        tokenVisible: {
          ...state.tokenVisible,
          [action.key]: !state.tokenVisible[action.key],
        },
      };
    case "copyingField":
      return { ...state, copyingField: action.field };
  }
}

function TokenRow(props: {
  label: string;
  tokenValue: string | null | undefined;
  hint: string;
  visible: boolean;
  toggle: () => void;
  copyKey: string;
  copyingField: string | null;
  onCopy: (value: string, field: string) => void | Promise<void>;
}) {
  return (
    <div className="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-gray-11">{props.label}</div>
        <div className="text-xs text-gray-7 font-mono truncate">
          {props.visible ? props.tokenValue || "—" : props.tokenValue ? "••••••••••••" : "—"}
        </div>
        <div className="text-[11px] text-gray-8 mt-1">{props.hint}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          className="text-xs h-8 py-0 px-3"
          onClick={props.toggle}
          disabled={!props.tokenValue}
        >
          {props.visible ? t("common.hide") : t("common.show")}
        </Button>
        <Button
          variant="outline"
          className="text-xs h-8 py-0 px-3"
          onClick={() => props.onCopy(props.tokenValue ?? "", props.copyKey)}
          disabled={!props.tokenValue}
        >
          {props.copyingField === props.copyKey ? t("config.copied") : t("config.copy")}
        </Button>
      </div>
    </div>
  );
}

function buildDiagnosticsBundleJson(input: {
  anyActiveRuns: boolean;
  canReloadWorkspace: boolean;
  clientConnected: boolean;
  developerMode: boolean;
  hostConnectUrl: string;
  hostConnectUrlUsesMdns: boolean;
  hostInfo: OpenworkServerInfo | null;
  openworkServerSettings: OpenworkServerSettings;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  runtimeWorkspaceId: string | null;
}) {
  const urlOverride = input.openworkServerSettings.urlOverride?.trim() ?? "";
  const token = input.openworkServerSettings.token?.trim() ?? "";
  const developerLogs = input.developerMode ? readDevLogs(80) : [];
  const perfLogs = input.developerMode ? readPerfLogs(80) : [];
  const bundle = {
    capturedAt: new Date().toISOString(),
    runtime: {
      tauri: isDesktopRuntime(),
      developerMode: input.developerMode,
    },
    workspace: {
      runtimeWorkspaceId: input.runtimeWorkspaceId ?? null,
      clientConnected: input.clientConnected,
      anyActiveRuns: input.anyActiveRuns,
    },
    openworkServer: {
      status: input.openworkServerStatus,
      url: input.openworkServerUrl,
      settings: {
        urlOverride: urlOverride || null,
        tokenPresent: Boolean(token),
      },
      host: input.hostInfo
        ? {
            running: Boolean(input.hostInfo.running),
            remoteAccessEnabled: input.hostInfo.remoteAccessEnabled,
            baseUrl: input.hostInfo.baseUrl ?? null,
            connectUrl: input.hostInfo.connectUrl ?? null,
            mdnsUrl: input.hostInfo.mdnsUrl ?? null,
            lanUrl: input.hostInfo.lanUrl ?? null,
          }
        : null,
    },
    reload: {
      canReloadWorkspace: input.canReloadWorkspace,
    },
    sharing: {
      hostConnectUrl: input.hostConnectUrl || null,
      hostConnectUrlUsesMdns: input.hostConnectUrlUsesMdns,
    },
    performance: {
      retainedEntries: perfLogs.length,
      recent: perfLogs,
    },
    developerLogs: {
      retainedEntries: developerLogs.length,
      recent: developerLogs,
    },
  };
  return JSON.stringify(bundle, null, 2);
}

export function ConfigView(props: ConfigViewProps) {
  const [localState, dispatchLocal] = useReducer(
    configLocalReducer,
    initialConfigLocalState,
  );
  const { openworkConnection, tokenVisible, copyingField } = localState;
  const openworkUrl = openworkConnection.url;
  const openworkToken = openworkConnection.token;
  const openworkTestState = openworkConnection.testState;
  const openworkTestMessage = openworkConnection.testMessage;
  const copyTimeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    dispatchLocal({
      type: "serverSettings",
      connection: {
        url: props.openworkServerSettings.urlOverride ?? "",
        token: props.openworkServerSettings.token ?? "",
        testState: "idle",
        testMessage: null,
      },
    });
  }, [props.openworkServerSettings]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== undefined) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

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

  const reloadAvailabilityReason = (() => {
    if (!props.clientConnected) return t("config.reload_connect_hint");
    if (!props.canReloadWorkspace) return t("config.reload_availability_hint");
    return null;
  })();

  const reloadButtonLabel = props.reloadBusy
    ? t("config.reloading")
    : t("config.reload_engine");
  const reloadButtonTone: "danger" | "secondary" = props.anyActiveRuns
    ? "danger"
    : "secondary";
  const reloadButtonDisabled =
    props.reloadBusy || Boolean(reloadAvailabilityReason);

  const buildOpenworkSettings = (): OpenworkServerSettings => ({
    ...props.openworkServerSettings,
    urlOverride: openworkUrl.trim() || undefined,
    token: openworkToken.trim() || undefined,
  });

  const hasOpenworkChanges = (() => {
    const currentUrl = props.openworkServerSettings.urlOverride ?? "";
    const currentToken = props.openworkServerSettings.token ?? "";
    return (
      openworkUrl.trim() !== currentUrl || openworkToken.trim() !== currentToken
    );
  })();

  const resolvedWorkspaceId = (() => {
    const explicitId = props.runtimeWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseOpenworkWorkspaceIdFromUrl(openworkUrl) ?? "";
  })();

  const resolvedWorkspaceUrl = (() => {
    const baseUrl = openworkUrl.trim();
    if (!baseUrl) return "";
    return buildOpenworkWorkspaceBaseUrl(baseUrl, resolvedWorkspaceId) ?? baseUrl;
  })();

  const hostInfo = props.openworkServerHostInfo;
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

  const diagnosticsBundleJson = useMemo(() => {
    return buildDiagnosticsBundleJson({
      anyActiveRuns: props.anyActiveRuns,
      canReloadWorkspace: props.canReloadWorkspace,
      clientConnected: props.clientConnected,
      developerMode: props.developerMode,
      hostConnectUrl,
      hostConnectUrlUsesMdns,
      hostInfo,
      openworkServerSettings: props.openworkServerSettings,
      openworkServerStatus: props.openworkServerStatus,
      openworkServerUrl: props.openworkServerUrl,
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
    props.openworkServerSettings.token,
    props.openworkServerSettings.urlOverride,
    props.openworkServerStatus,
    props.openworkServerUrl,
    props.runtimeWorkspaceId,
  ]);

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

  const handleTestConnection = async () => {
    if (openworkTestState === "testing") return;
    const next = buildOpenworkSettings();
    props.updateOpenworkServerSettings(next);
    dispatchLocal({
      type: "testState",
      testState: "testing",
      testMessage: null,
    });
    try {
      const ok = await props.testOpenworkServerConnection(next);
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
        reloadError={props.reloadError}
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
          onCopy={handleCopy}
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
        openworkUrl={openworkUrl}
        openworkToken={openworkToken}
        tokenVisible={tokenVisible.openwork}
        openworkStatusLabel={openworkStatusLabel}
        openworkStatusStyle={openworkStatusStyle}
        resolvedWorkspaceUrl={resolvedWorkspaceUrl}
        resolvedWorkspaceId={resolvedWorkspaceId}
        openworkTestState={openworkTestState}
        openworkTestMessage={openworkTestMessage}
        hasOpenworkChanges={hasOpenworkChanges}
        onUrlChange={(url) => dispatchLocal({ type: "url", url })}
        onTokenChange={(token) => dispatchLocal({ type: "token", token })}
        onToggleToken={() => dispatchLocal({ type: "toggleToken", key: "openwork" })}
        onTestConnection={handleTestConnection}
        onSave={() => props.updateOpenworkServerSettings(buildOpenworkSettings())}
        onReset={props.resetOpenworkServerSettings}
      />
      <ConfigMessagingIdentitiesSection />
      {!isDesktopRuntime() ? <div className="text-xs text-gray-9">{t("config.desktop_only_hint")}</div> : null}
    </section>
  );
}

function ConfigWorkspaceSummary(props: { runtimeWorkspaceId: string | null }) {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
      <div className="text-sm font-medium text-gray-12">{t("config.workspace_config_title")}</div>
      <div className="text-xs text-gray-10">{t("config.workspace_config_desc")}</div>
      {props.runtimeWorkspaceId ? (
        <div className="text-[11px] text-gray-7 font-mono truncate">
          {t("config.workspace_id_prefix")}
          {props.runtimeWorkspaceId}
        </div>
      ) : null}
    </div>
  );
}

function ConfigEngineReloadSection(props: {
  anyActiveRuns: boolean;
  reloadBusy: boolean;
  reloadError: string | null;
  reloadAvailabilityReason: string | null;
  reloadButtonTone: "danger" | "secondary";
  reloadButtonDisabled: boolean;
  reloadButtonLabel: string;
  onReload: () => Promise<void>;
}) {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
      <div>
        <div className="text-sm font-medium text-gray-12">{t("config.engine_reload_title")}</div>
        <div className="text-xs text-gray-10">{t("config.engine_reload_desc")}</div>
      </div>
      <div className="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-sm text-gray-12">{t("config.reload_now_title")}</div>
          <div className="text-xs text-gray-7">{t("config.reload_now_desc")}</div>
          {props.anyActiveRuns ? <div className="text-[11px] text-amber-11">{t("config.reload_active_tasks_warning")}</div> : null}
          {props.reloadError ? <div className="text-[11px] text-red-11">{props.reloadError}</div> : null}
          {props.reloadAvailabilityReason ? <div className="text-[11px] text-gray-9">{props.reloadAvailabilityReason}</div> : null}
        </div>
        <Button variant={props.reloadButtonTone} className="text-xs h-8 py-0 px-3 shrink-0" onClick={props.onReload} disabled={props.reloadButtonDisabled}>
          <RefreshCcw size={14} className={props.reloadBusy ? "animate-spin" : ""} />
          {props.reloadButtonLabel}
        </Button>
      </div>
    </div>
  );
}

function ConfigDiagnosticsSection(props: {
  busy: boolean;
  diagnosticsBundleJson: string;
  copyingField: string | null;
  onCopy: (value: string, field: string) => void | Promise<void>;
}) {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-medium text-gray-12">{t("config.diagnostics_title")}</div>
          <div className="text-xs text-gray-10">{t("config.diagnostics_desc")}</div>
        </div>
        <Button variant="secondary" className="text-xs h-8 py-0 px-3 shrink-0" onClick={() => void props.onCopy(props.diagnosticsBundleJson, "debug-bundle")} disabled={props.busy}>
          {props.copyingField === "debug-bundle" ? t("config.copied") : t("config.copy")}
        </Button>
      </div>
      <pre className="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1/20 border border-gray-6 rounded-xl p-3">
        {props.diagnosticsBundleJson}
      </pre>
    </div>
  );
}

function ConfigServerSharingSection(props: {
  hostInfo: OpenworkServerInfo;
  hostConnectUrl: string;
  hostRemoteAccessEnabled: boolean;
  hostConnectUrlUsesMdns: boolean;
  hostStatusLabel: string;
  hostStatusStyle: string;
  tokenVisible: Record<TokenVisibilityKey, boolean>;
  copyingField: string | null;
  onCopy: (value: string, field: string) => void | Promise<void>;
  onToggleToken: (key: TokenVisibilityKey) => void;
}) {
  const hostUrlHint = !props.hostRemoteAccessEnabled
    ? t("config.remote_access_off_hint")
    : props.hostConnectUrlUsesMdns
      ? t("config.mdns_hint")
      : t("config.local_ip_hint");
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-medium text-gray-12">{t("config.server_sharing_title")}</div>
          <div className="text-xs text-gray-10">{t("config.server_sharing_desc")}</div>
        </div>
        <div className={`text-xs px-2 py-1 rounded-full border ${props.hostStatusStyle}`}>{props.hostStatusLabel}</div>
      </div>
      <div className="grid gap-3">
        <div className="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium text-gray-11">{t("config.server_url_label")}</div>
            <div className="text-xs text-gray-7 font-mono truncate">{props.hostConnectUrl || t("config.starting_server")}</div>
            {props.hostConnectUrl ? <div className="text-[11px] text-gray-8 mt-1">{hostUrlHint}</div> : null}
          </div>
          <Button variant="outline" className="text-xs h-8 py-0 px-3 shrink-0" onClick={() => props.onCopy(props.hostConnectUrl, "host-url")} disabled={!props.hostConnectUrl}>
            {props.copyingField === "host-url" ? t("config.copied") : t("config.copy")}
          </Button>
        </div>
        <TokenRow label={t("config.collaborator_token_label")} tokenValue={props.hostInfo.clientToken} hint={props.hostRemoteAccessEnabled ? t("config.collaborator_token_remote_hint") : t("config.collaborator_token_disabled_hint")} visible={props.tokenVisible.client} toggle={() => props.onToggleToken("client")} copyKey="client-token" copyingField={props.copyingField} onCopy={props.onCopy} />
        <TokenRow label={t("config.owner_token_label")} tokenValue={props.hostInfo.ownerToken} hint={props.hostRemoteAccessEnabled ? t("config.owner_token_remote_hint") : t("config.owner_token_disabled_hint")} visible={props.tokenVisible.owner} toggle={() => props.onToggleToken("owner")} copyKey="owner-token" copyingField={props.copyingField} onCopy={props.onCopy} />
        <TokenRow label={t("config.host_admin_token_label")} tokenValue={props.hostInfo.hostToken} hint={t("config.host_admin_token_hint")} visible={props.tokenVisible.host} toggle={() => props.onToggleToken("host")} copyKey="host-token" copyingField={props.copyingField} onCopy={props.onCopy} />
      </div>
      <div className="text-xs text-gray-9">{t("config.server_sharing_menu_hint")}</div>
    </div>
  );
}

function ConfigServerConnectionSection(props: {
  busy: boolean;
  openworkUrl: string;
  openworkToken: string;
  tokenVisible: boolean;
  openworkStatusLabel: string;
  openworkStatusStyle: string;
  resolvedWorkspaceUrl: string;
  resolvedWorkspaceId: string;
  openworkTestState: OpenworkTestState;
  openworkTestMessage: string | null;
  hasOpenworkChanges: boolean;
  onUrlChange: (url: string) => void;
  onTokenChange: (token: string) => void;
  onToggleToken: () => void;
  onTestConnection: () => Promise<void>;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-medium text-gray-12">{t("config.server_section_title")}</div>
          <div className="text-xs text-gray-10">{t("config.server_section_desc")}</div>
        </div>
        <div className={`text-xs px-2 py-1 rounded-full border ${props.openworkStatusStyle}`}>{props.openworkStatusLabel}</div>
      </div>
      <div className="grid gap-3">
        <TextInput label={t("config.server_url_input_label")} value={props.openworkUrl} onChange={(event) => props.onUrlChange(event.currentTarget.value)} placeholder="http://127.0.0.1:<port>" hint={t("config.server_url_hint")} disabled={props.busy} />
        <label className="block">
          <div className="mb-1 text-xs font-medium text-gray-11">{t("config.token_label")}</div>
          <div className="flex items-center gap-2">
            <input type={props.tokenVisible ? "text" : "password"} value={props.openworkToken} onChange={(event) => props.onTokenChange(event.currentTarget.value)} placeholder={t("config.token_placeholder")} disabled={props.busy} className="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20" />
            <Button variant="outline" className="text-xs h-9 px-3 shrink-0" onClick={props.onToggleToken} disabled={props.busy}>
              {props.tokenVisible ? t("common.hide") : t("common.show")}
            </Button>
          </div>
          <div className="mt-1 text-xs text-gray-10">{t("config.token_hint")}</div>
        </label>
      </div>
      <div className="space-y-1">
        <div className="text-[11px] text-gray-7 font-mono truncate">{t("config.resolved_worker_url")}{props.resolvedWorkspaceUrl || t("config.not_set")}</div>
        <div className="text-[11px] text-gray-8 font-mono truncate">{t("config.worker_id")}{props.resolvedWorkspaceId || t("config.unavailable")}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => void props.onTestConnection()} disabled={props.busy || props.openworkTestState === "testing"}>{props.openworkTestState === "testing" ? t("config.testing") : t("config.test_connection")}</Button>
        <Button variant="outline" onClick={props.onSave} disabled={props.busy || !props.hasOpenworkChanges}>{t("common.save")}</Button>
        <Button variant="ghost" onClick={props.onReset} disabled={props.busy}>{t("common.reset")}</Button>
      </div>
      {props.openworkTestState !== "idle" ? <ConfigConnectionTestStatus state={props.openworkTestState} message={props.openworkTestMessage} /> : null}
      {props.openworkStatusLabel !== t("config.status_connected") ? <div className="text-xs text-gray-9">{t("config.server_needed_hint")}</div> : null}
    </div>
  );
}

function ConfigConnectionTestStatus(props: { state: OpenworkTestState; message: string | null }) {
  return (
    <div className={`text-xs ${props.state === "success" ? "text-green-11" : props.state === "error" ? "text-red-11" : "text-gray-9"}`} role="status" aria-live="polite">
      {props.state === "testing" ? t("config.testing_connection") : (props.message ?? t("config.connection_status_updated"))}
    </div>
  );
}

function ConfigMessagingIdentitiesSection() {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
      <div className="text-sm font-medium text-gray-12">{t("config.messaging_identities_title")}</div>
      <div className="text-xs text-gray-10">{t("config.messaging_identities_desc")}</div>
    </div>
  );
}
