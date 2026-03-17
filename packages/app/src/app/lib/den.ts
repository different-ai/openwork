import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../utils";

const STORAGE_BASE_URL = "openwork.den.baseUrl";
const STORAGE_API_BASE_URL = "openwork.den.apiBaseUrl";
const STORAGE_AUTH_TOKEN = "openwork.den.authToken";
const STORAGE_ACTIVE_ORG_ID = "openwork.den.activeOrgId";
const DEFAULT_DEN_TIMEOUT_MS = 12_000;

export const DEFAULT_DEN_AUTH_NAME = "OpenWork User";
export const DEFAULT_DEN_BASE_URL =
  (typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_DEN_BASE_URL === "string"
    ? import.meta.env.VITE_DEN_BASE_URL
    : "").trim() || "https://app.openworklabs.com";

export type DenSettings = {
  baseUrl: string;
  apiBaseUrl?: string;
  authToken?: string | null;
  activeOrgId?: string | null;
};

type DenBaseUrls = {
  baseUrl: string;
  apiBaseUrl: string;
};

export type DenUser = {
  id: string;
  email: string;
  name: string | null;
};

export type DenOrgSummary = {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "member";
};

export type DenWorkerSummary = {
  workerId: string;
  workerName: string;
  status: string;
  instanceUrl: string | null;
  provider: string | null;
  isMine: boolean;
  createdAt: string | null;
};

export type DenWorkerTokens = {
  clientToken: string | null;
  ownerToken: string | null;
  hostToken: string | null;
  openworkUrl: string | null;
  workspaceId: string | null;
};

type DenAuthResult = {
  user: DenUser | null;
  token: string | null;
};

export type DenDesktopHandoffExchange = {
  user: DenUser | null;
  token: string | null;
};

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

export class DenApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "DenApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeDenBaseUrl(input: string | null | undefined): string | null {
  const value = (input ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isWebAppHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "app.openworklabs.com" || normalized === "app.openwork.software" || normalized.startsWith("app.");
}

function stripDenApiBasePath(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    const suffix = "/api/den";
    if (!pathname.toLowerCase().endsWith(suffix)) {
      return normalized;
    }

    const nextPathname = pathname.slice(0, -suffix.length) || "/";
    url.pathname = nextPathname;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function ensureDenApiBasePath(input: string | null | undefined): string | null {
  const normalized = normalizeDenBaseUrl(input);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.toLowerCase().endsWith("/api/den")) {
      return normalized;
    }
    url.pathname = `${pathname}/api/den`.replace(/\/+/g, "/");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized;
  }
}

function deriveDenApiBaseUrl(input: string | null | undefined): string {
  const normalized = normalizeDenBaseUrl(input) ?? DEFAULT_DEN_BASE_URL;

  try {
    const url = new URL(normalized);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (pathname.toLowerCase().endsWith("/api/den")) {
      return normalized;
    }
    if (isWebAppHost(url.hostname)) {
      return ensureDenApiBasePath(normalized) ?? normalized;
    }
  } catch {
    return normalized;
  }

  return normalized;
}

export function resolveDenBaseUrls(input: { baseUrl?: string | null; apiBaseUrl?: string | null } | string | null | undefined): DenBaseUrls {
  const rawBaseUrl = typeof input === "string" ? input : input?.baseUrl;
  const rawApiBaseUrl = typeof input === "string" ? null : input?.apiBaseUrl;
  const normalizedBaseUrl = normalizeDenBaseUrl(rawBaseUrl);
  const normalizedApiBaseUrl = normalizeDenBaseUrl(rawApiBaseUrl);
  const seedUrl = normalizedBaseUrl ?? normalizedApiBaseUrl ?? DEFAULT_DEN_BASE_URL;

  return {
    baseUrl: stripDenApiBasePath(normalizedBaseUrl ?? seedUrl) ?? DEFAULT_DEN_BASE_URL,
    apiBaseUrl: normalizedApiBaseUrl ?? deriveDenApiBaseUrl(seedUrl),
  };
}

function resolveRequestBaseUrl(baseUrls: DenBaseUrls, path: string): string {
  return path.startsWith("/api/") ? baseUrls.baseUrl : baseUrls.apiBaseUrl;
}

