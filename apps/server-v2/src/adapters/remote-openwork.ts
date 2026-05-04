import { HTTPException } from "hono/http-exception";
import type { ServerRecord, WorkspaceRecord } from "../database/types.js";
import { RouteError } from "../http.js";

function encodeBasicAuth(username: string, password: string) {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function pickString(record: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export function buildRemoteOpenworkHeaders(server: ServerRecord) {
  const auth = server.auth && typeof server.auth === "object" ? server.auth as Record<string, unknown> : null;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const bearer = pickString(auth, ["openworkClientToken", "openworkToken", "authToken", "token", "bearerToken"]);
  const hostToken = pickString(auth, ["openworkHostToken", "hostToken"]);
  const username = pickString(auth, ["username", "user"]);
  const password = pickString(auth, ["password", "pass"]);

  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  } else if (username && password) {
    headers.Authorization = `Basic ${encodeBasicAuth(username, password)}`;
  }

  if (hostToken) {
    headers["X-OpenWork-Host-Token"] = hostToken;
  }

  return headers;
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (payload && typeof payload === "object" && "ok" in (payload as Record<string, unknown>)) {
    const record = payload as Record<string, unknown>;
    if (record.ok === true && "data" in record) {
      return record.data as T;
    }
    if (record.ok === false) {
      const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
      const code = typeof error.code === "string" ? error.code : "bad_gateway";
      const message = typeof error.message === "string" ? error.message : "Remote OpenWork request failed.";
      throw new RouteError(502, code as any, message);
    }
  }
  return payload as T;
}

export function resolveRemoteWorkspaceTarget(server: ServerRecord, workspace: WorkspaceRecord) {
  const serverBaseUrl = server.baseUrl?.trim();
  if (!serverBaseUrl) {
    throw new RouteError(502, "bad_gateway", `Remote server ${server.id} is missing a base URL.`);
  }
  const remoteWorkspaceId = workspace.remoteWorkspaceId?.trim();
  if (!remoteWorkspaceId) {
    throw new RouteError(502, "bad_gateway", `Remote workspace ${workspace.id} is missing a remote workspace identifier.`);
  }
  return {
    remoteWorkspaceId,
    serverBaseUrl: normalizeBaseUrl(serverBaseUrl),
  };
}

export async function requestRemoteOpenwork<T>(input: {
  body?: unknown;
  method?: string;
  path: string;
  server: ServerRecord;
  timeoutMs?: number;
}): Promise<T> {
  const baseUrl = input.server.baseUrl?.trim();
  if (!baseUrl) {
    throw new RouteError(502, "bad_gateway", `Remote server ${input.server.id} is missing a base URL.`);
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${input.path}`, {
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    headers: {
      ...buildRemoteOpenworkHeaders(input.server),
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  });

  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : null;

  if (response.status === 404) {
    throw new HTTPException(404, { message: typeof (payload as any)?.message === "string" ? (payload as any).message : "Remote resource not found." });
  }
  if (response.status === 401) {
    throw new RouteError(502, "bad_gateway", "Remote OpenWork server rejected the stored credentials.");
  }
  if (response.status === 403) {
    throw new RouteError(502, "bad_gateway", "Remote OpenWork server rejected the stored permissions.");
  }
  if (!response.ok) {
    const message = typeof (payload as any)?.error?.message === "string"
      ? (payload as any).error.message
      : typeof (payload as any)?.message === "string"
        ? (payload as any).message
        : `Remote OpenWork request failed with status ${response.status}.`;
    throw new RouteError(502, "bad_gateway", message);
  }

  return unwrapEnvelope<T>(payload);
}

export async function requestRemoteOpenworkRaw(input: {
  body?: BodyInit | null;
  contentType?: string | null;
  method?: string;
  path: string;
  server: ServerRecord;
  timeoutMs?: number;
}) {
  const baseUrl = input.server.baseUrl?.trim();
  if (!baseUrl) {
    throw new RouteError(502, "bad_gateway", `Remote server ${input.server.id} is missing a base URL.`);
  }

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${input.path}`, {
    body: input.body ?? undefined,
    headers: {
      ...buildRemoteOpenworkHeaders(input.server),
      ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    },
    method: input.method ?? (input.body ? "POST" : "GET"),
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });

  if (response.status === 404) {
    throw new HTTPException(404, { message: "Remote resource not found." });
  }
  if (response.status === 401 || response.status === 403) {
    throw new RouteError(502, "bad_gateway", "Remote OpenWork server rejected the stored credentials.");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new RouteError(502, "bad_gateway", text.trim() || `Remote OpenWork request failed with status ${response.status}.`);
  }

  return response;
}
