"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Step = 1 | 2 | 3;
type AuthMode = "sign-in" | "sign-up";

type AuthUser = {
  id: string;
  email: string;
  name: string | null;
};

type WorkerLaunch = {
  workerId: string;
  workerName: string;
  status: string;
  provider: string | null;
  instanceUrl: string | null;
  clientToken: string | null;
  hostToken: string | null;
};

type WorkerSummary = {
  workerId: string;
  workerName: string;
  status: string;
};

type WorkerTokens = {
  clientToken: string | null;
  hostToken: string | null;
};

type EventLevel = "info" | "success" | "warning" | "error";

type LaunchEvent = {
  id: string;
  level: EventLevel;
  label: string;
  detail: string;
  at: string;
};

const LAST_WORKER_STORAGE_KEY = "openwork:web:last-worker";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shortValue(value: string): string {
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    const trimmed = payload.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.includes("<body")) {
      return `${fallback} Upstream returned an HTML error page.`;
    }
    if (trimmed.length > 240) {
      return `${fallback} Upstream returned a non-JSON error payload.`;
    }
    return trimmed;
  }

  if (!isRecord(payload)) {
    return fallback;
  }

  const message = payload.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message;
  }

  const error = payload.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return fallback;
}

function getUser(payload: unknown): AuthUser | null {
  if (!isRecord(payload) || !isRecord(payload.user)) {
    return null;
  }

  const user = payload.user;
  if (typeof user.id !== "string" || typeof user.email !== "string") {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    name: typeof user.name === "string" ? user.name : null
  };
}

function getToken(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  return typeof payload.token === "string" ? payload.token : null;
}

function getCheckoutUrl(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.polar)) {
    return null;
  }
  return typeof payload.polar.checkoutUrl === "string" ? payload.polar.checkoutUrl : null;
}

function getWorker(payload: unknown): WorkerLaunch | null {
  if (!isRecord(payload) || !isRecord(payload.worker)) {
    return null;
  }

  const worker = payload.worker;
  if (typeof worker.id !== "string" || typeof worker.name !== "string") {
    return null;
  }

  const instance = isRecord(payload.instance) ? payload.instance : null;
  const tokens = isRecord(payload.tokens) ? payload.tokens : null;

  return {
    workerId: worker.id,
    workerName: worker.name,
    status: typeof worker.status === "string" ? worker.status : "unknown",
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    clientToken: tokens && typeof tokens.client === "string" ? tokens.client : null,
    hostToken: tokens && typeof tokens.host === "string" ? tokens.host : null
  };
}

function getWorkerSummary(payload: unknown): WorkerSummary | null {
  if (!isRecord(payload) || !isRecord(payload.worker)) {
    return null;
  }

  const worker = payload.worker;
  if (typeof worker.id !== "string" || typeof worker.name !== "string") {
    return null;
  }

  return {
    workerId: worker.id,
    workerName: worker.name,
    status: typeof worker.status === "string" ? worker.status : "unknown"
  };
}

function getWorkerTokens(payload: unknown): WorkerTokens | null {
  if (!isRecord(payload) || !isRecord(payload.tokens)) {
    return null;
  }

  const tokens = payload.tokens;
  const clientToken = typeof tokens.client === "string" ? tokens.client : null;
  const hostToken = typeof tokens.host === "string" ? tokens.host : null;

  if (!clientToken && !hostToken) {
    return null;
  }

  return { clientToken, hostToken };
}

function isWorkerLaunch(value: unknown): value is WorkerLaunch {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.workerId === "string" &&
    typeof value.workerName === "string" &&
    typeof value.status === "string" &&
    (typeof value.provider === "string" || value.provider === null) &&
    (typeof value.instanceUrl === "string" || value.instanceUrl === null) &&
    (typeof value.clientToken === "string" || value.clientToken === null) &&
    (typeof value.hostToken === "string" || value.hostToken === null)
  );
}

