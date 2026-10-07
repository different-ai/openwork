"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { DenPageHeader } from "../../(den)/_components/ui/page-header";
import { DenButton, buttonVariants } from "../../(den)/_components/ui/button";
import { DenInput } from "../../(den)/_components/ui/input";
import { DenNotice } from "../../(den)/_components/ui/notice";
import { gatewayBrowserEndpoint } from "./gateway-browser-endpoint";

type BrowserStep = "loading" | "sign_in_required" | "account_mismatch" | "ready" | "error" | "blocked" | "restart" | "connected";
type ConnectMethod = "google" | "microsoft" | "aws_sso" | "litellm_key" | "litellm_issued";
type AwsDevice = { attempt: string; userCode: string; verificationUrl: string; expiresAt: number };

const METHOD_BRAND: Record<"google" | "microsoft" | "aws_sso", string> = { google: "Google", microsoft: "Microsoft", aws_sso: "AWS" };

/** Only the identity provider's own authorize page may receive the person. */
function isAuthorizationUrl(method: ConnectMethod, url: URL) {
  if (url.username || url.password) return false;
  if (method === "microsoft") return url.origin === "https://login.microsoftonline.com" && /^\/[0-9a-f-]{36}\/oauth2\/v2\.0\/authorize$/i.test(url.pathname);
  return url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth";
}

/** AWS's own approval page for the device code (Identity Center or the access portal). */
function isAwsVerificationUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && /(?:^|\.)(?:amazonaws\.com|awsapps\.com|app\.aws|aws\.amazon\.com)$/i.test(url.hostname);
  } catch { return false; }
}
type IssueState = { status: string; message: string | null; keyCount: number };

