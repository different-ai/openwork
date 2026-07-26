/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  FlaskConical,
  Loader2,
  LogOut,
  Server,
  TerminalSquare,
} from "lucide-react";

import type {
  OpenworkAgentRuntime,
  OpenworkAgentRuntimeStatus,
  OpenworkCodexDeviceLogin,
  OpenworkServerClient,
} from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsNotice, SettingsStatusBadge } from "./settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
} from "./settings-layout";

type CodexRuntimeSectionProps = {
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  remote: boolean;
  onOpenExternal: (url: string) => void;
  onRuntimeChanged: (status: OpenworkAgentRuntimeStatus) => void | Promise<void>;
};

function runtimeCardClass(selected: boolean) {
  return cn(
    "rounded-2xl border px-4 py-4 transition-colors",
    selected ? "border-blue-7 bg-blue-2/40" : "border-dls-border bg-dls-sidebar/20",
  );
}

function accountLabel(status: OpenworkAgentRuntimeStatus) {
  if (!status.account.connected) return "ChatGPT not connected";
  const identity = status.account.email || status.account.planType;
  return identity ? `ChatGPT connected · ${identity}` : "ChatGPT connected";
}

export function CodexRuntimeSection(props: CodexRuntimeSectionProps) {
  const [status, setStatus] = useState<OpenworkAgentRuntimeStatus | null>(null);
  const [login, setLogin] = useState<OpenworkCodexDeviceLogin | null>(null);
  const [busy, setBusy] = useState<"load" | "runtime" | "login" | "logout" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!props.client || !props.workspaceId || !props.remote) return null;
    try {
      const next = await props.client.getAgentRuntime(props.workspaceId);
      setStatus(next);
      setError(next.error);
      return next;
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Unable to read the worker runtime");
      return null;
    }
  }, [props.client, props.remote, props.workspaceId]);

  useEffect(() => {
    if (!props.remote) return;
    setBusy("load");
    void refresh().finally(() => setBusy(null));
  }, [props.remote, refresh]);

  useEffect(() => {
    if (!login || !props.client || !props.workspaceId) return;
    let cancelled = false;
    const poll = async () => {
      const next = await refresh();
      if (cancelled || !next?.account.connected) return;
      setLogin(null);
      await props.onRuntimeChanged(next);
    };
    const timer = window.setInterval(() => { void poll(); }, 2_000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [login, props.client, props.onRuntimeChanged, props.workspaceId, refresh]);

  if (!props.remote) return null;

  const selectRuntime = async (runtime: OpenworkAgentRuntime) => {
    if (!props.client || !props.workspaceId || busy) return;
    setBusy("runtime");
    setError(null);
    try {
      const next = await props.client.setAgentRuntime(props.workspaceId, runtime);
      setStatus(next);
      setLogin(null);
      await props.onRuntimeChanged(next);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : "Unable to change the worker runtime");
    } finally {
      setBusy(null);
    }
  };

  const startLogin = async () => {
    if (!props.client || !props.workspaceId || busy) return;
    setBusy("login");
    setError(null);
    try {
      const next = await props.client.startCodexDeviceLogin(props.workspaceId);
      setLogin(next);
      props.onOpenExternal(next.verificationUrl);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Unable to start ChatGPT sign-in");
    } finally {
      setBusy(null);
    }
  };

  const cancelLogin = async () => {
    if (!props.client || !props.workspaceId || !login || busy) return;
    setBusy("cancel");
    try {
      await props.client.cancelCodexDeviceLogin(props.workspaceId, login.loginId);
      setLogin(null);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Unable to cancel ChatGPT sign-in");
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    if (!props.client || !props.workspaceId || busy) return;
    setBusy("logout");
    setError(null);
    try {
      const next = await props.client.logoutCodex(props.workspaceId);
      setStatus(next);
      await props.onRuntimeChanged(next);
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : "Unable to disconnect ChatGPT");
    } finally {
      setBusy(null);
    }
  };

  const copyCode = async () => {
    if (!login) return;
    await navigator.clipboard.writeText(login.userCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const codexSelected = status?.runtime === "codex";
  const processHealthy = codexSelected && status?.process.healthy === true;

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>
          Agent runtime
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-6 bg-amber-2 px-2 py-0.5 text-[10px] font-medium text-amber-11">
            <FlaskConical className="size-3" /> Experimental
          </span>
        </LayoutSectionTitle>
        <LayoutSectionDescription>
          Choose which agent runs tasks on this remote worker. Your laptop only controls the session.
        </LayoutSectionDescription>
      </LayoutSectionHeader>

      <div className="grid gap-3 md:grid-cols-2">
        <button
          type="button"
          className={runtimeCardClass(status?.runtime !== "codex")}
          disabled={Boolean(busy)}
          onClick={() => void selectRuntime("opencode")}
        >
          <div className="flex items-start gap-3 text-left">
            <TerminalSquare className="mt-0.5 size-5 shrink-0 text-dls-text" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                OpenCode
                {status?.runtime !== "codex" ? <CheckCircle2 className="size-4 text-emerald-10" /> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Default OpenWork runtime and provider ecosystem.</p>
            </div>
          </div>
        </button>

        <button
          type="button"
          className={runtimeCardClass(codexSelected)}
          disabled={Boolean(busy) || status?.available === false}
          onClick={() => void selectRuntime("codex")}
        >
          <div className="flex items-start gap-3 text-left">
            <Server className="mt-0.5 size-5 shrink-0 text-blue-10" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                Codex Server
                {codexSelected ? <CheckCircle2 className="size-4 text-emerald-10" /> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Codex app-server using your ChatGPT subscription.</p>
            </div>
          </div>
        </button>
      </div>

      {busy === "load" && !status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading worker runtime…
        </div>
      ) : null}

      {codexSelected && status ? (
        <LayoutSectionItem className="rounded-2xl border border-dls-border px-4 py-4">
          <LayoutSectionItemHeader>
            <div>
              <LayoutSectionItemTitle>
                Codex on remote worker
                <SettingsStatusBadge
                  tone={processHealthy ? "ready" : "warning"}
                  label={processHealthy ? "Healthy" : "Unavailable"}
                />
              </LayoutSectionItemTitle>
              <LayoutSectionItemDescription>{accountLabel(status)}</LayoutSectionItemDescription>
            </div>
            <LayoutSectionItemHeaderActions>
              {status.account.connected ? (
                <Button variant="outline" disabled={Boolean(busy)} onClick={() => void logout()}>
                  {busy === "logout" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <LogOut className="mr-1.5 size-3.5" />}
                  Disconnect
                </Button>
              ) : (
                <Button disabled={Boolean(busy) || !processHealthy} onClick={() => void startLogin()}>
                  {busy === "login" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                  Connect ChatGPT
                </Button>
              )}
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>

          <div className="grid gap-2 rounded-xl bg-dls-sidebar/45 px-3 py-3 text-xs text-muted-foreground sm:grid-cols-2">
            <div><span className="text-dls-text">Runtime:</span> Codex app-server</div>
            <div><span className="text-dls-text">Location:</span> Remote worker</div>
            <div><span className="text-dls-text">Transport:</span> stdio (private)</div>
            <div><span className="text-dls-text">Public control port:</span> None</div>
            <div className="sm:col-span-2"><span className="text-dls-text">Version:</span> {status.version || "Unknown"}</div>
          </div>
        </LayoutSectionItem>
      ) : null}

      {login ? (
        <LayoutSectionItem className="rounded-2xl border border-blue-6 bg-blue-2/35 px-4 py-4">
          <LayoutSectionItemHeader>
            <div>
              <LayoutSectionItemTitle>Finish signing in to ChatGPT</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                Enter this one-time code on the OpenAI device sign-in page. Credentials stay on the worker.
              </LayoutSectionItemDescription>
            </div>
          </LayoutSectionItemHeader>
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded-lg border border-blue-6 bg-background px-4 py-2 text-lg font-semibold tracking-[0.2em] text-dls-text">
              {login.userCode}
            </code>
            <Button variant="outline" onClick={() => void copyCode()}>
              {copied ? <Check className="mr-1.5 size-3.5" /> : <Clipboard className="mr-1.5 size-3.5" />}
              {copied ? "Copied" : "Copy code"}
            </Button>
            <Button variant="outline" onClick={() => props.onOpenExternal(login.verificationUrl)}>
              <ExternalLink className="mr-1.5 size-3.5" /> Open sign-in page
            </Button>
            <Button variant="ghost" disabled={busy === "cancel"} onClick={() => void cancelLogin()}>
              Cancel
            </Button>
          </div>
          <div className="flex items-center gap-2 text-xs text-blue-11">
            <Loader2 className="size-3.5 animate-spin" /> Waiting for ChatGPT authorization…
          </div>
        </LayoutSectionItem>
      ) : null}

      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
    </LayoutSection>
  );
}
