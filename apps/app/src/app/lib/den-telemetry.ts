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
const SESSION_DIMENSION_TIMEOUT_MS = 5_000;
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
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH_SIZE = 50;
const sessionDimensionsById = new Map<string, TelemetryDimensionInput[]>();

function rememberSessionDimensions(sessionId: string, dimensions: TelemetryDimensionInput[]): void {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId || dimensions.length === 0) return;

  const current = sessionDimensionsById.get(trimmedSessionId) ?? [];
  const nextByType = new Map(current.map((dimension) => [dimension.type, dimension]));
  for (const dimension of dimensions) {
    const type = dimension.type.trim();
    const label = dimension.label.trim();
    if (!type || !label) continue;
    nextByType.set(type, {
      type,
      label,
      ...(dimension.value?.trim() ? { value: dimension.value.trim() } : {}),
      ...(dimension.metadata ? { metadata: dimension.metadata } : {}),
    });
  }

  const next = Array.from(nextByType.values());
  if (next.length > 0) sessionDimensionsById.set(trimmedSessionId, next);
}

function forgetSessionDimension(sessionId: string, type: string): void {
  const trimmedSessionId = sessionId.trim();
  const trimmedType = type.trim();
  if (!trimmedSessionId || !trimmedType) return;

  const current = sessionDimensionsById.get(trimmedSessionId);
  if (!current) return;
  const next = current.filter((dimension) => dimension.type !== trimmedType);
  if (next.length > 0) sessionDimensionsById.set(trimmedSessionId, next);
  else sessionDimensionsById.delete(trimmedSessionId);
}

function dimensionsForEvent(fields: TelemetryEventFields): TelemetryDimensionInput[] | undefined {
  if (fields.dimensions?.length) return fields.dimensions;
  const sessionId = fields.sessionId?.trim();
  if (!sessionId) return undefined;
  return sessionDimensionsById.get(sessionId);
}

function getResolvedApiUrl(settings: DenSettings, path: string): string | null {
  if (!settings.authToken) return null;

  const baseUrls = resolveDenBaseUrls({
    baseUrl: settings.baseUrl,
    apiBaseUrl: settings.apiBaseUrl,
  });

  return `${baseUrls.apiBaseUrl}${path}`;
}

async function flushEvents(): Promise<void> {
  if (pendingEvents.length === 0) return;

  const settings = readDenSettings();
  if (!settings.authToken) {
    pendingEvents = [];
    return;
  }

  const url = getResolvedApiUrl(settings, INGEST_PATH);
  if (!url) {
    pendingEvents = [];
    return;
  }

  const batch = pendingEvents.splice(0, MAX_BATCH_SIZE);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

    const fetchFn = isDesktopRuntime() ? globalThis.fetch : globalThis.fetch;

    try {
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
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Swallow silently -- telemetry should never affect UX
  }
}

export async function setTelemetrySessionDimension(
  sessionId: string,
  type: string,
  dimension: Omit<TelemetryDimensionInput, "type">,
): Promise<void> {
  const settings = readDenSettings();
  if (!settings.authToken) return;

  const trimmedSessionId = sessionId.trim();
  const trimmedType = type.trim();
  const label = dimension.label.trim();
  if (!trimmedSessionId || !trimmedType || !label) return;
  rememberSessionDimensions(trimmedSessionId, [{
    type: trimmedType,
    label,
    ...(dimension.value?.trim() ? { value: dimension.value.trim() } : {}),
    ...(dimension.metadata ? { metadata: dimension.metadata } : {}),
  }]);

  const path = `/v1/telemetry/sessions/${encodeURIComponent(trimmedSessionId)}/dimensions/${encodeURIComponent(trimmedType)}`;
  const url = getResolvedApiUrl(settings, path);
  if (!url) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_DIMENSION_TIMEOUT_MS);
    try {
      await globalThis.fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${settings.authToken}`,
        },
        body: JSON.stringify({
          label,
          ...(dimension.value?.trim() ? { value: dimension.value.trim() } : {}),
          ...(dimension.metadata ? { metadata: dimension.metadata } : {}),
        }),
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

export async function clearTelemetrySessionDimension(sessionId: string, type: string): Promise<void> {
  const settings = readDenSettings();
  if (!settings.authToken) return;

  const trimmedSessionId = sessionId.trim();
  const trimmedType = type.trim();
  if (!trimmedSessionId || !trimmedType) return;
  forgetSessionDimension(trimmedSessionId, trimmedType);

  const path = `/v1/telemetry/sessions/${encodeURIComponent(trimmedSessionId)}/dimensions/${encodeURIComponent(trimmedType)}`;
  const url = getResolvedApiUrl(settings, path);
  if (!url) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SESSION_DIMENSION_TIMEOUT_MS);
    try {
      await globalThis.fetch(url, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${settings.authToken}`,
        },
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
  const settings = readDenSettings();
  if (!settings.authToken) return;
  const dimensions = dimensionsForEvent(fields);
  if (fields.sessionId && dimensions?.length) {
    rememberSessionDimensions(fields.sessionId, dimensions);
  }

  pendingEvents.push({
    type,
    timestamp: new Date().toISOString(),
    source: "app",
    ...fields,
    ...(dimensions?.length ? { dimensions } : {}),
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
