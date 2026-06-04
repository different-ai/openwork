/** @jsxImportSource react */
import { RefreshCcw } from "lucide-react";

import type { OpenworkServerInfo } from "../../../../app/lib/desktop";
import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import type { OpenworkTestState, TokenVisibilityKey } from "./config-view-state";

export function ConfigWorkspaceSummary(props: { runtimeWorkspaceId: string | null }) {
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

export function ConfigEngineReloadSection(props: {
  anyActiveRuns: boolean;
  reloadBusy: boolean;
  reloadAvailabilityReason: string | null;
  reloadButtonTone: "destructive" | "secondary";
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
          {props.reloadAvailabilityReason ? <div className="text-[11px] text-gray-9">{props.reloadAvailabilityReason}</div> : null}
        </div>
        <Button variant={props.reloadButtonTone} size="sm" className="shrink-0" onClick={props.onReload} disabled={props.reloadButtonDisabled}>
          <RefreshCcw size={14} className={props.reloadBusy ? "animate-spin" : ""} />
          {props.reloadButtonLabel}
        </Button>
      </div>
    </div>
  );
}

export function ConfigDiagnosticsSection(props: {
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
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => void props.onCopy(props.diagnosticsBundleJson, "debug-bundle")} disabled={props.busy}>
          {props.copyingField === "debug-bundle" ? t("config.copied") : t("config.copy")}
        </Button>
      </div>
      <pre className="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1/20 border border-gray-6 rounded-xl p-3">
        {props.diagnosticsBundleJson}
      </pre>
    </div>
  );
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
        <Button variant="outline" size="sm" onClick={props.toggle} disabled={!props.tokenValue}>
          {props.visible ? t("common.hide") : t("common.show")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => props.onCopy(props.tokenValue ?? "", props.copyKey)} disabled={!props.tokenValue}>
          {props.copyingField === props.copyKey ? t("config.copied") : t("config.copy")}
        </Button>
      </div>
    </div>
  );
}

export function ConfigServerSharingSection(props: {
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
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => props.onCopy(props.hostConnectUrl, "host-url")} disabled={!props.hostConnectUrl}>
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

export function ConfigServerConnectionSection(props: {
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
            <Button variant="outline" className="shrink-0" onClick={props.onToggleToken} disabled={props.busy}>
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
        <Button variant="outline" onClick={() => void props.onTestConnection()} disabled={props.busy || props.openworkTestState === "testing"}>{props.openworkTestState === "testing" ? t("config.testing") : t("config.test_connection")}</Button>
        <Button onClick={props.onSave} disabled={props.busy || !props.hasOpenworkChanges}>{t("common.save")}</Button>
        <Button variant="outline" onClick={props.onReset} disabled={props.busy}>{t("common.reset")}</Button>
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

export function ConfigMessagingIdentitiesSection() {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
      <div className="text-sm font-medium text-gray-12">{t("config.messaging_identities_title")}</div>
      <div className="text-xs text-gray-10">{t("config.messaging_identities_desc")}</div>
    </div>
  );
}
