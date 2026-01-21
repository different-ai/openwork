import { Show, createEffect, createSignal, on } from "solid-js";
import { useI18n } from "../i18n";
import { CheckCircle2, Loader2, RefreshCcw, X } from "lucide-solid";
import Button from "./Button";
import type { Client } from "../app/types";
import type { McpDirectoryInfo } from "../app/constants";
import { unwrap } from "../lib/opencode";

export type McpAuthModalProps = {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
  onReloadEngine?: () => void;
  client: Client | null;
  entry: McpDirectoryInfo | null;
  projectDir: string;
};

export default function McpAuthModal(props: McpAuthModalProps) {
  const [t] = useI18n();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [needsReload, setNeedsReload] = createSignal(false);
  const [alreadyConnected, setAlreadyConnected] = createSignal(false);
  const [authInProgress, setAuthInProgress] = createSignal(false);

  const startAuth = async (forceRetry = false) => {
    const entry = props.entry;
    const client = props.client;

    if (!entry || !client) return;

    const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    if (!forceRetry && authInProgress()) {
      return;
    }

    setError(null);
    setNeedsReload(false);
    setAlreadyConnected(false);
    setLoading(true);
    setAuthInProgress(true);

    try {
      let mcpStatus: string | null = null;

      try {
        const mcpStatusResult = await client.mcp.status({ directory: props.projectDir });
        const mcpData = mcpStatusResult.data;
        if (mcpData && mcpData[slug]) {
          const statusEntry = mcpData[slug] as { status?: string };
          mcpStatus = statusEntry.status ?? null;
        }
      } catch {
        // Ignore status failures and attempt auth anyway.
      }

      if (mcpStatus === "connected") {
        setAlreadyConnected(true);
        setLoading(false);
        return;
      }

      const authResult = await client.mcp.auth.authenticate({
        name: slug,
        directory: props.projectDir,
      });
      const authStatus = unwrap(authResult);

      if (authStatus.status === "connected") {
        setAlreadyConnected(true);
      } else if (authStatus.status === "needs_client_registration") {
        setNeedsReload(true);
        setError(authStatus.error ?? "Client registration is required before OAuth can continue.");
      } else if (authStatus.status === "disabled") {
        setError("This MCP server is disabled. Enable it and try again.");
      } else if (authStatus.status === "failed") {
        setError(authStatus.error ?? "OAuth authentication failed.");
      } else if (authStatus.status === "needs_auth") {
        setError("Authorization is still required. Try again to restart the flow.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start OAuth flow";

      if (message.toLowerCase().includes("does not support oauth")) {
        setError(
          `${message}\n\n` +
          "This could mean:\n" +
          "• The MCP server doesn't advertise OAuth capabilities\n" +
          "• The engine needs to reload to discover server capabilities\n" +
          "• Try: opencode mcp auth " + (props.entry?.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "server") + " from the CLI"
        );
        setNeedsReload(true);
      } else if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("unknown")) {
        setNeedsReload(true);
        setError(`${message}. Try reloading the engine first.`);
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
    if (props.onReloadEngine) {
      props.onReloadEngine();
      setTimeout(() => {
        startAuth(true);
      }, 2000);
    }
  };

  const handleClose = () => {
    setError(null);
    setLoading(false);
    setAlreadyConnected(false);
    setNeedsReload(false);
    setAuthInProgress(false);
    props.onClose();
  };

  const handleComplete = () => {
    setError(null);
    setLoading(false);
    setAlreadyConnected(false);
    setNeedsReload(false);
    setAuthInProgress(false);
    props.onComplete();
  };

  const serverName = () => props.entry?.name ?? "MCP Server";

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop */}
        <div
          class="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={handleClose}
        />

        {/* Modal */}
        <div class="relative w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div class="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
            <div>
              <h2 class="text-lg font-semibold text-white">
                {t("components.mcp_auth.connect")} {serverName()}
              </h2>
              <p class="text-sm text-zinc-400">{t("components.mcp_auth.subtitle")}</p>
            </div>
            <button
              type="button"
              class="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
              onClick={handleClose}
            >
              <X size={20} />
            </button>
          </div>

          {/* Content */}
          <div class="px-6 py-5 space-y-5">
            <Show when={loading()}>
              <div class="flex items-center justify-center py-8">
                <Loader2 size={32} class="animate-spin text-zinc-400" />
              </div>
            </Show>

            <Show when={!loading() && alreadyConnected()}>
              <div class="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-5 space-y-4">
                <div class="flex items-center gap-3">
                  <div class="flex-shrink-0 w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <CheckCircle2 size={24} class="text-emerald-400" />
                  </div>
                  <div>
                    <p class="text-sm font-medium text-white">{t("components.mcp_auth.already_connected.title")}</p>
                    <p class="text-xs text-zinc-400">
                      {serverName()} {t("components.mcp_auth.already_connected.desc")}
                    </p>
                  </div>
                </div>
                <p class="text-xs text-zinc-500">
                  {t("components.mcp_auth.already_connected.note")}
                </p>
              </div>
            </Show>

            <Show when={error()}>
              <div class="bg-red-500/10 border border-red-500/20 rounded-xl p-4 space-y-3">
                <p class="text-sm text-red-300">{error()}</p>

                <Show when={needsReload()}>
                  <div class="flex flex-wrap gap-2 pt-2">
                    <Show when={props.onReloadEngine}>
                      <Button variant="secondary" onClick={handleReloadAndRetry}>
                        <RefreshCcw size={14} />
                        {t("components.mcp_auth.actions.reload_retry")}
                      </Button>
                    </Show>
                    <Button variant="ghost" onClick={handleRetry}>
                      {t("components.mcp_auth.actions.retry_now")}
                    </Button>
                  </div>
                </Show>

                <Show when={!needsReload()}>
                  <div class="pt-2">
                    <Button variant="ghost" onClick={handleRetry}>
                      {t("components.mcp_auth.actions.retry")}
                    </Button>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={!loading() && !error() && !alreadyConnected()}>
              <div class="space-y-4">
                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-medium text-zinc-300">
                    1
                  </div>
                  <div>
                    <p class="text-sm font-medium text-white">{t("components.mcp_auth.steps.open_browser")}</p>
                    <p class="text-xs text-zinc-500 mt-1">
                      {t("components.mcp_auth.steps.open_browser_desc").replace("{name}", serverName())}
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-medium text-zinc-300">
                    2
                  </div>
                  <div>
                    <p class="text-sm font-medium text-white">{t("components.mcp_auth.steps.authorize")}</p>
                    <p class="text-xs text-zinc-500 mt-1">
                      {t("components.mcp_auth.steps.authorize_desc")}
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-medium text-zinc-300">
                    3
                  </div>
                  <div>
                    <p class="text-sm font-medium text-white">{t("components.mcp_auth.steps.return")}</p>
                    <p class="text-xs text-zinc-500 mt-1">
                      {t("components.mcp_auth.steps.return_desc")}
                    </p>
                  </div>
                </div>
              </div>

              <div class="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-sm text-zinc-400">
                {t("components.mcp_auth.status.waiting")}
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-800 bg-zinc-900/50">
            <Show when={alreadyConnected()}>
              <Button variant="primary" onClick={handleComplete}>
                <CheckCircle2 size={16} />
                {t("components.mcp_auth.actions.done")}
              </Button>
            </Show>
            <Show when={!alreadyConnected()}>
              <Button variant="ghost" onClick={handleClose}>
                {t("components.mcp_auth.actions.cancel")}
              </Button>
              <Button variant="secondary" onClick={handleComplete}>
                <CheckCircle2 size={16} />
                {t("components.mcp_auth.actions.im_done")}
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
