/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCcw } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { McpDirectoryInfo } from "@/app/constants";
import { opencodeMcpAuth } from "@/app/lib/desktop";
import { unwrap } from "@/app/lib/opencode";
import { getMcpIdentityKey, validateMcpServerName } from "@/app/mcp";
import type { Client } from "@/app/types";
import { isDesktopRuntime, normalizeDirectoryPath } from "@/app/utils";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { resolveMcpStatusByIdentity } from "./mcp-status-synchronization";

const MCP_AUTH_DISCOVERY_TIMEOUT_MS = 15_000;

type McpStatusEntry = {
  status?: string;
  error?: string;
};

function isSlackMcpEntry(entry: McpDirectoryInfo, slug: string): boolean {
  return slug === "slack" || entry.serverName === "slack" || entry.url === "https://mcp.slack.com/mcp";
}

function isDynamicClientRegistrationError(message: string | undefined): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return normalized.includes("dynamic client registration") && normalized.includes("does not support");
}

function readStatusError(status: unknown): string | undefined {
  if (!status || typeof status !== "object" || !("error" in status)) return undefined;
  return typeof status.error === "string" ? status.error : undefined;
}

export type McpAuthModalProps = {
  open: boolean;
  onClose: () => void;
  onAuthenticated?: (name: string) => void;
  onComplete: () => void | Promise<void>;
  onReloadEngine?: () => void | Promise<void>;
  reloadRequired?: boolean;
  reloadBlocked?: boolean;
  activeSessions?: Array<{ id: string; title: string }>;
  client: Client | null;
  entry: McpDirectoryInfo | null;
  projectDir: string;
  onForceStopSession?: (sessionID: string) => void | Promise<void>;
};

