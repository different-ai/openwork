"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, Info, KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";
import { DenButton } from "../../(den)/_components/ui/button";
import { DenSecretInput } from "../../(den)/_components/ui/secret-input";
import { DenStatusScreen } from "../../../components/den-status-screen";
import { gatewayBrowserEndpoint } from "./gateway-browser-endpoint";

type BrowserStep = "loading" | "sign_in_required" | "account_mismatch" | "ready" | "error" | "blocked" | "restart" | "connected" | "handoff";
type ConnectMethod = "google" | "microsoft" | "aws_sso" | "litellm_key" | "litellm_issued" | "truefoundry_issued";
type AwsDevice = { attempt: string; userCode: string; verificationUrl: string; expiresAt: number };
type RedirectBrand = "Google" | "Microsoft";
type Handoff = { brand: RedirectBrand; phase: "opening" | "returned" };
type AttemptMarker = { kind: "handoff"; brand: RedirectBrand } | { kind: "connected"; providerName: string };

const METHOD_BRAND: Record<"google" | "microsoft" | "aws_sso", string> = { google: "Google", microsoft: "Microsoft", aws_sso: "AWS" };
const MARKER_PREFIX = "openwork.gateway-connect.";

async function attemptMarkerKey(attempt: string) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(attempt));
  return MARKER_PREFIX + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rememberAttempt(attempt: string, marker: AttemptMarker) {
  try {
    const key = await attemptMarkerKey(attempt);
    if (key) window.sessionStorage.setItem(key, JSON.stringify(marker));
  } catch {
    return;
  }
}

async function recallAttempt(attempt: string): Promise<AttemptMarker | null> {
  try {
    const key = await attemptMarkerKey(attempt);
    const raw = key ? window.sessionStorage.getItem(key) : null;
    const value: unknown = raw ? JSON.parse(raw) : null;
    const kind = readString(value, "kind");
    const brand = readString(value, "brand");
    const providerName = readString(value, "providerName");
    if (kind === "handoff" && (brand === "Google" || brand === "Microsoft")) return { kind, brand };
    if (kind === "connected" && providerName) return { kind, providerName };
  } catch {
    return null;
  }
  return null;
}

