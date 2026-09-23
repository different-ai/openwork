"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { DenPageHeader } from "../../(den)/_components/ui/page-header";
import { DenButton, buttonVariants } from "../../(den)/_components/ui/button";
import { DenNotice } from "../../(den)/_components/ui/notice";
import { gatewayBrowserEndpoint } from "./gateway-browser-endpoint";

type BrowserStep = "loading" | "sign_in_required" | "account_mismatch" | "ready" | "error" | "blocked" | "restart";

function readString(value: unknown, key: string) {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const entry: unknown = Reflect.get(value, key);
  return typeof entry === "string" ? entry : null;
}

function browserAttempt() {
  const attempt = new URLSearchParams(window.location.search).get("attempt");
  return attempt && /^entry\.[A-Za-z0-9_-]{43}$/.test(attempt) ? attempt : null;
}

export function GatewayConnect() {
  const [step, setStep] = useState<BrowserStep>("loading");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const statusRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const startAttempted = useRef(false);
  const ready = useRef(false);

  const checkStatus = useCallback(async () => {
    if (!mounted.current || actionRequest.current || startAttempted.current) return;
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && statusRequest.current === controller;
    ready.current = false;
    setChecking(true);
    setError(null);
    try {
      const attempt = browserAttempt();
      if (!attempt) {
        setStep("restart");
        setError("This connection link is invalid. Start Connect again in OpenWork.");
        return;
      }
      const endpoint = await gatewayBrowserEndpoint(`/v1/inference-providers/oauth/browser-status?attempt=${encodeURIComponent(attempt)}`);
      if (!current()) return;
      const response = await fetch(endpoint, {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!current()) return;
      if (!response.ok) {
        setStep(response.status === 400 ? "restart" : response.status === 403 ? "blocked" : "error");
        setError(readString(payload, "message") ?? (response.status === 400
          ? "This connection link expired. Start Connect again in OpenWork."
          : response.status === 403
            ? "Connection access is unavailable. Contact your OpenWork administrator."
            : "Could not verify your sign-in. Check your connection and retry."));
        return;
      }
      const status = readString(payload, "status");
      if (status !== "sign_in_required" && status !== "account_mismatch" && status !== "ready") {
        throw new Error("invalid_browser_status");
      }
      ready.current = status === "ready";
      setStep(status);
    } catch {
      if (!current()) return;
      setStep("error");
      setError("Could not verify your sign-in. Check your connection and retry.");
    } finally {
      if (current()) {
        statusRequest.current = null;
        setChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void checkStatus();
    const onFocus = () => void checkStatus();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void checkStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      ready.current = false;
      statusRequest.current?.abort();
      actionRequest.current?.abort();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [checkStatus]);

  useEffect(() => {
    if (step !== "sign_in_required" && step !== "account_mismatch") return;
    let remaining = 40;
    const timer = window.setInterval(() => {
      remaining -= 1;
      if (remaining === 0) window.clearInterval(timer);
      if (!statusRequest.current) void checkStatus();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [checkStatus, step]);

  async function continueToGoogle() {
    if (!mounted.current || !ready.current || actionRequest.current || startAttempted.current) return;
    const controller = new AbortController();
    actionRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && actionRequest.current === controller;
    ready.current = false;
    statusRequest.current?.abort();
    setBusy(true);
    setError(null);
    try {
      const attempt = browserAttempt();
      if (!attempt) {
        setStep("restart");
        setError("This connection link is invalid. Start Connect again in OpenWork.");
        return;
      }
      const endpoint = await gatewayBrowserEndpoint(`/v1/inference-providers/oauth/browser-start?attempt=${encodeURIComponent(attempt)}`);
      if (!current()) return;
      startAttempted.current = true;
      const response = await fetch(endpoint, {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!current()) return;
      if (!response.ok) {
        const code = readString(payload, "error");
        if ((response.status === 401 || response.status === 403) && (code === "browser_signin_required" || code === "browser_account_mismatch")) {
          startAttempted.current = false;
          setStep(code === "browser_signin_required" ? "sign_in_required" : "account_mismatch");
        } else {
          setStep("restart");
          setError("Could not continue this connection. Start Connect again in OpenWork.");
        }
        return;
      }
      const authUrl = readString(payload, "authUrl");
      const url = authUrl ? new URL(authUrl) : null;
      if (!url || url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password) {
        throw new Error("invalid_authorization_url");
      }
      window.location.assign(url.toString());
    } catch {
      if (!current()) return;
      setStep(startAttempted.current ? "restart" : "error");
      setError(startAttempted.current
        ? "Could not confirm whether Google sign-in started. Start Connect again in OpenWork."
        : "Could not verify your sign-in. Check your connection and retry.");
    } finally {
      if (current()) {
        actionRequest.current = null;
        setBusy(false);
      }
    }
  }

  async function signOut() {
    if (!mounted.current || actionRequest.current || startAttempted.current) return;
    const controller = new AbortController();
    actionRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && actionRequest.current === controller;
    statusRequest.current?.abort();
    statusRequest.current = null;
    ready.current = false;
    setChecking(false);
    setBusy(true);
    setError(null);
    try {
      const endpoint = await gatewayBrowserEndpoint("/api/auth/sign-out");
      if (!current()) return;
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
      if (!current()) return;
      if (!response.ok) throw new Error("signout_failed");
      actionRequest.current = null;
      setBusy(false);
      await checkStatus();
    } catch {
      if (!current()) return;
      setStep("error");
      setError("Could not confirm sign-out. Retry the sign-in check before changing accounts.");
    } finally {
      if (current()) {
        actionRequest.current = null;
        setBusy(false);
      }
    }
  }

  const title = step === "sign_in_required" ? "Sign in to OpenWork"
    : step === "account_mismatch" ? "Switch OpenWork account"
      : step === "ready" ? "Sign in to Google"
        : step === "blocked" ? "Connection unavailable"
          : step === "restart" ? "Start Connect again"
            : "Could not verify sign-in";

  return (
    <main aria-busy={busy || checking} className="flex min-h-dvh items-center justify-center bg-[var(--dls-surface)] p-4 text-sm text-[var(--dls-text-primary)]">
      <div className="flex w-full max-w-xl flex-col gap-4">
        {step === "loading" ? (
          <div role="status" aria-label="Checking OpenWork sign-in" className="flex flex-col items-start gap-4 motion-safe:animate-pulse">
            <div aria-hidden="true" className="h-6 w-56 rounded bg-[var(--dls-hover)]" />
            <div aria-hidden="true" className="h-10 w-44 rounded-lg bg-[var(--dls-hover)]" />
          </div>
        ) : <DenPageHeader title={title} className="[&_h1]:text-xl [&_h1]:leading-tight [&_h1]:text-[var(--dls-text-primary)]" />}
        {step === "account_mismatch" ? <DenNotice tone="neutral" message={<span className="flex items-start gap-2"><LockKeyhole aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0" />Use the OpenWork account that started Connect.</span>} /> : null}
        {error ? <DenNotice tone={step === "blocked" ? "neutral" : "error"} message={error} /> : null}
        <div className="flex flex-wrap gap-3">
          {step === "sign_in_required" ? <a href="/" target="_blank" rel="noopener noreferrer" className={buttonVariants()}>Sign in to OpenWork</a> : null}
          {step === "ready" ? <DenButton loading={busy} disabled={checking || startAttempted.current} onClick={() => void continueToGoogle()}>Continue to Google</DenButton> : null}
          {step === "account_mismatch" ? <DenButton loading={busy} disabled={checking} onClick={() => void signOut()}>Sign out of this browser account</DenButton> : null}
          {step === "error" || step === "blocked" ? <DenButton loading={checking} onClick={() => void checkStatus()}>Retry sign-in check</DenButton> : null}
        </div>
        {checking && step !== "loading" ? <span role="status" className="sr-only">Checking OpenWork sign-in</span> : null}
      </div>
    </main>
  );
}
