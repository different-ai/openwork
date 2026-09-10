import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { AgentPartInput, FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2/client";

import { desktopFetch } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";

export type FieldsResult<T> =
  | ({ data: T; error?: undefined } & { request: Request; response: Response })
  | ({ data?: undefined; error: unknown } & { request: Request; response: Response });

/** Local SDK options metadata, never HTTP payload. Null asks to revalidate a replacement view. */
export type PromptDispatch = () => Promise<() => Array<TextPartInput | FilePartInput | AgentPartInput> | null>;
type PromptRequestOptions = { throwOnError?: boolean; meta?: { openworkPrompt?: PromptDispatch } };

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

export type OpencodeAuth = {
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "openwork";
};

const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MCP_AUTH_OPENCODE_REQUEST_TIMEOUT_MS = 90_000;
// Bound the acceptance handshake, not the task. A timeout leaves admission
// unknown, so the transport must never automatically resend the prompt.
const PROMPT_ASYNC_REQUEST_TIMEOUT_MS = 30_000;
const SESSION_LONG_RUNNING_URL_RE = /\/session\/[^/?#]+\/(?:command|summarize)(?:[?#]|$)/;
const SESSION_PROMPT_ASYNC_URL_RE = /\/session\/[^/?#]+\/prompt_async(?:[?#]|$)/;

export class PromptAdmissionUnknownError extends Error {
  readonly admission = "unknown";

  constructor(options?: { cause?: unknown; messageID?: string }) {
    super("Message acceptance is unknown. It may already be running; do not resend it while checking the conversation.", { cause: options?.cause });
    this.name = "PromptAdmissionUnknownError";
    this.messageID = options?.messageID;
  }

  readonly messageID?: string;
}

export function isPromptAdmissionUnknown(error: unknown): error is PromptAdmissionUnknownError {
  return error instanceof PromptAdmissionUnknownError;
}

let lastMessageStamp = 0;

/** Native sortable msg_ format. This identifies a submission, NOT an idempotency key. */
export function createPromptMessageID(): string {
  lastMessageStamp = Math.max(Date.now() * 0x1000, lastMessageStamp + 1);
  // Native stores the low six bytes of the timestamp/counter, then 14 random characters.
  return `msg_${lastMessageStamp.toString(16).padStart(12, "0").slice(-12)}${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input);
}

function resolveRequestTimeoutMs(input: RequestInfo | URL, fallbackMs: number): number {
  const url = getRequestUrl(input);
  if (SESSION_LONG_RUNNING_URL_RE.test(url)) {
    return 0;
  }
  if (SESSION_PROMPT_ASYNC_URL_RE.test(url)) {
    return Math.max(fallbackMs, PROMPT_ASYNC_REQUEST_TIMEOUT_MS);
  }
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
  options?: { headers?: Record<string, string>; directory?: string; throwOnError?: boolean; signal?: AbortSignal },
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
    signal: options?.signal,
  });

  const request = new Request(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.ok) {
    let data: T;
    try {
      data = response.status === 204 ? ({} as T) : ((await response.json()) as T);
    } catch (cause) {
      if (SESSION_PROMPT_ASYNC_URL_RE.test(path)) throw new PromptAdmissionUnknownError({ cause });
      throw cause;
    }
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

function resolveOpenworkWorkspaceMount(baseUrl: string): { baseUrl: string; workspaceId: string } | null {
  try {
    const url = new URL(baseUrl);
    const match = url.pathname
      .replace(/\/+$/, "")
      .match(/^(.*)\/(?:w|workspace)\/([^/]+)\/opencode$/);
    if (!match || match[1] === undefined || !match[2]) return null;
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
    const response = await Promise.race([fetchImpl(input, initWithSignal), timeoutPromise]);
    // A proxy/server failure can happen after native admission. Only an
    // explicit client rejection establishes that the prompt was not accepted.
    if (SESSION_PROMPT_ASYNC_URL_RE.test(getRequestUrl(input)) && (response.status >= 500 || response.status === 408)) {
      throw new PromptAdmissionUnknownError();
    }
    return response;
  } catch (error) {
    if (SESSION_PROMPT_ASYNC_URL_RE.test(getRequestUrl(input))) {
      throw isPromptAdmissionUnknown(error) ? error : new PromptAdmissionUnknownError({ cause: error });
    }
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

/**
 * URLs whose response body we must stream chunk-by-chunk (SSE, long-running
 * message streams, event subscriptions). The Tauri HTTP plugin's
 * `fetch_read_body` IPC call blocks until the entire body is delivered, so
 * pointing it at an infinite stream freezes the webview's main thread for
 * minutes. For these endpoints we always use the webview's native fetch —
 * CORS is already wide open on the openwork/opencode stack, so there's no
 * reason to route them through the plugin.
 */
const STREAM_URL_RE = /\/(event|stream)(\b|\/|$|\?)/;

function requestIsStreaming(input: RequestInfo | URL, init?: RequestInit): boolean {
  const url = getRequestUrl(input);
  if (STREAM_URL_RE.test(url)) return true;
  const accept =
    input instanceof Request
      ? input.headers.get("accept") ?? input.headers.get("Accept")
      : new Headers(init?.headers).get("accept") ?? new Headers(init?.headers).get("Accept");
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

function nativeFetchRef(): typeof globalThis.fetch {
  if (typeof window !== "undefined" && typeof window.fetch === "function") return window.fetch.bind(window);
  return globalThis.fetch as typeof globalThis.fetch;
}

export const createDesktopFetch = (auth?: OpencodeAuth) => {
  const authHeader = resolveAuthHeader(auth);
  const addAuth = (headers: Headers) => {
    if (!authHeader || headers.has("Authorization")) return;
    headers.set("Authorization", authHeader);
  };

  return (input: RequestInfo | URL, init?: RequestInit) => {
    // Streams must go through the webview's native fetch to avoid the
    // Tauri HTTP plugin's `fetch_read_body` hang on never-closing bodies.
    const shouldStream = requestIsStreaming(input, init);
    const underlyingFetch = shouldStream
      ? nativeFetchRef()
      : desktopFetch;
    // Streams should never be timed out at the transport layer; the caller
    // aborts via AbortSignal when the subscription unmounts.
    const timeoutMs = shouldStream ? 0 : DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS;

    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      addAuth(headers);
      const request = new Request(input, { headers });
      return fetchWithTimeout(underlyingFetch, request, undefined, timeoutMs);
    }

    const headers = new Headers(init?.headers);
    addAuth(headers);
    return fetchWithTimeout(
      underlyingFetch,
      input,
      {
        ...init,
        headers,
      },
      timeoutMs,
    );
  };
};

export function unwrap<T>(result: FieldsResult<T>): NonNullable<T> {
  if (result.data !== undefined) {
    return result.data as NonNullable<T>;
  }
  if (isPromptAdmissionUnknown(result.error)) throw result.error;
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
  if (!isDesktopRuntime()) {
    const authHeader = resolveAuthHeader(auth);
    if (authHeader) {
      headers.Authorization = authHeader;
    }
  }

  const fetchImpl = isDesktopRuntime()
    ? createDesktopFetch(auth)
    : (input: RequestInfo | URL, init?: RequestInit) => {
        const timeoutMs = requestIsStreaming(input, init) ? 0 : DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS;
        return fetchWithTimeout(globalThis.fetch, input, init, timeoutMs);
      };
  const client = createOpencodeClient({
    baseUrl,
    directory,
    headers: Object.keys(headers).length ? headers : undefined,
    fetch: fetchImpl,
  });

  const session = client.session as typeof client.session;
  const openworkMount = auth?.mode === "openwork" ? resolveOpenworkWorkspaceMount(baseUrl) : null;
  const sessionOverrides = session as any as {
    promptAsync: (parameters: PromptAsyncParameters, options?: PromptRequestOptions) => Promise<FieldsResult<{}>>;
    command: (parameters: CommandParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
  };

  sessionOverrides.promptAsync = async (parameters: PromptAsyncParameters, options?: PromptRequestOptions) => {
    const { sessionID, directory: requestDirectory, ...body } = parameters;
    if (options?.meta?.openworkPrompt) {
      for (let attempt = 0; ; attempt++) {
        const read = await options.meta.openworkPrompt();
        const parts = read();
        if (parts) { body.parts = parts; break; }
        if (attempt === 3) throw new Error("App views kept changing before dispatch. Try sending again.");
      }
    }
    try {
      // Keep the tagged transport failure intact instead of serializing it
      // through the SDK's error result. Native still receives prompt_async.
      return await withAdmissionDeadline(PROMPT_ASYNC_REQUEST_TIMEOUT_MS, (signal) => postSessionRequest(fetchImpl, baseUrl, `/session/${encodeURIComponent(sessionID)}/prompt_async`, body, {
        headers: Object.keys(headers).length ? headers : undefined,
        directory: requestDirectory ?? directory,
        throwOnError: options?.throwOnError,
        signal,
      }), () => new PromptAdmissionUnknownError({ messageID: parameters.messageID }));
    } catch (error) {
      if (isPromptAdmissionUnknown(error)) {
        throw new PromptAdmissionUnknownError({ cause: error, messageID: parameters.messageID });
      }
      throw error;
    }
  };

  const commandOriginal = sessionOverrides.command.bind(session);
  sessionOverrides.command = (parameters: CommandParameters, options?: { throwOnError?: boolean }) => {
    if (!openworkMount && !("reasoning_effort" in parameters)) {
      return commandOriginal(parameters, options);
    }
    const { sessionID, directory: requestDirectory, ...body } = parameters;
    return postSessionRequest(fetchImpl, baseUrl, `/session/${encodeURIComponent(sessionID)}/command`, body, {
      headers: Object.keys(headers).length ? headers : undefined,
      directory: requestDirectory ?? directory,
      throwOnError: options?.throwOnError,
    });
  };

  return client;
}

/** Includes body consumption: receiving headers alone cannot release a send lock. */
async function withAdmissionDeadline<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>, timeoutError: () => Error): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function hasAcceptedPromptMessage(client: ReturnType<typeof createClient>, sessionID: string, messageID: string): Promise<boolean> {
  const result = await withAdmissionDeadline(DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    (signal) => client.session.message({ sessionID, messageID }, { signal }),
    () => new Error("Acceptance check timed out. The message is still held."));
  const message = result.data?.info;
  // Absence (including a transient 404) is not proof of rejection.
  return message?.id === messageID && message.sessionID === sessionID && message.role === "user";
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