function readIssue(value: unknown): IssueState | null {
  if (typeof value !== "object" || value === null) return null;
  const status = readString(value, "status");
  const keyCount: unknown = Reflect.get(value, "keyCount");
  return status ? { status, message: readString(value, "message"), keyCount: typeof keyCount === "number" ? keyCount : 0 } : null;
}

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
  const [method, setMethod] = useState<ConnectMethod>("google");
  const [providerName, setProviderName] = useState("LiteLLM");
  const [liteLlmKey, setLiteLlmKey] = useState("");
  const [connectedModels, setConnectedModels] = useState(0);
  const [issue, setIssue] = useState<IssueState | null>(null);
  const [awsDevice, setAwsDevice] = useState<AwsDevice | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const awsPoll = useRef<number | null>(null);
  const connected = useRef(false);

  const checkStatus = useCallback(async () => {
    if (!mounted.current || actionRequest.current || startAttempted.current || connected.current) return;
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
        setError("This sign-in link is invalid. Start signing in again in OpenWork.");
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
          ? "This sign-in link expired. Start signing in again in OpenWork."
          : response.status === 403
            ? "You can't sign in to these models right now. Ask your admin."
            : "Could not verify your sign-in. Check your connection and retry."));
        return;
      }
      const status = readString(payload, "status");
      if (status !== "sign_in_required" && status !== "account_mismatch" && status !== "ready") {
        throw new Error("invalid_browser_status");
      }
      ready.current = status === "ready";
      if (status === "ready") {
        const reported = readString(payload, "method");
        const nextMethod = reported === "litellm_key" || reported === "litellm_issued" || reported === "microsoft" || reported === "aws_sso" ? reported : "google";
        setMethod(nextMethod);
        setProviderName(readString(payload, "providerName") ?? "LiteLLM");
        const nextIssue = nextMethod === "litellm_issued" && typeof payload === "object" && payload !== null ? readIssue(Reflect.get(payload, "issue")) : null;
        setIssue(nextIssue);
        if (nextIssue && nextIssue.keyCount > 0) {
          connected.current = true;
          setStep("connected");
          return;
        }
      }
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
      if (awsPoll.current !== null) window.clearTimeout(awsPoll.current);
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

  async function continueToProvider() {
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
        setError("This sign-in link is invalid. Start signing in again in OpenWork.");
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
          setError("Sign-in could not continue. Start signing in again in OpenWork.");
        }
        return;
      }
      const authUrl = readString(payload, "authUrl");
      const url = authUrl ? new URL(authUrl) : null;
      if (!url || !isAuthorizationUrl(method, url)) {
        throw new Error("invalid_authorization_url");
      }
      window.location.assign(url.toString());
    } catch {
      if (!current()) return;
      setStep(startAttempted.current ? "restart" : "error");
      setError(startAttempted.current
        ? `Could not confirm whether ${method === "microsoft" ? "Microsoft" : "Google"} sign-in started. Start signing in again in OpenWork.`
        : "Could not verify your sign-in. Check your connection and retry.");
    } finally {
      if (current()) {
        actionRequest.current = null;
        setBusy(false);
      }
    }
  }

  /** AWS IAM Identity Center: OpenWork shows AWS's approval page and code, then waits for approval. */
  async function startAwsSignIn() {
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
        setError("This sign-in link is invalid. Start signing in again in OpenWork.");
        return;
      }
      const endpoint = await gatewayBrowserEndpoint("/v1/inference-providers/oauth/browser-aws-start");
      if (!current()) return;
      startAttempted.current = true;
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ attempt }),
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
        } else if (response.status === 409) {
          startAttempted.current = false;
          ready.current = true;
          setError(readString(payload, "message") ?? "AWS is temporarily unavailable. Try again shortly.");
        } else {
          setStep("restart");
          setError(readString(payload, "message") ?? "AWS sign-in could not start. Start signing in again in OpenWork.");
        }
        return;
      }
      const nextAttempt = readString(payload, "attempt");
      const userCode = readString(payload, "userCode");
      const verificationUrl = readString(payload, "verificationUriComplete") ?? readString(payload, "verificationUri");
      const expiresIn: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "expiresIn") : null;
      const interval: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "interval") : null;
      if (!nextAttempt || !/^aws_sso\.[A-Za-z0-9_-]{43}$/.test(nextAttempt) || !userCode || !verificationUrl || !isAwsVerificationUrl(verificationUrl)) throw new Error("invalid_aws_device");
      setAwsDevice({ attempt: nextAttempt, userCode, verificationUrl, expiresAt: Date.now() + (typeof expiresIn === "number" ? expiresIn : 600) * 1000 });
      window.open(verificationUrl, "_blank", "noopener,noreferrer");
      scheduleAwsPoll(nextAttempt, typeof interval === "number" ? interval : 5);
    } catch {
      if (!current()) return;
      setStep(startAttempted.current ? "restart" : "error");
      setError(startAttempted.current ? "Could not confirm whether AWS sign-in started. Start signing in again in OpenWork." : "Could not verify your sign-in. Check your connection and retry.");
    } finally {
      if (current()) {
        actionRequest.current = null;
        setBusy(false);
      }
    }
  }

  function scheduleAwsPoll(attempt: string, seconds: number) {
    if (awsPoll.current !== null) window.clearTimeout(awsPoll.current);
    awsPoll.current = window.setTimeout(() => { awsPoll.current = null; void pollAwsSignIn(attempt); }, Math.min(Math.max(seconds, 1), 60) * 1000);
  }

  async function pollAwsSignIn(attempt: string) {
    if (!mounted.current || connected.current) return;
    try {
      const endpoint = await gatewayBrowserEndpoint("/v1/inference-providers/oauth/browser-aws-poll");
      if (!mounted.current) return;
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ attempt }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
      });
      const payload: unknown = await response.json();
      if (!mounted.current) return;
      if (response.ok && readString(payload, "status") === "connected") {
        connected.current = true;
        setAccountName(readString(payload, "accountName"));
        setAwsDevice(null);
        setStep("connected");
        return;
      }
      if (response.ok) {
        const retryAfter: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "retryAfter") : null;
        scheduleAwsPoll(attempt, typeof retryAfter === "number" ? retryAfter : 5);
        return;
      }
      const code = readString(payload, "error");
      if (response.status === 409) { scheduleAwsPoll(attempt, 10); return; }
      setAwsDevice(null);
      if (code === "browser_signin_required" || code === "browser_account_mismatch") setStep(code === "browser_signin_required" ? "sign_in_required" : "account_mismatch");
      else if (response.status === 403) { setStep("blocked"); setError(readString(payload, "message") ?? "AWS did not give you access to these models. Ask your admin."); }
      else { setStep("restart"); setError(readString(payload, "message") ?? "AWS sign-in did not finish. Start signing in again in OpenWork."); }
    } catch {
      if (!mounted.current) return;
      scheduleAwsPoll(attempt, 10);
    }
  }

  /** Per-user LiteLLM: the member pastes their own key; OpenWork checks it with the proxy. */
  async function connectLiteLlmKey() {
    if (!mounted.current || !ready.current || actionRequest.current) return;
    const apiKey = liteLlmKey.trim();
    if (!apiKey) {
      setError(`Paste your ${providerName} key.`);
      return;
    }
    const controller = new AbortController();
    actionRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && actionRequest.current === controller;
    statusRequest.current?.abort();
    setBusy(true);
    setError(null);
    try {
      const attempt = browserAttempt();
      if (!attempt) {
        setStep("restart");
        setError("This sign-in link is invalid. Start signing in again in OpenWork.");
        return;
      }
      const endpoint = await gatewayBrowserEndpoint("/v1/inference-providers/oauth/browser-litellm-key");
      if (!current()) return;
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ attempt, apiKey }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!current()) return;
      if (response.ok) {
        const models: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "modelIds") : null;
        setConnectedModels(Array.isArray(models) ? models.length : 0);
        setLiteLlmKey("");
        ready.current = false;
        connected.current = true;
        setStep("connected");
        return;
      }
      const code = readString(payload, "error");
      if (code === "browser_signin_required" || code === "browser_account_mismatch") {
        setStep(code === "browser_signin_required" ? "sign_in_required" : "account_mismatch");
      } else if (response.status === 400 && code === "oauth_entry_expired") {
        setStep("restart");
        setError("This sign-in link expired. Start signing in again in OpenWork.");
      } else if (response.status === 403) {
        setStep("blocked");
        setError(readString(payload, "message") ?? "You can't connect a key here right now. Ask your admin.");
      } else {
        setError(code === "litellm_unauthorized" ? `${providerName} rejected this key. Check it and try again.` : readString(payload, "message") ?? "Could not connect this key. Try again.");
      }
    } catch {
      if (!current()) return;
      setError("Could not reach OpenWork. Check your connection and try again.");
    } finally {
      if (current()) {
        actionRequest.current = null;
        setBusy(false);
      }
    }
  }

  /** OpenWork-created LiteLLM keys: look the person up in LiteLLM again. */
  async function checkIssuedKey() {
    if (!mounted.current || !ready.current || actionRequest.current) return;
    const controller = new AbortController();
    actionRequest.current = controller;
    const current = () => mounted.current && !controller.signal.aborted && actionRequest.current === controller;
    statusRequest.current?.abort();
    setBusy(true);
    setError(null);
    try {
      const attempt = browserAttempt();
      if (!attempt) {
        setStep("restart");
        setError("This sign-in link is invalid. Start signing in again in OpenWork.");
        return;
      }
      const endpoint = await gatewayBrowserEndpoint("/v1/inference-providers/oauth/browser-litellm-check");
      if (!current()) return;
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ attempt }),
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!current()) return;
      const next = response.ok ? readIssue(payload) : null;
      if (next) {
        setIssue(next);
        if (next.keyCount > 0) {
          ready.current = false;
          connected.current = true;
          setStep("connected");
        }
        return;
      }
      const code = readString(payload, "error");
      if (code === "browser_signin_required" || code === "browser_account_mismatch") setStep(code === "browser_signin_required" ? "sign_in_required" : "account_mismatch");
      else if (response.status === 400 && code === "oauth_entry_expired") { setStep("restart"); setError("This sign-in link expired. Start signing in again in OpenWork."); }
      else if (response.status === 403) { setStep("blocked"); setError(readString(payload, "message") ?? "You don't have LiteLLM access right now. Ask your admin."); }
      else setError(readString(payload, "message") ?? "Could not check LiteLLM. Try again.");
    } catch {
      if (!current()) return;
      setError("Could not reach OpenWork. Check your connection and try again.");
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

  const liteLlm = method === "litellm_key";
  const issued = method === "litellm_issued";
  const brand = method === "google" || method === "microsoft" || method === "aws_sso" ? METHOD_BRAND[method] : null;
  const title = step === "sign_in_required" ? "Sign in to OpenWork"
    : step === "account_mismatch" ? "Switch OpenWork account"
      : step === "connected" ? issued ? `${providerName} is ready` : `${providerName} connected`
      : step === "ready" ? liteLlm ? `Connect your ${providerName} key` : issued ? `${providerName} isn't set up for you yet` : awsDevice ? "Approve in AWS" : `Sign in to ${brand ?? "Google"}`
        : step === "blocked" ? "Sign-in unavailable"
          : step === "restart" ? "Start signing in again"
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
        {step === "account_mismatch" ? <DenNotice tone="neutral" message={<span className="flex items-start gap-2"><LockKeyhole aria-hidden="true" strokeWidth={1.5} className="size-4 shrink-0" />Use the OpenWork account that started signing in.</span>} /> : null}
        {error ? <DenNotice tone={step === "blocked" ? "neutral" : "error"} message={error} /> : null}
        {step === "connected" && method === "aws_sso" ? <DenNotice tone="info" message={`${accountName ? `Signed in to AWS as ${accountName}. ` : ""}Your models are ready in OpenWork. You can close this tab.`} /> : null}
        {step === "connected" && !issued && method !== "aws_sso" ? <DenNotice tone="info" message={`${connectedModels} ${connectedModels === 1 ? "model is" : "models are"} ready in OpenWork. You can close this tab.`} /> : null}
        {step === "ready" && awsDevice ? (
          <div className="flex flex-col gap-3" data-testid="gateway-connect-aws-device">
            <p className="text-[var(--dls-text-secondary)]">Approve OpenWork in the AWS tab. Check that AWS shows this code:</p>
            <code className="w-fit rounded-lg border border-[var(--dls-border)] px-3 py-2 font-mono text-lg tracking-widest" data-testid="gateway-connect-aws-code">{awsDevice.userCode}</code>
            <span role="status" className="text-[var(--dls-text-secondary)]">Waiting for AWS…</span>
          </div>
        ) : null}
        {step === "connected" && issued ? <DenNotice tone="info" message="Your models are ready in OpenWork. You can close this tab." /> : null}
        {step === "ready" && issued ? <DenNotice tone="neutral" message={issue?.message ?? "OpenWork is creating your LiteLLM key. Check again in a moment."} /> : null}
        {step === "ready" && liteLlm ? (
          <label className="flex flex-col gap-1.5 text-[12px] font-medium text-[var(--dls-text-secondary)]">
            {providerName} key
            <DenInput type="password" autoComplete="off" value={liteLlmKey} placeholder="sk-…" data-testid="gateway-connect-litellm-key" className="font-mono text-[12px]"
              onChange={(event) => setLiteLlmKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void connectLiteLlmKey(); }} />
          </label>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {step === "sign_in_required" ? <a href="/" target="_blank" rel="noopener noreferrer" className={buttonVariants()}>Sign in to OpenWork</a> : null}
          {step === "ready" && (method === "google" || method === "microsoft") ? <DenButton loading={busy} disabled={checking || startAttempted.current} onClick={() => void continueToProvider()}>Continue to {METHOD_BRAND[method]}</DenButton> : null}
          {step === "ready" && method === "aws_sso" && !awsDevice ? <DenButton loading={busy} disabled={checking || startAttempted.current} data-testid="gateway-connect-aws-start" onClick={() => void startAwsSignIn()}>Continue to AWS</DenButton> : null}
          {step === "ready" && awsDevice ? <a href={awsDevice.verificationUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary" })}>Open AWS again</a> : null}
          {step === "ready" && issued ? <DenButton loading={busy} disabled={checking} data-testid="gateway-connect-litellm-check" onClick={() => void checkIssuedKey()}>Check again</DenButton> : null}
          {step === "ready" && liteLlm ? <DenButton loading={busy} disabled={checking} data-testid="gateway-connect-litellm-submit" onClick={() => void connectLiteLlmKey()}>Connect key</DenButton> : null}
          {step === "account_mismatch" ? <DenButton loading={busy} disabled={checking} onClick={() => void signOut()}>Sign out of this browser account</DenButton> : null}
          {step === "error" || step === "blocked" ? <DenButton loading={checking} onClick={() => void checkStatus()}>Retry sign-in check</DenButton> : null}
        </div>
        {checking && step !== "loading" ? <span role="status" className="sr-only">Checking OpenWork sign-in</span> : null}
      </div>
    </main>
  );
}
