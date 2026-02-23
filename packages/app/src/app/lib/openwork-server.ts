import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauriRuntime } from "../utils";
import type { ScheduledJob } from "./tauri";

export type OpenworkServerCapabilities = {
  skills: { read: boolean; write: boolean; source: "openwork" | "opencode" };
  hub?: {
    skills?: {
      read: boolean;
      install: boolean;
      repo?: { owner: string; name: string; ref: string };
    };
  };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
  sandbox?: { enabled: boolean; backend: "none" | "docker" | "container" };
  proxy?: { opencode: boolean; opencodeRouter: boolean };
  toolProviders?: {
    browser?: {
      enabled: boolean;
      placement: "in-sandbox" | "host-machine" | "client-machine" | "external";
      mode: "none" | "headless" | "interactive";
    };
    files?: {
      injection: boolean;
      outbox: boolean;
      inboxPath: string;
      outboxPath: string;
      maxBytes: number;
    };
  };
};

export type OpenworkServerStatus = "connected" | "disconnected" | "limited";

export type OpenworkServerDiagnostics = {
  ok: boolean;
  version: string;
  uptimeMs: number;
  readOnly: boolean;
  approval: { mode: "manual" | "auto"; timeoutMs: number };
  corsOrigins: string[];
  workspaceCount: number;
  activeWorkspaceId: string | null;
  workspace: OpenworkWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type OpenworkServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
};

export type OpenworkWorkspaceInfo = {
  id: string;
  name: string;
  path: string;
  workspaceType: "local" | "remote";
  baseUrl?: string;
  directory?: string;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
    password?: string;
  };
};

export type OpenworkWorkspaceList = {
  items: OpenworkWorkspaceInfo[];
  activeId?: string | null;
};

export type OpenworkPluginItem = {
  spec: string;
  source: "config" | "dir.project" | "dir.global";
  scope: "project" | "global";
  path?: string;
};

export type OpenworkSkillItem = {
  name: string;
  path: string;
  description: string;
  scope: "project" | "global";
  trigger?: string;
};

export type OpenworkSkillContent = {
  item: OpenworkSkillItem;
  content: string;
};

export type OpenworkHubSkillItem = {
  name: string;
  description: string;
  trigger?: string;
  source: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  };
};

export type OpenworkWorkspaceFileContent = {
  path: string;
  content: string;
  bytes: number;
  updatedAt: number;
};

export type OpenworkWorkspaceFileWriteResult = {
  ok: boolean;
  path: string;
  bytes: number;
  updatedAt: number;
};

export type OpenworkCommandItem = {
  name: string;
  description?: string;
  template: string;
  agent?: string;
  model?: string | null;
  subtask?: boolean;
  scope: "workspace" | "global";
};

export type OpenworkMcpItem = {
  name: string;
  config: Record<string, unknown>;
  source: "config.project" | "config.global" | "config.remote";
  disabledByTools?: boolean;
};

export type OpenworkOpenCodeRouterTelegramResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    configured: boolean;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type OpenworkOpenCodeRouterSlackResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    configured: boolean;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type OpenworkOpenCodeRouterTelegramBotInfo = {
  id: number;
  username?: string;
  name?: string;
};

export type OpenworkOpenCodeRouterTelegramInfo = {
  ok: boolean;
  configured: boolean;
  enabled: boolean;
  bot: OpenworkOpenCodeRouterTelegramBotInfo | null;
};

export type OpenworkOpenCodeRouterTelegramEnabledResult = {
  ok: boolean;
  persisted?: boolean;
  enabled: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
};

export type OpenworkOpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
  activity?: {
    dayStart: number;
    inboundToday: number;
    outboundToday: number;
    lastInboundAt?: number;
    lastOutboundAt?: number;
    lastMessageAt?: number;
  };
  agent?: {
    scope: "workspace";
    path: string;
    loaded: boolean;
    selected?: string;
  };
};

export type OpenworkOpenCodeRouterBindingItem = {
  channel: string;
  identityId: string;
  peerId: string;
  directory: string;
  updatedAt?: number;
};

export type OpenworkOpenCodeRouterBindingsResult = {
  ok: boolean;
  items: OpenworkOpenCodeRouterBindingItem[];
};

