import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

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

export type OpencodeAuth = {
  username?: string;
  password?: string;
  token?: string;
  mode?: "basic" | "openwork";
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
  const sessionOverrides = session as any as {
    promptAsync: (parameters: PromptAsyncParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
    command: (parameters: CommandParameters, options?: { throwOnError?: boolean }) => Promise<FieldsResult<{}>>;
  };

  const promptAsyncOriginal = sessionOverrides.promptAsync.bind(session);
  sessionOverrides.promptAsync = (parameters: PromptAsyncParameters, options?: { throwOnError?: boolean }) => {
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
