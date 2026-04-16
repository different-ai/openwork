import { createOpencodeClient, type Message, type Part, type Session, type SessionStatus, type Todo } from "@opencode-ai/sdk/v2/client";
import { createOpenWorkServerWorkspaceEventStream } from "@openwork/server-sdk";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { OpenworkServerError } from "./openwork-server";
import { isTauriRuntime } from "../utils";

type FieldsResult<T> =
  | ({ data: T; error?: undefined } & { request: Request; response: Response })
  | ({ data?: undefined; error: unknown } & { request: Request; response: Response });

type PromptAsyncParameters = {
  sessionID: string;
  directory?: string;
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  tools?: { [key: string]: boolean };
  system?: string;
  variant?: string;
  parts?: unknown[];
  reasoning_effort?: string;
};

type CommandParameters = {
  sessionID: string;
  directory?: string;
  messageID?: string;
  agent?: string;
  model?: string;
  arguments?: string;
  command?: string;
  variant?: string;
  parts?: unknown[];
  reasoning_effort?: string;
};

type SessionListParameters = {
  directory?: string;
  roots?: boolean;
  start?: number;
  search?: string;
  limit?: number;
};

type SessionLookupParameters = {
  sessionID: string;
  directory?: string;
};

type SessionMessagesParameters = {
  sessionID: string;
  directory?: string;
  limit?: number;
};

export type OpencodeAuth = {
  hostToken?: string;
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "openwork";
  sessionRouting?: {
    baseUrl: string;
    hostToken?: string;
    required?: boolean;
    token: string;
    workspaceId: string;
  };
};