export function readDenSettings(): DenSettings {
  if (typeof window === "undefined") {
    return resolveDenBaseUrls(DEFAULT_DEN_BASE_URL);
  }

  const baseUrls = resolveDenBaseUrls({
    baseUrl: window.localStorage.getItem(STORAGE_BASE_URL) ?? "",
    apiBaseUrl: window.localStorage.getItem(STORAGE_API_BASE_URL) ?? "",
  });

  return {
    ...baseUrls,
    authToken: (window.localStorage.getItem(STORAGE_AUTH_TOKEN) ?? "").trim() || null,
    activeOrgId: (window.localStorage.getItem(STORAGE_ACTIVE_ORG_ID) ?? "").trim() || null,
  };
}

export function writeDenSettings(next: DenSettings) {
  if (typeof window === "undefined") {
    return;
  }

  const { baseUrl, apiBaseUrl } = resolveDenBaseUrls(next);
  const authToken = next.authToken?.trim() ?? "";
  const activeOrgId = next.activeOrgId?.trim() ?? "";

  window.localStorage.setItem(STORAGE_BASE_URL, baseUrl);
  window.localStorage.setItem(STORAGE_API_BASE_URL, apiBaseUrl);
  if (authToken) {
    window.localStorage.setItem(STORAGE_AUTH_TOKEN, authToken);
  } else {
    window.localStorage.removeItem(STORAGE_AUTH_TOKEN);
  }

  if (activeOrgId) {
    window.localStorage.setItem(STORAGE_ACTIVE_ORG_ID, activeOrgId);
  } else {
    window.localStorage.removeItem(STORAGE_ACTIVE_ORG_ID);
  }
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) {
    return payload.trim();
  }

  if (!isRecord(payload)) {
    return fallback;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  return fallback;
}

function getUser(payload: unknown): DenUser | null {
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
    name: typeof user.name === "string" ? user.name : null,
  };
}

function getToken(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.token !== "string") {
    return null;
  }
  return payload.token.trim() || null;
}

function getOrgList(payload: unknown): DenOrgSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.orgs)) {
    return [];
  }

  return payload.orgs
    .map((entry) => {
      if (!isRecord(entry)) return null;
      if (
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        typeof entry.slug !== "string" ||
        (entry.role !== "owner" && entry.role !== "member")
      ) {
        return null;
      }

      return {
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        role: entry.role,
      } satisfies DenOrgSummary;
    })
    .filter((entry): entry is DenOrgSummary => Boolean(entry));
}

function getWorkers(payload: unknown): DenWorkerSummary[] {
  if (!isRecord(payload) || !Array.isArray(payload.workers)) {
    return [];
  }

  return payload.workers
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const instance = isRecord(entry.instance) ? entry.instance : null;
      if (typeof entry.id !== "string" || typeof entry.name !== "string") {
        return null;
      }
      return {
        workerId: entry.id,
        workerName: entry.name,
        status: typeof entry.status === "string" ? entry.status : "unknown",
        instanceUrl: instance && typeof instance.url === "string" ? instance.url : null,
        provider: instance && typeof instance.provider === "string" ? instance.provider : null,
        isMine: Boolean(entry.isMine),
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
      } satisfies DenWorkerSummary;
    })
    .filter((entry): entry is DenWorkerSummary => Boolean(entry));
}

function getWorkerTokens(payload: unknown): DenWorkerTokens | null {
  if (!isRecord(payload) || !isRecord(payload.tokens)) {
    return null;
  }

  const tokens = payload.tokens;
  const connect = isRecord(payload.connect) ? payload.connect : null;
  return {
    clientToken: typeof tokens.client === "string" ? tokens.client : null,
    ownerToken: typeof tokens.owner === "string" ? tokens.owner : null,
    hostToken: typeof tokens.host === "string" ? tokens.host : null,
    openworkUrl: connect && typeof connect.openworkUrl === "string" ? connect.openworkUrl : null,
    workspaceId: connect && typeof connect.workspaceId === "string" ? connect.workspaceId : null,
  };
}

