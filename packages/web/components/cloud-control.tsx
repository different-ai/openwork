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
  openworkUrl: string | null;
  workspaceId: string | null;
  clientToken: string | null;
  hostToken: string | null;
};

type WorkerSummary = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
};

type WorkerTokens = {
  clientToken: string | null;
  hostToken: string | null;
  openworkUrl: string | null;
  workspaceId: string | null;
};

type WorkerListItem = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
  createdAt: string | null;
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
    openworkUrl: instance && typeof instance.url === "string" ? instance.url : null,
    workspaceId: null,
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

  const instance = isRecord(payload.instance) ? payload.instance : null;

  return {
    workerId: worker.id,
    workerName: worker.name,
    status: typeof worker.status === "string" ? worker.status : "unknown",
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    isMine: worker.isMine === true
  };
}

function getWorkerTokens(payload: unknown): WorkerTokens | null {
  if (!isRecord(payload) || !isRecord(payload.tokens)) {
    return null;
  }

  const tokens = payload.tokens;
  const connect = isRecord(payload.connect) ? payload.connect : null;
  const clientToken = typeof tokens.client === "string" ? tokens.client : null;
  const hostToken = typeof tokens.host === "string" ? tokens.host : null;
  const openworkUrl = connect && typeof connect.openworkUrl === "string" ? connect.openworkUrl : null;
  const workspaceId = connect && typeof connect.workspaceId === "string" ? connect.workspaceId : null;

  if (!clientToken && !hostToken) {
    return null;
  }

  return { clientToken, hostToken, openworkUrl, workspaceId };
}

function parseWorkerListItem(value: unknown): WorkerListItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const workerId = value.id;
  const workerName = value.name;
  if (typeof workerId !== "string" || typeof workerName !== "string") {
    return null;
  }

  const instance = isRecord(value.instance) ? value.instance : null;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : null;

  return {
    workerId,
    workerName,
    status: typeof value.status === "string" ? value.status : "unknown",
    instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
    provider: instance && typeof instance.provider === "string" ? instance.provider : null,
    isMine: value.isMine === true,
    createdAt
  };
}

function getWorkersList(payload: unknown): WorkerListItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.workers)) {
    return [];
  }

  const rows: WorkerListItem[] = [];
  for (const item of payload.workers) {
    const parsed = parseWorkerListItem(item);
    if (parsed) {
      rows.push(parsed);
    }
  }

  return rows;
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
    (typeof value.openworkUrl === "string" || value.openworkUrl === null || typeof value.openworkUrl === "undefined") &&
    (typeof value.workspaceId === "string" || value.workspaceId === null || typeof value.workspaceId === "undefined") &&
    (typeof value.clientToken === "string" || value.clientToken === null) &&
    (typeof value.hostToken === "string" || value.hostToken === null)
  );
}

