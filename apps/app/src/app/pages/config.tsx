import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { readDevLogs } from "../lib/dev-log";
import { isTauriRuntime } from "../utils";
import { readPerfLogs } from "../lib/perf-log";
import { t, td } from "../../i18n";

import Button from "../components/button";
import TextInput from "../components/text-input";

import { RefreshCcw } from "lucide-solid";

import { buildOpenworkWorkspaceBaseUrl, parseOpenworkWorkspaceIdFromUrl } from "../lib/openwork-server";
import type { OpenworkServerSettings, OpenworkServerStatus } from "../lib/openwork-server";
import type { OpenworkServerInfo } from "../lib/tauri";

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
  testOpenworkServerConnection: (next: OpenworkServerSettings) => Promise<boolean>;

  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;

  developerMode: boolean;
};

export default function ConfigView(props: ConfigViewProps) {
  const [openworkUrl, setOpenworkUrl] = createSignal("");
  const [openworkToken, setOpenworkToken] = createSignal("");
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);
  const [openworkTestState, setOpenworkTestState] = createSignal<"idle" | "testing" | "success" | "error">("idle");
  const [openworkTestMessage, setOpenworkTestMessage] = createSignal<string | null>(null);
  const [clientTokenVisible, setClientTokenVisible] = createSignal(false);
  const [ownerTokenVisible, setOwnerTokenVisible] = createSignal(false);
  const [hostTokenVisible, setHostTokenVisible] = createSignal(false);
  const [copyingField, setCopyingField] = createSignal<string | null>(null);
  let copyTimeout: number | undefined;

  createEffect(() => {
    setOpenworkUrl(props.openworkServerSettings.urlOverride ?? "");
    setOpenworkToken(props.openworkServerSettings.token ?? "");
  });

  createEffect(() => {
    openworkUrl();
    openworkToken();
    setOpenworkTestState("idle");
    setOpenworkTestMessage(null);
  });

  const openworkStatusLabel = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return td("config.status_connected", "Connected");
      case "limited":
        return td("config.status_limited", "Limited");
      default:
        return td("config.status_not_connected", "Not connected");
    }
  });

  const openworkStatusStyle = createMemo(() => {
    switch (props.openworkServerStatus) {
      case "connected":
        return "bg-green-7/10 text-green-11 border-green-7/20";
      case "limited":
        return "bg-amber-7/10 text-amber-11 border-amber-7/20";
      default:
        return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    }
  });

  const reloadAvailabilityReason = createMemo(() => {
    if (!props.clientConnected) return td("config.reload_connect_hint", "Connect to this worker to reload.");
    if (!props.canReloadWorkspace) {
      return td("config.reload_availability_hint", "Reloading is only available for local workers or connected OpenWork servers.");
    }
    return null;
  });

  const reloadButtonLabel = createMemo(() => (props.reloadBusy ? td("config.reloading", "Reloading...") : td("config.reload_engine", "Reload engine")));
  const reloadButtonTone = createMemo(() => (props.anyActiveRuns ? "danger" : "secondary"));
  const reloadButtonDisabled = createMemo(() => props.reloadBusy || Boolean(reloadAvailabilityReason()));

  const buildOpenworkSettings = () => ({
    ...props.openworkServerSettings,
    urlOverride: openworkUrl().trim() || undefined,
    token: openworkToken().trim() || undefined,
  });

  const hasOpenworkChanges = createMemo(() => {
    const currentUrl = props.openworkServerSettings.urlOverride ?? "";
    const currentToken = props.openworkServerSettings.token ?? "";
    return openworkUrl().trim() !== currentUrl || openworkToken().trim() !== currentToken;
  });

  const resolvedWorkspaceId = createMemo(() => {
    const explicitId = props.runtimeWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseOpenworkWorkspaceIdFromUrl(openworkUrl()) ?? "";
  });

  const resolvedWorkspaceUrl = createMemo(() => {
    const baseUrl = openworkUrl().trim();
    if (!baseUrl) return "";
    return buildOpenworkWorkspaceBaseUrl(baseUrl, resolvedWorkspaceId()) ?? baseUrl;
  });

  const hostInfo = createMemo(() => props.openworkServerHostInfo);
  const hostRemoteAccessEnabled = createMemo(
    () => hostInfo()?.remoteAccessEnabled === true,
  );
  const hostStatusLabel = createMemo(() => {
    if (!hostInfo()?.running) return td("config.host_offline", "Offline");
    return hostRemoteAccessEnabled() ? td("config.host_remote_enabled", "Remote enabled") : td("config.host_local_only", "Local only");
  });
  const hostStatusStyle = createMemo(() => {
    if (!hostInfo()?.running) return "bg-gray-4/60 text-gray-11 border-gray-7/50";
    return "bg-green-7/10 text-green-11 border-green-7/20";
  });
  const hostConnectUrl = createMemo(() => {
    const info = hostInfo();
    return info?.connectUrl ?? info?.mdnsUrl ?? info?.lanUrl ?? info?.baseUrl ?? "";
  });
  const hostConnectUrlUsesMdns = createMemo(() => hostConnectUrl().includes(".local"));

  const diagnosticsBundle = createMemo(() => {
    const urlOverride = props.openworkServerSettings.urlOverride?.trim() ?? "";
    const token = props.openworkServerSettings.token?.trim() ?? "";
    const host = hostInfo();
    const developerLogs = props.developerMode ? readDevLogs(80) : [];
    const perfLogs = props.developerMode ? readPerfLogs(80) : [];
    return {
      capturedAt: new Date().toISOString(),
      runtime: {
        tauri: isTauriRuntime(),
        developerMode: props.developerMode,
      },
      workspace: {
        runtimeWorkspaceId: props.runtimeWorkspaceId ?? null,
        clientConnected: props.clientConnected,
        anyActiveRuns: props.anyActiveRuns,
      },
      openworkServer: {
        status: props.openworkServerStatus,
        url: props.openworkServerUrl,
        settings: {
          urlOverride: urlOverride || null,
          tokenPresent: Boolean(token),
        },
        host: host
          ? {
              running: Boolean(host.running),
              remoteAccessEnabled: host.remoteAccessEnabled,
              baseUrl: host.baseUrl ?? null,
              connectUrl: host.connectUrl ?? null,
              mdnsUrl: host.mdnsUrl ?? null,
              lanUrl: host.lanUrl ?? null,
            }
          : null,
      },
      reload: {
        canReloadWorkspace: props.canReloadWorkspace,
      },
      sharing: {
        hostConnectUrl: hostConnectUrl() || null,
        hostConnectUrlUsesMdns: hostConnectUrlUsesMdns(),
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
  });

  const diagnosticsBundleJson = createMemo(() => JSON.stringify(diagnosticsBundle(), null, 2));

  const handleCopy = async (value: string, field: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyingField(field);
      if (copyTimeout !== undefined) {
        window.clearTimeout(copyTimeout);
      }
      copyTimeout = window.setTimeout(() => {
        setCopyingField(null);
        copyTimeout = undefined;
      }, 2000);
    } catch {
      // ignore
    }
  };

  onCleanup(() => {
    if (copyTimeout !== undefined) {
      window.clearTimeout(copyTimeout);
    }
  });

  return (
    <section class="space-y-6">
      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
        <div class="text-sm font-medium text-gray-12">{td("config.workspace_config_title", "Workspace config")}</div>
        <div class="text-xs text-gray-10">
          {td("config.workspace_config_desc", "These settings affect the selected workspace. Runtime-only actions apply to whichever workspace is currently connected.")}
        </div>
        <Show when={props.runtimeWorkspaceId}>
          <div class="text-[11px] text-gray-7 font-mono truncate">
            {td("config.workspace_id_prefix", "Workspace:")}{props.runtimeWorkspaceId}
          </div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{td("config.engine_reload_title", "Engine reload")}</div>
          <div class="text-xs text-gray-10">{td("config.engine_reload_desc", "Restart the OpenCode server for this workspace.")}</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">{td("config.reload_now_title", "Reload now")}</div>
            <div class="text-xs text-gray-7">{td("config.reload_now_desc", "Applies config updates and reconnects your session.")}</div>
            <Show when={props.anyActiveRuns}>
              <div class="text-[11px] text-amber-11">{td("config.reload_active_tasks_warning", "Reloading will stop active tasks.")}</div>
            </Show>
            <Show when={props.reloadError}>
              <div class="text-[11px] text-red-11">{props.reloadError}</div>
            </Show>
            <Show when={reloadAvailabilityReason()}>
              <div class="text-[11px] text-gray-9">{reloadAvailabilityReason()}</div>
            </Show>
          </div>
          <Button
            variant={reloadButtonTone()}
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={props.reloadWorkspaceEngine}
            disabled={reloadButtonDisabled()}
          >
            <RefreshCcw size={14} class={props.reloadBusy ? "animate-spin" : ""} />
            {reloadButtonLabel()}
          </Button>
        </div>

      </div>

      <Show when={props.developerMode}>
        <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="text-sm font-medium text-gray-12">{td("config.diagnostics_title", "Diagnostics bundle")}</div>
              <div class="text-xs text-gray-10">{td("config.diagnostics_desc", "Copy sanitized runtime state for debugging.")}</div>
            </div>
            <Button
              variant="secondary"
              class="text-xs h-8 py-0 px-3 shrink-0"
              onClick={() => void handleCopy(diagnosticsBundleJson(), "debug-bundle")}
              disabled={props.busy}
            >
              {copyingField() === "debug-bundle" ? td("config.copied", "Copied") : td("config.copy", "Copy")}
            </Button>
          </div>
          <pre class="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1/20 border border-gray-6 rounded-xl p-3">
            {diagnosticsBundleJson()}
          </pre>
        </div>
      </Show>

      <Show when={hostInfo()}>
        <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="text-sm font-medium text-gray-12">{td("config.server_sharing_title", "OpenWork server sharing")}</div>
              <div class="text-xs text-gray-10">
                {td("config.server_sharing_desc", "Share these details with a trusted device. Keep the server on the same network for the fastest setup.")}
              </div>
            </div>
            <div class={`text-xs px-2 py-1 rounded-full border ${hostStatusStyle()}`}>
              {hostStatusLabel()}
            </div>
          </div>

          <div class="grid gap-3">
            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">{td("config.server_url_label", "OpenWork Server URL")}</div>
                <div class="text-xs text-gray-7 font-mono truncate">{hostConnectUrl() || td("config.starting_server", "Starting server…")}</div>
                <Show when={hostConnectUrl()}>
                  <div class="text-[11px] text-gray-8 mt-1">
                    {!hostRemoteAccessEnabled()
                      ? td("config.remote_access_off_hint", "Remote access is off. Use Share workspace to enable it before connecting from another machine.")
                      : hostConnectUrlUsesMdns()
                      ? td("config.mdns_hint", ".local names are easier to remember but may not resolve on all networks.")
                      : td("config.local_ip_hint", "Use your local IP on the same Wi-Fi for the fastest connection.")}
                  </div>
                </Show>
              </div>
              <Button
                variant="outline"
                class="text-xs h-8 py-0 px-3 shrink-0"
                onClick={() => handleCopy(hostConnectUrl(), "host-url")}
                disabled={!hostConnectUrl()}
              >
                {copyingField() === "host-url" ? td("config.copied", "Copied") : td("config.copy", "Copy")}
              </Button>
            </div>

            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">{td("config.collaborator_token_label", "Collaborator token")}</div>
                <div class="text-xs text-gray-7 font-mono truncate">
                  {clientTokenVisible()
                    ? hostInfo()?.clientToken || "—"
                    : hostInfo()?.clientToken
                      ? "••••••••••••"
                      : "—"}
                </div>
                <div class="text-[11px] text-gray-8 mt-1">
                  {hostRemoteAccessEnabled()
                    ? td("config.collaborator_token_remote_hint", "Routine remote access for phones or laptops connecting to this server.")
                    : td("config.collaborator_token_disabled_hint", "Stored in advance for remote sharing, but remote access is currently disabled.")}
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => setClientTokenVisible((prev) => !prev)}
                  disabled={!hostInfo()?.clientToken}
                >
                  {clientTokenVisible() ? td("common.hide", "Hide") : td("common.show", "Show")}
                </Button>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => handleCopy(hostInfo()?.clientToken ?? "", "client-token")}
                  disabled={!hostInfo()?.clientToken}
                >
                  {copyingField() === "client-token" ? td("config.copied", "Copied") : td("config.copy", "Copy")}
                </Button>
              </div>
            </div>

            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">{td("config.owner_token_label", "Owner token")}</div>
                <div class="text-xs text-gray-7 font-mono truncate">
                  {ownerTokenVisible()
                    ? hostInfo()?.ownerToken || "—"
                    : hostInfo()?.ownerToken
                      ? "••••••••••••"
                      : "—"}
                </div>
                <div class="text-[11px] text-gray-8 mt-1">
                  {hostRemoteAccessEnabled()
                    ? td("config.owner_token_remote_hint", "Use this when a remote client needs to answer permission prompts or take owner-only actions.")
                    : td("config.owner_token_disabled_hint", "Only relevant after you enable remote access for this worker.")}
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => setOwnerTokenVisible((prev) => !prev)}
                  disabled={!hostInfo()?.ownerToken}
                >
                  {ownerTokenVisible() ? td("common.hide", "Hide") : td("common.show", "Show")}
                </Button>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => handleCopy(hostInfo()?.ownerToken ?? "", "owner-token")}
                  disabled={!hostInfo()?.ownerToken}
                >
                  {copyingField() === "owner-token" ? td("config.copied", "Copied") : td("config.copy", "Copy")}
                </Button>
              </div>
            </div>

            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">{td("config.host_admin_token_label", "Host admin token")}</div>
                <div class="text-xs text-gray-7 font-mono truncate">
                  {hostTokenVisible()
                    ? hostInfo()?.hostToken || "—"
                    : hostInfo()?.hostToken
                      ? "••••••••••••"
                      : "—"}
                </div>
                <div class="text-[11px] text-gray-8 mt-1">{td("config.host_admin_token_hint", "Internal host-only token for approvals CLI and admin APIs. Do not use this in the remote app connect flow.")}</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => setHostTokenVisible((prev) => !prev)}
                  disabled={!hostInfo()?.hostToken}
                >
                  {hostTokenVisible() ? td("common.hide", "Hide") : td("common.show", "Show")}
                </Button>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => handleCopy(hostInfo()?.hostToken ?? "", "host-token")}
                  disabled={!hostInfo()?.hostToken}
                >
                  {copyingField() === "host-token" ? td("config.copied", "Copied") : td("config.copy", "Copy")}
                </Button>
              </div>
            </div>
          </div>

          <div class="text-xs text-gray-9">
            {td("config.server_sharing_menu_hint", "For per-workspace sharing links, use Share... in the workspace menu.")}
          </div>
        </div>
      </Show>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div class="text-sm font-medium text-gray-12">{td("config.server_section_title", "OpenWork server")}</div>
            <div class="text-xs text-gray-10">
              {td("config.server_section_desc", "Connect to an OpenWork server. Use the URL plus a collaborator or owner token from your server admin.")}
            </div>
          </div>
          <div class={`text-xs px-2 py-1 rounded-full border ${openworkStatusStyle()}`}>{openworkStatusLabel()}</div>
        </div>

        <div class="grid gap-3">
          <TextInput
            label={td("config.server_url_input_label", "OpenWork server URL")}
            value={openworkUrl()}
            onInput={(event) => setOpenworkUrl(event.currentTarget.value)}
            placeholder="http://127.0.0.1:<port>"
            hint={td("config.server_url_hint", "Use the URL shared by your OpenWork server. Local desktop workers reuse a persistent high port in the 48000-51000 range.")}
            disabled={props.busy}
          />

          <label class="block">
            <div class="mb-1 text-xs font-medium text-gray-11">{td("config.token_label", "Collaborator or owner token")}</div>
            <div class="flex items-center gap-2">
              <input
                type={openworkTokenVisible() ? "text" : "password"}
                value={openworkToken()}
                onInput={(event) => setOpenworkToken(event.currentTarget.value)}
                placeholder={td("config.token_placeholder", "Paste your token")}
                disabled={props.busy}
                class="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
              />
              <Button
                variant="outline"
                class="text-xs h-9 px-3 shrink-0"
                onClick={() => setOpenworkTokenVisible((prev) => !prev)}
                disabled={props.busy}
              >
                {openworkTokenVisible() ? td("common.hide", "Hide") : td("common.show", "Show")}
              </Button>
            </div>
            <div class="mt-1 text-xs text-gray-10">{td("config.token_hint", "Optional. Paste a collaborator token for routine access or an owner token when this client must answer permission prompts.")}</div>
          </label>
        </div>

        <div class="space-y-1">
          <div class="text-[11px] text-gray-7 font-mono truncate">{td("config.resolved_worker_url", "Resolved worker URL:")}{resolvedWorkspaceUrl() || td("config.not_set", "Not set")}</div>
          <div class="text-[11px] text-gray-8 font-mono truncate">{td("config.worker_id", "Worker ID:")}{resolvedWorkspaceId() || td("config.unavailable", "Unavailable")}</div>
        </div>

        <div class="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={async () => {
              if (openworkTestState() === "testing") return;
              const next = buildOpenworkSettings();
              props.updateOpenworkServerSettings(next);
              setOpenworkTestState("testing");
              setOpenworkTestMessage(null);
              try {
                const ok = await props.testOpenworkServerConnection(next);
                setOpenworkTestState(ok ? "success" : "error");
                setOpenworkTestMessage(
                  ok ? td("config.connection_successful", "Connection successful.") : td("config.connection_failed", "Connection failed."),
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : td("config.connection_failed_check", "Connection failed. Check the host URL and token.");
                setOpenworkTestState("error");
                setOpenworkTestMessage(message);
              }
            }}
            disabled={props.busy || openworkTestState() === "testing"}
          >
            {openworkTestState() === "testing" ? td("config.testing", "Testing...") : td("config.test_connection", "Test connection")}
          </Button>
          <Button
            variant="outline"
            onClick={() => props.updateOpenworkServerSettings(buildOpenworkSettings())}
            disabled={props.busy || !hasOpenworkChanges()}
          >
            {td("common.save", "Save")}
          </Button>
          <Button variant="ghost" onClick={props.resetOpenworkServerSettings} disabled={props.busy}>
            {td("common.reset", "Reset")}
          </Button>
        </div>

        <Show when={openworkTestState() !== "idle"}>
          <div
            class={`text-xs ${
              openworkTestState() === "success"
                ? "text-green-11"
                : openworkTestState() === "error"
                  ? "text-red-11"
                  : "text-gray-9"
            }`}
            role="status"
            aria-live="polite"
          >
            {openworkTestState() === "testing"
              ? td("config.testing_connection", "Testing connection...")
              : openworkTestMessage() ?? td("config.connection_status_updated", "Connection status updated.")}
          </div>
        </Show>

        <Show when={openworkStatusLabel() !== td("config.status_connected", "Connected")}>
          <div class="text-xs text-gray-9">{td("config.server_needed_hint", "OpenWork server connection needed to sync skills, plugins, and commands.")}</div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
        <div class="text-sm font-medium text-gray-12">{td("config.messaging_identities_title", "Messaging identities")}</div>
        <div class="text-xs text-gray-10">
          {td("config.messaging_identities_desc", "Manage Telegram/Slack identities and routing in the Identities tab.")}
        </div>
      </div>

      <Show when={!isTauriRuntime()}>
        <div class="text-xs text-gray-9">
          {td("config.desktop_only_hint", "Some config features (local server sharing + messaging bridge) require the desktop app.")}
        </div>
      </Show>
    </section>
  );
}