async function requestJson(path: string, init: RequestInit = {}, timeoutMs = 30000) {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const shouldAttachTimeout = !init.signal && timeoutMs > 0;
  const timeoutController = shouldAttachTimeout ? new AbortController() : null;
  const timeoutHandle = timeoutController
    ? setTimeout(() => {
        timeoutController.abort();
      }, timeoutMs)
    : null;

  let response: Response;
  try {
    response = await fetch(`/api/den${path}`, {
      ...init,
      headers,
      credentials: "include",
      signal: init.signal ?? timeoutController?.signal
    });
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return { response, payload, text };
}

function CredentialRow({
  label,
  value,
  placeholder,
  canCopy,
  copied,
  onCopy
}: {
  label: string;
  value: string | null;
  placeholder: string;
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <label className="ow-field-block">
      <span className="ow-field-label">{label}</span>
      <div className="ow-copy-row">
        <input readOnly value={value ?? placeholder} className="ow-input ow-mono" onClick={(event) => event.currentTarget.select()} />
        <button type="button" className="ow-btn-icon" disabled={!canCopy} onClick={onCopy}>
          {copied ? "Copied" : canCopy ? "Copy" : "N/A"}
        </button>
      </div>
    </label>
  );
}

export function CloudControlPanel() {
  const [step, setStep] = useState<Step>(1);

  const [authMode, setAuthMode] = useState<AuthMode>("sign-in");
  const [name, setName] = useState("OpenWork Builder");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authInfo, setAuthInfo] = useState("Sign in to launch and manage cloud workers.");
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);

  const [workerName, setWorkerName] = useState("Founder Ops Pilot");
  const [worker, setWorker] = useState<WorkerLaunch | null>(null);
  const [workerLookupId, setWorkerLookupId] = useState("");
  const [launchBusy, setLaunchBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<"status" | "token" | null>(null);
  const [launchStatus, setLaunchStatus] = useState("Name your worker and click launch.");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [paymentReturned, setPaymentReturned] = useState(false);

  const [events, setEvents] = useState<LaunchEvent[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const progressWidth = step === 1 ? "33.333%" : step === 2 ? "66.666%" : "100%";

  function appendEvent(level: EventLevel, label: string, detail: string) {
    setEvents((current) => {
      const next: LaunchEvent[] = [
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          level,
          label,
          detail,
          at: new Date().toISOString()
        },
        ...current
      ];

      return next.slice(0, 10);
    });
  }

  async function copyToClipboard(field: string, value: string | null) {
    if (!value) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 1800);
  }

  async function refreshSession(quiet = false) {
    const headers = new Headers();
    if (authToken) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }

    const { response, payload } = await requestJson("/v1/me", { method: "GET", headers }, 12000);

    if (!response.ok) {
      setUser(null);
      if (!quiet) {
        setAuthError("No active session found. Sign in first.");
      }
      return null;
    }

    const sessionUser = getUser(payload);
    if (!sessionUser) {
      if (!quiet) {
        setAuthError("Session response did not include a user.");
      }
      return null;
    }

    setUser(sessionUser);
    setAuthInfo(`Signed in as ${sessionUser.email}.`);
    return sessionUser;
  }

  useEffect(() => {
    void refreshSession(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const customerSessionToken = params.get("customer_session_token");
    if (!customerSessionToken) {
      return;
    }

    setPaymentReturned(true);
    setCheckoutUrl(null);
    setLaunchStatus("Checkout return detected. Click launch to continue worker provisioning.");
    appendEvent("success", "Returned from checkout", `Session ${shortValue(customerSessionToken)}`);

    params.delete("customer_session_token");
    const nextQuery = params.toString();
    const nextUrl = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
    window.history.replaceState({}, "", nextUrl);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const raw = window.localStorage.getItem(LAST_WORKER_STORAGE_KEY);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isWorkerLaunch(parsed)) {
        return;
      }

      const restored: WorkerLaunch = {
        ...parsed,
        clientToken: null,
        hostToken: null
      };

      setWorker(restored);
      setWorkerLookupId(restored.workerId);
      setLaunchStatus(`Recovered worker ${restored.workerName}. Generate a new API key if needed.`);
      appendEvent("info", "Recovered worker context", `Worker ID ${restored.workerId}`);
    } catch {
      return;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !worker) {
      return;
    }

    const serializable: WorkerLaunch = {
      ...worker,
      clientToken: null,
      hostToken: null
    };

    window.localStorage.setItem(LAST_WORKER_STORAGE_KEY, JSON.stringify(serializable));
  }, [worker]);

  useEffect(() => {
    if (worker) {
      setStep(3);
      return;
    }

    if (user || checkoutUrl || paymentReturned) {
      setStep(2);
      return;
    }

    setStep(1);
  }, [worker, user, checkoutUrl, paymentReturned]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setAuthBusy(true);
    setAuthError(null);

    try {
      const endpoint = authMode === "sign-up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
      const body =
        authMode === "sign-up"
          ? {
              name: name.trim() || "OpenWork Builder",
              email: email.trim(),
              password
            }
          : {
              email: email.trim(),
              password
            };

      const { response, payload } = await requestJson(endpoint, {
        method: "POST",
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        setAuthError(getErrorMessage(payload, `Authentication failed with ${response.status}.`));
        return;
      }

      const token = getToken(payload);
      if (token) {
        setAuthToken(token);
      }

      const payloadUser = getUser(payload);
      if (payloadUser) {
        setUser(payloadUser);
        setAuthInfo(`Signed in as ${payloadUser.email}.`);
        appendEvent("success", authMode === "sign-up" ? "Account created" : "Signed in", payloadUser.email);
      } else {
        const refreshed = await refreshSession(true);
        if (!refreshed) {
          setAuthInfo("Authentication succeeded, but session details are still syncing.");
        } else {
          appendEvent("success", authMode === "sign-up" ? "Account created" : "Signed in", refreshed.email);
        }
      }

      setStep(2);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setAuthError(message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLaunchWorker() {
    if (!user) {
      setAuthError("Sign in before launching a worker.");
      return;
    }

    setLaunchBusy(true);
    setLaunchError(null);
    setCheckoutUrl(null);
    setLaunchStatus("Checking subscription and launch eligibility...");
    appendEvent("info", "Launch requested", workerName.trim() || "Cloud worker");

    try {
      const { response, payload } = await requestJson(
        "/v1/workers",
        {
          method: "POST",
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
          body: JSON.stringify({
            name: workerName.trim() || "Cloud Worker",
            destination: "cloud"
          })
        },
        45000
      );

      if (response.status === 402) {
        const url = getCheckoutUrl(payload);
        setCheckoutUrl(url);
        setLaunchStatus("Payment is required. Complete checkout and return to continue launch.");
        setLaunchError(url ? null : "Checkout URL missing from paywall response.");
        appendEvent("warning", "Paywall required", url ? "Checkout URL generated" : "Checkout URL missing");
        return;
      }

      if (!response.ok) {
        const message = getErrorMessage(payload, `Launch failed with ${response.status}.`);
        setLaunchError(message);
        setLaunchStatus("Launch failed. Fix the error and retry.");
        appendEvent("error", "Launch failed", message);
        return;
      }

      const parsedWorker = getWorker(payload);
      if (!parsedWorker) {
        setLaunchError("Launch response was missing worker details.");
        setLaunchStatus("Launch response format was unexpected.");
        appendEvent("error", "Launch failed", "Worker payload missing");
        return;
      }

      setWorker(parsedWorker);
      setWorkerLookupId(parsedWorker.workerId);
      setPaymentReturned(false);
      setCheckoutUrl(null);
      setLaunchStatus(`Worker ${parsedWorker.workerName} is ${parsedWorker.status}.`);
      appendEvent("success", "Worker launched", `Worker ID ${parsedWorker.workerId}`);
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "Launch request timed out after 45s. Retry launch or come back later with your worker ID."
          : error instanceof Error
            ? error.message
            : "Unknown network error";

      setLaunchError(message);
      setLaunchStatus("Launch request failed.");
      appendEvent("error", "Launch failed", message);
    } finally {
      setLaunchBusy(false);
    }
  }

  async function handleCheckStatus() {
    if (!user) {
      setLaunchError("Sign in before checking worker status.");
      return;
    }

    const id = workerLookupId.trim();
    if (!id) {
      setLaunchError("Enter a worker ID first.");
      return;
    }

    setActionBusy("status");
    setLaunchError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(id)}`, {
        method: "GET",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Status check failed with ${response.status}.`);
        setLaunchError(message);
        appendEvent("error", "Status check failed", message);
        return;
      }

      const summary = getWorkerSummary(payload);
      if (!summary) {
        setLaunchError("Status response was missing worker details.");
        appendEvent("error", "Status check failed", "Worker summary missing");
        return;
      }

      setWorker((previous) => {
        if (previous && previous.workerId === summary.workerId) {
          return {
            ...previous,
            workerName: summary.workerName,
            status: summary.status
          };
        }

        return {
          workerId: summary.workerId,
          workerName: summary.workerName,
          status: summary.status,
          provider: null,
          instanceUrl: null,
          clientToken: null,
          hostToken: null
        };
      });

      setWorkerLookupId(summary.workerId);
      setLaunchStatus(`Worker ${summary.workerName} is currently ${summary.status}.`);
      appendEvent("info", "Status refreshed", `${summary.workerName}: ${summary.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setLaunchError(message);
      appendEvent("error", "Status check failed", message);
    } finally {
      setActionBusy(null);
    }
  }

  async function handleGenerateKey() {
    if (!user) {
      setLaunchError("Sign in before generating a worker API key.");
      return;
    }

    const id = workerLookupId.trim();
    if (!id) {
      setLaunchError("Enter a worker ID before generating an API key.");
      return;
    }

    setActionBusy("token");
    setLaunchError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(id)}/tokens`, {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Key generation failed with ${response.status}.`);
        setLaunchError(message);
        appendEvent("error", "Key generation failed", message);
        return;
      }

      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        setLaunchError("Key generation returned no token values.");
        appendEvent("error", "Key generation failed", "Missing token payload");
        return;
      }

      setWorker((previous) => {
        if (previous && previous.workerId === id) {
          return {
            ...previous,
            clientToken: tokens.clientToken,
            hostToken: tokens.hostToken
          };
        }

        return {
          workerId: id,
          workerName: "Existing worker",
          status: "unknown",
          provider: null,
          instanceUrl: null,
          clientToken: tokens.clientToken,
          hostToken: tokens.hostToken
        };
      });

      setLaunchStatus("Generated a fresh worker API key.");
      appendEvent("success", "Generated new worker API key", `Worker ID ${id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setLaunchError(message);
      appendEvent("error", "Key generation failed", message);
    } finally {
      setActionBusy(null);
    }
  }

  const steps = useMemo(
    () => [
      {
        id: 1,
        title: "Sign in",
        detail: user ? `Signed in as ${user.email}` : "Authenticate with your OpenWork account"
      },
      {
        id: 2,
        title: "Launch",
        detail: checkoutUrl
          ? "Complete checkout, return, and relaunch"
          : launchBusy
            ? launchStatus
            : "Launch a cloud worker from this card"
      },
      {
        id: 3,
        title: "Connect",
        detail: worker ? "Copy URL + API key into the OpenWork app" : "Credentials appear when launch succeeds"
      }
    ],
    [checkoutUrl, launchBusy, launchStatus, user, worker]
  );

  return (
    <section className="ow-card">
      <div className="ow-progress-track">
        <span className="ow-progress-fill" style={{ width: progressWidth }} />
      </div>

      <div className="ow-card-body">
        {step === 1 ? (
          <div className="ow-stack">
            <div className="ow-heading-block">
              <span className="ow-icon-chip">01</span>
              <h1 className="ow-title">Welcome back</h1>
              <p className="ow-subtitle">Sign in to launch and manage cloud workers.</p>
            </div>

            <form className="ow-stack" onSubmit={handleAuthSubmit}>
              {authMode === "sign-up" ? (
                <label className="ow-field-block">
                  <span className="ow-field-label">Name</span>
                  <input
                    className="ow-input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    required
                  />
                </label>
              ) : null}

              <label className="ow-field-block">
                <span className="ow-field-label">Email</span>
                <input
                  className="ow-input"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </label>

              <label className="ow-field-block">
                <span className="ow-field-label">Password</span>
                <input
                  className="ow-input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={authMode === "sign-up" ? "new-password" : "current-password"}
                  required
                />
              </label>

              <button type="submit" className="ow-btn-primary" disabled={authBusy}>
                {authBusy ? "Working..." : authMode === "sign-in" ? "Continue" : "Create account"}
              </button>
            </form>

            <div className="ow-inline-row">
              <p className="ow-caption">{authMode === "sign-in" ? "Need an account?" : "Already have an account?"}</p>
              <button
                type="button"
                className="ow-link"
                onClick={() => setAuthMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"))}
              >
                {authMode === "sign-in" ? "Create account" : "Switch to sign in"}
              </button>
            </div>

            <div className="ow-note-box">
              <p>{authInfo}</p>
              {authError ? <p className="ow-error-text">{authError}</p> : null}
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="ow-stack">
            <div className="ow-heading-block">
              <span className="ow-icon-chip">02</span>
              <h1 className="ow-title">Launch a Worker</h1>
              <p className="ow-subtitle">Signed in as {(user?.email ?? email) || "your account"}.</p>
            </div>

            <div className="ow-step-list">
              {steps.map((item) => (
                <div key={item.id} className={`ow-step-item ${step >= item.id ? "is-done" : ""}`}>
                  <span className="ow-step-index">{step > item.id ? "OK" : item.id}</span>
                  <div>
                    <p className="ow-step-title">{item.title}</p>
                    <p className="ow-step-detail">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>

            <label className="ow-field-block">
              <span className="ow-field-label">Worker Name</span>
              <input
                className="ow-input"
                value={workerName}
                onChange={(event) => setWorkerName(event.target.value)}
                maxLength={80}
              />
            </label>

            <button type="button" className="ow-btn-primary" onClick={handleLaunchWorker} disabled={!user || launchBusy}>
              {launchBusy ? "Launching..." : `Launch "${workerName || "Cloud Worker"}"`}
            </button>

            <div className="ow-note-box">
              <p>{launchStatus}</p>
              {launchError ? <p className="ow-error-text">{launchError}</p> : null}
            </div>

            {checkoutUrl ? (
              <div className="ow-paywall-box">
                <p className="ow-paywall-title">Payment required</p>
                <a href={checkoutUrl} rel="noreferrer" className="ow-btn-secondary ow-full">
                  Continue to Polar checkout
                </a>
                <p className="ow-caption">After checkout, return to this screen and click launch again.</p>
              </div>
            ) : null}

            <div className="ow-lookup-box">
              <p className="ow-section-title">Come back later</p>
              <div className="ow-inline-actions">
                <input
                  className="ow-input ow-mono"
                  value={workerLookupId}
                  onChange={(event) => setWorkerLookupId(event.target.value)}
                  placeholder="Worker ID"
                />
                <button
                  type="button"
                  className="ow-btn-secondary"
                  onClick={handleCheckStatus}
                  disabled={actionBusy !== null}
                >
                  {actionBusy === "status" ? "Checking..." : "Check status"}
                </button>
                <button
                  type="button"
                  className="ow-btn-secondary"
                  onClick={handleGenerateKey}
                  disabled={actionBusy !== null}
                >
                  {actionBusy === "token" ? "Generating..." : "New API key"}
                </button>
              </div>
            </div>

            {events.length > 0 ? (
              <div className="ow-log-box">
                <p className="ow-section-title">Launch log</p>
                <ul className="ow-log-list">
                  {events.map((entry) => (
                    <li key={entry.id} className={`ow-log-item level-${entry.level}`}>
                      <div className="ow-log-head">
                        <span>{entry.label}</span>
                        <span className="ow-mono">{new Date(entry.at).toLocaleTimeString()}</span>
                      </div>
                      <p>{entry.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="ow-stack">
            <div className="ow-heading-block">
              <span className="ow-icon-chip">03</span>
              <h1 className="ow-title">Worker is live</h1>
              <p className="ow-subtitle">Copy your connection details and paste them into the OpenWork app.</p>
            </div>

            <CredentialRow
              label="Worker URL"
              value={worker?.instanceUrl ?? null}
              placeholder="URL becomes available after provisioning."
              canCopy={Boolean(worker?.instanceUrl)}
              copied={copiedField === "worker-url"}
              onCopy={() => void copyToClipboard("worker-url", worker?.instanceUrl ?? null)}
            />

            <CredentialRow
              label="Worker API Key"
              value={worker?.clientToken ?? null}
              placeholder="Click New API key to generate credentials."
              canCopy={Boolean(worker?.clientToken)}
              copied={copiedField === "worker-key"}
              onCopy={() => void copyToClipboard("worker-key", worker?.clientToken ?? null)}
            />

            <CredentialRow
              label="Worker ID"
              value={(worker?.workerId ?? workerLookupId) || null}
              placeholder="Worker ID"
              canCopy={Boolean(worker?.workerId || workerLookupId)}
              copied={copiedField === "worker-id"}
              onCopy={() => void copyToClipboard("worker-id", (worker?.workerId ?? workerLookupId) || null)}
            />

            {authToken ? (
              <CredentialRow
                label="Session API Key"
                value={authToken}
                placeholder="Session API key"
                canCopy={true}
                copied={copiedField === "session-key"}
                onCopy={() => void copyToClipboard("session-key", authToken)}
              />
            ) : null}

            <div className="ow-inline-actions">
              <button type="button" className="ow-btn-secondary" onClick={handleCheckStatus} disabled={actionBusy !== null}>
                {actionBusy === "status" ? "Checking..." : "Check status"}
              </button>
              <button type="button" className="ow-btn-secondary" onClick={handleGenerateKey} disabled={actionBusy !== null}>
                {actionBusy === "token" ? "Generating..." : "New API key"}
              </button>
              <button
                type="button"
                className="ow-btn-secondary"
                onClick={() => {
                  setWorker(null);
                  setLaunchError(null);
                  setCheckoutUrl(null);
                  setLaunchStatus("Ready to launch another worker.");
                  appendEvent("info", "Starting a new launch", "Worker form reset");
                }}
              >
                Launch another
              </button>
            </div>

            <div className="ow-note-box">
              <p>Open the OpenWork app and paste the Worker URL plus Worker API key into the remote worker connect flow.</p>
              {launchError ? <p className="ow-error-text">{launchError}</p> : null}
            </div>

            {events.length > 0 ? (
              <div className="ow-log-box">
                <p className="ow-section-title">Launch log</p>
                <ul className="ow-log-list">
                  {events.map((entry) => (
                    <li key={entry.id} className={`ow-log-item level-${entry.level}`}>
                      <div className="ow-log-head">
                        <span>{entry.label}</span>
                        <span className="ow-mono">{new Date(entry.at).toLocaleTimeString()}</span>
                      </div>
                      <p>{entry.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
