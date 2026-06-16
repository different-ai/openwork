/**
 * Den telemetry reporter.
 *
 * Activates lazily when the user is signed into Den.
 * Sends lightweight usage signals to POST /v1/telemetry/ingest.
 * Fire-and-forget: no retries, no queue, no local storage.
 * If the request fails, the error is swallowed silently.
 *
 * The server extracts org_id and user_id from the auth session.
 * The client never sends prompt contents, code, or file paths.
 */

import { isDesktopRuntime } from "./runtime-env";
import { type DenSettings, readDenSettings, resolveDenBaseUrls } from "./den";

const INGEST_PATH = "/v1/telemetry/ingest";
const INGEST_TIMEOUT_MS = 5_000;

type TelemetryEventFields = {
  sessionId?: string;
  durationMs?: number;
  success?: boolean;
};

type TelemetryEvent = TelemetryEventFields & {
  type: string;
  timestamp: string;
  source: "app";
};

let pendingEvents: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH_SIZE = 50;

function getResolvedIngestUrl(settings: DenSettings): string | null {
  if (!settings.authToken) return null;

  const baseUrls = resolveDenBaseUrls({
    baseUrl: settings.baseUrl,
    apiBaseUrl: settings.apiBaseUrl,
  });

  return `${baseUrls.apiBaseUrl}${INGEST_PATH}`;
}

async function flushEvents(): Promise<void> {
  if (pendingEvents.length === 0) return;

  const settings = readDenSettings();
  if (!settings.authToken) {
    pendingEvents = [];
    return;
  }

  const url = getResolvedIngestUrl(settings);
  if (!url) {
    pendingEvents = [];
    return;
  }

  const batch = pendingEvents.splice(0, MAX_BATCH_SIZE);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

    const fetchFn = isDesktopRuntime() ? globalThis.fetch : globalThis.fetch;

    await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.authToken}`,
      },
      body: JSON.stringify({ events: batch }),
      signal: controller.signal,
      credentials: "include",
    });

    clearTimeout(timeout);
  } catch {
    // Swallow silently -- telemetry should never affect UX
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushEvents();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Track a telemetry event. The event is batched and flushed periodically.
 * If the user is not signed into Den, the event is silently dropped.
 */
export function trackTelemetryEvent(type: string, fields: TelemetryEventFields = {}): void {
  const settings = readDenSettings();
  if (!settings.authToken) return;

  pendingEvents.push({
    type,
    timestamp: new Date().toISOString(),
    source: "app",
    ...fields,
  });

  if (pendingEvents.length >= MAX_BATCH_SIZE) {
    void flushEvents();
  } else {
    scheduleFlush();
  }
}

/**
 * Track that the user started an OpenCode session.
 * This is the primary "are people actually using the app" signal.
 */
export function trackSessionActive(sessionId?: string): void {
  trackTelemetryEvent("session.active", { sessionId });
}

/**
 * Track that a task run started in a session.
 * Carries only an opaque session id -- never prompt text or file paths.
 */
export function trackTaskStarted(sessionId: string): void {
  trackTelemetryEvent("task.started", { sessionId });
}

/**
 * Track that a task run finished successfully.
 */
export function trackTaskCompleted(sessionId: string, durationMs: number): void {
  trackTelemetryEvent("task.completed", { sessionId, durationMs, success: true });
}

/**
 * Track that a task run errored.
 */
export function trackTaskFailed(sessionId: string, durationMs: number): void {
  trackTelemetryEvent("task.failed", { sessionId, durationMs, success: false });
}

/**
 * Flush any pending events immediately. Call on sign-out or app close.
 */
export function flushTelemetry(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  void flushEvents();
}
