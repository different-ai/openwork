import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { CheckCircle2, Loader2, RefreshCcw, X } from "lucide-solid";
import Button from "./button";
import type { Client } from "../types";
import type { McpDirectoryInfo } from "../constants";
import { unwrap } from "../lib/opencode";
import { validateMcpServerName } from "../mcp";
import { t, type Language } from "../../i18n";
import { isTauriRuntime } from "../utils";

export type McpAuthModalProps = {
  open: boolean;
  onClose: () => void;
  onComplete: () => void | Promise<void>;
  onReloadEngine?: () => void | Promise<void>;
  reloadRequired?: boolean;
  client: Client | null;
  entry: McpDirectoryInfo | null;
  projectDir: string;
  language: Language;
};

export default function McpAuthModal(props: McpAuthModalProps) {
  const translate = (key: string, replacements?: Record<string, string>) => {
    let result = t(key, props.language);
    if (replacements) {
      Object.entries(replacements).forEach(([placeholder, value]) => {
        result = result.replace(`{${placeholder}}`, value);
      });
    }
    return result;
  };

  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [needsReload, setNeedsReload] = createSignal(false);
  const [alreadyConnected, setAlreadyConnected] = createSignal(false);
  const [authInProgress, setAuthInProgress] = createSignal(false);
  const [statusChecking, setStatusChecking] = createSignal(false);

  let statusPoll: number | null = null;

  const stopStatusPolling = () => {
    if (statusPoll !== null) {
      window.clearInterval(statusPoll);
      statusPoll = null;
    }
  };

  onCleanup(() => stopStatusPolling());

  const openAuthorizationUrl = async (url: string) => {
    if (isTauriRuntime()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    }

    if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const fetchMcpStatus = async (slug: string) => {
    const entry = props.entry;
    const client = props.client;
    if (!entry || !client) return null;

    try {
      const result = await client.mcp.status({ directory: props.projectDir });
      const status = result.data?.[slug] as { status?: string; error?: string } | undefined;
      return status ?? null;
    } catch {
      return null;
    }
  };

  const startStatusPolling = (slug: string) => {
    if (typeof window === "undefined") return;
    stopStatusPolling();
    let attempts = 0;
    statusPoll = window.setInterval(async () => {
      attempts += 1;
      if (attempts > 20) {
        stopStatusPolling();
        return;
      }

      const status = await fetchMcpStatus(slug);
      if (status?.status === "connected") {
        setAlreadyConnected(true);
        stopStatusPolling();
      }
    }, 2000);
  };

  const startAuth = async (forceRetry = false) => {
    const entry = props.entry;
    const client = props.client;

    if (!entry || !client) return;

    let slug = "";
    try {
      const safeName = validateMcpServerName(entry.name);
      slug = safeName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");
      setError(message);
      setLoading(false);
      setAuthInProgress(false);
      return;
    }

    if (!forceRetry && authInProgress()) {
      return;
    }

    setError(null);
    setNeedsReload(false);
    setAlreadyConnected(false);
    stopStatusPolling();
    setLoading(true);
    setAuthInProgress(true);

    try {
      if (props.reloadRequired) {
        setNeedsReload(true);
        setError(translate("mcp.auth.reload_before_oauth"));
        return;
      }

      const statusEntry = await fetchMcpStatus(slug);
      if (statusEntry?.status === "connected") {
        setAlreadyConnected(true);
        return;
      }

      const authResult = await client.mcp.auth.start({
        name: slug,
        directory: props.projectDir,
      });
      const auth = unwrap(authResult) as { authorizationUrl?: string };

      if (!auth.authorizationUrl) {
        setAlreadyConnected(true);
        return;
      }

      await openAuthorizationUrl(auth.authorizationUrl);
      startStatusPolling(slug);
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");

      if (message.toLowerCase().includes("does not support oauth")) {
        const serverSlug = props.entry?.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "server";
        setError(
          `${message}\n\n` + translate("mcp.auth.oauth_not_supported_hint", { server: serverSlug })
        );
        setNeedsReload(true);
      } else if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("unknown")) {
        setNeedsReload(true);
        setError(translate("mcp.auth.try_reload_engine", { message }));
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
      setAuthInProgress(false);
    }
  };

  // Start the OAuth flow when modal opens with an entry
  createEffect(
    on(
      () => [props.open, props.entry, props.client] as const,
      ([isOpen, entry, client]) => {
        if (!isOpen || !entry || !client) {
          return;
        }
        // Only start auth on initial open, not on every prop change
        startAuth(false);
      },
      { defer: true } // Defer to avoid double-firing on mount
    )
  );

  const handleRetry = () => {
    startAuth(true);
  };

  const handleReloadAndRetry = async () => {
    if (!props.onReloadEngine) return;
    await props.onReloadEngine();
    startAuth(true);
  };

  const handleClose = () => {
    setError(null);
    setLoading(false);
    setAlreadyConnected(false);
    setNeedsReload(false);
    setAuthInProgress(false);
    setStatusChecking(false);
    stopStatusPolling();
    props.onClose();
  };

  const isBusy = () => loading() || statusChecking();

  const handleComplete = async () => {
    const entry = props.entry;
    const client = props.client;
    if (!entry || !client) return;

    setError(null);
    setStatusChecking(true);

    let slug = "";
    try {
      const safeName = validateMcpServerName(entry.name);
      slug = safeName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");
      setError(message);
      setStatusChecking(false);
      return;
    }

    const statusEntry = await fetchMcpStatus(slug);
    if (statusEntry?.status === "connected") {
      setAlreadyConnected(true);
      setStatusChecking(false);
      await props.onComplete();
      return;
    }

    if (statusEntry?.status === "needs_client_registration") {
      setError(statusEntry.error ?? translate("mcp.auth.client_registration_required"));
    } else if (statusEntry?.status === "disabled") {
      setError(translate("mcp.auth.server_disabled"));
    } else if (statusEntry?.status === "failed") {
      setError(statusEntry.error ?? translate("mcp.auth.oauth_failed"));
    } else {
      setError(translate("mcp.auth.authorization_still_required"));
    }

    setStatusChecking(false);
  };

  const serverName = () => props.entry?.name ?? "MCP Server";

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop */}
        <div
          class="absolute inset-0 bg-gray-1/60 backdrop-blur-sm"
          onClick={handleClose}
        />

        {/* Modal */}
        <div class="relative w-full max-w-lg bg-gray-2 border border-gray-6 rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div class="flex items-center justify-between px-6 py-4 border-b border-gray-6">
            <div>
              <h2 class="text-lg font-semibold text-gray-12">
                  {translate("mcp.auth.connect_server", { server: serverName() })}
              </h2>
              <p class="text-sm text-gray-11">{translate("mcp.auth.open_browser_signin")}</p>
            </div>
            <button
              type="button"
              class="p-2 text-gray-11 hover:text-gray-12 hover:bg-gray-4 rounded-lg transition-colors"
              onClick={handleClose}
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div class="px-6 py-5 space-y-5">
            <Show when={isBusy()}>
              <div class="flex items-center justify-center py-8">
                <Loader2 size={32} class="animate-spin text-gray-11" />
              </div>
            </Show>

            <Show when={!isBusy() && alreadyConnected()}>
              <div class="bg-green-7/10 border border-green-7/20 rounded-xl p-5 space-y-4">
                <div class="flex items-center gap-3">
                  <div class="flex-shrink-0 w-10 h-10 rounded-full bg-green-7/20 flex items-center justify-center">
                    <CheckCircle2 size={24} class="text-green-11" />
                  </div>
                  <div>
                    <p class="text-sm font-medium text-gray-12">Already Connected</p>
                    <p class="text-xs text-gray-11">
                        {translate("mcp.auth.already_connected_description", { server: serverName() })}
                    </p>
                  </div>
                </div>
                <p class="text-xs text-gray-10">
                    {translate("mcp.auth.configured_previously")}
                </p>
              </div>
            </Show>

            <Show when={error()}>
              <div class="bg-red-7/10 border border-red-7/20 rounded-xl p-4 space-y-3">
                <p class="text-sm text-red-11">{error()}</p>
                
                <Show when={needsReload()}>
                  <div class="flex flex-wrap gap-2 pt-2">
                    <Show when={props.onReloadEngine}>
                      <Button variant="secondary" onClick={handleReloadAndRetry}>
                        <RefreshCcw size={14} />
                        {translate("mcp.auth.reload_engine_retry")}
                      </Button>
                    </Show>
                    <Button variant="ghost" onClick={handleRetry}>
                      {translate("mcp.auth.retry_now")}
                    </Button>
                  </div>
                </Show>

                <Show when={!needsReload()}>
                  <div class="pt-2">
                    <Button variant="ghost" onClick={handleRetry}>
                      {translate("mcp.auth.retry")}
                    </Button>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={!isBusy() && !error() && !alreadyConnected()}>
              <div class="space-y-4">
                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs font-medium text-gray-11">
                    1
                  </div>
                  <div>
                    <p class="text-sm font-medium text-gray-12">Opening your browser</p>
                    <p class="text-xs text-gray-10 mt-1">
                        {translate("mcp.auth.step1_description", { server: serverName() })}
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs font-medium text-gray-11">
                    2
                  </div>
                  <div>
                    <p class="text-sm font-medium text-gray-12">Authorize OpenWork</p>
                    <p class="text-xs text-gray-10 mt-1">
                        {translate("mcp.auth.step2_description")}
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-gray-4 flex items-center justify-center text-xs font-medium text-gray-11">
                    3
                  </div>
                  <div>
                    <p class="text-sm font-medium text-gray-12">Return here when you're done</p>
                    <p class="text-xs text-gray-10 mt-1">
                        {translate("mcp.auth.step3_description")}
                    </p>
                  </div>
                </div>
              </div>

              <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-11">
                  {translate("mcp.auth.waiting_authorization")}
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-6 bg-gray-2/50">
            <Show when={alreadyConnected()}>
              <Button variant="primary" onClick={handleComplete}>
                <CheckCircle2 size={16} />
                {translate("mcp.auth.done")}
              </Button>
            </Show>
            <Show when={!alreadyConnected()}>
              <Button variant="ghost" onClick={handleClose}>
                {translate("mcp.auth.cancel")}
              </Button>
              <Button variant="secondary" onClick={handleComplete}>
                <CheckCircle2 size={16} />
                {translate("mcp.auth.im_done")}
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
