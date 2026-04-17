/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCcw, X } from "lucide-react";

import type { McpDirectoryInfo } from "../../../app/constants";
import { unwrap } from "../../../app/lib/opencode";
import { opencodeMcpAuth } from "../../../app/lib/tauri";
import { validateMcpServerName } from "../../../app/mcp";
import type { Client } from "../../../app/types";
import { isTauriRuntime, normalizeDirectoryPath } from "../../../app/utils";
import { t, type Language } from "../../../i18n";
import { Button } from "../../design-system/button";
import { TextInput } from "../../design-system/text-input";

const MCP_AUTH_POLL_INTERVAL_MS = 2_000;
const MCP_AUTH_TIMEOUT_MS = 90_000;
const MCP_AUTH_DISCOVERY_TIMEOUT_MS = 15_000;

type McpStatusEntry = {
  status?: string;
  error?: string;
};

export type McpAuthModalProps = {
  open: boolean;
  onClose: () => void;
  onComplete: () => void | Promise<void>;
  onReloadEngine?: () => void | Promise<void>;
  reloadRequired?: boolean;
  reloadBlocked?: boolean;
  activeSessions?: Array<{ id: string; title: string }>;
  isRemoteWorkspace?: boolean;
  client: Client | null;
  entry: McpDirectoryInfo | null;
  projectDir: string;
  language: Language;
  onForceStopSession?: (sessionID: string) => void | Promise<void>;
};