export type OpenworkOpenCodeRouterBindingUpdateResult = {
  ok: boolean;
};

export type OpenworkOpenCodeRouterSendResult = {
  ok: boolean;
  channel: string;
  identityId?: string;
  directory: string;
  peerId?: string;
  attempted: number;
  sent: number;
  failures?: Array<{ identityId: string; peerId: string; error: string }>;
  reason?: string;
};

export type OpenworkOpenCodeRouterIdentityItem = {
  id: string;
  enabled: boolean;
  running: boolean;
  access?: "public" | "private";
  pairingRequired?: boolean;
};

export type OpenworkOpenCodeRouterTelegramIdentitiesResult = {
  ok: boolean;
  items: OpenworkOpenCodeRouterIdentityItem[];
};

export type OpenworkOpenCodeRouterSlackIdentitiesResult = {
  ok: boolean;
  items: OpenworkOpenCodeRouterIdentityItem[];
};

export type OpenworkOpenCodeRouterTelegramIdentityUpsertResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    id: string;
    enabled: boolean;
    access?: "public" | "private";
    pairingRequired?: boolean;
    pairingCode?: string;
    applied?: boolean;
    starting?: boolean;
    error?: string;
    bot?: OpenworkOpenCodeRouterTelegramBotInfo | null;
  };
};

export type OpenworkOpenCodeRouterSlackIdentityUpsertResult = {
  ok: boolean;
  persisted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    id: string;
    enabled: boolean;
    applied?: boolean;
    starting?: boolean;
    error?: string;
  };
};

export type OpenworkOpenCodeRouterTelegramIdentityDeleteResult = {
  ok: boolean;
  persisted?: boolean;
  deleted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  telegram?: {
    id: string;
    deleted: boolean;
  };
};

export type OpenworkOpenCodeRouterSlackIdentityDeleteResult = {
  ok: boolean;
  persisted?: boolean;
  deleted?: boolean;
  applied?: boolean;
  applyError?: string;
  applyStatus?: number;
  slack?: {
    id: string;
    deleted: boolean;
  };
};

export type OpenworkWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  openwork?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
};

export type OpenworkArtifactItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  createdAt?: number;
  updatedAt?: number;
  mime?: string;
};

export type OpenworkArtifactList = {
  items: OpenworkArtifactItem[];
};

export type OpenworkInboxItem = {
  id: string;
  name?: string;
  path?: string;
  size?: number;
  updatedAt?: number;
};

export type OpenworkInboxList = {
  items: OpenworkInboxItem[];
};

export type OpenworkInboxUploadResult = {
  ok: boolean;
  path: string;
  bytes: number;
};

export type OpenworkSoulHeartbeatEntry = {
  id: string;
  ts: string | null;
  workspace: string | null;
  summary: string;
  looseEnds: string[];
  nextAction: string | null;
};

export type OpenworkSoulStatus = {
  enabled: boolean;
  state: "off" | "healthy" | "stale" | "error";
  memoryEnabled: boolean;
  instructionsEnabled: boolean;
  heartbeatLogExists: boolean;
  heartbeatCommandExists: boolean;
  heartbeatJob: {
    name: string;
    slug: string;
    schedule: string;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunError: string | null;
  } | null;
  heartbeatCount: number;
  lastHeartbeatAt: string | null;
  lastHeartbeatSummary: string | null;
  staleAfterMs: number | null;
  overdue: boolean;
  summary: string;
  memoryPath: string;
  heartbeatPath: string;
};

type RawJsonResponse<T> = {
  ok: boolean;
  status: number;
  json: T | null;
};

export type OpenworkActor = {
  type: "remote" | "host";
  clientId?: string;
  tokenHash?: string;
};

export type OpenworkAuditEntry = {
  id: string;
  workspaceId: string;
  actor: OpenworkActor;
  action: string;
  target: string;
  summary: string;
  timestamp: number;
};

export type OpenworkReloadTrigger = {
  type: "skill" | "plugin" | "config" | "mcp" | "agent" | "command";
  name?: string;
  action?: "added" | "removed" | "updated";
  path?: string;
};

export type OpenworkReloadEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  reason: "plugins" | "skills" | "mcp" | "config" | "agents" | "commands";
  trigger?: OpenworkReloadTrigger;
  timestamp: number;
};

