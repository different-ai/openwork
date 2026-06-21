import type { Message, Part, Session, Todo } from "@opencode-ai/sdk/v2/client";
import { desktopFetch } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";
import type { ExecResult, OpencodeConfigFile, WorkspaceInfo, WorkspaceList } from "./desktop";
import type { DenOrgMarketplace, DenOrgPluginResolved, DenResourceSnapshot } from "./den-types";
import type { CloudImportedMarketplace, CloudImportedPlugin } from "../cloud/import-state";

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
  proxy?: { opencode: boolean };
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
  activeWorkspaceId?: string | null;
  selectedWorkspaceId?: string | null;
  workspace: OpenworkWorkspaceInfo | null;
  authorizedRoots: string[];
  server: { host: string; port: number; configPath?: string | null };
  tokenSource: { client: string; host: string };
};

export type OpenworkRuntimeServiceName = "openwork-server" | "opencode";

export type OpenworkRuntimeServiceSnapshot = {
  name: OpenworkRuntimeServiceName;
  enabled: boolean;
  running: boolean;
  targetVersion: string | null;
  actualVersion: string | null;
  upgradeAvailable: boolean;
};

export type OpenworkRuntimeSnapshot = {
  ok: boolean;
  orchestrator?: {
    version: string;
    startedAt: number;
  };
  worker?: {
    workspace: string;
    sandboxMode: string;
  };
  upgrade?: {
    status: "idle" | "running" | "failed";
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
    operationId: string | null;
    services: OpenworkRuntimeServiceName[];
  };
  services: OpenworkRuntimeServiceSnapshot[];
};

export type OpenworkServerSettings = {
  urlOverride?: string;
  portOverride?: number;
  token?: string;
  hostToken?: string;
  remoteAccessEnabled?: boolean;
};

// The shared WorkspaceWire contract now carries the opencode block; keep the
// historical name as an alias for the many existing imports.
export type OpenworkWorkspaceInfo = WorkspaceInfo;

export type OpenworkWorkspaceList = {
  items: OpenworkWorkspaceInfo[];
  workspaces?: WorkspaceInfo[];
  activeId?: string | null;
};

export type OpenworkSessionMessage = {
  info: Message;
  parts: Part[];
};

export type OpenworkSessionSnapshot = {
  session: Session;
  messages: OpenworkSessionMessage[];
  todos: Todo[];
  status:
    | { type: "idle" }
    | { type: "busy" }
    | { type: "retry"; attempt: number; message: string; next: number };
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

export type OpenworkHubRepo = {
  owner?: string;
  repo?: string;
  ref?: string;
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
  revision?: string;
};

export type OpenworkWorkspaceFileDeleteResult = {
  ok: boolean;
  path: string;
  code?: string;
};

export type OpenworkAuthorizedFoldersResponse = {
  folders: string[];
  hiddenCount: number;
  workspaceRoot: string;
};

export type OpenworkAuthorizedFoldersUpdateResponse = {
  folders: string[];
  hiddenCount: number;
  updatedAt: number;
};

export type OpenworkRuntimeConfigMigrationResult = {
  migrated: boolean;
  keys: string[];
  legacyKeys: string[];
  userOpencodeKeys: string[];
  updatedAt: number | null;
  legacyError?: string | null;
};

export type OpenworkRuntimeConfigStatus = {
  runtime: Record<string, unknown>;
  runtimeKeys: string[];
  effectiveRuntime: Record<string, unknown>;
  sources?: {
    projectOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    globalOpencode: { path: string; exists: boolean; keys: string[]; config: Record<string, unknown> };
    runtimeDatabase: { keys: string[]; config: Record<string, unknown> };
    injected: { keys: string[]; config: Record<string, unknown> };
  };
  legacyOpenwork: {
    path: string;
    keys: string[];
    error: string | null;
  };
  userOpencode: {
    path: string;
    exists: boolean;
    keys: string[];
    migratableKeys: string[];
  };
};

export type OpenworkDesktopCloudSyncChange = {
  id: string;
  kind: "new" | "modified" | "removed";
  resourceKind: "llmProvider" | "marketplace" | "plugin" | "configItem";
  marketplaceId?: string;
  pluginId?: string;
  previousLastUpdatedAt: string | null;
  nextLastUpdatedAt: string | null;
  queuedAt: number;
};

export type OpenworkDesktopCloudSyncState = {
  entries: Record<string, unknown>;
  updatedAt: number;
  version: 1;
};

export type OpenworkDesktopCloudSyncResult = {
  changes: OpenworkDesktopCloudSyncChange[];
  state: OpenworkDesktopCloudSyncState;
};

export type OpenworkCloudPluginInstallResult = {
  item: CloudImportedPlugin;
};

export type OpenworkCloudPluginsResult = {
  marketplaces: Record<string, CloudImportedMarketplace>;
  plugins: Record<string, CloudImportedPlugin>;
};

export type OpenworkClaudePluginComponent = {
  type: "mcp" | "skill" | "command" | "agent";
  name: string;
  description: string | null;
};

export type OpenworkClaudePluginPreview = {
  pluginId: string;
  name: string;
  description: string | null;
  version: string | null;
  source: { owner: string; repo: string; ref: string; dir: string | null };
  components: OpenworkClaudePluginComponent[];
  warnings: string[];
};

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

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

export type OpenworkMcpEngineSync = {
  status: "ok" | "failed";
  at: number;
  failures: Array<{ name: string; status?: number; message?: string }>;
};

export type OpenworkWorkspaceExport = {
  workspaceId: string;
  exportedAt: number;
  opencode?: Record<string, unknown>;
  openwork?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; trigger?: string; content: string }>;
  commands?: Array<{ name: string; description?: string; template?: string }>;
  files?: Array<{ path: string; content: string }>;
};