function isAuthorizationUrl(method: ConnectMethod, url: URL) {
  if (url.username || url.password) return false;
  if (method === "microsoft") return url.origin === "https://login.microsoftonline.com" && /^\/[0-9a-f-]{36}\/oauth2\/v2\.0\/authorize$/i.test(url.pathname);
  return url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth";
}

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
  const ready: unknown = Reflect.get(value, "ready");
  return status ? { status, message: readString(value, "message"), keyCount: typeof keyCount === "number" ? keyCount : ready === true ? 1 : 0 } : null;
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
  const [connectedModels, setConnectedModels] = useState<number | null>(null);
  const [issue, setIssue] = useState<IssueState | null>(null);
  const [awsDevice, setAwsDevice] = useState<AwsDevice | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const awsPoll = useRef<number | null>(null);
  const connected = useRef(false);
  const [handoff, setHandoffState] = useState<Handoff | null>(null);
  const handoffRef = useRef<Handoff | null>(null);
  const setHandoff = useCallback((next: Handoff | null) => {
    handoffRef.current = next;
    setHandoffState(next);
    if (next) setStep("handoff");
  }, []);

  const applyMarker = useCallback((marker: AttemptMarker) => {
    if (marker.kind === "handoff") {
      startAttempted.current = true;
      setHandoff({ brand: marker.brand, phase: "returned" });
      return;
    }
    connected.current = true;
    setProviderName(marker.providerName);
    setConnectedModels(null);
    setStep("connected");
  }, [setHandoff]);

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
        if (response.status === 400) {
          const marker = await recallAttempt(attempt);
          if (!current()) return;
          if (marker) {
            applyMarker(marker);
            return;
          }
        }
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
        const nextMethod = reported === "litellm_key" || reported === "litellm_issued" || reported === "truefoundry_issued" || reported === "microsoft" || reported === "aws_sso" ? reported : "google";
        setMethod(nextMethod);
        setProviderName(readString(payload, "providerName") ?? "LiteLLM");
        const nextIssue = typeof payload === "object" && payload !== null
          ? nextMethod === "litellm_issued" ? readIssue(Reflect.get(payload, "issue")) : nextMethod === "truefoundry_issued" ? readIssue(Reflect.get(payload, "truefoundry")) : null
          : null;
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
  }, [applyMarker]);

  useEffect(() => {
    mounted.current = true;
    void checkStatus();
    const markReturned = () => {
      const current = handoffRef.current;
      if (current?.phase === "opening") setHandoff({ ...current, phase: "returned" });
    };
    const onFocus = () => void checkStatus();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        markReturned();
        void checkStatus();
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) markReturned();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      ready.current = false;
      statusRequest.current?.abort();
      actionRequest.current?.abort();
      if (awsPoll.current !== null) window.clearTimeout(awsPoll.current);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [checkStatus, setHandoff]);

  useEffect(() => {
    if (handoff?.phase !== "opening") return;
    const timer = window.setTimeout(() => {
      if (handoffRef.current?.phase === "opening") setHandoff({ brand: handoffRef.current.brand, phase: "returned" });
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [handoff, setHandoff]);

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
        } else if (response.status === 403 && code === "feature_disabled") {
          startAttempted.current = false;
          setStep("blocked");
          setError(readString(payload, "message") ?? "You can't sign in to these models right now. Ask your admin.");
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
      const brand: RedirectBrand = method === "microsoft" ? "Microsoft" : "Google";
      await rememberAttempt(attempt, { kind: "handoff", brand });
      if (!current()) return;
      setHandoff({ brand, phase: "opening" });
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
        const entry = browserAttempt();
        if (entry) void rememberAttempt(entry, { kind: "connected", providerName });
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
        void rememberAttempt(attempt, { kind: "connected", providerName });
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
      const endpoint = await gatewayBrowserEndpoint(method === "truefoundry_issued" ? "/v1/inference-providers/oauth/browser-truefoundry-check" : "/v1/inference-providers/oauth/browser-litellm-check");
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
          void rememberAttempt(attempt, { kind: "connected", providerName });
        }
        return;
      }
      const code = readString(payload, "error");
      if (code === "browser_signin_required" || code === "browser_account_mismatch") setStep(code === "browser_signin_required" ? "sign_in_required" : "account_mismatch");
      else if (response.status === 400 && code === "oauth_entry_expired") { setStep("restart"); setError("This sign-in link expired. Start signing in again in OpenWork."); }
      else if (response.status === 403) { setStep("blocked"); setError(readString(payload, "message") ?? `You don't have ${providerName} access right now. Ask your admin.`); }
      else setError(readString(payload, "message") ?? `Could not check ${providerName}. Try again.`);
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
  const issued = method === "litellm_issued" || method === "truefoundry_issued";
  const brand = method === "google" || method === "microsoft" || method === "aws_sso" ? METHOD_BRAND[method] : null;
  const consentNote = "Only continue if you started signing in from the OpenWork app.";

  if (step === "loading") {
    return (
      <DenStatusScreen title="" description="" loading loadingLabel="Checking OpenWork sign-in">
        <div aria-hidden="true" className="mt-9 flex items-center gap-3 rounded-xl border border-[var(--dls-border)] px-4 py-3.5 motion-safe:animate-pulse">
          <span className="size-8 shrink-0 rounded-lg bg-[var(--dls-hover)]" />
          <span className="flex flex-1 flex-col gap-2"><span className="h-3.5 w-2/5 rounded bg-[var(--dls-hover)]" /><span className="h-3 w-1/4 rounded bg-[var(--dls-hover)]" /></span>
        </div>
        <div aria-hidden="true" className="mt-6 h-10 w-full rounded-lg bg-[var(--dls-hover)] motion-safe:animate-pulse" />
      </DenStatusScreen>
    );
  }

  const view = ((): { title: string; description: string; body: ReactNode; footer?: string } => {
    if (step === "sign_in_required") return {
      title: "Sign in to OpenWork",
      description: "Sign in to OpenWork in this browser with the account you use in the app. This page continues on its own.",
      body: <Actions><DenButton href="/" target="_blank" rel="noopener noreferrer" className="w-full">Sign in to OpenWork</DenButton></Actions>,
      footer: consentNote,
    };
    if (step === "account_mismatch") return {
      title: "Switch OpenWork account",
      description: "This browser is signed in to a different OpenWork account than the one you use in the app.",
      body: <>
        <StatusRow tone="neutral" icon={<LockKeyhole aria-hidden="true" strokeWidth={1.5} className="size-4" />} title="Use the account that started signing in" detail="Sign out here, then sign in with the account you use in OpenWork." />
        {error ? <StatusRow tone="error" icon={<CircleAlert aria-hidden="true" strokeWidth={1.5} className="size-4" />} title="Something went wrong" detail={error} stacked /> : null}
        <Actions><DenButton loading={busy} disabled={checking} className="w-full" onClick={() => void signOut()}>Sign out of this account</DenButton></Actions>
      </>,
      footer: consentNote,
    };
    if (step === "handoff" && handoff) return handoff.phase === "opening" ? {
      title: `Opening ${handoff.brand}`,
      description: `Taking you to ${handoff.brand} to sign in.`,
      body: <StatusRow tone="waiting" icon={<LoaderCircle aria-hidden="true" strokeWidth={1.5} className="size-4 animate-spin motion-reduce:animate-none" />} title={providerName} detail={`Opening ${handoff.brand}…`} />,
    } : {
      title: "Return to OpenWork",
      description: `This sign-in already went to ${handoff.brand}. If you finished there, your models are ready in OpenWork and you can close this tab.`,
      body: <StatusRow tone="neutral" icon={<Info aria-hidden="true" strokeWidth={1.5} className="size-4" />} title="Didn't finish signing in?" detail="Start signing in again from OpenWork. This link only works once." />,
    };
    if (step === "connected") {
      const detail = method === "aws_sso" ? accountName ? `Signed in to AWS as ${accountName}` : "Signed in to AWS"
        : !issued && connectedModels !== null ? `${connectedModels} ${connectedModels === 1 ? "model is" : "models are"} ready in OpenWork`
          : "Your models are ready in OpenWork";
      return {
        title: issued ? `${providerName} is ready` : `${providerName} connected`,
        description: "You can close this tab and go back to OpenWork.",
        body: <StatusRow tone="success" icon={<Check aria-hidden="true" strokeWidth={2} className="size-4" />} title={`${providerName} is connected to OpenWork`} detail={detail} />,
      };
    }
    if (step === "ready" && awsDevice) return {
      title: "Approve in AWS",
      description: "Approve OpenWork in the AWS tab. Check that AWS shows this code.",
      body: <>
        <div className="mt-9 flex justify-center rounded-xl border border-[var(--dls-border)] px-4 py-6" data-testid="gateway-connect-aws-device">
          <code className="select-all font-mono text-[28px] font-medium leading-none tracking-[0.2em]" data-testid="gateway-connect-aws-code">{awsDevice.userCode}</code>
        </div>
        <StatusRow tone="waiting" icon={<LoaderCircle aria-hidden="true" strokeWidth={1.5} className="size-4 animate-spin motion-reduce:animate-none" />} title={providerName} detail="Waiting for AWS…" stacked />
        <Actions><DenButton variant="secondary" href={awsDevice.verificationUrl} target="_blank" rel="noopener noreferrer" className="w-full">Open AWS again</DenButton></Actions>
      </>,
      footer: "Keep this tab open until AWS approves.",
    };
    if (step === "ready" && liteLlm) return {
      title: `Connect your ${providerName} key`,
      description: `Paste your own ${providerName} key to use its models in OpenWork.`,
      body: <>
        <label className="mt-9 flex flex-col gap-1.5 text-[13px] font-medium text-[var(--dls-text-primary)]">
          {providerName} key
          <DenSecretInput autoComplete="off" value={liteLlmKey} placeholder="sk-…" data-testid="gateway-connect-litellm-key" className="font-mono text-[13px]"
            onChange={setLiteLlmKey} onKeyDown={(event) => { if (event.key === "Enter") void connectLiteLlmKey(); }} />
        </label>
        {error ? <StatusRow tone="error" icon={<CircleAlert aria-hidden="true" strokeWidth={1.5} className="size-4" />} title="Key not connected" detail={error} stacked /> : null}
        <Actions><DenButton loading={busy} disabled={checking} data-testid="gateway-connect-litellm-submit" className="w-full" icon={KeyRound} onClick={() => void connectLiteLlmKey()}>Connect key</DenButton></Actions>
      </>,
      footer: consentNote,
    };
    if (step === "ready" && issued) return {
      title: `${providerName} isn't set up for you yet`,
      description: issue?.message ?? `OpenWork is creating your ${providerName} key. Check again in a moment.`,
      body: <>
        {error ? <StatusRow tone="error" icon={<CircleAlert aria-hidden="true" strokeWidth={1.5} className="size-4" />} title="Couldn't check" detail={error} /> : null}
        <Actions><DenButton loading={busy} disabled={checking} data-testid="gateway-connect-litellm-check" className="w-full" onClick={() => void checkIssuedKey()}>Check again</DenButton></Actions>
      </>,
    };
    if (step === "ready" && brand) {
      const mark = method === "microsoft" ? <MicrosoftMark /> : method === "google" ? <GoogleMark /> : <span aria-hidden="true" className="text-[10px] font-semibold tracking-tight">AWS</span>;
      const start = method === "aws_sso" ? () => void startAwsSignIn() : () => void continueToProvider();
      return {
        title: `Sign in to ${brand}`,
        description: `${providerName} uses your ${brand} account to give you access to its models in OpenWork.`,
        body: <>
          <StatusRow tone="neutral" icon={mark} title={providerName} detail={`Signs in with your ${brand} account`} />
          {error ? <StatusRow tone="error" icon={<CircleAlert aria-hidden="true" strokeWidth={1.5} className="size-4" />} title={`${brand} sign-in didn't start`} detail={error} stacked /> : null}
          <Actions>
            <DenButton loading={busy} disabled={checking || startAttempted.current} className="w-full" data-testid={method === "aws_sso" ? "gateway-connect-aws-start" : "gateway-connect-continue"} onClick={start}>
              {method === "aws_sso" ? null : mark}Continue to {brand}
            </DenButton>
          </Actions>
        </>,
        footer: consentNote,
      };
    }
    if (step === "blocked") return {
      title: "Sign-in unavailable",
      description: "Your admin controls who can use these models.",
      body: <>
        <StatusRow tone="neutral" icon={<LockKeyhole aria-hidden="true" strokeWidth={1.5} className="size-4" />} title="You can't sign in right now" detail={error ?? "Ask your admin for access."} />
        <Actions><DenButton variant="secondary" loading={checking} className="w-full" onClick={() => void checkStatus()}>Check again</DenButton></Actions>
      </>,
    };
    if (step === "restart") return {
      title: "Start signing in again",
      description: "This sign-in link can't be used anymore. Go back to OpenWork to get a new one.",
      body: error ? <StatusRow tone="neutral" icon={<Info aria-hidden="true" strokeWidth={1.5} className="size-4" />} title="Link no longer works" detail={error} /> : null,
      footer: "You can close this tab.",
    };
    return {
      title: "Couldn't verify sign-in",
      description: "OpenWork couldn't check this sign-in.",
      body: <>
        <StatusRow tone="error" icon={<CircleAlert aria-hidden="true" strokeWidth={1.5} className="size-4" />} title="Check failed" detail={error ?? "Check your connection and try again."} />
        <Actions><DenButton loading={checking} className="w-full" onClick={() => void checkStatus()}>Try again</DenButton></Actions>
      </>,
    };
  })();

  return (
    <DenStatusScreen title={view.title} description={view.description} busy={busy || checking}>
      <div data-testid="gateway-connect" data-step={step}>
        {view.body}
        {view.footer ? <p className="mt-8 border-t border-[var(--dls-border)] pt-6 text-[13px] leading-5 text-[var(--dls-text-secondary)]">{view.footer}</p> : null}
        {checking ? <span role="status" className="sr-only">Checking OpenWork sign-in</span> : null}
      </div>
    </DenStatusScreen>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-col gap-3">{children}</div>;
}

type RowTone = "neutral" | "waiting" | "success" | "error";

const ROW_TONE: Record<RowTone, { row: string; tile: string }> = {
  neutral: { row: "border-[var(--dls-border)]", tile: "bg-[var(--dls-hover)] text-[var(--dls-text-primary)]" },
  waiting: { row: "border-[var(--dls-border)]", tile: "bg-[var(--dls-hover)] text-[var(--dls-text-secondary)]" },
  success: { row: "border-[var(--dls-border)]", tile: "bg-emerald-50 text-emerald-700" },
  error: { row: "border-red-200 bg-red-50", tile: "bg-red-100 text-red-700" },
};

function StatusRow({ tone, icon, title, detail, stacked = false }: { tone: RowTone; icon: ReactNode; title: string; detail: string; stacked?: boolean }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`${stacked ? "mt-3" : "mt-9"} flex items-center gap-3 rounded-xl border px-4 py-3.5 ${ROW_TONE[tone].row}`}>
      <span aria-hidden="true" className={`grid size-8 shrink-0 place-items-center rounded-lg ${ROW_TONE[tone].tile}`}>{icon}</span>
      <span className="grid min-w-0 gap-0.5">
        <strong className="break-words text-[15px] font-medium leading-[22px] text-[var(--dls-text-primary)]">{title}</strong>
        <small className={`break-words text-[13px] leading-5 ${tone === "error" ? "text-red-700" : "text-[var(--dls-text-secondary)]"}`}>{detail}</small>
      </span>
    </div>
  );
}

function MicrosoftMark() {
  return (
    <svg viewBox="0 0 21 21" aria-hidden="true" className="size-3.5 shrink-0" fill="currentColor">
      <rect x="1" y="1" width="9" height="9" /><rect x="11" y="1" width="9" height="9" /><rect x="1" y="11" width="9" height="9" /><rect x="11" y="11" width="9" height="9" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3.5 shrink-0" fill="currentColor">
      <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
    </svg>
  );
}
