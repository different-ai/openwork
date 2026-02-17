import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { isTauriRuntime } from "../utils";
import { t } from "../../i18n";

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
  openworkServerWorkspaceId: string | null;

  updateOpenworkServerSettings: (next: OpenworkServerSettings) => void;
  resetOpenworkServerSettings: () => void;
  testOpenworkServerConnection: (next: OpenworkServerSettings) => Promise<boolean>;

  canReloadWorkspace: boolean;
  reloadWorkspaceEngine: () => Promise<void>;
  reloadBusy: boolean;
  reloadError: string | null;

  workspaceAutoReloadAvailable: boolean;
  workspaceAutoReloadEnabled: boolean;
  setWorkspaceAutoReloadEnabled: (value: boolean) => void | Promise<void>;
  workspaceAutoReloadResumeEnabled: boolean;
  setWorkspaceAutoReloadResumeEnabled: (value: boolean) => void | Promise<void>;

  developerMode: boolean;
};

export default function ConfigView(props: ConfigViewProps) {
  const [openworkUrl, setOpenworkUrl] = createSignal("");
  const [openworkToken, setOpenworkToken] = createSignal("");
  const [openworkTokenVisible, setOpenworkTokenVisible] = createSignal(false);
  const [openworkTestState, setOpenworkTestState] = createSignal<"idle" | "testing" | "success" | "error">("idle");
  const [openworkTestMessage, setOpenworkTestMessage] = createSignal<string | null>(null);
  const [clientTokenVisible, setClientTokenVisible] = createSignal(false);
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
        return t("status.connected");
      case "limited":
        return t("status.limited");
      case "disconnected":
      default:
        return t("status.disconnected");
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
    if (!props.clientConnected) return t("config.reload_connect_hint");
    if (!props.canReloadWorkspace) {
      return t("config.reload_local_only");
    }
    return null;
  });

  const reloadButtonLabel = createMemo(() => (props.reloadBusy ? t("config.reloading") : t("config.reload_engine")));
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
    const explicitId = props.openworkServerWorkspaceId?.trim() ?? "";
    if (explicitId) return explicitId;
    return parseOpenworkWorkspaceIdFromUrl(openworkUrl()) ?? "";
  });

  const resolvedWorkspaceUrl = createMemo(() => {
    const baseUrl = openworkUrl().trim();
    if (!baseUrl) return "";
    return buildOpenworkWorkspaceBaseUrl(baseUrl, resolvedWorkspaceId()) ?? baseUrl;
  });

  const hostInfo = createMemo(() => props.openworkServerHostInfo);
  const hostStatusLabel = createMemo(() => {
    if (!hostInfo()?.running) return t("config.status_offline");
    return t("config.status_available");
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
    return {
      capturedAt: new Date().toISOString(),
      runtime: {
        tauri: isTauriRuntime(),
        developerMode: props.developerMode,
      },
      workspace: {
        openworkServerWorkspaceId: props.openworkServerWorkspaceId ?? null,
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
              baseUrl: host.baseUrl ?? null,
              connectUrl: host.connectUrl ?? null,
              mdnsUrl: host.mdnsUrl ?? null,
              lanUrl: host.lanUrl ?? null,
            }
          : null,
      },
      reload: {
        canReloadWorkspace: props.canReloadWorkspace,
        autoReloadAvailable: props.workspaceAutoReloadAvailable,
        autoReloadEnabled: props.workspaceAutoReloadEnabled,
        autoReloadResumeEnabled: props.workspaceAutoReloadResumeEnabled,
      },
      sharing: {
        hostConnectUrl: hostConnectUrl() || null,
        hostConnectUrlUsesMdns: hostConnectUrlUsesMdns(),
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
        <div class="text-sm font-medium text-gray-12">{t("config.title")}</div>
        <div class="text-xs text-gray-10">
          {t("config.subtitle")}
        </div>
        <Show when={props.openworkServerWorkspaceId}>
          <div class="text-[11px] text-gray-7 font-mono truncate">
            {t("config.workspace_label")}{props.openworkServerWorkspaceId}
          </div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div>
          <div class="text-sm font-medium text-gray-12">{t("config.engine_reload_title")}</div>
          <div class="text-xs text-gray-10">{t("config.engine_reload_subtitle")}</div>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">{t("config.reload_now")}</div>
            <div class="text-xs text-gray-7">{t("config.reload_now_subtitle")}</div>
            <Show when={props.anyActiveRuns}>
              <div class="text-[11px] text-amber-11">{t("config.reload_warning")}</div>
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

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">{t("config.auto_reload_title")}</div>
            <div class="text-xs text-gray-7">{t("config.auto_reload_subtitle")}</div>
            <Show when={!props.workspaceAutoReloadAvailable}>
              <div class="text-[11px] text-gray-9">{t("config.auto_reload_desktop_only")}</div>
            </Show>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.setWorkspaceAutoReloadEnabled(!props.workspaceAutoReloadEnabled)}
            disabled={props.busy || !props.workspaceAutoReloadAvailable}
          >
            {props.workspaceAutoReloadEnabled ? t("common.on") : t("common.off")}
          </Button>
        </div>

        <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
          <div class="min-w-0 space-y-1">
            <div class="text-sm text-gray-12">{t("config.resume_sessions_title")}</div>
            <div class="text-xs text-gray-7">
              {t("config.resume_sessions_subtitle")}
            </div>
          </div>
          <Button
            variant="outline"
            class="text-xs h-8 py-0 px-3 shrink-0"
            onClick={() => props.setWorkspaceAutoReloadResumeEnabled(!props.workspaceAutoReloadResumeEnabled)}
            disabled={
              props.busy ||
              !props.workspaceAutoReloadAvailable ||
              !props.workspaceAutoReloadEnabled
            }
            title={props.workspaceAutoReloadEnabled ? "" : t("config.enable_auto_reload_first")}
          >
            {props.workspaceAutoReloadResumeEnabled ? t("common.on") : t("common.off")}
          </Button>
        </div>
      </div>

      <Show when={props.developerMode}>
        <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
          <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <div class="text-sm font-medium text-gray-12">{t("config.diagnostics_title")}</div>
              <div class="text-xs text-gray-10">{t("config.diagnostics_subtitle")}</div>
            </div>
            <Button
              variant="secondary"
              class="text-xs h-8 py-0 px-3 shrink-0"
              onClick={() => void handleCopy(diagnosticsBundleJson(), "debug-bundle")}
              disabled={props.busy}
            >
              {copyingField() === "debug-bundle" ? t("config.copied") : t("config.copy")}
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
              <div class="text-sm font-medium text-gray-12">{t("config.sharing_title")}</div>
              <div class="text-xs text-gray-10">
                {t("config.sharing_subtitle")}
              </div>
            </div>
            <div class={`text-xs px-2 py-1 rounded-full border ${hostStatusStyle()}`}>
              {hostStatusLabel()}
            </div>
          </div>

          <div class="grid gap-3">
            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">{t("config.server_url_label")}</div>
                <div class="text-xs text-gray-7 font-mono truncate">{hostConnectUrl() || t("config.starting_server")}</div>
                <Show when={hostConnectUrl()}>
                  <div class="text-[11px] text-gray-8 mt-1">
                    {hostConnectUrlUsesMdns()
                      ? t("config.mdns_hint")
                      : t("config.ip_hint")}
                  </div>
                </Show>
              </div>
              <Button
                variant="outline"
                class="text-xs h-8 py-0 px-3 shrink-0"
                onClick={() => handleCopy(hostConnectUrl(), "host-url")}
                disabled={!hostConnectUrl()}
              >
                {copyingField() === "host-url" ? t("config.copied") : t("config.copy")}
              </Button>
            </div>

            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">{t("config.access_token_label")}</div>
                <div class="text-xs text-gray-7 font-mono truncate">
                  {clientTokenVisible()
                    ? hostInfo()?.clientToken || "—"
                    : hostInfo()?.clientToken
                      ? "••••••••••••"
                      : "—"}
                </div>
                <div class="text-[11px] text-gray-8 mt-1">{t("config.access_token_hint")}</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => setClientTokenVisible((prev) => !prev)}
                  disabled={!hostInfo()?.clientToken}
                >
                  {clientTokenVisible() ? t("config.hide") : t("config.show")}
                </Button>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => handleCopy(hostInfo()?.clientToken ?? "", "client-token")}
                  disabled={!hostInfo()?.clientToken}
                >
                  {copyingField() === "client-token" ? t("config.copied") : t("config.copy")}
                </Button>
              </div>
            </div>

            <div class="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
              <div class="min-w-0">
                <div class="text-xs font-medium text-gray-11">{t("config.server_token_label")}</div>
                <div class="text-xs text-gray-7 font-mono truncate">
                  {hostTokenVisible()
                    ? hostInfo()?.hostToken || "—"
                    : hostInfo()?.hostToken
                      ? "••••••••••••"
                      : "—"}
                </div>
                <div class="text-[11px] text-gray-8 mt-1">{t("config.server_token_hint")}</div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => setHostTokenVisible((prev) => !prev)}
                  disabled={!hostInfo()?.hostToken}
                >
                  {hostTokenVisible() ? t("config.hide") : t("config.show")}
                </Button>
                <Button
                  variant="outline"
                  class="text-xs h-8 py-0 px-3"
                  onClick={() => handleCopy(hostInfo()?.hostToken ?? "", "host-token")}
                  disabled={!hostInfo()?.hostToken}
                >
                  {copyingField() === "host-token" ? t("config.copied") : t("config.copy")}
                </Button>
              </div>
            </div>
          </div>

          <div class="text-xs text-gray-9" innerHTML={t("config.share_hint")} />
        </div>
      </Show>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div class="text-sm font-medium text-gray-12">{t("config.openwork_server_title")}</div>
            <div class="text-xs text-gray-10">
              {t("config.openwork_server_subtitle")}
            </div>
          </div>
          <div class={`text-xs px-2 py-1 rounded-full border ${openworkStatusStyle()}`}>{openworkStatusLabel()}</div>
        </div>

        <div class="grid gap-3">
          <TextInput
            label={t("dashboard.openwork_host_label")}
            value={openworkUrl()}
            onInput={(event) => setOpenworkUrl(event.currentTarget.value)}
            placeholder={t("dashboard.remote_base_url_placeholder")}
            hint={t("dashboard.openwork_host_hint")}
            disabled={props.busy}
          />

          <label class="block">
            <div class="mb-1 text-xs font-medium text-gray-11">{t("dashboard.openwork_host_token_label")}</div>
            <div class="flex items-center gap-2">
              <input
                type={openworkTokenVisible() ? "text" : "password"}
                value={openworkToken()}
                onInput={(event) => setOpenworkToken(event.currentTarget.value)}
                placeholder={t("dashboard.openwork_host_token_placeholder")}
                disabled={props.busy}
                class="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
              />
              <Button
                variant="outline"
                class="text-xs h-9 px-3 shrink-0"
                onClick={() => setOpenworkTokenVisible((prev) => !prev)}
                disabled={props.busy}
              >
                {openworkTokenVisible() ? t("config.hide") : t("config.show")}
              </Button>
            </div>
            <div class="mt-1 text-xs text-gray-10">{t("dashboard.openwork_host_token_hint")}</div>
          </label>
        </div>

        <div class="space-y-1">
          <div class="text-[11px] text-gray-7 font-mono truncate">{t("config.resolved_worker_url")}{resolvedWorkspaceUrl() || t("config.not_set")}</div>
          <div class="text-[11px] text-gray-8 font-mono truncate">{t("config.worker_id")}{resolvedWorkspaceId() || t("config.unavailable")}</div>
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
                  ok ? t("config.connection_success") : t("config.connection_failed")
                );
              } catch (error) {
                const message = error instanceof Error ? error.message : t("config.connection_failed_generic");
                setOpenworkTestState("error");
                setOpenworkTestMessage(message);
              }
            }}
            disabled={props.busy || openworkTestState() === "testing"}
          >
            {openworkTestState() === "testing" ? t("config.testing") : t("config.test_connection")}
          </Button>
          <Button
            variant="outline"
            onClick={() => props.updateOpenworkServerSettings(buildOpenworkSettings())}
            disabled={props.busy || !hasOpenworkChanges()}
          >
            {t("config.save")}
          </Button>
          <Button variant="ghost" onClick={props.resetOpenworkServerSettings} disabled={props.busy}>
            {t("config.reset")}
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
            {openworkTestState() === "testing" ? t("config.testing_connection") : openworkTestMessage() ?? t("config.connection_status_updated")}
          </div>
        </Show>

        <Show when={openworkStatusLabel() !== t("status.connected")}>
          <div class="text-xs text-gray-9">{t("config.sync_hint")}</div>
        </Show>
      </div>

      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
        <div class="text-sm font-medium text-gray-12">{t("config.identities_title")}</div>
        <div class="text-xs text-gray-10" innerHTML={t("config.identities_subtitle")} />
      </div>

      <Show when={!isTauriRuntime()}>
        <div class="text-xs text-gray-9">
          {t("config.desktop_only_hint")}
        </div>
      </Show>
    </section>
  );
}
