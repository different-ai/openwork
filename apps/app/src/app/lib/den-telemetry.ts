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
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushEvents();
  }, FLUSH_INTERVAL_MS);
}

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

export function trackSessionActive(sessionId?: string, dimensions?: TelemetryDimensionInput[]): void {
  trackTelemetryEvent("session.active", { sessionId, dimensions });
}

export function trackTaskStarted(sessionId: string, dimensions?: TelemetryDimensionInput[]): void {
  trackTelemetryEvent("task.started", { sessionId, dimensions });
}

export function trackTaskCompleted(sessionId: string, durationMs: number): void {
  trackTelemetryEvent("task.completed", { sessionId, durationMs, success: true });
}

export function trackTaskFailed(sessionId: string, durationMs: number): void {
  trackTelemetryEvent("task.failed", { sessionId, durationMs, success: false });
}
