import { Show, createEffect, createSignal, on } from "solid-js";
import { CheckCircle2, Copy, ExternalLink, Loader2, RefreshCcw, X } from "lucide-solid";
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
  const [copied, setCopied] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [authUrl, setAuthUrl] = createSignal<string | null>(null);
  const [needsReload, setNeedsReload] = createSignal(false);
  const [alreadyConnected, setAlreadyConnected] = createSignal(false);
  const [authInProgress, setAuthInProgress] = createSignal(false);
  const [lastAuthEntry, setLastAuthEntry] = createSignal<string | null>(null);

  const startAuth = async (forceRetry = false) => {
    const entry = props.entry;
    const client = props.client;

    if (!entry || !client) return;

    const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    // Prevent duplicate auth.start calls for the same entry
    if (!forceRetry && authInProgress()) {
      console.log("[McpAuthModal] auth already in progress, skipping duplicate call");
      return;
    }

    // If we already have a URL for this entry, don't restart
    if (!forceRetry && authUrl() && lastAuthEntry() === slug) {
      console.log("[McpAuthModal] already have auth URL for", slug, "skipping");
      return;
    }

    console.log("[McpAuthModal] startAuth called for:", slug, "forceRetry:", forceRetry);

    setAuthUrl(null);
    setError(null);
    setNeedsReload(false);
    setAlreadyConnected(false);
    setLoading(true);
    setAuthInProgress(true);
    setLastAuthEntry(slug);

    try {
      // First check the MCP status
      console.log("[McpAuthModal] fetching MCP status...");
      let mcpStatus: string | null = null;
      
      try {
        const mcpStatusResult = await client.mcp.status({ directory: props.projectDir });
        console.log("[McpAuthModal] mcp.status result:", mcpStatusResult);
        const mcpData = mcpStatusResult.data;
        console.log("[McpAuthModal] registered MCPs:", Object.keys(mcpData || {}));
        
        if (mcpData && mcpData[slug]) {
          const statusEntry = mcpData[slug] as { status?: string };
          mcpStatus = statusEntry.status ?? null;
          console.log(`[McpAuthModal] MCP '${slug}' status:`, statusEntry);
        } else {
          console.warn(`[McpAuthModal] MCP '${slug}' NOT FOUND in status. Available:`, Object.keys(mcpData || {}));
        }
      } catch (statusErr) {
        console.warn("[McpAuthModal] failed to get mcp.status:", statusErr);
      }

      // If already connected, no OAuth needed
      if (mcpStatus === "connected") {
        console.log(`[McpAuthModal] MCP '${slug}' is already connected, no OAuth needed`);
        setAlreadyConnected(true);
        setLoading(false);
        return;
      }

      // If status is not needs_auth or failed, might need reload
      if (mcpStatus && mcpStatus !== "needs_auth" && mcpStatus !== "failed" && mcpStatus !== "needs_client_registration") {
        console.log(`[McpAuthModal] MCP '${slug}' status is '${mcpStatus}', may not need auth`);
      }

      // Start OAuth and show the URL as a fallback for the user.
      console.log("[McpAuthModal] ⚠️ CALLING auth.start for:", slug, "at", new Date().toISOString());
      console.log("[McpAuthModal] ⚠️ This should only appear ONCE per connect attempt!");
      const authResult = await client.mcp.auth.start({
        name: slug,
        directory: props.projectDir,
      });
      console.log("[McpAuthModal] mcp.auth.start result:", authResult);

      const authStatus = unwrap(authResult);
      console.log("[McpAuthModal] unwrapped:", authStatus);

      const authorizationUrl = (authStatus as { authorizationUrl?: string }).authorizationUrl ?? "";

      if (authorizationUrl.trim()) {
        setAuthUrl(authorizationUrl);
      } else {
        console.warn("[McpAuthModal] empty authorizationUrl");
        setNeedsReload(true);
        setError(
          "The engine returned an empty authorization URL. " +
            "This could mean OAuth is already configured globally, or the engine needs a reload."
        );
      }
    } catch (err) {
      console.error("[McpAuthModal] error:", err);
      const message = err instanceof Error ? err.message : "Failed to start OAuth flow";
      
      // Check for specific error types
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
    console.log("[McpAuthModal] handleRetry called");
    setLastAuthEntry(null); // Clear so we can retry
    startAuth(true); // Force retry
  };

  const handleReloadAndRetry = async () => {
    if (props.onReloadEngine) {
      console.log("[McpAuthModal] handleReloadAndRetry - reloading engine");
      props.onReloadEngine();
      // Wait a bit for reload, then retry
      setTimeout(() => {
        console.log("[McpAuthModal] handleReloadAndRetry - retrying after reload");
        setLastAuthEntry(null);
        startAuth(true);
      }, 2000);
    }
  };

  const copyUrl = async () => {
    const url = authUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback ignored
    }
  };

  const openInBrowser = async () => {
    const url = authUrl();
    if (!url) return;

    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch (err) {
      console.error("[McpAuthModal] failed to open URL:", err);
      // Fallback to window.open
      window.open(url, "_blank");
    }
  };

  const handleClose = () => {
    setAuthUrl(null);
    setError(null);
    setLoading(false);
    setAlreadyConnected(false);
    setNeedsReload(false);
    setAuthInProgress(false);
    setLastAuthEntry(null);
    props.onClose();
  };

  const handleComplete = () => {
    setAuthUrl(null);
    setError(null);
    setLoading(false);
    setAlreadyConnected(false);
    setNeedsReload(false);
    setAuthInProgress(false);
    setLastAuthEntry(null);
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
                Connect {serverName()}
              </h2>
              <p class="text-sm text-zinc-400">Complete OAuth authentication</p>
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
                    <p class="text-sm font-medium text-white">Already Connected</p>
                    <p class="text-xs text-zinc-400">
                      {serverName()} is already authenticated and ready to use.
                    </p>
                  </div>
                </div>
                <p class="text-xs text-zinc-500">
                  The MCP may have been configured globally or in a previous session. 
                  You can close this modal and start using the MCP tools right away.
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
                        Reload Engine & Retry
                      </Button>
                    </Show>
                    <Button variant="ghost" onClick={handleRetry}>
                      Retry Now
                    </Button>
                  </div>
                </Show>
                
                <Show when={!needsReload()}>
                  <div class="pt-2">
                    <Button variant="ghost" onClick={handleRetry}>
                      Retry
                    </Button>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={!loading() && !error() && authUrl()}>
              {/* Steps */}
              <div class="space-y-4">
                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-medium text-zinc-300">
                    1
                  </div>
                  <div>
                    <p class="text-sm font-medium text-white">
                      Open the authorization page
                    </p>
                    <p class="text-xs text-zinc-500 mt-1">
                      Click the button below to open {serverName()}'s login page in your browser.
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-medium text-zinc-300">
                    2
                  </div>
                  <div>
                    <p class="text-sm font-medium text-white">
                      Authorize OpenWork
                    </p>
                    <p class="text-xs text-zinc-500 mt-1">
                      Sign in and grant access when prompted.
                    </p>
                  </div>
                </div>

                <div class="flex items-start gap-3">
                  <div class="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-medium text-zinc-300">
                    3
                  </div>
                  <div>
                    <p class="text-sm font-medium text-white">
                      Return here and reload
                    </p>
                    <p class="text-xs text-zinc-500 mt-1">
                      After authorizing, close this modal and reload the engine.
                    </p>
                  </div>
                </div>
              </div>

              {/* URL Box */}
              <div class="bg-zinc-950/70 border border-zinc-800 rounded-xl p-3 space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-xs text-zinc-500 uppercase tracking-wide">
                    Authorization URL
                  </span>
                  <button
                    type="button"
                    class="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors"
                    onClick={copyUrl}
                  >
                    <Show when={copied()} fallback={<Copy size={12} />}>
                      <CheckCircle2 size={12} class="text-emerald-400" />
                    </Show>
                    {copied() ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p class="text-xs font-mono text-zinc-300 break-all leading-relaxed">
                  {authUrl()}
                </p>
              </div>

              {/* Action Buttons */}
              <div class="flex flex-col gap-3">
                <Button variant="primary" onClick={openInBrowser}>
                  <ExternalLink size={16} />
                  Open in Browser
                </Button>
                <p class="text-center text-xs text-zinc-500">
                  Or copy the URL above and paste it in your browser manually.
                </p>
              </div>
            </Show>

            <Show when={!loading() && !error() && !authUrl() && !alreadyConnected()}>
              <div class="text-center py-4">
                <p class="text-sm text-zinc-400">
                  Waiting for authorization to complete in your browser...
                </p>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-800 bg-zinc-900/50">
            <Show when={alreadyConnected()}>
              <Button variant="primary" onClick={handleComplete}>
                <CheckCircle2 size={16} />
                Done
              </Button>
            </Show>
            <Show when={!alreadyConnected()}>
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button variant="secondary" onClick={handleComplete}>
                <CheckCircle2 size={16} />
                I've Completed OAuth
              </Button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
