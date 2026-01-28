export type OpenworkServerCapabilities = {
  skills: { read: boolean; write: boolean; source: "openwork" | "opencode" };
  plugins: { read: boolean; write: boolean };
  mcp: { read: boolean; write: boolean };
  commands: { read: boolean; write: boolean };
  config: { read: boolean; write: boolean };
};

export type OpenworkServerStatus = "connected" | "disconnected" | "limited";

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
  };
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
};

export type OpenworkRemoteSkillSource = {
  id: string;
  input: string;
  repo: string;
  ref: string | null;
  pathPrefix: string | null;
  resolvedRef?: string | null;
  status: "success" | "error";
  errorMessage?: string | null;
};

export type OpenworkRemoteSkillItem = {
  id: string;
  sourceId: string;
  sourceInput: string;
  name: string;
  description?: string | null;
  repo: string;
  ref: string | null;
  path: string;
  skillFilePath: string;
  contentUrl: string;
};

export type OpenworkRemoteSkillsResponse = {
  sources: OpenworkRemoteSkillSource[];
  items: OpenworkRemoteSkillItem[];
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

function buildHeaders(token?: string, extra?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (extra) {
    Object.assign(headers, extra);
  }
  return headers;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: buildHeaders(options.token),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const code = typeof json?.code === "string" ? json.code : "request_failed";
    const message = typeof json?.message === "string" ? json.message : response.statusText;
    throw new OpenworkServerError(response.status, code, message, json?.details);
  }

  return json as T;
}

export function createOpenworkServerClient(options: { baseUrl: string; token?: string }) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const token = options.token;

  return {
    baseUrl,
    token,
    health: () => requestJson<{ ok: boolean; version: string; uptimeMs: number }>(baseUrl, "/health"),
    capabilities: () => requestJson<OpenworkServerCapabilities>(baseUrl, "/capabilities", { token }),
    listWorkspaces: () => requestJson<{ items: OpenworkWorkspaceInfo[] }>(baseUrl, "/workspaces", { token }),
    getConfig: (workspaceId: string) =>
      requestJson<{ opencode: Record<string, unknown>; openwork: Record<string, unknown>; updatedAt?: number | null }>(
        baseUrl,
        `/workspace/${workspaceId}/config`,
        { token },
      ),
    patchConfig: (workspaceId: string, payload: { opencode?: Record<string, unknown>; openwork?: Record<string, unknown> }) =>
      requestJson<{ updatedAt?: number | null }>(baseUrl, `/workspace/${workspaceId}/config`, {
        token,
        method: "PATCH",
        body: payload,
      }),
    listPlugins: (workspaceId: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(baseUrl, `/workspace/${workspaceId}/plugins`, {
        token,
      }),
    addPlugin: (workspaceId: string, spec: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins`,
        { token, method: "POST", body: { spec } },
      ),
    removePlugin: (workspaceId: string, name: string) =>
      requestJson<{ items: OpenworkPluginItem[]; loadOrder: string[] }>(
        baseUrl,
        `/workspace/${workspaceId}/plugins/${encodeURIComponent(name)}`,
        { token, method: "DELETE" },
      ),
    listSkills: (workspaceId: string) =>
      requestJson<{ items: OpenworkSkillItem[] }>(baseUrl, `/workspace/${workspaceId}/skills`, { token }),
    listRemoteSkills: (workspaceId: string, sources: string[]) =>
      requestJson<OpenworkRemoteSkillsResponse>(baseUrl, `/workspace/${workspaceId}/skills/remote`, {
        token,
        method: "POST",
        body: { sources },
      }),
    upsertSkill: (workspaceId: string, payload: { name: string; content: string; description?: string }) =>
      requestJson<OpenworkSkillItem>(baseUrl, `/workspace/${workspaceId}/skills`, {
        token,
        method: "POST",
        body: payload,
      }),
    installRemoteSkill: (workspaceId: string, payload: { source: string; path: string; name: string }) =>
      requestJson<OpenworkSkillItem>(baseUrl, `/workspace/${workspaceId}/skills/remote/install`, {
        token,
        method: "POST",
        body: payload,
      }),
    listMcp: (workspaceId: string) =>
      requestJson<{ items: OpenworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, { token }),
    addMcp: (workspaceId: string, payload: { name: string; config: Record<string, unknown> }) =>
      requestJson<{ items: OpenworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp`, {
        token,
        method: "POST",
        body: payload,
      }),
    removeMcp: (workspaceId: string, name: string) =>
      requestJson<{ items: OpenworkMcpItem[] }>(baseUrl, `/workspace/${workspaceId}/mcp/${encodeURIComponent(name)}`, {
        token,
        method: "DELETE",
      }),
    listCommands: (workspaceId: string, scope: "workspace" | "global" = "workspace") =>
      requestJson<{ items: OpenworkCommandItem[] }>(
        baseUrl,
        `/workspace/${workspaceId}/commands?scope=${scope}`,
        { token },
      ),
    upsertCommand: (
      workspaceId: string,
      payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
    ) =>
      requestJson<{ items: OpenworkCommandItem[] }>(baseUrl, `/workspace/${workspaceId}/commands`, {
        token,
        method: "POST",
        body: payload,
      }),
    deleteCommand: (workspaceId: string, name: string) =>
      requestJson<{ ok: boolean }>(baseUrl, `/workspace/${workspaceId}/commands/${encodeURIComponent(name)}`, {
        token,
        method: "DELETE",
      }),
  };
}

export type OpenworkServerClient = ReturnType<typeof createOpenworkServerClient>;
