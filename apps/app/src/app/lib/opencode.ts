import type { Client } from "../types";
import { desktopFetch, desktopFetchViaMain, isPermissionReplyRequest } from "./desktop";

export type FieldsResult<T> =
  | ({ data: T; error?: undefined } & { request: Request; response: Response })
  | ({ data?: undefined; error: unknown } & { request: Request; response: Response });

const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
// Finishing a provider sign-in exchanges the code with the provider.
const OAUTH_OPENCODE_REQUEST_TIMEOUT_MS = 5 * 60_000;
// The first native v2 write also opens its location and reconciles the org's
// providers, connections and skills. This can exceed the ordinary read budget.
const V2_SESSION_WRITE_TIMEOUT_MS = 60_000;
const V2_SESSION_WRITE_URL_RE = /\/opencode2\/api\/session(?:\/[^/?#]+\/prompt)?\/?(?:[?#]|$)/;
const V2_INTEGRATION_OAUTH_URL_RE = /\/opencode2\/api\/integration\/[^/?#]+\/connect\/oauth(?:[/?#]|$)/;

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

/** The settled server failure behind an uncertain admission: the parsed
 * response body when the server answered, otherwise the transport error or
 * undefined for a timeout. It explains the failure; it never proves rejection. */
export function promptAdmissionFailure(error: PromptAdmissionUnknownError): unknown {
  let cause: unknown = error.cause;
  while (isPromptAdmissionUnknown(cause)) cause = cause.cause;
  return cause;
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

function resolveRequestTimeoutMs(input: RequestInfo | URL, fallbackMs: number, method: string): number {
  const url = getRequestUrl(input);
  if (method.toUpperCase() === "POST" && V2_SESSION_WRITE_URL_RE.test(url)) {
    return Math.max(fallbackMs, V2_SESSION_WRITE_TIMEOUT_MS);
  }
  if (V2_INTEGRATION_OAUTH_URL_RE.test(url)) {
    return Math.max(fallbackMs, OAUTH_OPENCODE_REQUEST_TIMEOUT_MS);
  }
  return fallbackMs;
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  cancelPermissionReply = false,
) {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const effectiveTimeoutMs = cancelPermissionReply ? timeoutMs : resolveRequestTimeoutMs(input, timeoutMs, method);
  if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
    return fetchImpl(input, init);
  }

  const cancellable = cancelPermissionReply || ["GET", "PATCH"].includes((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase());
  const callerSignal = cancellable
    ? init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal
    : undefined;
  callerSignal?.throwIfAborted();
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const signal = cancellable && callerSignal && controller
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller?.signal;
  const initWithSignal = signal && (cancellable || !init?.signal) ? { ...(init ?? {}), signal } : init;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      try {
        controller?.abort(cancellable ? new Error("Request timed out.") : undefined);
      } catch {
        // ignore
      }
      reject(new Error("Request timed out."));
    }, effectiveTimeoutMs);
  });

  try {
    return await Promise.race([fetchImpl(input, initWithSignal), timeoutPromise]);
  } catch (error) {
    if (cancellable) {
      signal?.throwIfAborted();
      throw error;
    }
    if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
      throw new Error("Request timed out.");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

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
  const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept");
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

function nativeFetchRef(): typeof globalThis.fetch {
  if (typeof window !== "undefined" && typeof window.fetch === "function") return window.fetch.bind(window);
  return globalThis.fetch as typeof globalThis.fetch;
}

export const createDesktopFetch = (token?: string) => {
  const authHeader = token ? `Bearer ${token}` : null;
  const addAuth = (headers: Headers) => {
    if (!authHeader || headers.has("Authorization")) return;
    headers.set("Authorization", authHeader);
  };

  return (input: RequestInfo | URL, init?: RequestInit) => {
    // Streams must go through the webview's native fetch to avoid the
    // Tauri HTTP plugin's `fetch_read_body` hang on never-closing bodies.
    const shouldStream = requestIsStreaming(input, init);
    const permissionReply = isPermissionReplyRequest(input, init);
    const underlyingFetch = shouldStream
      ? nativeFetchRef()
      : permissionReply ? desktopFetchViaMain : desktopFetch;
    // Streams should never be timed out at the transport layer; the caller
    // aborts via AbortSignal when the subscription unmounts.
    const timeoutMs = shouldStream ? 0 : DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS;

    if (permissionReply && !(input instanceof Request)) input = new Request(input, init);
    if (input instanceof Request) {
      const requestInit = permissionReply || isPermissionReplyRequest(input) || ["GET", "PATCH"].includes((init?.method ?? input.method).toUpperCase()) ? init : undefined;
      const headers = new Headers(requestInit?.headers ?? input.headers);
      addAuth(headers);
      const request = new Request(input, { ...requestInit, headers });
      // Keep an explicit null override even in runtimes whose Request clone
      // retains the original signal when constructed with signal: null.
      return fetchWithTimeout(underlyingFetch, request, { signal: requestInit?.signal }, timeoutMs, permissionReply);
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
      permissionReply,
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

export async function hasAcceptedPromptMessage(client: Client, sessionID: string, messageID: string): Promise<boolean> {
  const result = await withAdmissionDeadline(DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    (signal) => client.session.message({ sessionID, messageID }, { signal }),
    () => new Error("Acceptance check timed out. The message is still held."));
  const message = result.data?.info;
  // Absence (including a transient 404) is not proof of rejection.
  return message?.id === messageID && message.sessionID === sessionID && message.role === "user";
}

export type PromptAdmission = "accepted" | "absent" | "unknown";

/** Reconcile an uncertain prompt against native. Only the exact user message
 * proves acceptance. `absent` is authoritative the other way: native listed
 * the idle conversation without the message, so the settled POST is not going
 * to admit it later. A failed or partial read stays unknown and keeps the hold. */
export async function readPromptAdmission(client: Client, sessionID: string, messageID: string): Promise<PromptAdmission> {
  if (await hasAcceptedPromptMessage(client, sessionID, messageID)) return "accepted";
  const [messages, statuses] = await Promise.all([
    client.session.messages({ sessionID }),
    client.session.status(),
  ]);
  if (!Array.isArray(messages.data) || !statuses.data) return "unknown";
  const status = statuses.data[sessionID];
  if (status && status.type !== "idle") return "unknown";
  return messages.data.some(({ info }) => info.id === messageID) ? "unknown" : "absent";
}
