/**
 * Product analytics for the OpenWork desktop app (PostHog, zero-dependency).
 *
 * Principles (mirrors `den-telemetry.ts`):
 * - Never send message content, file paths, code, or prompts. Only event
 *   names, counts, lengths, durations, and coarse context (workspace type,
 *   provider/model id). Sole exception: answers the user types directly
 *   into an explicit survey field (e.g. the onboarding attribution survey).
 * - Fire-and-forget: analytics must never break or slow the app.
 * - Respect the user: a single `analyticsEnabled` preference (Settings ->
 *   Preferences) turns everything off; no key baked in means no network.
 * - Every capture is mirrored into the local app inspector
 *   (`window.__openwork.record("analytics.<event>")`) so coded evals can
 *   assert instrumentation without any analytics backend.
 */
import { denSessionUpdatedEvent, type DenSessionUpdatedDetail } from "./den-session-events";
import { recordInspectorEvent } from "./app-inspector";

const ENV_POSTHOG_KEY = String(import.meta.env.VITE_OPENWORK_POSTHOG_KEY ?? "").trim();
const ENV_POSTHOG_HOST = String(import.meta.env.VITE_OPENWORK_POSTHOG_HOST ?? "").trim();
const ENV_APP_VERSION = String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim();

// Same public project key the landing page and den-web use; PostHog client
// keys are publishable by design. Override or blank via VITE_OPENWORK_POSTHOG_KEY.
const DEFAULT_POSTHOG_KEY = "phc_4YnPTlDVYPjgwKvLuNxhbHjV5kadgvd7XLzVHWnCXAI";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// Dev builds send nothing unless a key is explicitly provided, so local
// runs, CI, and evals never pollute production analytics. The inspector
// mirror still records events locally either way.
const POSTHOG_KEY = ENV_POSTHOG_KEY || (import.meta.env.DEV ? "" : DEFAULT_POSTHOG_KEY);
const POSTHOG_HOST = (ENV_POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");

const PREFS_STORAGE_KEY = "openwork.preferences";
const DISTINCT_ID_STORAGE_KEY = "openwork.analytics.distinctId";
const FLUSH_INTERVAL_MS = 10_000;
const MAX_BATCH = 50;

export type AnalyticsProperties = Record<string, string | number | boolean | null>;

type QueuedEvent = {
  event: string;
  properties: AnalyticsProperties;
  timestamp: string;
};

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

export function isAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return true;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "analyticsEnabled" in parsed) {
      return (parsed as { analyticsEnabled?: unknown }).analyticsEnabled !== false;
    }
    return true;
  } catch {
    return true;
  }
}

export function getAnalyticsDistinctId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem(DISTINCT_ID_STORAGE_KEY)?.trim();
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.localStorage.setItem(DISTINCT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return "unknown";
  }
}

function baseProperties(): AnalyticsProperties {
  return {
    app_version: ENV_APP_VERSION || null,
    platform: typeof navigator === "undefined" ? null : navigator.platform || null,
  };
}

/**
 * Queue an analytics event. Always mirrored to the local inspector;
 * only sent over the network when enabled and a key is configured.
 */
export function captureAnalyticsEvent(event: string, properties: AnalyticsProperties = {}) {
  try {
    recordInspectorEvent(`analytics.${event}`, properties);
  } catch {
    // Inspector unavailable (non-browser context).
  }

  if (!POSTHOG_KEY || !isAnalyticsEnabled()) return;

  queue.push({
    event,
    properties: { ...baseProperties(), ...properties },
    timestamp: new Date().toISOString(),
  });
  if (queue.length >= MAX_BATCH) {
    void flushAnalytics();
  }
}

/**
 * Link the anonymous distinct id to the signed-in Den user so DAU and
 * retention survive sign-in. Sends only the user id — no email or name.
 */
function identify(denUserId: string) {
  if (!POSTHOG_KEY || !isAnalyticsEnabled()) return;
  queue.push({
    event: "$identify",
    properties: {
      ...baseProperties(),
      distinct_id: denUserId,
      $anon_distinct_id: getAnalyticsDistinctId(),
    },
    timestamp: new Date().toISOString(),
  });
}

export async function flushAnalytics(): Promise<void> {
  if (queue.length === 0 || !POSTHOG_KEY) return;
  const batch = queue.splice(0, MAX_BATCH);
  const distinctId = getAnalyticsDistinctId();

  try {
    await fetch(`${POSTHOG_HOST}/batch/`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        batch: batch.map((entry) => ({
          event: entry.event,
          distinct_id:
            typeof entry.properties.distinct_id === "string"
              ? entry.properties.distinct_id
              : distinctId,
          timestamp: entry.timestamp,
          properties: entry.properties,
        })),
      }),
    });
  } catch {
    // Network failure — drop silently. Analytics must never surface errors.
  }
}

// Task run duration tracking: sendDraft marks the start, the session.idle
// sync event takes it. Also acts as a dedupe guard so idle events that do
// not correspond to an instrumented run (or arrive from a second workspace
// sync) emit nothing.
const taskRunStarts = new Map<string, number>();

export function markTaskRunStart(sessionId: string) {
  if (sessionId.trim()) taskRunStarts.set(sessionId, Date.now());
}

export function takeTaskRunStart(sessionId: string): number | null {
  const startedAt = taskRunStarts.get(sessionId);
  if (startedAt === undefined) return null;
  taskRunStarts.delete(sessionId);
  return startedAt;
}

/**
 * One-time setup: flush loop, unload flush, and cloud sign-in listener.
 * Mounted from AppRoot.
 */
export function initAnalytics() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  flushTimer = setInterval(() => void flushAnalytics(), FLUSH_INTERVAL_MS);

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAnalytics();
  });

  window.addEventListener(denSessionUpdatedEvent, ((event: CustomEvent<DenSessionUpdatedDetail>) => {
    if (event.detail?.status !== "success") return;
    const userId = event.detail.user?.id?.trim() ?? "";
    if (userId) identify(userId);
    captureAnalyticsEvent("cloud_signed_in", {});
  }) as EventListener);
}

export function disposeAnalytics() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  initialized = false;
  queue = [];
}