export const DEFAULT_OPENWORK_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "openwork.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "openwork.server.port";
const STORAGE_TOKEN = "openwork.server.token";

export function normalizeOpenworkServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function parseOpenworkWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeOpenworkServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    if (prev !== "w" || !last) return null;
    return decodeURIComponent(last);
  } catch {
    const match = normalized.match(/\/w\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

export function buildOpenworkWorkspaceBaseUrl(hostUrl: string, workspaceId?: string | null) {
  const normalized = normalizeOpenworkServerUrl(hostUrl) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    const alreadyMounted = prev === "w" && Boolean(last);
    if (alreadyMounted) {
      return url.toString().replace(/\/+$/, "");
    }

    const id = (workspaceId ?? "").trim();
    if (!id) return url.toString().replace(/\/+$/, "");

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/w/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    const id = (workspaceId ?? "").trim();
    if (!id) return normalized;
    return `${normalized.replace(/\/+$/, "")}/w/${encodeURIComponent(id)}`;
  }
}

export function readOpenworkServerSettings(): OpenworkServerSettings {
  if (typeof window === "undefined") return {};
  try {
    const urlOverride = normalizeOpenworkServerUrl(
      window.localStorage.getItem(STORAGE_URL_OVERRIDE) ?? "",
    );
    const portRaw = window.localStorage.getItem(STORAGE_PORT_OVERRIDE) ?? "";
    const portOverride = portRaw ? Number(portRaw) : undefined;
    const token = window.localStorage.getItem(STORAGE_TOKEN) ?? undefined;
    return {
      urlOverride: urlOverride ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token: token?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

export function writeOpenworkServerSettings(next: OpenworkServerSettings): OpenworkServerSettings {
  if (typeof window === "undefined") return next;
  try {
    const urlOverride = normalizeOpenworkServerUrl(next.urlOverride ?? "");
    const portOverride = typeof next.portOverride === "number" ? next.portOverride : undefined;
    const token = next.token?.trim() || undefined;

    if (urlOverride) {
      window.localStorage.setItem(STORAGE_URL_OVERRIDE, urlOverride);
    } else {
      window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    }

    if (typeof portOverride === "number" && !Number.isNaN(portOverride)) {
      window.localStorage.setItem(STORAGE_PORT_OVERRIDE, String(portOverride));
    } else {
      window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    }

    if (token) {
      window.localStorage.setItem(STORAGE_TOKEN, token);
    } else {
      window.localStorage.removeItem(STORAGE_TOKEN);
    }

    return readOpenworkServerSettings();
  } catch {
    return next;
  }
}

export function hydrateOpenworkServerSettingsFromEnv() {
  if (typeof window === "undefined") return;

  const envUrl = typeof import.meta.env?.VITE_OPENWORK_URL === "string"
    ? import.meta.env.VITE_OPENWORK_URL.trim()
    : "";
  const envPort = typeof import.meta.env?.VITE_OPENWORK_PORT === "string"
    ? import.meta.env.VITE_OPENWORK_PORT.trim()
    : "";
  const envToken = typeof import.meta.env?.VITE_OPENWORK_TOKEN === "string"
    ? import.meta.env.VITE_OPENWORK_TOKEN.trim()
    : "";

  if (!envUrl && !envPort && !envToken) return;

  try {
    const current = readOpenworkServerSettings();
    const next: OpenworkServerSettings = { ...current };
    let changed = false;

    if (!current.urlOverride && envUrl) {
      next.urlOverride = normalizeOpenworkServerUrl(envUrl) ?? undefined;
      changed = true;
    }

    if (!current.portOverride && envPort) {
      const parsed = Number(envPort);
      if (Number.isFinite(parsed) && parsed > 0) {
        next.portOverride = parsed;
        changed = true;
      }
    }

    if (!current.token && envToken) {
      next.token = envToken;
      changed = true;
    }

    if (changed) {
      writeOpenworkServerSettings(next);
    }
  } catch {
    // ignore
  }
}

export function clearOpenworkServerSettings() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_URL_OVERRIDE);
    window.localStorage.removeItem(STORAGE_PORT_OVERRIDE);
    window.localStorage.removeItem(STORAGE_TOKEN);
  } catch {
    // ignore
  }
}

export function deriveOpenworkServerUrl(
  opencodeBaseUrl: string,
  settings?: OpenworkServerSettings,
) {
  const override = settings?.urlOverride?.trim();
  if (override) {
    return normalizeOpenworkServerUrl(override);
  }

  const base = opencodeBaseUrl.trim();
  if (!base) return null;
  try {
    const url = new URL(base);
    const port = settings?.portOverride ?? DEFAULT_OPENWORK_SERVER_PORT;
    url.port = String(port);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}

export class OpenworkServerError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildHeaders(
  token?: string,
  hostToken?: string,
  extra?: Record<string, string>,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-OpenWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

function buildAuthHeaders(token?: string, hostToken?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (hostToken) {
    headers["X-OpenWork-Host-Token"] = hostToken;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

// Use Tauri's fetch when running in the desktop app to avoid CORS issues
const resolveFetch = () => (isTauriRuntime() ? tauriFetch : globalThis.fetch);

const DEFAULT_OPENWORK_SERVER_TIMEOUT_MS = 10_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
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
  } catch (error) {
    const name = (error && typeof error === "object" && "name" in error ? (error as any).name : "") as string;
    if (name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new OpenworkServerError(response.status, code, message, json?.details);
  }

  return json as T;
}

async function requestJsonRaw<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<RawJsonResponse<T>> {
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildHeaders(options.token, options.hostToken),
      body: options.body ? JSON.stringify(options.body) : undefined,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
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

async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "POST",
      headers: buildAuthHeaders(options.token, options.hostToken),
      body: options.body,
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function requestBinary(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; timeoutMs?: number } = {},
): Promise<{ data: ArrayBuffer; contentType: string | null; filename: string | null }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch();
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: options.method ?? "GET",
      headers: buildAuthHeaders(options.token, options.hostToken),
    },
    options.timeoutMs ?? DEFAULT_OPENWORK_SERVER_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new OpenworkServerError(response.status, code, message, json?.details);
  }

  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const filenameRaw = filenameMatch?.[1] ?? filenameMatch?.[2] ?? null;
  const filename = filenameRaw ? decodeURIComponent(filenameRaw) : null;
  const data = await response.arrayBuffer();
  return { data, contentType, filename };
}

export function createOpenworkServerClient(options: { baseUrl: string; token?: string; hostToken?: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;
  const hostToken = options.hostToken;

  const timeouts = {
    health: 3_000,
    capabilities: 6_000,
    listWorkspaces: 8_000,
    activateWorkspace: 10_000,
    deleteWorkspace: 10_000,
    deleteSession: 12_000,
    status: 6_000,
    config: 10_000,
    opencodeRouter: 10_000,
    workspaceExport: 30_000,
    workspaceImport: 30_000,
    binary: 60_000,
  };

  return {
    baseUrl,
    token,
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    status: () => requestJson<OpenworkServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    capabilities: () => requestJson<OpenworkServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    opencodeRouterHealth: () =>
      requestJsonRaw<OpenworkOpenCodeRouterHealthSnapshot>(baseUrl, "/opencode-router/health", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    opencodeRouterBindings: (filters?: { channel?: string; identityId?: string }) => {
      const search = new URLSearchParams();
      if (filters?.channel?.trim()) search.set("channel", filters.channel.trim());
      if (filters?.identityId?.trim()) search.set("identityId", filters.identityId.trim());
      const suffix = search.toString();
      const path = suffix ? `/opencode-router/bindings?${suffix}` : "/opencode-router/bindings";
      return requestJsonRaw<OpenworkOpenCodeRouterBindingsResult>(baseUrl, path, { token, hostToken, timeoutMs: timeouts.opencodeRouter });
    },
    opencodeRouterTelegramIdentities: () =>
      requestJsonRaw<OpenworkOpenCodeRouterTelegramIdentitiesResult>(baseUrl, "/opencode-router/identities/telegram", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    opencodeRouterSlackIdentities: () =>
      requestJsonRaw<OpenworkOpenCodeRouterSlackIdentitiesResult>(baseUrl, "/opencode-router/identities/slack", { token, hostToken, timeoutMs: timeouts.opencodeRouter }),
    listWorkspaces: () => requestJson<OpenworkWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    activateWorkspace: (workspaceId: string) =>
      requestJson<{ activeId: string; workspace: OpenworkWorkspaceInfo }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      ),
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: OpenworkWorkspaceInfo[] }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteWorkspace },
      ),
    deleteSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ ok: boolean }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.deleteSession },
      ),
    exportWorkspace: (workspaceId: string) =>
      requestJson<OpenworkWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      }),
    importWorkspace: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/import`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.workspaceImport,
      }),
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; openwork: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    setOpenCodeRouterTelegramToken: (
      workspaceId: string,
      tokenValue: string,
      healthPort?: number | null,
    ) =>
      requestJson<OpenworkOpenCodeRouterTelegramResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/telegram-token`,
        {
          token,
          hostToken,
          method: "POST",
          body: { token: tokenValue, healthPort },
          timeoutMs: timeouts.opencodeRouter,
        },
      ),
    setOpenCodeRouterSlackTokens: (
      workspaceId: string,
      botToken: string,
      appToken: string,
      healthPort?: number | null,
    ) =>
      requestJson<OpenworkOpenCodeRouterSlackResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/slack-tokens`,
        {
          token,
          hostToken,
          method: "POST",
          body: { botToken, appToken, healthPort },
          timeoutMs: timeouts.opencodeRouter,
        },
      ),
    getOpenCodeRouterTelegram: (workspaceId: string) =>
      requestJson<OpenworkOpenCodeRouterTelegramInfo>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/telegram`,
        { token, hostToken, timeoutMs: timeouts.opencodeRouter },
      ),
    getOpenCodeRouterTelegramIdentities: (workspaceId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<OpenworkOpenCodeRouterTelegramIdentitiesResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/identities/telegram${query}`,
        { token, hostToken, timeoutMs: timeouts.opencodeRouter },
      );
    },
    upsertOpenCodeRouterTelegramIdentity: (
      workspaceId: string,
      input: { id?: string; token: string; enabled?: boolean; access?: "public" | "private"; pairingCode?: string },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<OpenworkOpenCodeRouterTelegramIdentityUpsertResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/identities/telegram`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.id?.trim() ? { id: input.id.trim() } : {}),
            token: input.token,
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            ...(input.access ? { access: input.access } : {}),
            ...(input.pairingCode?.trim() ? { pairingCode: input.pairingCode.trim() } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    deleteOpenCodeRouterTelegramIdentity: (workspaceId: string, identityId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<OpenworkOpenCodeRouterTelegramIdentityDeleteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/identities/telegram/${encodeURIComponent(identityId)}${query}`,
        { token, hostToken, method: "DELETE" },
      );
    },
    getOpenCodeRouterSlackIdentities: (workspaceId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<OpenworkOpenCodeRouterSlackIdentitiesResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/identities/slack${query}`,
        { token, hostToken },
      );
    },
    upsertOpenCodeRouterSlackIdentity: (
      workspaceId: string,
      input: { id?: string; botToken: string; appToken: string; enabled?: boolean },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<OpenworkOpenCodeRouterSlackIdentityUpsertResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/identities/slack`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(input.id?.trim() ? { id: input.id.trim() } : {}),
            botToken: input.botToken,
            appToken: input.appToken,
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    deleteOpenCodeRouterSlackIdentity: (workspaceId: string, identityId: string, options?: { healthPort?: number | null }) => {
      const query = typeof options?.healthPort === "number" ? `?healthPort=${encodeURIComponent(String(options.healthPort))}` : "";
      return requestJson<OpenworkOpenCodeRouterSlackIdentityDeleteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/identities/slack/${encodeURIComponent(identityId)}${query}`,
        { token, hostToken, method: "DELETE" },
      );
    },
    getOpenCodeRouterBindings: (
      workspaceId: string,
      filters?: { channel?: string; identityId?: string; healthPort?: number | null },
    ) => {
      const search = new URLSearchParams();
      if (filters?.channel?.trim()) search.set("channel", filters.channel.trim());
      if (filters?.identityId?.trim()) search.set("identityId", filters.identityId.trim());
      if (typeof filters?.healthPort === "number") search.set("healthPort", String(filters.healthPort));
      const suffix = search.toString();
      return requestJson<OpenworkOpenCodeRouterBindingsResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/bindings${suffix ? `?${suffix}` : ""}`,
        { token, hostToken },
      );
    },
    setOpenCodeRouterBinding: (
      workspaceId: string,
      input: { channel: string; identityId?: string; peerId: string; directory?: string },
      options?: { healthPort?: number | null },
    ) =>
      requestJson<OpenworkOpenCodeRouterBindingUpdateResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/bindings`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            channel: input.channel,
            ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}),
            peerId: input.peerId,
            ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
            healthPort: options?.healthPort ?? null,
          },
        },
      ),
    sendOpenCodeRouterMessage: (
      workspaceId: string,
      input: {
        channel: "telegram" | "slack";
        text: string;
        identityId?: string;
        directory?: string;
        peerId?: string;
        autoBind?: boolean;
      },
      options?: { healthPort?: number | null },
    ) => {
      const payload = {
        channel: input.channel,
        text: input.text,
        ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}),
        ...(input.directory?.trim() ? { directory: input.directory.trim() } : {}),
        ...(input.peerId?.trim() ? { peerId: input.peerId.trim() } : {}),
        ...(input.autoBind === true ? { autoBind: true } : {}),
        healthPort: options?.healthPort ?? null,
      };

      const primaryPath = `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/send`;
      const mountedWorkspaceId = parseOpenworkWorkspaceIdFromUrl(baseUrl);
      const fallbackPath =
        mountedWorkspaceId && mountedWorkspaceId === workspaceId
          ? `/opencode-router/send`
          : `/w/${encodeURIComponent(workspaceId)}/opencode-router/send`;

      return requestJson<OpenworkOpenCodeRouterSendResult>(baseUrl, primaryPath, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.opencodeRouter,
      }).catch(async (error) => {
        if (!(error instanceof OpenworkServerError) || error.status !== 404) {
          throw error;
        }
        return requestJson<OpenworkOpenCodeRouterSendResult>(baseUrl, fallbackPath, {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.opencodeRouter,
        });
      });
    },
    setOpenCodeRouterTelegramEnabled: (
      workspaceId: string,
      enabled: boolean,
      options?: { clearToken?: boolean; healthPort?: number | null },
    ) =>
      requestJson<OpenworkOpenCodeRouterTelegramEnabledResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/opencode-router/telegram-enabled`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled, clearToken: options?.clearToken ?? false, healthPort: options?.healthPort ?? null },
        },
      ),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; openwork?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    listReloadEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: OpenworkReloadEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${workspaceId}/events${query}`,
        { token, hostToken },
      );
    },
    reloadEngine: (workspaceId: string) =>
      requestJson<{ ok: boolean; reloadedAt?: number }>(baseUrl, `/workspace/${workspaceId}/engine/reload`, {
        token,
        hostToken,
        method: "POST",
      }),
    listPlugins: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins${query}`,
        { token, hostToken },
      );
    },
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins`,
        { token, hostToken, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins/${encodeURIComponent(name)}`,
        { token, hostToken, method: "DELETE" },
      ),
    listSkills: (workspaceId: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<{ items: OpenworkSkillItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/skills${query}`,
        { token, hostToken },
      );
    },
    listHubSkills: () =>
      requestJson<{ items: OpenworkHubSkillItem[] }>(baseUrl, `/hub/skills`, {
        token,
        hostToken,
      }),
    installHubSkill: (
      workspaceId: string,
      name: string,
      options?: { overwrite?: boolean; repo?: { owner?: string; repo?: string; ref?: string } },
    ) =>
      requestJson<{ ok: boolean; name: string; path: string; action: "added" | "updated"; written: number; skipped: number }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/hub/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            ...(options?.overwrite ? { overwrite: true } : {}),
            ...(options?.repo ? { repo: options.repo } : {}),
          },
        },
      ),
    getSkill: (workspaceId: string, name: string, options?: { includeGlobal?: boolean }) => {
      const query = options?.includeGlobal ? "?includeGlobal=true" : "";
      return requestJson<OpenworkSkillContent>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}${query}`,
        { token, hostToken },
      );
    },
    upsertSkill: (workspaceId: string, payload: { name: string; content: string; description?: string }) =>
      requestJson<OpenworkSkillItem>(baseUrl, `/workspace/${workspaceId}/skills`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    listMcp: (workspaceId: string) =>
      requestJson<{ items: OpenworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, { token, hostToken }),
    addMcp: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: OpenworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    removeMcp: (workspaceId: string, name: string) =>
      requestJson<{ items: OpenworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    logoutMcpAuth: (workspaceId: string, name: string) =>
      requestJson<{ ok: true }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/auth`, {
        token,
        hostToken,
        method: "DELETE",
      }),

    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: OpenworkCommandItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/commands?scope=${scope}`,
        { token, hostToken },
      ),
    listAudit: (workspaceId: string, limit = 50) =>
      requestJson<{ items: OpenworkAuditEntry[] }>(
        baseUrl,
        `/workspace/${workspaceId}/audit?limit=${limit}`,
        { token, hostToken },
      ),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: OpenworkCommandItem[] }>(baseUrl, `/workspace/${workspaceId}/commands`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${workspaceId}/commands/${encodeURIComponent(name)}`, {
        token,
        hostToken,
        method: "DELETE",
      }),
    listScheduledJobs: (workspaceId: string) =>
      requestJson<{ items: ScheduledJob[] }>(baseUrl, `/workspace/${workspaceId}/scheduler/jobs`, { token, hostToken }),
    deleteScheduledJob: (workspaceId: string, name: string) =>
      requestJson<{ job: ScheduledJob }>(baseUrl, `/workspace/${workspaceId}/scheduler/jobs/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    getSoulStatus: (workspaceId: string) =>
      requestJson<OpenworkSoulStatus>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/soul/status`, {
        token,
        hostToken,
      }),
    listSoulHeartbeats: (workspaceId: string, limit = 20) =>
      requestJson<{ items: OpenworkSoulHeartbeatEntry[]; total: number; path: string }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/soul/heartbeats?limit=${encodeURIComponent(String(limit))}`,
        { token, hostToken },
      ),

    uploadInbox: async (workspaceId: string, file: File, options?: { path?: string }) => {
      const id = workspaceId.trim();
      if (!id) throw new Error("workspaceId is required");
      if (!file) throw new Error("file is required");
      const form = new FormData();
      form.append("file", file);
      if (options?.path?.trim()) {
        form.append("path", options.path.trim());
      }

      const result = await requestMultipartRaw(baseUrl, `/workspace/${encodeURIComponent(id)}/inbox`, {
        token,
        hostToken,
        method: "POST",
        body: form,
        timeoutMs: timeouts.binary,
      });

      if (!result.ok) {
        let message = result.text.trim();
        try {
          const json = message ? JSON.parse(message) : null;
          if (json && typeof json.message === "string") {
            message = json.message;
          }
        } catch {
          // ignore
        }
        throw new OpenworkServerError(result.status, "request_failed", message || "Inbox upload failed");
      }

      const body = result.text.trim();
      if (body) {
        try {
          const parsed = JSON.parse(body) as Partial<OpenworkInboxUploadResult>;
          if (typeof parsed.path === "string" && parsed.path.trim()) {
            return {
              ok: parsed.ok ?? true,
              path: parsed.path.trim(),
              bytes: typeof parsed.bytes === "number" ? parsed.bytes : file.size,
            } satisfies OpenworkInboxUploadResult;
          }
        } catch {
          // ignore invalid JSON and fall back
        }
      }

      return {
        ok: true,
        path: options?.path?.trim() || file.name,
        bytes: file.size,
      } satisfies OpenworkInboxUploadResult;
    },

    listInbox: (workspaceId: string) =>
      requestJson<OpenworkInboxList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/inbox`, {
        token,
        hostToken,
      }),

    downloadInboxItem: (workspaceId: string, inboxId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(inboxId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    readWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<OpenworkWorkspaceFileContent>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`,
        { token, hostToken },
      ),

    writeWorkspaceFile: (
      workspaceId: string,
      payload: { path: string; content: string; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<OpenworkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/content`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
        },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<OpenworkArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),
  };
}

export type OpenworkServerClient = ReturnType<typeof createOpenworkServerClient>;