export function McpAuthModal(props: McpAuthModalProps) {
  const translate = (key: string, replacements?: Record<string, string>) => {
    let result = t(key, props.language);
    if (replacements) {
      for (const [placeholder, value] of Object.entries(replacements)) {
        result = result.replace(`{${placeholder}}`, value);
      }
    }
    return result;
  };

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [alreadyConnected, setAlreadyConnected] = useState(false);
  const [authInProgress, setAuthInProgress] = useState(false);
  const [statusChecking, setStatusChecking] = useState(false);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [callbackInput, setCallbackInput] = useState("");
  const [manualAuthBusy, setManualAuthBusy] = useState(false);
  const [cliAuthBusy, setCliAuthBusy] = useState(false);
  const [cliAuthResult, setCliAuthResult] = useState<string | null>(null);
  const [authUrlCopied, setAuthUrlCopied] = useState(false);
  const [resolvedDir, setResolvedDir] = useState("");
  const [awaitingReload, setAwaitingReload] = useState(false);
  const [reloadStarting, setReloadStarting] = useState(false);
  const [reloadSatisfied, setReloadSatisfied] = useState(false);
  const [forceStopBusySessionID, setForceStopBusySessionID] = useState<string | null>(null);

  const statusPollRef = useRef<number | null>(null);
  const authCopyTimeoutRef = useRef<number | null>(null);
  const previousOpenRef = useRef(false);
  const previousEntryNameRef = useRef<string | null>(null);

  const stopStatusPolling = () => {
    if (statusPollRef.current !== null) {
      window.clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    }
  };

  useEffect(() => {
    const normalized = normalizeDirectoryPath(props.projectDir ?? "");
    const collapsed = normalized.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
    setResolvedDir(collapsed);
  }, [props.projectDir]);

  useEffect(() => {
    return () => {
      stopStatusPolling();
      if (authCopyTimeoutRef.current !== null) {
        window.clearTimeout(authCopyTimeoutRef.current);
        authCopyTimeoutRef.current = null;
      }
    };
  }, []);

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

  const handleCopyAuthorizationUrl = async () => {
    if (!authorizationUrl) return;

    try {
      await navigator.clipboard.writeText(authorizationUrl);
      setAuthUrlCopied(true);
      if (authCopyTimeoutRef.current !== null) {
        window.clearTimeout(authCopyTimeoutRef.current);
      }
      authCopyTimeoutRef.current = window.setTimeout(() => {
        setAuthUrlCopied(false);
        authCopyTimeoutRef.current = null;
      }, 2_000);
    } catch {
      // ignore clipboard failures
    }
  };

  const fetchMcpStatus = async (slug: string) => {
    if (!props.entry || !props.client) return null;

    try {
      const directory = resolvedDir.trim();
      if (!directory) return null;
      const result = await props.client.mcp.status({ directory });
      const status = result.data?.[slug] as McpStatusEntry | undefined;
      return status ?? null;
    } catch {
      return null;
    }
  };

  const resolveDirectory = async () => {
    const current = resolvedDir.trim();
    if (current) return current;
    if (!props.client) return "";

    try {
      const info = unwrap(await props.client.path.get());
      const normalized = normalizeDirectoryPath(info.directory ?? "");
      const collapsed = normalized.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
      if (collapsed) {
        setResolvedDir(collapsed);
      }
      return collapsed;
    } catch {
      return "";
    }
  };

  const resolveSlug = (name: string) =>
    validateMcpServerName(name).toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const waitForMcpAvailability = async (slug: string) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < MCP_AUTH_DISCOVERY_TIMEOUT_MS) {
      const status = await fetchMcpStatus(slug);
      if (status) return status;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    return null;
  };

  const startStatusPolling = (slug: string) => {
    if (typeof window === "undefined") return;

    stopStatusPolling();
    const startedAt = Date.now();
    statusPollRef.current = window.setInterval(async () => {
      if (Date.now() - startedAt >= MCP_AUTH_TIMEOUT_MS) {
        stopStatusPolling();
        setError(translate("mcp.auth.request_timed_out"));
        return;
      }

      const status = await fetchMcpStatus(slug);
      if (status?.status === "connected") {
        setAlreadyConnected(true);
        setError(null);
        stopStatusPolling();
      }
    }, MCP_AUTH_POLL_INTERVAL_MS);
  };

  const startAuth = async (forceRetry = false, allowAutoReload = true) => {
    if (!props.entry || !props.client) return;

    let slug = "";
    try {
      slug = resolveSlug(props.entry.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");
      setError(message);
      setLoading(false);
      setAuthInProgress(false);
      return;
    }

    if (!forceRetry && authInProgress) {
      return;
    }

    setError(null);
    setNeedsReload(false);
    setAlreadyConnected(false);
    stopStatusPolling();
    setAuthorizationUrl(null);
    setCallbackInput("");
    setReloadNotice(null);
    setLoading(true);
    setAuthInProgress(true);

    try {
      const directory = await resolveDirectory();
      if (!directory) {
        setError(translate("mcp.pick_workspace_first"));
        return;
      }

      const statusEntry = await fetchMcpStatus(slug);
      if (props.reloadRequired && !reloadSatisfied && !statusEntry) {
        setNeedsReload(true);
        setReloadNotice(
          props.reloadBlocked
            ? translate("mcp.auth.reload_blocked")
            : translate("mcp.auth.reload_notice"),
        );
        return;
      }

      if (statusEntry?.status === "connected") {
        setAlreadyConnected(true);
        return;
      }

      if (!props.isRemoteWorkspace) {
        const result = await props.client.mcp.auth.authenticate({
          name: slug,
          directory,
        });
        const status = unwrap(result) as McpStatusEntry;

        if (status.status === "connected") {
          setAlreadyConnected(true);
          await props.onComplete();
          return;
        }

        if (status.status === "needs_client_registration") {
          setError(status.error ?? translate("mcp.auth.client_registration_required"));
        } else if (status.status === "disabled") {
          setError(translate("mcp.auth.server_disabled"));
        } else if (status.status === "failed") {
          setError(status.error ?? translate("mcp.auth.oauth_failed"));
        } else {
          setError(translate("mcp.auth.authorization_still_required"));
        }
        return;
      }

      const authResult = await props.client.mcp.auth.start({
        name: slug,
        directory,
      });
      const auth = unwrap(authResult) as { authorizationUrl?: string };

      if (!auth.authorizationUrl) {
        setAlreadyConnected(true);
        return;
      }

      setAuthorizationUrl(auth.authorizationUrl);
      await openAuthorizationUrl(auth.authorizationUrl);
      startStatusPolling(slug);
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");

      if (message.toLowerCase().includes("does not support oauth")) {
        const serverSlug = props.entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "server";
        const canAutoReload =
          allowAutoReload && !props.isRemoteWorkspace && !props.reloadBlocked && Boolean(props.onReloadEngine);

        if (canAutoReload && props.onReloadEngine) {
          await props.onReloadEngine();
          await startAuth(true, false);
          return;
        }

        if (props.reloadRequired && !reloadSatisfied) {
          setReloadNotice(
            props.reloadBlocked
              ? translate("mcp.auth.reload_blocked")
              : translate("mcp.auth.reload_notice"),
          );
        } else {
          setError(
            `${message}\n\n${translate("mcp.auth.oauth_not_supported_hint", { server: serverSlug })}`,
          );
        }
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

  const isInvalidRefreshToken = () => {
    if (!error) return false;
    const normalized = error.toLowerCase();
    return (
      normalized.includes("invalidgranterror") ||
      normalized.includes("invalid refresh token") ||
      normalized.includes("invalid_refresh_token")
    );
  };

  const handleCliReauth = async () => {
    if (!props.entry || cliAuthBusy || props.isRemoteWorkspace || !isTauriRuntime()) return;

    setCliAuthBusy(true);
    setCliAuthResult(null);

    try {
      const result = await opencodeMcpAuth(props.projectDir, props.entry.name);
      if (result.ok) {
        setError(null);
        setNeedsReload(true);
        setReloadNotice(translate("mcp.auth.oauth_completed_reload"));
      } else {
        setCliAuthResult(result.stderr || result.stdout || translate("mcp.auth.reauth_failed"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.reauth_failed");
      setCliAuthResult(message);
    } finally {
      setCliAuthBusy(false);
    }
  };

  useEffect(() => {
    if (!props.open || !props.entry || !props.client) {
      previousOpenRef.current = props.open;
      previousEntryNameRef.current = props.entry?.name ?? null;
      return;
    }

    const previousEntryName = previousEntryNameRef.current;
    const isInitialOpen = !previousOpenRef.current;
    const entryChanged = previousEntryName !== props.entry.name;

    if (isInitialOpen || entryChanged) {
      setReloadSatisfied(false);
    }

    previousOpenRef.current = props.open;
    previousEntryNameRef.current = props.entry.name;

    if (props.reloadRequired && !reloadSatisfied) {
      setAwaitingReload(true);
      return;
    }

    void startAuth(false);
  }, [props.open, props.entry, props.client, props.reloadRequired]);

  useEffect(() => {
    if (!props.open || !awaitingReload || props.reloadBlocked || !props.onReloadEngine || !props.entry || reloadStarting) {
      return;
    }

    let cancelled = false;

    void (async () => {
      setReloadStarting(true);
      setError(null);
      setNeedsReload(false);
      setReloadNotice(null);

      try {
        await props.onReloadEngine?.();
        if (cancelled) return;

        const slug = resolveSlug(props.entry!.name);
        const status = await waitForMcpAvailability(slug);
        if (cancelled) return;

        if (!status) {
          setAwaitingReload(false);
          setNeedsReload(true);
          setReloadNotice(
            props.reloadBlocked
              ? translate("mcp.auth.reload_blocked")
              : translate("mcp.auth.reload_notice"),
          );
          return;
        }

        setReloadSatisfied(true);
        setAwaitingReload(false);
        await startAuth(false, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : translate("mcp.auth.reload_failed");
        if (cancelled) return;
        setAwaitingReload(false);
        setNeedsReload(true);
        setError(message);
      } finally {
        if (!cancelled) {
          setReloadStarting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [props.open, awaitingReload, props.reloadBlocked, props.onReloadEngine, props.entry, reloadStarting]);

  const handleRetry = () => {
    void startAuth(true);
  };

  const handleReloadAndRetry = async () => {
    if (!props.onReloadEngine) return;
    if (props.isRemoteWorkspace && typeof window !== "undefined") {
      const proceed = window.confirm(translate("mcp.auth.reload_remote_confirm"));
      if (!proceed) return;
    }
    await props.onReloadEngine();
    await startAuth(true);
  };

  const handleForceStopSession = async (sessionID: string) => {
    if (!props.onForceStopSession || forceStopBusySessionID) return;
    setForceStopBusySessionID(sessionID);
    try {
      await props.onForceStopSession(sessionID);
    } finally {
      setForceStopBusySessionID(null);
    }
  };

  const handleClose = () => {
    setError(null);
    setLoading(false);
    setAlreadyConnected(false);
    setNeedsReload(false);
    setAuthInProgress(false);
    setStatusChecking(false);
    setAuthorizationUrl(null);
    setCallbackInput("");
    setManualAuthBusy(false);
    setReloadNotice(null);
    setCliAuthBusy(false);
    setCliAuthResult(null);
    setAwaitingReload(false);
    setReloadStarting(false);
    setReloadSatisfied(false);
    setForceStopBusySessionID(null);
    stopStatusPolling();
    props.onClose();
  };

  const parseAuthCode = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const match = trimmed.match(/[?&]code=([^&]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }

    if (/^https?:\/\//i.test(trimmed) || trimmed.includes("localhost") || trimmed.includes("127.0.0.1")) {
      return null;
    }

    return trimmed;
  };

  const handleManualComplete = async () => {
    if (!props.entry || !props.client) return;

    let slug = "";
    try {
      slug = resolveSlug(props.entry.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.failed_to_start_oauth");
      setError(message);
      return;
    }

    const code = parseAuthCode(callbackInput);
    if (!code) {
      setError(translate("mcp.auth.callback_invalid"));
      return;
    }

    setManualAuthBusy(true);
    setError(null);
    stopStatusPolling();

    try {
      const directory = await resolveDirectory();
      if (!directory) {
        setError(translate("mcp.pick_workspace_first"));
        return;
      }

      const result = await props.client.mcp.auth.callback({
        name: slug,
        directory,
        code,
      });
      const status = unwrap(result) as McpStatusEntry;
      if (status.status === "connected") {
        setAlreadyConnected(true);
        setManualAuthBusy(false);
        await props.onComplete();
        return;
      }

      if (status.status === "needs_client_registration") {
        setError(status.error ?? translate("mcp.auth.client_registration_required"));
      } else if (status.status === "disabled") {
        setError(translate("mcp.auth.server_disabled"));
      } else if (status.status === "failed") {
        setError(status.error ?? translate("mcp.auth.oauth_failed"));
      } else {
        setError(translate("mcp.auth.authorization_still_required"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : translate("mcp.auth.oauth_failed");
      setError(message);
    } finally {
      setManualAuthBusy(false);
    }
  };

  const handleComplete = async () => {
    if (!props.entry || !props.client) return;

    setError(null);
    setStatusChecking(true);

    let slug = "";
    try {
      slug = resolveSlug(props.entry.name);
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

  if (!props.open) return null;

  const isBusy = loading || statusChecking || manualAuthBusy;
  const isPreparingReload = awaitingReload || reloadStarting;
  const serverName = props.entry?.name ?? "MCP Server";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-1/60 backdrop-blur-sm" onClick={handleClose} />

      <div
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-gray-6 bg-gray-2 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-6 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-12">
              {translate("mcp.auth.connect_server", { server: serverName })}
            </h2>
            <p className="text-sm text-gray-11">{translate("mcp.auth.open_browser_signin")}</p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
            onClick={handleClose}
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          {isBusy ? (
            <div className="space-y-4 rounded-xl border border-gray-6/60 bg-gray-1/40 px-5 py-6 text-center">
              <div className="flex items-center justify-center">
                <Loader2 size={32} className="animate-spin text-gray-11" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-12">{translate("mcp.auth.waiting_authorization")}</p>
                <p className="text-xs text-gray-10">{translate("mcp.auth.follow_browser_steps")}</p>
                <button
                  type="button"
                  className="text-xs text-gray-10 underline underline-offset-2 transition-colors hover:text-gray-11"
                  onClick={handleRetry}
                >
                  {translate("mcp.auth.reopen_browser_link")}
                </button>
              </div>
            </div>
          ) : null}

          {!isBusy && isPreparingReload ? (
            <div className="space-y-4 rounded-xl border border-amber-6/60 bg-amber-2/40 px-5 py-6 text-center">
              <div className="flex items-center justify-center">
                <Loader2 size={32} className="animate-spin text-amber-11" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-12">
                  {props.reloadBlocked
                    ? translate("mcp.auth.waiting_for_conversation_title")
                    : translate("mcp.auth.applying_changes_title")}
                </p>
                <p className="text-xs text-gray-10">
                  {props.reloadBlocked
                    ? translate("mcp.auth.waiting_for_conversation_body")
                    : translate("mcp.auth.applying_changes_body")}
                </p>
              </div>
              {props.reloadBlocked && (props.activeSessions?.length ?? 0) > 0 ? (
                <div className="space-y-2 text-left">
                  {(props.activeSessions ?? []).map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-amber-6/50 bg-amber-1/40 px-3 py-2"
                    >
                      <span className="text-xs text-gray-11">
                        {translate("mcp.auth.waiting_for_session", { session: session.title })}
                      </span>
                      <button
                        type="button"
                        className="text-xs text-amber-11 underline underline-offset-2 transition-colors hover:text-amber-12 disabled:no-underline disabled:opacity-60"
                        onClick={() => void handleForceStopSession(session.id)}
                        disabled={forceStopBusySessionID === session.id}
                      >
                        {forceStopBusySessionID === session.id
                          ? translate("mcp.auth.force_stopping")
                          : translate("mcp.auth.force_stop")}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {!isBusy && alreadyConnected ? (
            <div className="space-y-4 rounded-xl border border-green-7/20 bg-green-7/10 p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-7/20">
                  <CheckCircle2 size={24} className="text-green-11" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-12">{translate("mcp.auth.already_connected")}</p>
                  <p className="text-xs text-gray-11">
                    {translate("mcp.auth.already_connected_description", { server: serverName })}
                  </p>
                </div>
              </div>
              <p className="text-xs text-gray-10">{translate("mcp.auth.configured_previously")}</p>
            </div>
          ) : null}

          {reloadNotice ? (
            <div className="space-y-3 rounded-xl border border-gray-6/70 bg-gray-1/50 p-4">
              <p className="text-sm text-gray-11">{reloadNotice}</p>

              <div className="flex flex-wrap gap-2 pt-1">
                {props.onReloadEngine ? (
                  <Button
                    variant="secondary"
                    onClick={() => void handleReloadAndRetry()}
                    disabled={props.reloadBlocked}
                    title={props.reloadBlocked ? translate("mcp.reload_banner_blocked_hint") : undefined}
                  >
                    <RefreshCcw size={14} />
                    {translate("mcp.auth.reload_engine_retry")}
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={handleRetry}>
                  {translate("mcp.auth.retry_now")}
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="space-y-3 rounded-xl border border-red-7/20 bg-red-7/10 p-4">
              <p className="whitespace-pre-wrap text-sm text-red-11">{error}</p>

              {needsReload ? (
                <div className="flex flex-wrap gap-2 pt-2">
                  {props.onReloadEngine ? (
                    <Button
                      variant="secondary"
                      onClick={() => void handleReloadAndRetry()}
                      disabled={props.reloadBlocked}
                      title={props.reloadBlocked ? translate("mcp.reload_banner_blocked_hint") : undefined}
                    >
                      <RefreshCcw size={14} />
                      {translate("mcp.auth.reload_engine_retry")}
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={handleRetry}>
                    {translate("mcp.auth.retry_now")}
                  </Button>
                </div>
              ) : (
                <div className="pt-2">
                  <Button variant="ghost" onClick={handleRetry}>
                    {translate("mcp.auth.retry")}
                  </Button>
                </div>
              )}

              {isInvalidRefreshToken() ? (
                <div className="space-y-2 pt-2">
                  <p className="text-xs text-red-11">{translate("mcp.auth.invalid_refresh_token")}</p>
                  {!props.isRemoteWorkspace ? (
                    isTauriRuntime() ? (
                      <Button variant="secondary" onClick={() => void handleCliReauth()} disabled={cliAuthBusy}>
                        {cliAuthBusy ? <Loader2 size={14} className="animate-spin" /> : null}
                        {cliAuthBusy
                          ? translate("mcp.auth.reauth_running")
                          : translate("mcp.auth.reauth_action")}
                      </Button>
                    ) : (
                      <div className="text-[11px] text-red-10">
                        {translate("mcp.auth.reauth_cli_hint", { server: serverName })}
                      </div>
                    )
                  ) : (
                    <div className="text-[11px] text-red-10">{translate("mcp.auth.reauth_remote_hint")}</div>
                  )}
                  {cliAuthResult ? <div className="text-[11px] text-red-10">{cliAuthResult}</div> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {!isBusy && authorizationUrl && props.isRemoteWorkspace && !alreadyConnected ? (
            <div className="space-y-3 rounded-xl border border-gray-6/60 bg-gray-1/40 p-4">
              <div className="text-xs font-medium text-gray-12">{translate("mcp.auth.manual_finish_title")}</div>
              <div className="text-xs text-gray-10">{translate("mcp.auth.manual_finish_hint")}</div>
              <div className="flex items-center gap-3 rounded-xl border border-gray-6/70 bg-gray-2/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-wide text-gray-8">
                    {translate("mcp.auth.authorization_link")}
                  </div>
                  <div className="truncate font-mono text-[11px] text-gray-11">{authorizationUrl}</div>
                </div>
                <Button variant="ghost" className="text-xs" onClick={() => void handleCopyAuthorizationUrl()}>
                  {authUrlCopied ? translate("mcp.auth.copied") : translate("mcp.auth.copy_link")}
                </Button>
              </div>
              <TextInput
                label={translate("mcp.auth.callback_label")}
                placeholder={translate("mcp.auth.callback_placeholder")}
                value={callbackInput}
                onChange={(event) => setCallbackInput(event.currentTarget.value)}
              />
              <div className="text-[11px] text-gray-9">{translate("mcp.auth.port_forward_hint")}</div>
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  onClick={() => void handleManualComplete()}
                  disabled={manualAuthBusy || !callbackInput.trim()}
                >
                  {manualAuthBusy ? <Loader2 size={14} className="animate-spin" /> : null}
                  {translate("mcp.auth.complete_connection")}
                </Button>
              </div>
            </div>
          ) : null}

          {!isBusy && !isPreparingReload && !error && !reloadNotice && !alreadyConnected ? (
            <>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-4 text-xs font-medium text-gray-11">
                    1
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-12">{translate("mcp.auth.step1_title")}</p>
                    <p className="mt-1 text-xs text-gray-10">
                      {translate("mcp.auth.step1_description", { server: serverName })}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-4 text-xs font-medium text-gray-11">
                    2
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-12">{translate("mcp.auth.step2_title")}</p>
                    <p className="mt-1 text-xs text-gray-10">{translate("mcp.auth.step2_description")}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-4 text-xs font-medium text-gray-11">
                    3
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-12">{translate("mcp.auth.step3_title")}</p>
                    <p className="mt-1 text-xs text-gray-10">{translate("mcp.auth.step3_description")}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-11">
                <div className="space-y-3">
                  <p>{translate("mcp.auth.waiting_authorization")}</p>
                  <p className="text-xs text-gray-10">{translate("mcp.auth.follow_browser_steps")}</p>
                  <button
                    type="button"
                    className="text-left text-xs text-gray-10 underline underline-offset-2 transition-colors hover:text-gray-11"
                    onClick={handleRetry}
                  >
                    {translate("mcp.auth.reopen_browser_link")}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-gray-6 bg-gray-2/50 px-6 py-4">
          {alreadyConnected ? (
            <Button variant="primary" onClick={() => void handleComplete()}>
              <CheckCircle2 size={16} />
              {translate("mcp.auth.done")}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={handleClose}>
                {translate("mcp.auth.cancel")}
              </Button>
              <Button variant="secondary" onClick={() => void handleComplete()}>
                <CheckCircle2 size={16} />
                {translate("mcp.auth.im_done")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
