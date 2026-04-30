/**
 * Dev observability client. Forwards browser console logs, uncaught errors,
 * promise rejections, and fetch activity to the openwork-server `/dev/log`
 * sink so an operator can tail a single file and see everything the React
 * shell is doing — especially right before a hang.
 *
 * Also powers a lightweight hang detector: a heartbeat runs every 1s; if the
 * main thread doesn't service the heartbeat within 3s we log a stall event.
 *
 * Everything here is a no-op in prod builds (checked via `import.meta.env`).
 */

import { publishInspectorSlice, recordInspectorEvent } from "./app-inspector";

type LogLevel = "log" | "info" | "warn" | "error" | "debug";

type DevLogEntry = {
  level: LogLevel | "uncaught" | "unhandledRejection" | "hang" | "meta" | "fetch";
  source?: string;
  url?: string;
  message?: string;
  stack?: string;
  durationMs?: number;
  status?: number;
  method?: string;
  args?: unknown[];
  extra?: Record<string, unknown>;
  sessionKey?: string;
};

let started = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let queue: DevLogEntry[] = [];
let serverUrlRef: () => string | Promise<string> = () => readFallbackServerUrl();
const pendingFetches = new Map<number, { url: string; method: string; startedAt: number }>();
let nextFetchId = 1;
let lastHeartbeat = Date.now();
let hangHandle: ReturnType<typeof setInterval> | null = null;
// Reference to the un-wrapped fetch. We use it from inside `flushQueue` so our
// own POST to /dev/log doesn't go through the wrapper (which would recurse
// and also spam the log with its own activity).
let nativeFetchRef: typeof fetch = typeof window !== "undefined" ? window.fetch.bind(window) : (globalThis.fetch as typeof fetch);
let originalFetchRef: typeof fetch | null = null;
let nativeConsoleRef: Record<LogLevel, (...args: unknown[]) => void> | null = null;
let windowErrorHandlerRef: ((event: ErrorEvent) => void) | null = null;
let windowUnhandledRejectionHandlerRef: ((event: PromiseRejectionEvent) => void) | null = null;
let visibilityHandlerRef: (() => void) | null = null;
let disposeInspectorSliceRef: (() => void) | null = null;
const sessionKey = `react-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Cached availability of the server-side /dev/log sink, keyed by base URL.
// Prevents the debug-logger from spamming 404s into the console when the
// pnpm dev process was started WITHOUT OPENWORK_DEV_LOG_FILE set. The
// sink returns 404 in that case and the browser logs every failed POST.
// We probe once per base URL and disable posting for the remainder of the
// session when the probe fails.
const sinkAvailabilityByBase = new Map<string, boolean>();
const sinkProbePromises = new Map<string, Promise<boolean>>();

async function sinkIsAvailable(base: string): Promise<boolean> {
  const cached = sinkAvailabilityByBase.get(base);
  if (typeof cached === "boolean") return cached;
  let pending = sinkProbePromises.get(base);
  if (pending) return pending;
  pending = nativeFetchRef(`${base.replace(/\/+$/, "")}/dev/log`, {
    method: "GET",
    keepalive: true,
  })
    .then(async (response) => {
      if (!response.ok) return false;
      // Server returns 200 + `{ok:true}` when the sink is enabled and
      // 200 + `{ok:false, reason:"dev_log_disabled"}` otherwise, so the
      // probe itself never logs a 404 to the console.
      try {
        const body = (await response.json()) as { ok?: boolean };
        return body.ok === true;
      } catch {
        return false;
      }
    })
    .catch(() => false)
    .then((ok) => {
      sinkAvailabilityByBase.set(base, ok);
      sinkProbePromises.delete(base);
      return ok;
    });
  sinkProbePromises.set(base, pending);
  return pending;
}

function readFallbackServerUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem("openwork.server.urlOverride") ?? "";
  } catch {
    return "";
  }
}

function safeStringify(input: unknown, depth = 0): unknown {
  if (depth > 3) return "[…]";
  if (input === null || typeof input !== "object") {
    if (typeof input === "function") return `[function ${(input as Function).name || "anonymous"}]`;
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "symbol") return input.toString();
    return input;
  }
  if (input instanceof Error) {
    return { name: input.name, message: input.message, stack: input.stack };
  }
  if (Array.isArray(input)) {
    return input.slice(0, 25).map((item) => safeStringify(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count++ > 25) {
      out.__truncated = true;
      break;
    }
    try {
      out[key] = safeStringify(value, depth + 1);
    } catch {
      out[key] = "[unserializable]";
    }
  }
  return out;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, 500);
}

async function flushQueue() {
  if (queue.length === 0) return;
  const base = await serverUrlRef();
  if (!base) return;

  // Skip the POST entirely when we know the sink is disabled, otherwise
  // every dev session without OPENWORK_DEV_LOG_FILE set spams 404s.
  const available = await sinkIsAvailable(base);
  if (!available) {
    // Drop the queued entries; they're still retained in
    // window.__openwork.events() for any operator who needs them.
    queue = [];
    return;
  }

  const batch = queue;
  queue = [];
  try {
    await nativeFetchRef(`${base.replace(/\/+$/, "")}/dev/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      keepalive: true,
    });
  } catch {
    // Keep this silent; we don't want the logger to itself create a log
    // storm when the server is unreachable. Events are still retained in
    // window.__openwork.events().
  }
}

