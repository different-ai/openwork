import type { Surface } from "@openwork/cdp";

import { evalIn } from "./desktop.ts";

export type EngineSessionProbeEngine = "v1" | "v2";

export interface EngineSessionProbeSession {
  id: string;
  title: string;
}

export interface EngineSessionProbePart {
  type: string;
  text: string;
  tool: string;
  callId: string;
  status: string;
  input: Record<string, unknown>;
  output: string;
}

export interface EngineSessionProbeMessage {
  parts: EngineSessionProbePart[];
}

export interface EngineSessionProbeSnapshot {
  session: EngineSessionProbeSession | null;
  messages: EngineSessionProbeMessage[];
}

export interface EngineSessionProbeResult<T> {
  ok: boolean;
  status: number;
  data: T;
  body: unknown;
}

interface ProbeRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
}

interface ProbeTransportResult {
  status: number;
  body: unknown;
}

interface SharedProbeOptions {
  engine: EngineSessionProbeEngine;
  workspaceId: string;
}

interface SurfaceProbeOptions extends SharedProbeOptions {
  surface: Surface;
}

interface ServerProbeOptions extends SharedProbeOptions {
  serverUrl: string;
  token: string;
}

export type EngineSessionProbeOptions = SurfaceProbeOptions | ServerProbeOptions;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function responseData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

function responseItems(value: unknown): unknown[] {
  const data = responseData(value);
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data.items)) return data.items;
  return [];
}

function parseSession(value: unknown): EngineSessionProbeSession | null {
  const data = responseData(value);
  if (!isRecord(data)) return null;
  const source = readRecord(data, "info") ?? data;
  const id = readString(source, "id") ?? readString(source, "sessionID");
  if (!id) return null;
  return {
    id,
    title: readString(source, "title") ?? "Untitled session",
  };
}

function partValues(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.parts)) return value.parts;
  if (Array.isArray(value.content)) return value.content;
  const text = readString(value, "text");
  return text === undefined ? [] : [{ type: "text", text }];
}

function parsePart(value: unknown, engine: EngineSessionProbeEngine): EngineSessionProbePart | null {
  if (!isRecord(value)) return null;
  const state = readRecord(value, "state") ?? {};
  const metadata = readRecord(state, "metadata");
  return {
    type: readString(value, "type") ?? "",
    text: readString(value, "text") ?? "",
    tool: engine === "v2" ? readString(value, "name") ?? readString(value, "tool") ?? "" : readString(value, "tool") ?? "",
    callId: engine === "v2"
      ? readString(value, "id") ?? readString(value, "callID") ?? ""
      : readString(value, "callID") ?? readString(value, "callId") ?? readString(value, "toolCallId") ?? "",
    status: readString(state, "status") ?? "",
    input: readRecord(state, "input") ?? readRecord(value, "input") ?? {},
    output: readString(state, "output") ?? readString(metadata, "output") ?? readString(value, "output") ?? "",
  };
}

function parseMessage(value: unknown, engine: EngineSessionProbeEngine): EngineSessionProbeMessage | null {
  if (!isRecord(value)) return null;
  const source = responseData(value);
  if (!isRecord(source)) return null;
  return {
    parts: partValues(source).flatMap((part) => {
      const parsed = parsePart(part, engine);
      return parsed ? [parsed] : [];
    }),
  };
}

function parseTransportResult(value: unknown): ProbeTransportResult {
  if (!isRecord(value) || typeof value.status !== "number" || !("body" in value)) {
    throw new Error(`Invalid engine session probe response: ${JSON.stringify(value)}`);
  }
  return { status: value.status, body: value.body };
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestFromSurface(
  surface: Surface,
  path: string,
  options: ProbeRequestOptions,
): Promise<ProbeTransportResult> {
  const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (options.body !== undefined && requestBody === undefined) {
    throw new Error(`Could not serialize engine session probe body for ${path}`);
  }
  const value = await evalIn(surface, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { status: 0, body: { error: "local_server_unavailable" } };
    const baseUrl = String(info.baseUrl);
    let end = baseUrl.length;
    while (end > 0 && baseUrl[end - 1] === "/") end -= 1;
    const response = await fetch(baseUrl.slice(0, end) + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(options.method ?? "GET")},
      headers: {
        Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
        "Content-Type": "application/json",
      },
      ${requestBody === undefined ? "" : `body: ${JSON.stringify(requestBody)},`}
      signal: AbortSignal.timeout(${options.timeoutMs ?? 15_000}),
    });
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body };
  })()`, { awaitPromise: true, timeoutMs: (options.timeoutMs ?? 15_000) + 5_000 });
  return parseTransportResult(value);
}

async function requestFromServer(
  serverUrl: string,
  token: string,
  path: string,
  options: ProbeRequestOptions,
): Promise<ProbeTransportResult> {
  const requestBody = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (options.body !== undefined && requestBody === undefined) {
    throw new Error(`Could not serialize engine session probe body for ${path}`);
  }
  let end = serverUrl.length;
  while (end > 0 && serverUrl[end - 1] === "/") end -= 1;
  const response = await fetch(`${serverUrl.slice(0, end)}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(requestBody === undefined ? {} : { body: requestBody }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  return { status: response.status, body: parseBody(text) };
}

async function request(
  options: EngineSessionProbeOptions,
  path: string,
  init: ProbeRequestOptions = {},
): Promise<ProbeTransportResult> {
  if ("surface" in options) return requestFromSurface(options.surface, path, init);
  return requestFromServer(options.serverUrl, options.token, path, init);
}