function listItemToWorker(item: WorkerListItem, current: WorkerLaunch | null = null): WorkerLaunch {
  return {
    workerId: item.workerId,
    workerName: item.workerName,
    status: item.status,
    provider: item.provider,
    instanceUrl: item.instanceUrl,
    openworkUrl: item.instanceUrl,
    workspaceId: null,
    clientToken: current?.workerId === item.workerId ? current.clientToken : null,
    hostToken: current?.workerId === item.workerId ? current.hostToken : null
  };
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseWorkspaceIdFromUrl(value: string): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return null;
  }

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    if (prev !== "w" || !last) {
      return null;
    }
    return decodeURIComponent(last);
  } catch {
    const match = normalized.match(/\/w\/([^/?#]+)/);
    if (!match?.[1]) {
      return null;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

function buildWorkspaceUrl(instanceUrl: string, workspaceId: string): string {
  return `${normalizeUrl(instanceUrl)}/w/${encodeURIComponent(workspaceId)}`;
}

function parseWorkspaceIdFromWorkspacesPayload(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return null;
  }

  const activeId = typeof payload.activeId === "string" ? payload.activeId : null;
  if (activeId && payload.items.some((item) => isRecord(item) && item.id === activeId)) {
    return activeId;
  }

  for (const item of payload.items) {
    if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
      return item.id;
    }
  }

  return null;
}

async function requestAbsoluteJson(url: string, init: RequestInit = {}, timeoutMs = 12000) {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  const shouldAttachTimeout = !init.signal && timeoutMs > 0;
  const timeoutController = shouldAttachTimeout ? new AbortController() : null;
  const timeoutHandle = timeoutController
    ? setTimeout(() => {
        timeoutController.abort();
      }, timeoutMs)
    : null;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: "omit",
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

  return { response, payload };
}

async function resolveOpenworkWorkspaceUrl(instanceUrl: string, accessToken: string): Promise<{ workspaceId: string; openworkUrl: string } | null> {
  const baseUrl = normalizeUrl(instanceUrl);
  const token = accessToken.trim();
  if (!baseUrl || !token) {
    return null;
  }

  const mountedWorkspaceId = parseWorkspaceIdFromUrl(baseUrl);
  if (mountedWorkspaceId) {
    return {
      workspaceId: mountedWorkspaceId,
      openworkUrl: baseUrl
    };
  }

  const { response, payload } = await requestAbsoluteJson(`${baseUrl}/workspaces`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    return null;
  }

  const workspaceId = parseWorkspaceIdFromWorkspacesPayload(payload);
  if (!workspaceId) {
    return null;
  }

  return {
    workspaceId,
    openworkUrl: buildWorkspaceUrl(baseUrl, workspaceId)
  };
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
  const [workers, setWorkers] = useState<WorkerListItem[]>([]);
  const [workersBusy, setWorkersBusy] = useState(false);
  const [workersError, setWorkersError] = useState<string | null>(null);
  const [launchBusy, setLaunchBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<"status" | "token" | null>(null);
  const [launchStatus, setLaunchStatus] = useState("Name your worker and click launch.");
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [paymentReturned, setPaymentReturned] = useState(false);

  const [events, setEvents] = useState<LaunchEvent[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [tokenFetchedForWorkerId, setTokenFetchedForWorkerId] = useState<string | null>(null);

  const selectedWorker = workers.find((item) => item.workerId === workerLookupId) ?? null;

  const progressWidth = step === 1 ? "33.333%" : step === 2 ? "66.666%" : "100%";
  const openworkConnectUrl = worker?.openworkUrl ?? worker?.instanceUrl ?? null;
  const hasWorkspaceScopedUrl = Boolean(openworkConnectUrl && /\/w\/[^/?#]+/.test(openworkConnectUrl));

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

  async function withResolvedOpenworkCredentials(candidate: WorkerLaunch, options: { quiet?: boolean } = {}) {
    const existingConnectUrl = candidate.openworkUrl?.trim() ?? "";
    const existingWorkspaceId = candidate.workspaceId?.trim() ?? "";
    if (existingConnectUrl && existingWorkspaceId) {
      return {
        ...candidate,
        openworkUrl: existingConnectUrl,
        workspaceId: existingWorkspaceId
      };
    }

    const instanceUrl = candidate.instanceUrl?.trim() ?? "";
    if (!instanceUrl) {
      return {
        ...candidate,
        openworkUrl: null,
        workspaceId: null
      };
    }

    const accessToken = candidate.clientToken?.trim() ?? "";
    if (!accessToken) {
      const mountedWorkspaceId = parseWorkspaceIdFromUrl(instanceUrl);
      return {
        ...candidate,
        openworkUrl: normalizeUrl(instanceUrl),
        workspaceId: mountedWorkspaceId
      };
    }

    try {
      const resolved = await resolveOpenworkWorkspaceUrl(instanceUrl, accessToken);
      if (resolved) {
        return {
          ...candidate,
          openworkUrl: resolved.openworkUrl,
          workspaceId: resolved.workspaceId
        };
      }
    } catch {
      if (!options.quiet) {
        appendEvent("warning", "Credential hint", "Could not resolve /w/ws_ URL yet. Using host URL fallback.");
      }
    }

    return {
      ...candidate,
      openworkUrl: normalizeUrl(instanceUrl),
      workspaceId: parseWorkspaceIdFromUrl(instanceUrl)
    };
  }

  async function refreshWorkers(options: { keepSelection?: boolean } = {}) {
    if (!user) {
      setWorkers([]);
      setWorkersError(null);
      return;
    }

    setWorkersBusy(true);
    setWorkersError(null);

    try {
      const { response, payload } = await requestJson("/v1/workers?limit=20", {
        method: "GET",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Failed to load workers (${response.status}).`);
        setWorkersError(message);
        return;
      }

      const nextWorkers = getWorkersList(payload);
      setWorkers(nextWorkers);

      const currentSelection = options.keepSelection ? workerLookupId : "";
      const nextSelectedId =
        currentSelection && nextWorkers.some((item) => item.workerId === currentSelection)
          ? currentSelection
          : nextWorkers[0]?.workerId ?? "";

      setWorkerLookupId(nextSelectedId);

      if (nextSelectedId && worker && worker.workerId === nextSelectedId) {
        const selected = nextWorkers.find((item) => item.workerId === nextSelectedId) ?? null;
        if (selected) {
          setWorker((current) => listItemToWorker(selected, current));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setWorkersError(message);
    } finally {
      setWorkersBusy(false);
    }
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
    if (!user) {
      setWorkers([]);
      setWorkersError(null);
      return;
    }

    void refreshWorkers();
  }, [user?.id, authToken]);

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
        openworkUrl: parsed.openworkUrl ?? parsed.instanceUrl,
        workspaceId: parsed.workspaceId ?? parseWorkspaceIdFromUrl(parsed.instanceUrl ?? ""),
        clientToken: null,
        hostToken: null
      };

      setWorker(restored);
      setWorkerLookupId(restored.workerId);
      setLaunchStatus(`Recovered worker ${restored.workerName}. Get an access token if needed.`);
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

  useEffect(() => {
    if (!user || !worker) {
      return;
    }
    if (worker.clientToken) {
      return;
    }
    if (actionBusy !== null || launchBusy) {
      return;
    }
    if (tokenFetchedForWorkerId === worker.workerId) {
      return;
    }

    setTokenFetchedForWorkerId(worker.workerId);
    void handleGenerateKey();
  }, [actionBusy, launchBusy, tokenFetchedForWorkerId, user, worker]);

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

      const resolvedWorker = await withResolvedOpenworkCredentials(parsedWorker);
      setWorker(resolvedWorker);
      setWorkerLookupId(parsedWorker.workerId);
      setPaymentReturned(false);
      setCheckoutUrl(null);
      setLaunchStatus(`Worker ${resolvedWorker.workerName} is ${resolvedWorker.status}.`);
      appendEvent("success", "Worker launched", `Worker ID ${parsedWorker.workerId}`);
    } catch (error) {
      const message =
        error instanceof DOMException && error.name === "AbortError"
          ? "Launch request timed out after 45s. Refresh the worker list below to continue without manual IDs."
          : error instanceof Error
            ? error.message
            : "Unknown network error";

      setLaunchError(message);
      setLaunchStatus("Launch request failed.");
      appendEvent("error", "Launch failed", message);
    } finally {
      setLaunchBusy(false);
      void refreshWorkers({ keepSelection: true });
    }
  }

  async function handleCheckStatus() {
    if (!user) {
      setLaunchError("Sign in before checking worker status.");
      return;
    }

    const id = workerLookupId.trim() || worker?.workerId || workers[0]?.workerId || "";
    if (!id) {
      setLaunchError("No worker selected yet. Launch one first, then use this panel.");
      return;
    }

    setWorkerLookupId(id);

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

      const nextWorker: WorkerLaunch =
        worker && worker.workerId === summary.workerId
          ? {
              ...worker,
              workerName: summary.workerName,
              status: summary.status,
              provider: summary.provider,
              instanceUrl: summary.instanceUrl
            }
          : {
              workerId: summary.workerId,
              workerName: summary.workerName,
              status: summary.status,
              provider: summary.provider,
              instanceUrl: summary.instanceUrl,
              openworkUrl: summary.instanceUrl,
              workspaceId: null,
              clientToken: null,
              hostToken: null
            };

      const resolvedWorker = await withResolvedOpenworkCredentials(nextWorker, { quiet: true });
      setWorker(resolvedWorker);

      setWorkerLookupId(summary.workerId);
      setLaunchStatus(`Worker ${summary.workerName} is currently ${summary.status}.`);
      appendEvent("info", "Status refreshed", `${summary.workerName}: ${summary.status}`);
      void refreshWorkers({ keepSelection: true });
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
      setLaunchError("Sign in before fetching a worker access token.");
      return;
    }

    const id = workerLookupId.trim() || worker?.workerId || workers[0]?.workerId || "";
    if (!id) {
      setLaunchError("No worker selected yet. Launch one first, then fetch a token.");
      return;
    }

    setWorkerLookupId(id);

    setActionBusy("token");
    setLaunchError(null);

    try {
      const { response, payload } = await requestJson(`/v1/workers/${encodeURIComponent(id)}/tokens`, {
        method: "POST",
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const message = getErrorMessage(payload, `Token fetch failed with ${response.status}.`);
        setLaunchError(message);
        appendEvent("error", "Token fetch failed", message);
        return;
      }

      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        setLaunchError("Token response returned no token values.");
        appendEvent("error", "Token fetch failed", "Missing token payload");
        return;
      }

      const nextWorker: WorkerLaunch =
        worker && worker.workerId === id
          ? {
              ...worker,
              openworkUrl: tokens.openworkUrl ?? worker.openworkUrl,
              workspaceId: tokens.workspaceId ?? worker.workspaceId,
              clientToken: tokens.clientToken,
              hostToken: tokens.hostToken
            }
          : {
              workerId: id,
              workerName: "Existing worker",
              status: "unknown",
              provider: null,
              instanceUrl: null,
              openworkUrl: tokens.openworkUrl,
              workspaceId: tokens.workspaceId,
              clientToken: tokens.clientToken,
              hostToken: tokens.hostToken
            };

      const resolvedWorker = await withResolvedOpenworkCredentials(nextWorker, { quiet: true });
      setWorker(resolvedWorker);

      setLaunchStatus("Access token is ready for this worker.");
      appendEvent("success", "Access token ready", `Worker ID ${id}`);
      void refreshWorkers({ keepSelection: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown network error";
      setLaunchError(message);
      appendEvent("error", "Token fetch failed", message);
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
        detail: worker ? "Copy OpenWork URL + access token into OpenWork" : "Credentials appear when launch succeeds"
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
              <p className="ow-section-title">Your workers</p>
              <p className="ow-caption">No Worker ID guessing. Pick from your recent workers and continue.</p>

              {workersBusy ? <p className="ow-caption">Loading workers...</p> : null}
              {workersError ? <p className="ow-error-text">{workersError}</p> : null}

              {workers.length > 0 ? (
                <ul className="ow-worker-list">
                  {workers.map((item) => (
                    <li
                      key={item.workerId}
                      className={`ow-worker-item ${workerLookupId === item.workerId ? "is-active" : ""}`}
                    >
                      <div className="ow-worker-head">
                        <div>
                          <p className="ow-step-title">{item.workerName}</p>
                          <p className="ow-step-detail">{item.status}</p>
                        </div>
                        {item.isMine ? <span className="ow-badge">Yours</span> : null}
                      </div>
                      <p className="ow-worker-meta ow-mono">{item.instanceUrl ?? "URL pending provisioning"}</p>
                      <button
                        type="button"
                        className="ow-btn-secondary"
                        onClick={() => {
                          setWorkerLookupId(item.workerId);
                          setWorker((current) => listItemToWorker(item, current));
                        }}
                      >
                        {workerLookupId === item.workerId ? "Selected" : "Select"}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}

              {workers.length === 0 && !workersBusy ? (
                <p className="ow-caption">No workers yet. Launch one and it will appear here automatically.</p>
              ) : null}

              <div className="ow-inline-actions">
                <button
                  type="button"
                  className="ow-btn-secondary"
                  onClick={() => void refreshWorkers({ keepSelection: true })}
                  disabled={workersBusy}
                >
                  Refresh list
                </button>
                <button
                  type="button"
                  className="ow-btn-secondary"
                  onClick={handleCheckStatus}
                  disabled={actionBusy !== null || !selectedWorker}
                >
                  {actionBusy === "status" ? "Checking..." : "Check status"}
                </button>
                <button
                  type="button"
                  className="ow-btn-secondary"
                  onClick={handleGenerateKey}
                  disabled={actionBusy !== null || !selectedWorker}
                >
                  {actionBusy === "token" ? "Fetching..." : "Get access token"}
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
              label="OpenWork worker URL"
              value={openworkConnectUrl}
              placeholder="URL becomes available after provisioning."
              canCopy={Boolean(openworkConnectUrl)}
              copied={copiedField === "openwork-url"}
              onCopy={() => void copyToClipboard("openwork-url", openworkConnectUrl)}
            />

            <CredentialRow
              label="Access token"
              value={worker?.clientToken ?? null}
              placeholder="Click Get access token to retrieve credentials."
              canCopy={Boolean(worker?.clientToken)}
              copied={copiedField === "access-token"}
              onCopy={() => void copyToClipboard("access-token", worker?.clientToken ?? null)}
            />

            <CredentialRow
              label="Worker host URL"
              value={worker?.instanceUrl ?? null}
              placeholder="Host URL"
              canCopy={Boolean(worker?.instanceUrl)}
              copied={copiedField === "worker-host-url"}
              onCopy={() => void copyToClipboard("worker-host-url", worker?.instanceUrl ?? null)}
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
                {actionBusy === "token" ? "Fetching..." : "Get access token"}
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
              <p>Open OpenWork and paste OpenWork worker URL plus Access token into the remote connect flow.</p>
              {!hasWorkspaceScopedUrl && openworkConnectUrl ? (
                <p className="ow-caption">Tip: URL should include /w/ws_... . Click Check status to resolve the mounted workspace URL.</p>
              ) : null}
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