export function McpAuthModal(props: McpAuthModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [alreadyConnected, setAlreadyConnected] = useState(false);
  const [authInProgress, setAuthInProgress] = useState(false);
  const [statusChecking, setStatusChecking] = useState(false);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);
  const [cliAuthBusy, setCliAuthBusy] = useState(false);
  const [cliAuthResult, setCliAuthResult] = useState<string | null>(null);
  const [resolvedDir, setResolvedDir] = useState("");
  const [awaitingReload, setAwaitingReload] = useState(false);
  const [reloadStarting, setReloadStarting] = useState(false);
  const [reloadSatisfied, setReloadSatisfied] = useState(false);
  const [forceStopBusySessionID, setForceStopBusySessionID] = useState<string | null>(null);

  const previousOpenRef = useRef(false);
  const previousEntryNameRef = useRef<string | null>(null);
  const reloadAuthRunRef = useRef(false);

  useEffect(() => {
    const normalized = normalizeDirectoryPath(props.projectDir ?? "");
    const collapsed = normalized.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
    setResolvedDir(collapsed);
  }, [props.projectDir]);

  const fetchMcpStatus = async (slug: string) => {
    if (!props.entry || !props.client) return null;

    try {
      const directory = resolvedDir.trim();
      if (!directory) return null;
      const result = await props.client.mcp.status({ directory });
      const status = resolveMcpStatusByIdentity(result.data ?? {}, [
        slug,
        props.entry.serverName,
        props.entry.name,
      ]);
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

  const resolveSlug = (entry: McpDirectoryInfo) => validateMcpServerName(getMcpIdentityKey(entry));

  const markAuthenticated = (slug: string) => {
    setAlreadyConnected(true);
    props.onAuthenticated?.(slug);
  };

  const waitForMcpAvailability = async (slug: string) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < MCP_AUTH_DISCOVERY_TIMEOUT_MS) {
      const status = await fetchMcpStatus(slug);
      if (status) return status;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    return null;
  };

  const startAuth = async (forceRetry = false, allowAutoReload = true) => {
    if (!props.entry || !props.client) return;

    let slug = "";
    try {
      slug = resolveSlug(props.entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("mcp.auth.failed_to_start_oauth");
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
    setReloadNotice(null);
    setLoading(true);
    setAuthInProgress(true);

    try {
      const directory = await resolveDirectory();
      if (!directory) {
        setError(t("mcp.pick_workspace_first"));
        return;
      }

      const statusEntry = await fetchMcpStatus(slug);
      if (isSlackMcpEntry(props.entry, slug) && isDynamicClientRegistrationError(readStatusError(statusEntry))) {
        setError(t("mcp.auth.slack_client_registration_required"));
        return;
      }
      if (props.reloadRequired && !reloadSatisfied && !statusEntry) {
        setNeedsReload(true);
        setReloadNotice(
          props.reloadBlocked
            ? t("mcp.auth.reload_blocked")
            : t("mcp.auth.reload_notice"),
        );
        return;
      }

      if (statusEntry?.status === "connected") {
        markAuthenticated(slug);
        return;
      }

      const result = await props.client.mcp.auth.authenticate({
        name: slug,
        directory,
      });
      const status = unwrap(result) as McpStatusEntry;

      if (status.status === "connected") {
        markAuthenticated(slug);
        await props.onComplete();
        return;
      }

      if (status.status === "needs_client_registration") {
        setError(status.error ?? t("mcp.auth.client_registration_required"));
      } else if (status.status === "disabled") {
        setError(t("mcp.auth.server_disabled"));
      } else if (status.status === "failed") {
        setError(status.error ?? t("mcp.auth.oauth_failed"));
      } else {
        setError(t("mcp.auth.authorization_still_required"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("mcp.auth.failed_to_start_oauth");

      if (isSlackMcpEntry(props.entry, slug) && isDynamicClientRegistrationError(message)) {
        setNeedsReload(false);
        setError(t("mcp.auth.slack_client_registration_required"));
      } else if (message.toLowerCase().includes("does not support oauth")) {
        const serverSlug = props.entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "server";
        const canAutoReload =
          allowAutoReload && !props.reloadBlocked && Boolean(props.onReloadEngine);

        if (canAutoReload && props.onReloadEngine) {
          await props.onReloadEngine();
          await startAuth(true, false);
          return;
        }

        if (props.reloadRequired && !reloadSatisfied) {
          setReloadNotice(
            props.reloadBlocked
              ? t("mcp.auth.reload_blocked")
              : t("mcp.auth.reload_notice"),
          );
        } else {
          setError(
            `${message}\n\n${t("mcp.auth.oauth_not_supported_hint", { server: serverSlug })}`,
          );
        }
        setNeedsReload(true);
      } else if (message.toLowerCase().includes("not found") || message.toLowerCase().includes("unknown")) {
        setNeedsReload(true);
        setError(t("mcp.auth.try_reload_engine", { message }));
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
    if (!props.entry || cliAuthBusy || !isDesktopRuntime()) return;

    setCliAuthBusy(true);
    setCliAuthResult(null);

    try {
      const result = await opencodeMcpAuth(props.projectDir, props.entry.name) as { ok: boolean; stderr?: string; stdout?: string };
      if (result.ok) {
        setError(null);
        setNeedsReload(true);
        setReloadNotice(t("mcp.auth.oauth_completed_reload"));
      } else {
        setCliAuthResult(result.stderr || result.stdout || t("mcp.auth.reauth_failed"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t("mcp.auth.reauth_failed");
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
    if (!props.open || !awaitingReload || props.reloadBlocked || !props.onReloadEngine || !props.entry || reloadAuthRunRef.current) {
      return;
    }

    let cancelled = false;

    void (async () => {
      reloadAuthRunRef.current = true;
      setReloadStarting(true);
      setError(null);
      setNeedsReload(false);
      setReloadNotice(null);

      try {
        await props.onReloadEngine?.();
        if (cancelled) return;

        const slug = resolveSlug(props.entry!);
        const status = await waitForMcpAvailability(slug);
        if (cancelled) return;

        if (!status) {
          setAwaitingReload(false);
          setNeedsReload(true);
          setReloadNotice(
            props.reloadBlocked
              ? t("mcp.auth.reload_blocked")
              : t("mcp.auth.reload_notice"),
          );
          return;
        }

        setReloadSatisfied(true);
        setAwaitingReload(false);
        await startAuth(false, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : t("mcp.auth.reload_failed");
        if (cancelled) return;
        setAwaitingReload(false);
        setNeedsReload(true);
        setError(message);
      } finally {
        reloadAuthRunRef.current = false;
        if (!cancelled) {
          setReloadStarting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      reloadAuthRunRef.current = false;
    };
  }, [props.open, awaitingReload, props.reloadBlocked, props.onReloadEngine, props.entry]);

  const handleRetry = () => {
    void startAuth(true);
  };

  const handleReloadAndRetry = async () => {
    if (!props.onReloadEngine) return;
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
    setReloadNotice(null);
    setCliAuthBusy(false);
    setCliAuthResult(null);
    setAwaitingReload(false);
    setReloadStarting(false);
    setReloadSatisfied(false);
    setForceStopBusySessionID(null);
    props.onClose();
  };

  const handleComplete = async () => {
    if (!props.entry || !props.client) return;

    setError(null);
    setStatusChecking(true);

    let slug = "";
    try {
      slug = resolveSlug(props.entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : t("mcp.auth.failed_to_start_oauth");
      setError(message);
      setStatusChecking(false);
      return;
    }

    const statusEntry = await fetchMcpStatus(slug);
    if (statusEntry?.status === "connected") {
      markAuthenticated(slug);
      setStatusChecking(false);
      await props.onComplete();
      return;
    }

    if (statusEntry?.status === "needs_client_registration") {
      setError(statusEntry.error ?? t("mcp.auth.client_registration_required"));
    } else if (statusEntry?.status === "disabled") {
      setError(t("mcp.auth.server_disabled"));
    } else if (statusEntry?.status === "failed") {
      setError(statusEntry.error ?? t("mcp.auth.oauth_failed"));
    } else {
      setError(t("mcp.auth.authorization_still_required"));
    }

    setStatusChecking(false);
  };

  const isBusy = loading || statusChecking;
  const isPreparingReload = awaitingReload || reloadStarting;
  const serverName = props.entry?.name ?? "MCP Server";

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("mcp.auth.connect_server", { server: serverName })}
          </DialogTitle>
          <DialogDescription>{t("mcp.auth.open_browser_signin")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
          {isBusy ? (
            <div className="space-y-4 rounded-xl border border-gray-6/60 bg-gray-1/40 px-5 py-6 text-center">
              <div className="flex items-center justify-center">
                <Loader2 size={32} className="animate-spin text-gray-11" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-12">{t("mcp.auth.waiting_authorization")}</p>
                <p className="text-xs text-gray-10">{t("mcp.auth.follow_browser_steps")}</p>
                <button
                  type="button"
                  className="text-xs text-gray-10 underline underline-offset-2 transition-colors hover:text-gray-11"
                  onClick={handleRetry}
                >
                  {t("mcp.auth.reopen_browser_link")}
                </button>
              </div>
            </div>
          ) : null}

          {!isBusy && isPreparingReload ? (
            <div className="space-y-4 rounded-xl border border-border bg-muted/30 px-5 py-6 text-center">
              <div className="flex items-center justify-center">
                <Loader2 size={32} className="animate-spin text-amber-11" />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-12">
                  {props.reloadBlocked
                    ? t("mcp.auth.waiting_for_conversation_title")
                    : t("mcp.auth.applying_changes_title")}
                </p>
                <p className="text-xs text-gray-10">
                  {props.reloadBlocked
                    ? t("mcp.auth.waiting_for_conversation_body")
                    : t("mcp.auth.applying_changes_body")}
                </p>
              </div>
              {props.reloadBlocked && (props.activeSessions?.length ?? 0) > 0 ? (
                <div className="space-y-2 text-left">
                  {(props.activeSessions ?? []).map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                    >
                      <span className="text-xs text-gray-11">
                        {t("mcp.auth.waiting_for_session", { session: session.title })}
                      </span>
                      <button
                        type="button"
                        className="text-xs text-amber-11 underline underline-offset-2 transition-colors hover:text-amber-12 disabled:no-underline disabled:opacity-60"
                        onClick={() => void handleForceStopSession(session.id)}
                        disabled={forceStopBusySessionID === session.id}
                      >
                        {forceStopBusySessionID === session.id
                          ? t("mcp.auth.force_stopping")
                          : t("mcp.auth.force_stop")}
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
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-green-7/20">
                  <CheckCircle2 size={24} className="text-green-11" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-12">{t("mcp.auth.already_connected")}</p>
                  <p className="text-xs text-gray-11">
                    {t("mcp.auth.already_connected_description", { server: serverName })}
                  </p>
                </div>
              </div>
              <p className="text-xs text-gray-10">{t("mcp.auth.configured_previously")}</p>
            </div>
          ) : null}

          {reloadNotice ? (
            <div className="space-y-3 rounded-xl border border-gray-6/70 bg-gray-1/50 p-4">
              <p className="text-sm text-gray-11">{reloadNotice}</p>

              <div className="flex flex-wrap gap-2 pt-1">
                {props.onReloadEngine ? (
                  <Button
                    onClick={() => void handleReloadAndRetry()}
                    disabled={props.reloadBlocked}
                    title={props.reloadBlocked ? t("mcp.reload_banner_blocked_hint") : undefined}
                  >
                    <RefreshCcw size={14} />
                    {t("mcp.auth.reload_engine_retry")}
                  </Button>
                ) : null}
                <Button variant="outline" onClick={handleRetry}>
                  {t("mcp.auth.retry_now")}
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
                      onClick={() => void handleReloadAndRetry()}
                      disabled={props.reloadBlocked}
                      title={props.reloadBlocked ? t("mcp.reload_banner_blocked_hint") : undefined}
                    >
                      <RefreshCcw size={14} />
                      {t("mcp.auth.reload_engine_retry")}
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={handleRetry}>
                    {t("mcp.auth.retry_now")}
                  </Button>
                </div>
              ) : (
                <div className="pt-2">
                  <Button variant="outline" onClick={handleRetry}>
                    {t("mcp.auth.retry")}
                  </Button>
                </div>
              )}

              {isInvalidRefreshToken() ? (
                <div className="space-y-2 pt-2">
                  <p className="text-xs text-red-11">{t("mcp.auth.invalid_refresh_token")}</p>
                  {isDesktopRuntime() ? (
                    <Button onClick={() => void handleCliReauth()} disabled={cliAuthBusy}>
                      {cliAuthBusy ? <Loader2 size={14} className="animate-spin" /> : null}
                      {cliAuthBusy
                        ? t("mcp.auth.reauth_running")
                        : t("mcp.auth.reauth_action")}
                    </Button>
                  ) : (
                    <div className="text-[11px] text-red-10">
                      {t("mcp.auth.reauth_cli_hint", { server: serverName })}
                    </div>
                  )}
                  {cliAuthResult ? <div className="text-[11px] text-red-10">{cliAuthResult}</div> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {!isBusy && !isPreparingReload && !error && !reloadNotice && !alreadyConnected ? (
            <>
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-4 text-xs font-medium text-gray-11">
                    1
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-12">{t("mcp.auth.step1_title")}</p>
                    <p className="mt-1 text-xs text-gray-10">
                      {t("mcp.auth.step1_description", { server: serverName })}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-4 text-xs font-medium text-gray-11">
                    2
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-12">{t("mcp.auth.step2_title")}</p>
                    <p className="mt-1 text-xs text-gray-10">{t("mcp.auth.step2_description")}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-gray-4 text-xs font-medium text-gray-11">
                    3
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-12">{t("mcp.auth.step3_title")}</p>
                    <p className="mt-1 text-xs text-gray-10">{t("mcp.auth.step3_description")}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-11">
                <div className="space-y-3">
                  <p>{t("mcp.auth.waiting_authorization")}</p>
                  <p className="text-xs text-gray-10">{t("mcp.auth.follow_browser_steps")}</p>
                  <button
                    type="button"
                    className="text-left text-xs text-gray-10 underline underline-offset-2 transition-colors hover:text-gray-11"
                    onClick={handleRetry}
                  >
                    {t("mcp.auth.reopen_browser_link")}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0">
          {alreadyConnected ? (
            <Button onClick={() => void handleComplete()}>
              <CheckCircle2 data-icon="inline-start" />
              {t("mcp.auth.done")}
            </Button>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" />}>
                {t("mcp.auth.cancel")}
              </DialogClose>
              <Button onClick={() => void handleComplete()}>
                <CheckCircle2 data-icon="inline-start" />
                {t("mcp.auth.im_done")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