const resolveFetch = () => (isTauriRuntime() ? tauriFetch : globalThis.fetch);

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetchImpl(url, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init.signal ? { ...init, signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(url, initWithSignal), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJsonRaw<T>(
  input: string | DenBaseUrls,
  path: string,
  options: { method?: string; token?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<RawJsonResponse<T>> {
  const baseUrls = typeof input === "string" ? resolveDenBaseUrls(input) : input;
  const url = `${resolveRequestBaseUrl(baseUrls, path)}${path}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = options.token?.trim() ?? "";
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetchWithTimeout(
    resolveFetch(),
    url,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "include",
    },
    options.timeoutMs ?? DEFAULT_DEN_TIMEOUT_MS,
  );

  const text = await response.text();
  let json: T | null = null;
  try {
    json = text ? (JSON.parse(text) as T) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json };
}

async function requestJson<T>(
  input: string | DenBaseUrls,
  path: string,
  options: { method?: string; token?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const raw = await requestJsonRaw<T>(input, path, options);
  if (!raw.ok) {
    const payload = raw.json;
    const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "request_failed";
    const message = getErrorMessage(payload, `Request failed with ${raw.status}.`);
    throw new DenApiError(raw.status, code, message, isRecord(payload) ? payload.details : undefined);
  }
  return raw.json as T;
}

export function createDenClient(options: { baseUrl: string; token?: string | null }) {
  const baseUrls = resolveDenBaseUrls(options.baseUrl);
  const token = options.token?.trim() ?? null;

  return {
    async signInEmail(email: string, password: string): Promise<DenAuthResult> {
      const payload = await requestJson<unknown>(baseUrls, "/api/auth/sign-in/email", {
        method: "POST",
        body: {
          email: email.trim(),
          password,
        },
      });
      return { user: getUser(payload), token: getToken(payload) };
    },

    async signUpEmail(email: string, password: string): Promise<DenAuthResult> {
      const payload = await requestJson<unknown>(baseUrls, "/api/auth/sign-up/email", {
        method: "POST",
        body: {
          name: DEFAULT_DEN_AUTH_NAME,
          email: email.trim(),
          password,
        },
      });
      return { user: getUser(payload), token: getToken(payload) };
    },

    async signOut() {
      await requestJsonRaw(baseUrls, "/api/auth/sign-out", {
        method: "POST",
        token,
        body: {},
      });
    },

    async getSession(): Promise<DenUser> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me", {
        method: "GET",
        token,
      });
      const user = getUser(payload);
      if (!user) {
        throw new DenApiError(500, "invalid_session_payload", "Session response did not include a user.");
      }
      return user;
    },

    async exchangeDesktopHandoff(grant: string): Promise<DenDesktopHandoffExchange> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/auth/desktop-handoff/exchange", {
        method: "POST",
        body: { grant },
      });
      return { user: getUser(payload), token: getToken(payload) };
    },

    async listOrgs(): Promise<{ orgs: DenOrgSummary[]; defaultOrgId: string | null }> {
      const payload = await requestJson<unknown>(baseUrls, "/v1/me/orgs", {
        method: "GET",
        token,
      });
      return {
        orgs: getOrgList(payload),
        defaultOrgId: isRecord(payload) && typeof payload.defaultOrgId === "string" ? payload.defaultOrgId : null,
      };
    },

    async listWorkers(orgId: string, limit = 20): Promise<DenWorkerSummary[]> {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("orgId", orgId);
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers?${params.toString()}`, {
        method: "GET",
        token,
      });
      return getWorkers(payload);
    },

    async getWorkerTokens(workerId: string, orgId: string): Promise<DenWorkerTokens> {
      const params = new URLSearchParams();
      params.set("orgId", orgId);
      const payload = await requestJson<unknown>(baseUrls, `/v1/workers/${encodeURIComponent(workerId)}/tokens?${params.toString()}`, {
        method: "POST",
        token,
        body: {},
      });
      const tokens = getWorkerTokens(payload);
      if (!tokens) {
        throw new DenApiError(500, "invalid_worker_token_payload", "Worker token response was missing token values.");
      }
      return tokens;
    },
  };
}