function result<T>(response: ProbeTransportResult, data: T, valid = true): EngineSessionProbeResult<T> {
  return {
    ok: response.status >= 200 && response.status < 300 && valid,
    status: response.status,
    data,
    body: response.body,
  };
}

export function engineSessionProbe(options: EngineSessionProbeOptions) {
  const mount = `/workspace/${encodeURIComponent(options.workspaceId)}/${options.engine === "v2" ? "opencode2" : "opencode"}`;
  const sessionPath = options.engine === "v2" ? "/api/session" : "/session";

  const get = async (sessionId: string): Promise<EngineSessionProbeResult<EngineSessionProbeSession | null>> => {
    const response = await request(options, `${mount}${sessionPath}/${encodeURIComponent(sessionId)}`);
    const session = parseSession(response.body);
    return result(response, session, session !== null);
  };

  const messages = async (
    sessionId: string,
    limit = 50,
  ): Promise<EngineSessionProbeResult<EngineSessionProbeMessage[]>> => {
    const response = await request(
      options,
      `${mount}${sessionPath}/${encodeURIComponent(sessionId)}/message?limit=${encodeURIComponent(String(limit))}`,
    );
    const parsed = responseItems(response.body).flatMap((message) => {
      const item = parseMessage(message, options.engine);
      return item ? [item] : [];
    });
    return result(response, parsed);
  };

  const snapshot = async (sessionId: string): Promise<EngineSessionProbeResult<EngineSessionProbeSnapshot>> => {
    const encodedSessionId = encodeURIComponent(sessionId);
    const responses = await Promise.all([
      request(options, `${mount}${sessionPath}/${encodedSessionId}`),
      request(options, `${mount}${sessionPath}/${encodedSessionId}/message?limit=50`),
      ...(options.engine === "v1"
        ? [
            request(options, `${mount}${sessionPath}/${encodedSessionId}/todo`),
            request(options, `${mount}${sessionPath}/status`),
          ]
        : []),
    ]);
    const sessionResponse = responses[0];
    const messagesResponse = responses[1];
    if (!sessionResponse || !messagesResponse) throw new Error("Engine session snapshot responses were incomplete.");
    const session = parseSession(sessionResponse.body);
    const parsedMessages = responseItems(messagesResponse.body).flatMap((message) => {
      const item = parseMessage(message, options.engine);
      return item ? [item] : [];
    });
    const failed = responses.find((response) => response.status < 200 || response.status >= 300);
    const snapshotResponse = {
      status: failed?.status ?? sessionResponse.status,
      body: { session: sessionResponse.body, messages: messagesResponse.body },
    };
    return result(snapshotResponse, { session, messages: parsedMessages }, failed === undefined && session !== null);
  };

  const list = async (limit = 200): Promise<EngineSessionProbeResult<EngineSessionProbeSession[]>> => {
    const response = await request(options, `${mount}${sessionPath}?limit=${encodeURIComponent(String(limit))}`);
    const sessions = responseItems(response.body).flatMap((value) => {
      const session = parseSession(value);
      return session ? [session] : [];
    });
    return result(response, sessions);
  };

  const create = async (
    directory: string,
    title: string,
  ): Promise<EngineSessionProbeResult<EngineSessionProbeSession | null>> => {
    const createdResponse = await request(options, `${mount}${sessionPath}`, {
      method: "POST",
      body: options.engine === "v2" ? { location: { directory } } : { title },
      timeoutMs: 30_000,
    });
    const created = parseSession(createdResponse.body);
    if (options.engine === "v1" || created === null || createdResponse.status < 200 || createdResponse.status >= 300) {
      return result(createdResponse, created, created !== null);
    }
    const renamedResponse = await request(
      options,
      `${mount}${sessionPath}/${encodeURIComponent(created.id)}/rename`,
      { method: "POST", body: { title }, timeoutMs: 30_000 },
    );
    const renamed = parseSession(renamedResponse.body) ?? { id: created.id, title };
    return result(renamedResponse, renamed);
  };

  const approvePendingPermissions = async (sessionId: string): Promise<number[]> => {
    const encodedSessionId = encodeURIComponent(sessionId);
    const modern = await request(options, `${mount}/api/session/${encodedSessionId}/permission`);
    let candidates = responseItems(modern.body).flatMap((value) => {
      const id = readString(value, "id");
      return id ? [{ id, modern: true }] : [];
    });
    if (options.engine === "v1" && candidates.length === 0) {
      const legacy = await request(options, `${mount}/permission`);
      candidates = responseItems(legacy.body).flatMap((value) => {
        const id = readString(value, "id");
        return id && readString(value, "sessionID") === sessionId ? [{ id, modern: false }] : [];
      });
    }
    const statuses: number[] = [];
    for (const candidate of candidates) {
      const path = candidate.modern
        ? `/api/session/${encodedSessionId}/permission/${encodeURIComponent(candidate.id)}/reply`
        : `/permission/${encodeURIComponent(candidate.id)}/reply`;
      const response = await request(options, `${mount}${path}`, {
        method: "POST",
        body: { reply: "once" },
        timeoutMs: 10_000,
      });
      statuses.push(response.status);
    }
    return statuses;
  };

  return { get, messages, snapshot, list, create, approvePendingPermissions };
}
