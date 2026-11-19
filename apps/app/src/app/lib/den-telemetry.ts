/**
 * Den telemetry reporter.
 *
 * Activates lazily when the user is signed into Den.
 * Sends lightweight usage signals to POST /v1/telemetry/ingest.
 * Fire-and-forget: no retries and no local storage; a short in-memory batch
 * is sent only under the account and organization that recorded it.
 * If the request fails, the error is swallowed silently.
 *
 * The server extracts org_id and user_id from the auth session.
 * The client never sends prompt contents, code, or file paths.
 */

import { type DenSettings, readDenSettings, resolveDenBaseUrls } from "./den";
import { desktopFetchViaMain } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";

const INGEST_PATH = "/v1/telemetry/ingest";
const INGEST_TIMEOUT_MS = 5_000;

export type TelemetryDimensionInput = {
  type: string;
  value?: string;
  label: string;
  metadata?: Record<string, unknown>;
};

type TelemetryEventFields = {
  sessionId?: string;
  durationMs?: number;
  success?: boolean;
  dimensions?: TelemetryDimensionInput[];
};

type TelemetryEvent = TelemetryEventFields & {
  type: string;
  timestamp: string;
  source: "app";
};

let pendingEvents: TelemetryEvent[] = [];
/** The account, organization and server the queued events were recorded under. */
let pendingContext: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH_SIZE = 50;

export function resolveDenTelemetryIngestUrl(settings: DenSettings): string | null {
  if (!settings.authToken) return null;

  const baseUrls = resolveDenBaseUrls({
    baseUrl: settings.baseUrl,
    apiBaseUrl: settings.apiBaseUrl,
  });

  return `${baseUrls.apiBaseUrl}${INGEST_PATH}`;
}

/**
 * The ingest route attributes events to the caller's token and active
 * organization, so a batch may only be sent under the context that recorded it.
 */
export function telemetryContextKey(settings: DenSettings): string | null {
  if (!settings.authToken) return null;
  return JSON.stringify([settings.baseUrl, settings.apiBaseUrl ?? null, settings.authToken, settings.activeOrgId ?? null]);
}

function discardPending(): void {
  pendingEvents = [];
  pendingContext = null;
}

async function flushEvents(): Promise<void> {
  if (pendingEvents.length === 0) return;

  const settings = readDenSettings();
  const context = telemetryContextKey(settings);
  // Signed out, or switched account or organization since these were recorded:
  // drop them rather than attribute them to the new context.
  if (!context || context !== pendingContext) {
    discardPending();
    return;
  }

  const url = resolveDenTelemetryIngestUrl(settings);
  if (!url) {
    discardPending();
    return;
  }

  const batch = pendingEvents.splice(0, MAX_BATCH_SIZE);
  if (pendingEvents.length === 0) pendingContext = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

    try {
      const fetchImpl = isDesktopRuntime() && new URL(url).origin !== window.location.origin
        ? desktopFetchViaMain
        : globalThis.fetch;
      await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${settings.authToken}`,
        },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
        credentials: "include",
      });
    } finally {
      clearTimeout(timeout);
    }
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
  const context = telemetryContextKey(readDenSettings());
  if (!context) return;
  if (pendingContext !== null && pendingContext !== context) discardPending();
  pendingContext = context;

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
export function trackSessionActive(sessionId?: string, dimensions?: TelemetryDimensionInput[]): void {
  trackTelemetryEvent("session.active", { sessionId, dimensions });
}

/**
 * Track that a task run started in a session.
 * Carries only an opaque session id -- never prompt text or file paths.
 */
export function trackTaskStarted(sessionId: string, dimensions?: TelemetryDimensionInput[]): void {
  trackTelemetryEvent("task.started", { sessionId, dimensions });
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
