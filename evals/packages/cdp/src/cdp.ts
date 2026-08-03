/**
 * Minimal Chrome DevTools Protocol client for the eval runner.
 *
 * Zero dependencies: uses the global fetch + WebSocket available in Node 24+.
 * Mirrors the pattern proven in apps/app/scripts/voice-cdp.mjs.
 */

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpClient {
  targetId?: string | null;
  webSocketDebuggerUrl?: string;
  send(method: string, params?: Record<string, unknown>, options?: CdpSendOptions): Promise<unknown>;
  close(): void;
}

export interface CdpSendOptions {
  timeoutMs?: number;
}

export interface CdpConnectOptions {
  connectTimeoutMs?: number;
  sendTimeoutMs?: number;
}

export interface EvaluateOptions {
  awaitPromise?: boolean;
  timeoutMs?: number;
}

/** Cheap DOM/CDP probes should fail quickly enough for their caller to retry. */
export const DEFAULT_CDP_PROBE_TIMEOUT_MS = 8_000;

interface PendingCallbacks {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTargets(payload: unknown): CdpTarget[] {
  if (!Array.isArray(payload)) {
    throw new Error("CDP target list response was not an array.");
  }
  return payload.map((entry, index) => {
    if (!isRecord(entry)) {
      return { id: String(index), type: "", title: "", url: "" };
    }
    return {
      id: stringField(entry.id) || String(index),
      type: stringField(entry.type),
      title: stringField(entry.title),
      url: stringField(entry.url),
      webSocketDebuggerUrl: optionalStringField(entry.webSocketDebuggerUrl),
    };
  });
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function listTargets(
  baseUrl: string,
  { timeoutMs = DEFAULT_CDP_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<CdpTarget[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Could not list CDP targets at ${baseUrl}: ${response.status}`);
  }
  return parseTargets(await response.json());
}

export async function pickAppTarget(
  baseUrl: string,
  { timeoutMs = DEFAULT_CDP_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<CdpTarget> {
  const targets = await listTargets(baseUrl, { timeoutMs });
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  const target =
    pages.find((page) => page.title === "OpenWork") ??
    pages.find(
      (page) =>
        page.url.includes("localhost") ||
        page.url.includes("127.0.0.1") ||
        page.url.includes("[::1]"),
    ) ??
    pages[0];
  if (!target) {
    throw new Error(`No CDP page target found at ${baseUrl}.`);
  }
  return target;
}

/**
 * Chromium reports webSocketDebuggerUrl with its own local host
 * (e.g. ws://127.0.0.1:9825/devtools/page/<id>), which breaks when the
 * endpoint is reached through a proxy (e.g. Daytona preview URLs).
 * Rebuild the ws URL on the base URL's host and scheme.
 */
export function debuggerUrlFor(baseUrl: string, target: CdpTarget): string {
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`CDP target ${target.id} has no webSocketDebuggerUrl.`);
  }
  const base = new URL(baseUrl);
  const ws = new URL(target.webSocketDebuggerUrl);
  ws.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  ws.hostname = base.hostname;
  ws.port = base.port;
  return ws.toString();
}

/**
 * Probe a list of CDP base URL candidates and return the first that responds.
 */
export async function resolveCdpBaseUrl(candidates: string[]): Promise<string> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      await listTargets(candidate);
      return candidate;
    } catch (error) {
      errors.push(`${candidate}: ${messageText(error)}`);
    }
  }
  throw new Error(
    `No CDP endpoint reachable. Tried:\n  ${errors.join("\n  ")}\n` +
      "Start the app first (pnpm dev) or pass --cdp-url.",
  );
}

// Default upper bound on a single CDP round trip (handshake or a send/reply).
// Without this, a stalled Daytona proxy WebSocket (seen intermittently — the
// handshake or a single message reply just never arrives) hangs the calling
// promise forever with no error, which hangs the whole flow silently.
const DEFAULT_CDP_TIMEOUT_MS = 20_000;

export function connect(
  webSocketDebuggerUrl: string,
  { connectTimeoutMs = DEFAULT_CDP_TIMEOUT_MS, sendTimeoutMs = DEFAULT_CDP_TIMEOUT_MS }: CdpConnectOptions = {},
): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map<number, PendingCallbacks>();
    let opened = false;
    let settled = false;

    const connectTimer = setTimeout(() => {
      if (opened) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Socket may already be in a closing state.
      }
      reject(new Error(`CDP connect timed out after ${connectTimeoutMs}ms: ${webSocketDebuggerUrl}`));
    }, connectTimeoutMs);

    const rejectPending = (error: Error) => {
      for (const callbacks of pending.values()) {
        if (callbacks.timer) clearTimeout(callbacks.timer);
        callbacks.reject(error);
      }
      pending.clear();
    };

    socket.addEventListener("open", () => {
      if (settled) return;
      opened = true;
      if (connectTimer) clearTimeout(connectTimer);
      resolve({
        targetId: new URL(webSocketDebuggerUrl).pathname.split("/").pop() ?? null,
        webSocketDebuggerUrl,
        close: () => socket.close(),
        send(method: string, params: Record<string, unknown> = {}, { timeoutMs = sendTimeoutMs }: CdpSendOptions = {}) {
          const id = nextId;
          nextId += 1;
          return new Promise((innerResolve, innerReject) => {
            // Name WHAT timed out. The rejection fires from a timer, so the
            // caller's stack is gone by then: "CDP call Runtime.evaluate timed
            // out" alone cannot tell you which of a spec's dozens of
            // evaluations blocked, which turns a one-line fix into a hunt.
            const subject = typeof params.expression === "string"
              ? ` evaluating: ${params.expression.replace(/\s+/g, " ").trim().slice(0, 160)}`
              : "";
            const timer = setTimeout(() => {
              pending.delete(id);
              innerReject(new Error(`CDP call ${method} timed out after ${timeoutMs}ms.${subject}`));
            }, timeoutMs);
            pending.set(id, { resolve: innerResolve, reject: innerReject, timer });
            try {
              socket.send(JSON.stringify({ id, method, params }));
            } catch (error) {
              pending.delete(id);
              if (timer) clearTimeout(timer);
              innerReject(error);
            }
          });
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (!isRecord(parsed) || typeof parsed.id !== "number") return;
      const callbacks = pending.get(parsed.id);
      if (!callbacks) return;
      pending.delete(parsed.id);
      if (callbacks.timer) clearTimeout(callbacks.timer);
      if (isRecord(parsed.error)) {
        callbacks.reject(new Error(stringField(parsed.error.message) || "CDP call failed."));
      } else {
        callbacks.resolve(parsed.result);
      }
    });
    socket.addEventListener("error", () => {
      const error = new Error("CDP websocket failed.");
      rejectPending(error);
      if (!opened && !settled) {
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        reject(error);
      }
    });
    socket.addEventListener("close", () => {
      const error = new Error("CDP websocket closed.");
      rejectPending(error);
      if (!opened && !settled) {
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        reject(error);
      }
    });
  });
}

export async function evaluate(
  client: CdpClient,
  expression: string,
  { awaitPromise = false, timeoutMs = DEFAULT_CDP_PROBE_TIMEOUT_MS }: EvaluateOptions = {},
): Promise<unknown> {
  const payload = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  }, { timeoutMs });
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.exceptionDetails)) {
    const exception = payload.exceptionDetails.exception;
    throw new Error(
      (isRecord(exception) && stringField(exception.description)) ||
        stringField(payload.exceptionDetails.text) ||
        "Evaluation failed.",
    );
  }
  const result = payload.result;
  return isRecord(result) ? result.value : undefined;
}

export async function navigate(client: CdpClient, url: string): Promise<void> {
  await client.send("Page.navigate", { url });
}

export async function captureScreenshot(client: CdpClient): Promise<Buffer> {
  const payload = await client.send("Page.captureScreenshot", { format: "png" });
  if (!isRecord(payload) || typeof payload.data !== "string") {
    throw new Error("Page.captureScreenshot did not return base64 PNG data.");
  }
  return Buffer.from(payload.data, "base64");
}