export type OpenworkWorkspaceImportChange = {
  kind: "opencode" | "openwork" | "skill" | "command" | "file";
  action: "create" | "update" | "replace" | "delete" | "unchanged";
  label: string;
  path: string;
};

export type OpenworkWorkspaceImportPreview = {
  fingerprint: string;
  summary: {
    total: number;
    create: number;
    update: number;
    replace: number;
    delete: number;
    unchanged: number;
  };
  changes: OpenworkWorkspaceImportChange[];
};

export type OpenworkWorkspaceExportSensitiveMode = "auto" | "include" | "exclude";

export type OpenworkWorkspaceExportWarning = {
  id: string;
  label: string;
  detail: string;
};

export type OpenworkBlueprintSessionsMaterializeResult = {
  ok: boolean;
  created: Array<{ templateId: string; sessionId: string; title: string }>;
  existing: Array<{ templateId: string; sessionId: string }>;
  openSessionId: string | null;
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

export type GoogleWorkspaceAccount = {
  accountId: string | null;
  email: string | null;
  name: string | null;
  picture: string | null;
  sub: string | null;
  scopes?: string[];
  connectedAt?: string | null;
};

export type GoogleWorkspaceAuthStatus = {
  configured: boolean;
  missing: string[];
  customClient: boolean;
  vault: "encrypted" | "plaintext-dev" | "unavailable";
  connected: boolean;
  account: GoogleWorkspaceAccount | null;
  accounts: GoogleWorkspaceAccount[];
  activeAccountId: string | null;
  scopes: string[];
  connectedAt: string | null;
  error: string | null;
  testStatus: string | null;
  smokeTest: {
    driveFileId: string | null;
    driveFileName: string | null;
    gmailDraftId: string | null;
  } | null;
};

export type GoogleWorkspaceConnectStart = {
  flowId: string;
  authUrl: string;
  expiresAt: number;
};

export type GoogleWorkspaceConnectStatus = {
  flowId: string;
  status: "pending" | "connected" | "failed" | "expired";
  expiresAt: number;
  error: string | null;
  googleWorkspace: GoogleWorkspaceAuthStatus | null;
};

export type OpenworkExtensionActionCall = {
  extensionId: string;
  action: string;
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type OpenworkExtensionActionResult = {
  ok: boolean;
  extensionId: string;
  action: string;
  result: unknown;
  context?: Record<string, unknown>;
};

export type OpenworkResolvedArtifactTarget = {
  id: string;
  kind: "file" | "url";
  value: string;
  name: string;
  preview: "browser" | "markdown" | "sheet" | "slides" | "image" | "pdf" | "html" | "text" | "external";
  confidence: number;
  reason: string;
  exists?: boolean;
  size?: number;
  updatedAt?: number;
  contentType?: string;
};

export type OpenworkWorkspaceFileStat = {
  ok: boolean;
  path: string;
  exists: boolean;
  kind?: "file" | "dir" | "other";
  size?: number;
  updatedAt?: number;
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

export type OpenworkUserEnvItem = {
  key: string;
  updatedAt: number;
  hasValue: boolean;
  value?: string;
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

export type OpenworkSessionGroupDefinition = {
  id: string;
  label: string;
};

export type OpenworkSessionGroupState = {
  groups: OpenworkSessionGroupDefinition[];
  assignments: Record<string, string>;
};

export type OpenworkSessionGroupEvent = {
  id: string;
  seq: number;
  workspaceId: string;
  type: "session_groups.updated";
  action: "created" | "updated" | "deleted" | "assigned" | "reordered" | "imported";
  groupId?: string;
  sessionId?: string;
  timestamp: number;
};

// Fallback for explicit server-mode URL derivation. Desktop local workers replace this
// with the persisted runtime-discovered port once the host reports it.
export const DEFAULT_OPENWORK_SERVER_PORT = 8787;

const STORAGE_URL_OVERRIDE = "openwork.server.urlOverride";
const STORAGE_PORT_OVERRIDE = "openwork.server.port";
const STORAGE_TOKEN = "openwork.server.token";
const STORAGE_HOST_AUTH_KEY = "openwork.server.hostToken";
const STORAGE_REMOTE_ACCESS = "openwork.server.remoteAccessEnabled";

export function normalizeOpenworkServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function isLoopbackOpenworkServerUrl(input: string) {
  const normalized = normalizeOpenworkServerUrl(input) ?? "";
  if (!normalized) return false;
  try {
    const hostname = new URL(normalized).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export function parseOpenworkWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeOpenworkServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const legacyIndex = segments.indexOf("w");
    if (legacyIndex >= 0 && segments[legacyIndex + 1]) {
      return decodeURIComponent(segments[legacyIndex + 1]);
    }
    const workspaceIndex = segments.indexOf("workspace");
    if (workspaceIndex >= 0 && segments[workspaceIndex + 1]) {
      return decodeURIComponent(segments[workspaceIndex + 1]);
    }
    return null;
  } catch {
    const match = normalized.match(/\/(?:w|workspace)\/([^/?#]+)/);
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
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = `${prefix ? `/${prefix}` : ""}/workspace/${encodeURIComponent(
        decodeURIComponent(segments[mountIndex + 1]),
      )}`;
      return url.toString().replace(/\/+$/, "");
    }

    const id = (workspaceId ?? "").trim();
    if (!id) return url.toString().replace(/\/+$/, "");

    const basePath = url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/workspace/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    const id = (workspaceId ?? "").trim();
    if (!id) return normalized;
    return `${normalized.replace(/\/+$/, "")}/workspace/${encodeURIComponent(id)}`;
  }
}

const OPENWORK_INVITE_PARAM_URL = "ow_url";
const OPENWORK_INVITE_PARAM_TOKEN = "ow_token";
const OPENWORK_INVITE_PARAM_STARTUP = "ow_startup";
const OPENWORK_INVITE_PARAM_AUTO_CONNECT = "ow_auto_connect";

export type OpenworkOpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: Record<string, unknown>;
  channels: Record<string, unknown>;
  config: Record<string, unknown>;
  activity?: {
    inboundToday?: number;
    outboundToday?: number;
    lastMessageAt?: number | null;
    [key: string]: unknown;
  };
  agent?: {
    loaded?: boolean;
    selected?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type OpenworkOpenCodeRouterIdentityItem = {
  id: string;
  channel?: string;
  enabled?: boolean;
  peerId?: string;
  [key: string]: unknown;
};

export type OpenworkOpenCodeRouterSendResult = {
  ok: boolean;
  sent: number;
  attempted: number;
  failures?: Array<{ identityId: string; peerId: string; error: string }>;
  reason?: string;
  [key: string]: unknown;
};

export type OpenworkConnectInvite = {
  url: string;
  token?: string;
  startup?: "server";
  autoConnect?: boolean;
};

export function readOpenworkConnectInviteFromSearch(input: string | URLSearchParams) {
  const search =
    typeof input === "string"
      ? new URLSearchParams(input.startsWith("?") ? input.slice(1) : input)
      : input;

  const rawUrl = search.get(OPENWORK_INVITE_PARAM_URL)?.trim() ?? "";
  const url = normalizeOpenworkServerUrl(rawUrl);
  if (!url) return null;

  const token = search.get(OPENWORK_INVITE_PARAM_TOKEN)?.trim() ?? "";
  const startupRaw = search.get(OPENWORK_INVITE_PARAM_STARTUP)?.trim() ?? "";
  const startup = startupRaw === "server" ? "server" : undefined;
  const autoConnect = search.get(OPENWORK_INVITE_PARAM_AUTO_CONNECT)?.trim() === "1";

  return {
    url,
    token: token || undefined,
    startup,
    autoConnect: autoConnect || undefined,
  } satisfies OpenworkConnectInvite;
}

export function stripOpenworkConnectInviteFromUrl(input: string) {
  try {
    const url = new URL(input);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_URL);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_TOKEN);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_STARTUP);
    url.searchParams.delete(OPENWORK_INVITE_PARAM_AUTO_CONNECT);
    return url.toString();
  } catch {
    return input;
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
    const hostToken = window.localStorage.getItem(STORAGE_HOST_AUTH_KEY) ?? undefined;
    const remoteAccessRaw = window.localStorage.getItem(STORAGE_REMOTE_ACCESS) ?? "";
    return {
      urlOverride: urlOverride ?? undefined,
      portOverride: Number.isNaN(portOverride) ? undefined : portOverride,
      token: token?.trim() || undefined,
      hostToken: hostToken?.trim() || undefined,
      remoteAccessEnabled: remoteAccessRaw === "1",
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
    const hostToken = next.hostToken?.trim() || undefined;
    const remoteAccessEnabled = next.remoteAccessEnabled === true;

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

    if (hostToken) {
      window.localStorage.setItem(STORAGE_HOST_AUTH_KEY, hostToken);
    } else {
      window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    }

    if (remoteAccessEnabled) {
      window.localStorage.setItem(STORAGE_REMOTE_ACCESS, "1");
    } else {
      window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
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
  const envHostToken = typeof import.meta.env?.VITE_OPENWORK_HOST_TOKEN === "string"
    ? import.meta.env.VITE_OPENWORK_HOST_TOKEN.trim()
    : "";

  if (!envUrl && !envPort && !envToken && !envHostToken) return;

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

    if (!current.hostToken && envHostToken) {
      next.hostToken = envHostToken;
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
    window.localStorage.removeItem(STORAGE_HOST_AUTH_KEY);
    window.localStorage.removeItem(STORAGE_REMOTE_ACCESS);
  } catch {
    // ignore
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

// Use Tauri's fetch when running in the desktop app to avoid CORS issues.
// Stream URLs (SSE) bypass the plugin because its `fetch_read_body` IPC call
// blocks until the body closes — that freezes the webview for infinite bodies.
const OPENWORK_STREAM_URL_RE = /\/events(\b|\?)|\/event-stream\b|\/stream\b/;

function isStreamUrl(url: string): boolean {
  return OPENWORK_STREAM_URL_RE.test(url);
}

const resolveFetch = (url?: string) => {
  if (!isDesktopRuntime()) return globalThis.fetch;
  if (url && isStreamUrl(url)) {
    return typeof window !== "undefined" ? window.fetch.bind(window) : globalThis.fetch;
  }
  return desktopFetch;
};

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
  const fetchImpl = resolveFetch(url);
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

async function requestMultipartRaw(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; hostToken?: string; body?: FormData; timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; text: string }>{
  const url = `${baseUrl}${path}`;
  const fetchImpl = resolveFetch(url);
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
  const fetchImpl = resolveFetch(url);
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
    sessionRead: 12_000,
    status: 6_000,
    config: 10_000,
    workspaceExport: 30_000,
    workspaceImport: 30_000,
    binary: 60_000,
  };

  return {
    baseUrl,
    token,
    health: () =>
      requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health", { token, hostToken, timeoutMs: timeouts.health }),
    runtimeVersions: () =>
      requestJson<OpenworkRuntimeSnapshot>(baseUrl, "/runtime/versions", { token, hostToken, timeoutMs: timeouts.status }),
    status: () => requestJson<OpenworkServerDiagnostics>(baseUrl, "/status", { token, hostToken, timeoutMs: timeouts.status }),
    capabilities: () => requestJson<OpenworkServerCapabilities>(baseUrl, "/capabilities", { token, hostToken, timeoutMs: timeouts.capabilities }),
    googleWorkspaceStatus: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/status", { token, hostToken, timeoutMs: timeouts.status }),
    googleWorkspaceConnectStart: (options?: { gmailRead?: boolean; features?: string[] }) => requestJson<GoogleWorkspaceConnectStart>(baseUrl, "/experimental/google-workspace/connect/start", { token, hostToken, method: "POST", body: { gmailRead: options?.gmailRead === true, features: options?.features ?? [] }, timeoutMs: timeouts.status }),
    googleWorkspaceConnectStatus: (flowId: string) => requestJson<GoogleWorkspaceConnectStatus>(baseUrl, `/experimental/google-workspace/connect/status/${encodeURIComponent(flowId)}`, { token, hostToken, timeoutMs: timeouts.status }),
    googleWorkspaceDisconnect: (accountId?: string | null) => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/disconnect", { token, hostToken, method: "POST", body: accountId ? { accountId } : {}, timeoutMs: timeouts.status }),
    googleWorkspaceSetActiveAccount: (accountId: string) => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/active-account", { token, hostToken, method: "POST", body: { accountId }, timeoutMs: timeouts.status }),
    googleWorkspaceTestConnection: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/test", { token, hostToken, method: "POST", timeoutMs: 60_000 }),
    googleWorkspaceRunScopeSmokeTest: () => requestJson<GoogleWorkspaceAuthStatus>(baseUrl, "/experimental/google-workspace/smoke-test", { token, hostToken, method: "POST", timeoutMs: 120_000 }),
    callExtensionAction: (payload: OpenworkExtensionActionCall) =>
      requestJson<OpenworkExtensionActionResult>(baseUrl, "/experimental/extensions/call", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.binary,
      }),
    listWorkspaces: () => requestJson<OpenworkWorkspaceList>(baseUrl, "/workspaces", { token, hostToken, timeoutMs: timeouts.listWorkspaces }),
    createLocalWorkspace: (payload: { folderPath: string; name: string; preset: string }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/local", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    createRemoteWorkspace: (payload: {
      baseUrl: string;
      openworkHostUrl?: string | null;
      openworkToken?: string | null;
      openworkWorkspaceId?: string | null;
      openworkWorkspaceName?: string | null;
      displayName?: string | null;
      directory?: string | null;
      remoteType?: "openwork" | "opencode";
      sandboxBackend?: string | null;
      sandboxRunId?: string | null;
      sandboxContainerName?: string | null;
    }) =>
      requestJson<WorkspaceList>(baseUrl, "/workspaces/remote", {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.activateWorkspace,
      }),
    updateWorkspaceDisplayName: (workspaceId: string, displayName: string | null) =>
      requestJson<WorkspaceList>(baseUrl, `/workspaces/${encodeURIComponent(workspaceId)}/display-name`, {
        token,
        hostToken,
        method: "PATCH",
        body: { displayName },
        timeoutMs: timeouts.activateWorkspace,
      }),
    activateWorkspace: (workspaceId: string, options?: { persist?: boolean }) => {
      const query = options?.persist ? "?persist=true" : "";
      return requestJson<{ activeId: string; workspace: OpenworkWorkspaceInfo; persisted: boolean }>(
        baseUrl,
        `/workspaces/${encodeURIComponent(workspaceId)}/activate${query}`,
        { token, hostToken, method: "POST", timeoutMs: timeouts.activateWorkspace },
      );
    },
    deleteWorkspace: (workspaceId: string) =>
      requestJson<{ ok: boolean; deleted: boolean; persisted: boolean; activeId: string | null; items: OpenworkWorkspaceInfo[]; workspaces?: WorkspaceInfo[] }>(
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
    listSessions: (
      workspaceId: string,
      options?: { roots?: boolean; start?: number; search?: string; limit?: number },
    ) => {
      const query = new URLSearchParams();
      if (typeof options?.roots === "boolean") query.set("roots", String(options.roots));
      if (typeof options?.start === "number") query.set("start", String(options.start));
      if (options?.search?.trim()) query.set("search", options.search.trim());
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ items: Session[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    getSessionGroups: (workspaceId: string) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number | null }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      ),
    putSessionGroups: (workspaceId: string, state: OpenworkSessionGroupState) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "PUT", body: { state }, timeoutMs: timeouts.config },
      ),
    createSessionGroup: (workspaceId: string, input: { id?: string; label: string }) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups`,
        { token, hostToken, method: "POST", body: input, timeoutMs: timeouts.config },
      ),
    reorderSessionGroups: (workspaceId: string, groupIds: string[]) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/reorder`,
        { token, hostToken, method: "PATCH", body: { groupIds }, timeoutMs: timeouts.config },
      ),
    assignSessionGroup: (workspaceId: string, sessionId: string, groupId: string | null) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/assignments/${encodeURIComponent(sessionId)}`,
        { token, hostToken, method: "PATCH", body: { groupId }, timeoutMs: timeouts.config },
      ),
    renameSessionGroup: (workspaceId: string, groupId: string, label: string) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`,
        { token, hostToken, method: "PATCH", body: { label }, timeoutMs: timeouts.config },
      ),
    removeSessionGroup: (workspaceId: string, groupId: string) =>
      requestJson<{ state: OpenworkSessionGroupState; updatedAt: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/${encodeURIComponent(groupId)}`,
        { token, hostToken, method: "DELETE", timeoutMs: timeouts.config },
      ),
    listSessionGroupEvents: (workspaceId: string, options?: { since?: number }) => {
      const query = typeof options?.since === "number" ? `?since=${options.since}` : "";
      return requestJson<{ items: OpenworkSessionGroupEvent[]; cursor?: number }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/session-groups/events${query}`,
        { token, hostToken },
      );
    },
    getSession: (workspaceId: string, sessionId: string) =>
      requestJson<{ item: Session }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      ),
    getSessionMessages: (workspaceId: string, sessionId: string, options?: { limit?: number }) => {
      const query = new URLSearchParams();
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ items: OpenworkSessionMessage[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    getSessionSnapshot: (workspaceId: string, sessionId: string, options?: { limit?: number }) => {
      const query = new URLSearchParams();
      if (typeof options?.limit === "number") query.set("limit", String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<{ item: OpenworkSessionSnapshot }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/snapshot${suffix}`,
        { token, hostToken, timeoutMs: timeouts.sessionRead },
      );
    },
    exportWorkspace: (
      workspaceId: string,
      options?: { sensitiveMode?: OpenworkWorkspaceExportSensitiveMode },
    ) => {
      const query = new URLSearchParams();
      if (options?.sensitiveMode) {
        query.set("sensitive", options.sensitiveMode);
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      return requestJson<OpenworkWorkspaceExport>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/export${suffix}`, {
        token,
        hostToken,
        timeoutMs: timeouts.workspaceExport,
      });
    },
    importWorkspace: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<{ ok: boolean; preview?: OpenworkWorkspaceImportPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/import`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.workspaceImport,
      }),
    previewWorkspaceImport: (workspaceId: string, payload: Record<string, unknown>) =>
      requestJson<OpenworkWorkspaceImportPreview>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/import/preview`,
        {
          token,
          hostToken,
          method: "POST",
          body: payload,
          timeoutMs: timeouts.workspaceImport,
        },
      ),
    materializeBlueprintSessions: (workspaceId: string) =>
      requestJson<OpenworkBlueprintSessionsMaterializeResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/blueprint/sessions/materialize`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.workspaceImport,
        },
      ),
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; openwork: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    listAuthorizedFolders: (workspaceId: string) =>
      requestJson<OpenworkAuthorizedFoldersResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    setAuthorizedFolders: (workspaceId: string, folders: string[]) =>
      requestJson<OpenworkAuthorizedFoldersUpdateResponse>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/authorized-folders`,
        {
          token,
          hostToken,
          method: "PUT",
          body: { folders },
          timeoutMs: timeouts.config,
        },
      ),
    migrateRuntimeConfig: (workspaceId: string) =>
      requestJson<OpenworkRuntimeConfigMigrationResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config/migrate`,
        {
          token,
          hostToken,
          method: "POST",
          timeoutMs: timeouts.config,
        },
      ),
    getRuntimeConfigStatus: (workspaceId: string) =>
      requestJson<OpenworkRuntimeConfigStatus>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/runtime-config`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; openwork?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        hostToken,
        method: "PATCH",
        body: payload,
      }),
    getDesktopCloudSync: (workspaceId: string) =>
      requestJson<OpenworkDesktopCloudSyncState>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/desktop-cloud-sync`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    syncDesktopCloud: (workspaceId: string, snapshot: DenResourceSnapshot) =>
      requestJson<OpenworkDesktopCloudSyncResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/desktop-cloud-sync`, {
        token,
        hostToken,
        method: "POST",
        body: { snapshot },
        timeoutMs: timeouts.config,
      }),
    listCloudPlugins: (workspaceId: string) =>
      requestJson<OpenworkCloudPluginsResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        timeoutMs: timeouts.config,
      }),
    installCloudPlugin: (workspaceId: string, payload: { marketplaceId: string | null; marketplace?: DenOrgMarketplace | null; resolved: DenOrgPluginResolved }) =>
      requestJson<OpenworkCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    removeCloudPlugin: (workspaceId: string, pluginId: string) =>
      requestJson<OpenworkCloudPluginInstallResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/cloud-plugins/${encodeURIComponent(pluginId)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),
    previewClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<{ preview: OpenworkClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: { ...payload, dryRun: true },
        timeoutMs: timeouts.config,
      }),
    installClaudePlugin: (workspaceId: string, payload: { url: string; ref?: string }) =>
      requestJson<OpenworkCloudPluginInstallResult & { preview: OpenworkClaudePluginPreview }>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/claude-plugins`, {
        token,
        hostToken,
        method: "POST",
        body: payload,
        timeoutMs: timeouts.config,
      }),
    readOpencodeConfigFile: (workspaceId: string, scope: "project" | "global" = "project") => {
      const query = `?scope=${scope}`;
      return requestJson<OpencodeConfigFile>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config${query}`, {
        token,
        hostToken,
      });
    },
    writeOpencodeConfigFile: (workspaceId: string, scope: "project" | "global", content: string) =>
      requestJson<ExecResult>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/opencode-config`, {
        token,
        hostToken,
        method: "POST",
        body: { scope, content },
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
    listHubSkills: (options?: { repo?: OpenworkHubRepo }) => {
      const params = new URLSearchParams();
      const owner = options?.repo?.owner?.trim();
      const repo = options?.repo?.repo?.trim();
      const ref = options?.repo?.ref?.trim();
      if (owner) params.set("owner", owner);
      if (repo) params.set("repo", repo);
      if (ref) params.set("ref", ref);
      const query = params.size ? `?${params.toString()}` : "";
      return requestJson<{ items: OpenworkHubSkillItem[] }>(baseUrl, `/hub/skills${query}`, {
        token,
        hostToken,
      });
    },
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
    deleteSkill: (workspaceId: string, name: string) =>
      requestJson<{ path: string }>(
        baseUrl,
        `/workspace/${workspaceId}/skills/${encodeURIComponent(name)}`,
        {
          token,
          hostToken,
          method: "DELETE",
        },
      ),
    listMcp: (workspaceId: string) =>
      requestJson<{ items: OpenworkMcpItem[]; engineSync?: OpenworkMcpEngineSync | null }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp`,
        { token, hostToken },
      ),
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
    setMcpEnabled: (workspaceId: string, name: string, enabled: boolean) =>
      requestJson<{ items: OpenworkMcpItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}/enabled`,
        {
          token,
          hostToken,
          method: "POST",
          body: { enabled },
        },
      ),

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
        throw new OpenworkServerError(
          result.status,
          "request_failed",
          message || "Shared folder upload failed",
        );
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

    statWorkspaceFile: (workspaceId: string, path: string) =>
      requestJson<OpenworkWorkspaceFileStat>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/stat?path=${encodeURIComponent(path)}`,
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

    deleteWorkspaceFiles: async (
      workspaceId: string,
      files: Array<{ path: string; recursive?: boolean }>,
    ): Promise<OpenworkWorkspaceFileDeleteResult[]> => {
      if (files.length === 0) return [];
      const created = await requestJson<{ session: { id: string } }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/sessions`,
        { token, hostToken, method: "POST", body: { write: true } },
      );
      const sessionId = created.session.id;
      try {
        const result = await requestJson<{ items: Array<{ ok?: boolean; path?: string; code?: string }> }>(
          baseUrl,
          `/files/sessions/${encodeURIComponent(sessionId)}/ops`,
          {
            token,
            hostToken,
            method: "POST",
            body: {
              operations: files.map((file) => ({
                type: "delete",
                path: file.path,
                recursive: file.recursive === true,
              })),
            },
          },
        );
        return result.items.map((item, index) => ({
          ok: item.ok === true,
          path: typeof item.path === "string" ? item.path : files[index]?.path ?? "",
          ...(typeof item.code === "string" ? { code: item.code } : {}),
        }));
      } finally {
        await requestJson<{ ok: boolean }>(baseUrl, `/files/sessions/${encodeURIComponent(sessionId)}`, {
          token,
          hostToken,
          method: "DELETE",
        }).catch(() => undefined);
      }
    },

    writeWorkspaceBinaryFile: (
      workspaceId: string,
      payload: { path: string; data: ArrayBuffer; baseUpdatedAt?: number | null; force?: boolean },
    ) =>
      requestJson<OpenworkWorkspaceFileWriteResult>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw`,
        {
          token,
          hostToken,
          method: "POST",
          body: {
            path: payload.path,
            dataBase64: arrayBufferToBase64(payload.data),
            baseUpdatedAt: payload.baseUpdatedAt,
            force: payload.force,
          },
        },
      ),

    downloadWorkspaceFile: (workspaceId: string, path: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/files/raw?path=${encodeURIComponent(path)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    listArtifacts: (workspaceId: string) =>
      requestJson<OpenworkArtifactList>(baseUrl, `/workspace/${encodeURIComponent(workspaceId)}/artifacts`, {
        token,
        hostToken,
      }),

    resolveArtifacts: (
      workspaceId: string,
      targets: Array<{
        kind: "file" | "url";
        value: string;
        name?: string;
        preview?: string;
        confidence?: number;
        reason?: string;
      }>,
    ) =>
      requestJson<{ items: OpenworkResolvedArtifactTarget[] }>(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/resolve`,
        { token, hostToken, method: "POST", body: { targets } },
      ),

    downloadArtifact: (workspaceId: string, artifactId: string) =>
      requestBinary(
        baseUrl,
        `/workspace/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { token, hostToken, timeoutMs: timeouts.binary },
      ),

    // User-level env vars (host-auth only — desktop shell is the sole caller).
    // See apps/server/src/env-file.ts and apps/app/pr/environment-variables.md.
    listUserEnvKeys: () =>
      requestJson<{ keys: string[] }>(
        baseUrl,
        "/env/keys",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnvStatus: (runtimeKey?: string | null) => {
      const params = new URLSearchParams();
      if (runtimeKey?.trim()) params.set("runtimeKey", runtimeKey.trim());
      const query = params.size ? `?${params.toString()}` : "";
      return requestJson<{ runtimeKey: string; pendingChanges: boolean }>(
        baseUrl,
        `/env/status${query}`,
        { token, hostToken, timeoutMs: timeouts.config },
      );
    },

    setUserEnvPendingChanges: (pendingChanges: boolean, runtimeKey?: string | null) =>
      requestJson<{ runtimeKey: string; pendingChanges: boolean }>(baseUrl, "/env/status", {
        token,
        hostToken,
        method: "PUT",
        body: { pendingChanges, runtimeKey: runtimeKey?.trim() || undefined },
        timeoutMs: timeouts.config,
      }),

    listUserEnv: () =>
      requestJson<{ items: OpenworkUserEnvItem[] }>(
        baseUrl,
        "/env?includeValues=false",
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    getUserEnv: (key: string) =>
      requestJson<{ item: OpenworkUserEnvItem & { value: string } }>(
        baseUrl,
        `/env/${encodeURIComponent(key)}`,
        { token, hostToken, timeoutMs: timeouts.config },
      ),

    upsertUserEnv: (entries: Array<{ key: string; value: string }>) =>
      requestJson<{ ok: true; count: number }>(baseUrl, "/env", {
        token,
        hostToken,
        method: "PUT",
        body: { entries },
        timeoutMs: timeouts.config,
      }),

    deleteUserEnv: (key: string) =>
      requestJson<{ ok: true }>(baseUrl, `/env/${encodeURIComponent(key)}`, {
        token,
        hostToken,
        method: "DELETE",
        timeoutMs: timeouts.config,
      }),

    createVoiceRealtimeSession: (payload?: { model?: string; sessionContext?: string }) =>
      requestJson<{
        ok: true;
        clientSecret: string;
        expiresAt: number | null;
        model: string;
        transcriptionModel: string;
        tools: string[];
      }>(baseUrl, "/voice/realtime/session", {
        token,
        hostToken,
        method: "POST",
        body: payload ?? {},
        timeoutMs: timeouts.config,
      }),
  };
}

export type OpenworkServerClient = ReturnType<typeof createOpenworkServerClient>;