const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS = 90_000;

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function resolveRequestTimeoutMs(input: RequestInfo | URL, fallbackMs: number): number {
  const url = getRequestUrl(input);
  if (/\/provider\/oauth\//.test(url) || /\/mcp\/auth\/callback\b/.test(url)) {
    return Math.max(fallbackMs, OAUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  if (/\/mcp\/.*auth\b/.test(url)) {
    return Math.max(fallbackMs, MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  return fallbackMs;
}


function buildDirectoryHeader(directory?: string) {
  if (!directory?.trim()) return undefined;
  const trimmed = directory.trim();
  return /[^\x00-\x7F]/.test(trimmed) ? encodeURIComponent(trimmed) : trimmed;
}

async function postSessionRequest<T>(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  options?: { headers?: Record<string, string>; directory?: string; throwOnError?: boolean },
): Promise<FieldsResult<T>> {
  const headers = new Headers(options?.headers);
  headers.set("Content-Type", "application/json");
  const directoryHeader = buildDirectoryHeader(options?.directory);
  if (directoryHeader) {
    headers.set("x-opencode-directory", directoryHeader);
  }

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const request = new Request(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.ok) {
    const data = response.status === 204 ? ({} as T) : ((await response.json()) as T);
    return { data, request, response };
  }

  const text = await response.text();
  let error: unknown = text;
  try {
    error = text ? JSON.parse(text) : text;
  } catch {
    // ignore
  }
  if (options?.throwOnError) throw error;
  return { error, request, response };
}

async function getLegacySessionStatus(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  sessionId: string,
  options?: { headers?: Record<string, string>; directory?: string; throwOnError?: boolean },
): Promise<FieldsResult<SessionStatus>> {
  const headers = new Headers(options?.headers);
  const directoryHeader = buildDirectoryHeader(options?.directory);
  if (directoryHeader) {
    headers.set("x-opencode-directory", directoryHeader);
  }

  const url = `${baseUrl}/session/status`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
  });
  const request = new Request(url, { method: "GET", headers });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const error = new Error(`Failed to read session status: ${response.status} ${response.statusText}`);
    if (options?.throwOnError) throw error;
    return { error, request, response };
  }

  const record = json && typeof json === "object" ? json as Record<string, SessionStatus> : {};
  return { data: record[sessionId] ?? ({ type: "idle" } as SessionStatus), request, response };
}

async function requestOpenworkRoute<T>(
  fetchImpl: typeof globalThis.fetch,
  routing: NonNullable<OpencodeAuth["sessionRouting"]>,
  path: string,
  options?: {
    body?: unknown;
    method?: string;
    throwOnError?: boolean;
  },
): Promise<FieldsResult<T>> {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${routing.token}`);
  if (routing.hostToken) {
    headers.set("X-OpenWork-Host-Token", routing.hostToken);
  }
  if (options?.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const url = `${routing.baseUrl.replace(/\/+$/, "")}${path}`;
  const response = await fetchImpl(url, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const request = new Request(url, {
    method: options?.method ?? "GET",
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const errorRecord = json && typeof json === "object" ? json as Record<string, unknown> : null;
    const code = typeof errorRecord?.error === "object" && errorRecord.error && typeof (errorRecord.error as any).code === "string"
      ? String((errorRecord.error as any).code)
      : typeof errorRecord?.code === "string"
        ? errorRecord.code
        : "request_failed";
    const message = typeof errorRecord?.error === "object" && errorRecord.error && typeof (errorRecord.error as any).message === "string"
      ? String((errorRecord.error as any).message)
      : typeof errorRecord?.message === "string"
        ? errorRecord.message
        : response.statusText;
    const details = typeof errorRecord?.error === "object" && errorRecord.error
      ? (errorRecord.error as any).details
      : errorRecord?.details;
    const error = new OpenworkServerError(response.status, code, message, details);
    if (options?.throwOnError) throw error;
    return { error, request, response };
  }

  const data = json && typeof json === "object" && (json as Record<string, unknown>).ok === true
    ? (json as { data: T }).data
    : (json as T);
  return { data, request, response };
}

function resolveOpenworkWorkspaceMount(baseUrl: string): { baseUrl: string; workspaceId: string } | null {
  try {
    const url = new URL(baseUrl);
    const match = url.pathname.replace(/\/+$/, "").match(/^(.*)\/w\/([^/]+)\/opencode$/);
    if (!match || !match[2]) return null;
    url.pathname = match[1] || "/";
    url.search = "";
    return {
      baseUrl: url.toString().replace(/\/+$/, ""),
      workspaceId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function createSyntheticResult<T>(
  url: string,
  method: string,
  input:
    | { ok: true; data: T; status?: number }
    | { ok: false; error: unknown; status?: number },
): FieldsResult<T> {
  const request = new Request(url, { method });
  const response = new Response(input.ok ? JSON.stringify(input.data) : null, {
    status: input.status ?? (input.ok ? 200 : 500),
    headers: { "Content-Type": "application/json" },
  });
  if (input.ok) {
    return { data: input.data, request, response };
  }
  return { error: input.error, request, response };
}

async function wrapOpenworkRead<T>(
  url: string,
  read: () => Promise<T>,
  options?: { throwOnError?: boolean },
): Promise<FieldsResult<T>> {
  try {
    return createSyntheticResult(url, "GET", { ok: true, data: await read() });
  } catch (error) {
    if (options?.throwOnError) throw error;
    return createSyntheticResult(url, "GET", {
      ok: false,
      error,
      status: error instanceof OpenworkServerError ? error.status : 500,
    });
  }
}

function shouldFallbackToLegacySessionRead(error: unknown): boolean {
  if (!(error instanceof OpenworkServerError)) return false;
  return error.status === 404 || error.status === 405 || error.status === 501;
}

async function wrapOpenworkRouteWithFallback<T>(
  url: string,
  method: string,
  run: () => Promise<T>,
  fallback: () => Promise<FieldsResult<T>>,
  allowLegacyFallback: boolean,
  options?: { throwOnError?: boolean },
): Promise<FieldsResult<T>> {
  try {
    return createSyntheticResult(url, method, { ok: true, data: await run() });
  } catch (error) {
    if (!allowLegacyFallback || !shouldFallbackToLegacySessionRead(error)) {
      if (options?.throwOnError) throw error;
      return createSyntheticResult(url, method, {
        ok: false,
        error,
        status: error instanceof OpenworkServerError ? error.status : 500,
      });
    }
    return fallback();
  }
}

function resolveSessionRouting(baseUrl: string, auth?: OpencodeAuth): NonNullable<OpencodeAuth["sessionRouting"]> | null {
  if (auth?.sessionRouting?.baseUrl?.trim() && auth.sessionRouting.workspaceId?.trim() && auth.sessionRouting.token?.trim()) {
    return {
      baseUrl: auth.sessionRouting.baseUrl.trim().replace(/\/+$/, ""),
      hostToken: auth.sessionRouting.hostToken?.trim() || undefined,
      required: auth.sessionRouting.required === true,
      token: auth.sessionRouting.token.trim(),
      workspaceId: auth.sessionRouting.workspaceId.trim(),
    };
  }

  const openworkMount = auth?.mode === "openwork" ? resolveOpenworkWorkspaceMount(baseUrl) : null;
  if (!openworkMount || !auth?.token?.trim()) {
    return null;
  }

  return {
    baseUrl: openworkMount.baseUrl,
    hostToken: auth.hostToken?.trim() || undefined,
    required: false,
    token: auth.token.trim(),
    workspaceId: openworkMount.workspaceId,
  };
}

async function wrapOpenworkReadWithFallback<T>(
  url: string,
  read: () => Promise<T>,
  fallback: () => Promise<FieldsResult<T>>,
  options?: { throwOnError?: boolean },
): Promise<FieldsResult<T>> {
  try {
    return createSyntheticResult(url, "GET", { ok: true, data: await read() });
  } catch (error) {
    if (!shouldFallbackToLegacySessionRead(error)) {
      if (options?.throwOnError) throw error;
      return createSyntheticResult(url, "GET", {
        ok: false,
        error,
        status: error instanceof OpenworkServerError ? error.status : 500,
      });
    }
    return fallback();
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
) {
  const effectiveTimeoutMs = resolveRequestTimeoutMs(input, timeoutMs);
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = controller?.signal;
  const initWithSignal = signal && !init?.signal ? { ...(init ?? {}), signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(input, initWithSignal), timeoutPromise]);
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

const encodeBasicAuth = (auth?: OpencodeAuth) => {
  if (!auth?.username || !auth?.password) return null;
  const token = `${auth.username}:${auth.password}`;
  if (typeof btoa === "function") return btoa(token);
  const buffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } })
    .Buffer;
  return buffer ? buffer.from(token, "utf8").toString("base64") : null;
};

const resolveAuthHeader = (auth?: OpencodeAuth) => {
  if (auth?.mode === "openwork" && auth.token) {
    return `Bearer ${auth.token}`;
  }
  const encoded = encodeBasicAuth(auth);
  return encoded ? `Basic ${encoded}` : null;
};

const createTauriFetch = (auth?: OpencodeAuth) => {
  const authHeader = resolveAuthHeader(auth);
  const addAuth = (headers: Headers) => {
    if (!authHeader || headers.has("Authorization")) return;
    headers.set("Authorization", authHeader);
  };

  return (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      addAuth(headers);
      const request = new Request(input, { headers });
      return fetchWithTimeout(
        tauriFetch as unknown as typeof globalThis.fetch,
        request,
        undefined,
        DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
      );
    }

    const headers = new Headers(init?.headers);
    addAuth(headers);
    return fetchWithTimeout(
      tauriFetch as unknown as typeof globalThis.fetch,
      input,
      {
        ...init,
        headers,
      },
      DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    );
  };
};

export function unwrap<T>(result: FieldsResult<T>): NonNullable<T> {
  if (result.data !== undefined) {
    return result.data as NonNullable<T>;
  }
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  throw new Error(message || "Unknown error");
}

export function createClient(baseUrl: string, directory?: string, auth?: OpencodeAuth) {
  const headers: Record<string, string> = {};
  if (!isTauriRuntime()) {
    const authHeader = resolveAuthHeader(auth);
    if (authHeader) {
      headers.Authorization = authHeader;
    }
  }

  const fetchImpl = isTauriRuntime()
    ? createTauriFetch(auth)
    : (input: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTimeout(globalThis.fetch, input, init, DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS);
  const client = createOpencodeClient({
    baseUrl,
    directory,
    headers: Object.keys(headers).length ? headers : undefined,
    fetch: fetchImpl,
  });

  const session = client.session as typeof client.session;
  const openworkRouting = resolveSessionRouting(baseUrl, auth);
  const allowOpenworkRouteFallback = openworkRouting?.required !== true;
  // TODO(2026-04-12): remove the old-server compatibility path here once all
  // OpenWork servers expose the workspace-scoped session read APIs.
  const sessionOverrides = session as any as {
    abort: (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
    create: (parameters?: { directory?: string }, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Session>>;
    delete: (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
    list: (parameters?: SessionListParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Session[]>>;
    get: (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Session>>;
    messages: (parameters: SessionMessagesParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Array<{ info: Message; parts: Part[] }>>>;
    status: (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<SessionStatus>>;
    todo: (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Todo[]>>;
    revert: (parameters: { messageID: string; sessionID: string }, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Session>>;
    shell: (parameters: { command: string; sessionID: string }, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
    summarize: (parameters: { directory?: string; modelID: string; providerID: string; sessionID: string }, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
    unrevert: (parameters: { sessionID: string }, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Session>>;
    update: (parameters: { archived?: boolean; sessionID: string; title?: string }, options?: { throwOnError?: boolean }) => Promise<FieldsResult<Session>>;
    promptAsync: (parameters: PromptAsyncParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
    command: (parameters: CommandParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
  };

  const listOriginal = sessionOverrides.list.bind(session);
  sessionOverrides.list = (parameters?: SessionListParameters, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return listOriginal(parameters, options);
    }
    const query = new URLSearchParams();
    if (typeof parameters?.roots === "boolean") query.set("roots", String(parameters.roots));
    if (typeof parameters?.start === "number") query.set("start", String(parameters.start));
    if (parameters?.search?.trim()) query.set("search", parameters.search.trim());
    if (typeof parameters?.limit === "number") query.set("limit", String(parameters.limit));
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions${query.size ? `?${query.toString()}` : ""}`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "GET",
      async () => (unwrap(await requestOpenworkRoute<{ items: Session[] }>(fetchImpl, openworkRouting, path, { throwOnError: true })).items),
      () => listOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const getOriginal = sessionOverrides.get.bind(session);
  sessionOverrides.get = (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return getOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "GET",
      async () => unwrap(await requestOpenworkRoute<Session>(fetchImpl, openworkRouting, path, { throwOnError: true })),
      () => getOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const messagesOriginal = sessionOverrides.messages.bind(session);
  sessionOverrides.messages = (parameters: SessionMessagesParameters, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return messagesOriginal(parameters, options);
    }
    const query = new URLSearchParams();
    if (typeof parameters.limit === "number") query.set("limit", String(parameters.limit));
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/messages${query.size ? `?${query.toString()}` : ""}`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "GET",
      async () => (unwrap(await requestOpenworkRoute<{ items: Array<{ info: Message; parts: Part[] }> }>(fetchImpl, openworkRouting, path, { throwOnError: true })).items),
      () => messagesOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const todoOriginal = sessionOverrides.todo.bind(session);
  sessionOverrides.todo = (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return todoOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/todo`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "GET",
      async () => (unwrap(await requestOpenworkRoute<{ items: Todo[] }>(fetchImpl, openworkRouting, path, { throwOnError: true })).items),
      () => todoOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  sessionOverrides.status = (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => {
    const fallback = () => getLegacySessionStatus(fetchImpl, baseUrl, parameters.sessionID, {
      directory: parameters.directory ?? directory,
      headers: Object.keys(headers).length ? headers : undefined,
      throwOnError: options?.throwOnError,
    });
    if (!openworkRouting) {
      return fallback();
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/status`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "GET",
      async () => unwrap(await requestOpenworkRoute<SessionStatus>(fetchImpl, openworkRouting, path, { throwOnError: true })),
      fallback,
      allowOpenworkRouteFallback,
      options,
    );
  };

  const createOriginal = sessionOverrides.create.bind(session);
  sessionOverrides.create = (parameters?: { directory?: string }, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return createOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "POST",
      async () => unwrap(await requestOpenworkRoute<Session>(fetchImpl, openworkRouting, path, { method: "POST", throwOnError: true })),
      () => createOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const updateOriginal = sessionOverrides.update.bind(session);
  sessionOverrides.update = (parameters: { archived?: boolean; sessionID: string; title?: string }, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return updateOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "PATCH",
      async () => unwrap(await requestOpenworkRoute<Session>(fetchImpl, openworkRouting, path, {
        body: {
          archived: parameters.archived,
          title: parameters.title,
        },
        method: "PATCH",
        throwOnError: true,
      })),
      () => updateOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const deleteOriginal = sessionOverrides.delete.bind(session);
  sessionOverrides.delete = (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return deleteOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "DELETE",
      async () => unwrap(await requestOpenworkRoute<{ deleted: true }>(fetchImpl, openworkRouting, path, { method: "DELETE", throwOnError: true })) && {},
      () => deleteOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const abortOriginal = sessionOverrides.abort.bind(session);
  sessionOverrides.abort = (parameters: SessionLookupParameters, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return abortOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/abort`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "POST",
      async () => unwrap(await requestOpenworkRoute<{ accepted: true }>(fetchImpl, openworkRouting, path, { method: "POST", throwOnError: true })) && {},
      () => abortOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const revertOriginal = sessionOverrides.revert.bind(session);
  sessionOverrides.revert = (parameters: { messageID: string; sessionID: string }, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return revertOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/revert`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "POST",
      async () => unwrap(await requestOpenworkRoute<Session>(fetchImpl, openworkRouting, path, {
        body: { messageID: parameters.messageID },
        method: "POST",
        throwOnError: true,
      })),
      () => revertOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const unrevertOriginal = sessionOverrides.unrevert.bind(session);
  sessionOverrides.unrevert = (parameters: { sessionID: string }, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return unrevertOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/unrevert`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "POST",
      async () => unwrap(await requestOpenworkRoute<Session>(fetchImpl, openworkRouting, path, { method: "POST", throwOnError: true })),
      () => unrevertOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const summarizeOriginal = sessionOverrides.summarize.bind(session);
  sessionOverrides.summarize = (parameters: { directory?: string; modelID: string; providerID: string; sessionID: string }, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return summarizeOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/summarize`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "POST",
      async () => unwrap(await requestOpenworkRoute<{ accepted: true }>(fetchImpl, openworkRouting, path, {
        body: { modelID: parameters.modelID, providerID: parameters.providerID },
        method: "POST",
        throwOnError: true,
      })) && {},
      () => summarizeOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const shellOriginal = sessionOverrides.shell.bind(session);
  sessionOverrides.shell = (parameters: { command: string; sessionID: string }, options?: { throwOnError?: boolean }) => {
    if (!openworkRouting) {
      return shellOriginal(parameters, options);
    }
    const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(parameters.sessionID)}/shell`;
    const url = `${openworkRouting.baseUrl}${path}`;
    return wrapOpenworkRouteWithFallback(
      url,
      "POST",
      async () => unwrap(await requestOpenworkRoute<{ accepted: true }>(fetchImpl, openworkRouting, path, {
        body: { command: parameters.command },
        method: "POST",
        throwOnError: true,
      })) && {},
      () => shellOriginal(parameters, options),
      allowOpenworkRouteFallback,
      options,
    );
  };

  const promptAsyncOriginal = sessionOverrides.promptAsync.bind(session);
  sessionOverrides.promptAsync = (parameters: PromptAsyncParameters, options?: { throwOnError?: boolean }) => {
    if (openworkRouting) {
      const { sessionID, directory: _requestDirectory, ...body } = parameters;
      const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(sessionID)}/prompt_async`;
      const url = `${openworkRouting.baseUrl}${path}`;
      return wrapOpenworkRouteWithFallback(
        url,
        "POST",
        async () => unwrap(await requestOpenworkRoute<{}>(fetchImpl, openworkRouting, path, {
          body,
          method: "POST",
          throwOnError: true,
        })),
        () => promptAsyncOriginal(parameters, options),
        allowOpenworkRouteFallback,
        options,
      );
    }

    if (!("reasoning_effort" in parameters)) {
      return promptAsyncOriginal(parameters, options);
    }
    const { sessionID, directory: requestDirectory, ...body } = parameters;
    return postSessionRequest(fetchImpl, baseUrl, `/session/${encodeURIComponent(sessionID)}/prompt_async`, body, {
      headers: Object.keys(headers).length ? headers : undefined,
      directory: requestDirectory ?? directory,
      throwOnError: options?.throwOnError,
    });
  };

  const commandOriginal = sessionOverrides.command.bind(session);
  sessionOverrides.command = (parameters: CommandParameters, options?: { throwOnError?: boolean }) => {
    if (openworkRouting) {
      const { sessionID, directory: _requestDirectory, ...body } = parameters;
      const path = `/workspaces/${encodeURIComponent(openworkRouting.workspaceId)}/sessions/${encodeURIComponent(sessionID)}/command`;
      const url = `${openworkRouting.baseUrl}${path}`;
      return wrapOpenworkRouteWithFallback(
        url,
        "POST",
        async () => unwrap(await requestOpenworkRoute<{}>(fetchImpl, openworkRouting, path, {
          body,
          method: "POST",
          throwOnError: true,
        })),
        () => commandOriginal(parameters, options),
        allowOpenworkRouteFallback,
        options,
      );
    }

    if (!("reasoning_effort" in parameters)) {
      return commandOriginal(parameters, options);
    }
    const { sessionID, directory: requestDirectory, ...body } = parameters;
    return postSessionRequest(fetchImpl, baseUrl, `/session/${encodeURIComponent(sessionID)}/command`, body, {
      headers: Object.keys(headers).length ? headers : undefined,
      directory: requestDirectory ?? directory,
      throwOnError: options?.throwOnError,
    });
  };

  const eventOverrides = client.event as typeof client.event & {
    subscribe: (parameters?: unknown, options?: { signal?: AbortSignal }) => Promise<{ stream: AsyncGenerator<unknown, void, unknown> }>;
  };
  const subscribeOriginal = eventOverrides.subscribe.bind(client.event);
  eventOverrides.subscribe = async (parameters?: unknown, options?: { signal?: AbortSignal }) => {
    if (!openworkRouting) {
      return subscribeOriginal(parameters as never, options as never);
    }

    try {
      return createOpenWorkServerWorkspaceEventStream({
        baseUrl: openworkRouting.baseUrl,
        headers: {
          Authorization: `Bearer ${openworkRouting.token}`,
          ...(openworkRouting.hostToken ? { "X-OpenWork-Host-Token": openworkRouting.hostToken } : {}),
        },
        signal: options?.signal,
        workspaceId: openworkRouting.workspaceId,
        fetch: fetchImpl,
      }) as any;
    } catch (error) {
      if (!shouldFallbackToLegacySessionRead(error)) {
        throw error;
      }
      return subscribeOriginal(parameters as never, options as never);
    }
  };

  return client;
}

export async function waitForHealthy(
  client: ReturnType<typeof createClient>,
  options?: { timeoutMs?: number; pollMs?: number },
) {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const pollMs = options?.pollMs ?? 250;

  const start = Date.now();
  let lastError: string | null = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const health = unwrap(await client.global.health());
      if (health.healthy) {
        return health;
      }
      lastError = "Server reported unhealthy";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown error";
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(lastError ?? "Timed out waiting for server health");
}