function enqueue(entry: DevLogEntry) {
  queue.push({ sessionKey, ...entry });
  if (queue.length > 200) queue.splice(0, queue.length - 200);
  recordInspectorEvent(`log.${entry.level}`, entry);
  scheduleFlush();
}

export function recordDebugLog(entry: DevLogEntry) {
  if (!started || !isEnabled()) {
    recordInspectorEvent(`log.${entry.level}`, entry);
    return;
  }
  enqueue(entry);
}

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  // Always on in dev; explicit opt-out via `localStorage.openwork.debug.disableLogger = "1"`.
  try {
    if (window.localStorage.getItem("openwork.debug.disableLogger") === "1") return false;
  } catch {
    // ignore
  }
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
  if (env.PROD === true) {
    return window.localStorage.getItem("openwork.debug.enableLoggerInProd") === "1";
  }
  return true;
}

export function startDebugLogger(opts?: { serverUrl?: () => string | Promise<string> }) {
  if (started) return;
  if (!isEnabled()) return;
  started = true;
  if (opts?.serverUrl) serverUrlRef = opts.serverUrl;

  // Patch console
  const nativeConsole: Record<LogLevel, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  nativeConsoleRef = nativeConsole;
  (Object.keys(nativeConsole) as LogLevel[]).forEach((level) => {
    const original = nativeConsole[level];
    console[level] = (...args: unknown[]) => {
      try {
        enqueue({
          level,
          url: typeof location !== "undefined" ? location.pathname + location.search : undefined,
          message: typeof args[0] === "string" ? args[0] : undefined,
          args: args.map((arg) => safeStringify(arg)),
        });
      } catch {
        // ignore
      }
      original(...args);
    };
  });

  // Window errors
  const handleWindowError = (event: ErrorEvent) => {
    const target = event.error as Error | undefined;
    enqueue({
      level: "uncaught",
      source: event.filename,
      message: event.message,
      stack: target?.stack,
      extra: { line: event.lineno, col: event.colno },
    });
  };
  windowErrorHandlerRef = handleWindowError;
  window.addEventListener("error", handleWindowError);

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    enqueue({
      level: "unhandledRejection",
      message: reason instanceof Error ? reason.message : typeof reason === "string" ? reason : undefined,
      stack: reason instanceof Error ? reason.stack : undefined,
      extra: { reason: safeStringify(reason) as Record<string, unknown> },
    });
  };
  windowUnhandledRejectionHandlerRef = handleUnhandledRejection;
  window.addEventListener("unhandledrejection", handleUnhandledRejection);

  // Fetch wrapping (so we can see which requests are hanging around a stall).
  // We capture the native reference here and reuse it inside `flushQueue` so
  // our own POST to /dev/log doesn't go through the wrapper (which would make
  // the logger log itself forever).
  const nativeFetch = window.fetch.bind(window);
  originalFetchRef = nativeFetch;
  nativeFetchRef = nativeFetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const id = nextFetchId++;
    let url = "";
    let method = "GET";
    try {
      if (typeof input === "string") {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else if (input instanceof Request) {
        url = input.url;
        method = input.method;
      }
      if (init?.method) method = init.method;
    } catch {
      // ignore
    }
    const isDevLogCall = url.includes("/dev/log");
    if (!isDevLogCall) {
      pendingFetches.set(id, { url, method, startedAt: Date.now() });
    }
    try {
      const response = await nativeFetch(input as RequestInfo, init);
      if (!isDevLogCall) {
        const duration = Date.now() - (pendingFetches.get(id)?.startedAt ?? Date.now());
        enqueue({
          level: "fetch",
          method,
          url,
          status: response.status,
          durationMs: duration,
        });
      }
      return response;
    } catch (error) {
      if (!isDevLogCall) {
        const duration = Date.now() - (pendingFetches.get(id)?.startedAt ?? Date.now());
        enqueue({
          level: "fetch",
          method,
          url,
          status: 0,
          durationMs: duration,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      if (!isDevLogCall) pendingFetches.delete(id);
    }
  }) as typeof window.fetch;

  // Heartbeat / hang detector.
  // A long heartbeat gap has two possible causes:
  // 1. A real JS-thread stall (bug) — usually 3-10s.
  // 2. macOS threw the webview into App Nap / backgrounding throttle when
  //    the window wasn't focused — gaps can be minutes, not a real "hang".
  // We split them so alarms only fire for case 1.
  const HANG_THRESHOLD_MS = 3000;
  const RESUME_THRESHOLD_MS = 10_000;
  lastHeartbeat = Date.now();
  hangHandle = setInterval(() => {
    const now = Date.now();
    const gap = now - lastHeartbeat;
    if (gap > HANG_THRESHOLD_MS) {
      const level = gap >= RESUME_THRESHOLD_MS ? ("meta" as const) : ("hang" as const);
      enqueue({
        level,
        durationMs: gap,
        message:
          level === "hang"
            ? `Main thread stalled ~${gap}ms`
            : `Webview resumed after ~${Math.round(gap / 1000)}s throttled/background (NOT a hang)`,
        extra: {
          resume: level !== "hang",
          pendingFetchCount: pendingFetches.size,
          pendingFetchSamples: Array.from(pendingFetches.values())
            .slice(0, 5)
            .map((entry) => ({
              url: entry.url,
              method: entry.method,
              ageMs: Date.now() - entry.startedAt,
            })),
          visibility: typeof document !== "undefined" ? document.visibilityState : "unknown",
        },
      });
    }
    lastHeartbeat = now;
  }, 1000);

  // When the page returns to visibility after being backgrounded, stale
  // in-flight SSE subscriptions/Query caches can make the UI look frozen
  // even though JS is fine. Nudge the app to re-resolve its connection and
  // re-fetch route data.
  if (typeof document !== "undefined") {
    const handleVisibilityChange = () => {
      enqueue({
        level: "meta",
        message: `visibilitychange: ${document.visibilityState}`,
        extra: { visibility: document.visibilityState },
      });
      if (document.visibilityState === "visible") {
        try {
          window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
        } catch {
          // ignore
        }
      }
    };
    visibilityHandlerRef = handleVisibilityChange;
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  disposeInspectorSliceRef = publishInspectorSlice("debug", () => ({
    enabled: true,
    sessionKey,
    pendingFetchCount: pendingFetches.size,
    pendingFetches: Array.from(pendingFetches.values()).map((entry) => ({
      url: entry.url,
      method: entry.method,
      ageMs: Date.now() - entry.startedAt,
    })),
    memory: readMemoryUsage(),
    queueSize: queue.length,
  }));

  enqueue({ level: "meta", message: "debug-logger started", extra: { userAgent: navigator.userAgent } });
}

function readMemoryUsage(): Record<string, unknown> | null {
  if (typeof performance === "undefined") return null;
  const mem = (performance as unknown as { memory?: { totalJSHeapSize: number; usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (!mem) return null;
  return {
    usedMb: Math.round((mem.usedJSHeapSize / (1024 * 1024)) * 10) / 10,
    totalMb: Math.round((mem.totalJSHeapSize / (1024 * 1024)) * 10) / 10,
    limitMb: Math.round((mem.jsHeapSizeLimit / (1024 * 1024)) * 10) / 10,
  };
}

export function stopDebugLogger() {
  if (!started) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (hangHandle) clearInterval(hangHandle);
  hangHandle = null;
  if (windowErrorHandlerRef) {
    window.removeEventListener("error", windowErrorHandlerRef);
    windowErrorHandlerRef = null;
  }
  if (windowUnhandledRejectionHandlerRef) {
    window.removeEventListener("unhandledrejection", windowUnhandledRejectionHandlerRef);
    windowUnhandledRejectionHandlerRef = null;
  }
  if (typeof document !== "undefined" && visibilityHandlerRef) {
    document.removeEventListener("visibilitychange", visibilityHandlerRef);
    visibilityHandlerRef = null;
  }
  if (disposeInspectorSliceRef) {
    disposeInspectorSliceRef();
    disposeInspectorSliceRef = null;
  }
  if (originalFetchRef && typeof window !== "undefined") {
    window.fetch = originalFetchRef;
    nativeFetchRef = originalFetchRef;
    originalFetchRef = null;
  }
  if (nativeConsoleRef) {
    (Object.keys(nativeConsoleRef) as LogLevel[]).forEach((level) => {
      console[level] = nativeConsoleRef![level];
    });
    nativeConsoleRef = null;
  }
  pendingFetches.clear();
  queue = [];
  started = false;
}
