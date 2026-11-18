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
 *   Preferences) turns everything off; an explicitly blank PostHog key means
 *   no network.
 * - Every capture is mirrored into the local app inspector
 *   (`window.__openwork.record("analytics.<event>")`) so coded evals can
 *   assert instrumentation without any analytics backend.
 */
import { denSessionUpdatedEvent, denSettingsChangedEvent, type DenSessionUpdatedDetail } from "./den-session-events";
import { isSelfHostedControlPlane, readDenSettings } from "./den";
import { readDesktopDistributionInfo } from "./desktop";
import { externalTelemetryAllowed } from "./enterprise-activation";
import { analyticsLaunchProperties, analyticsRuntimeProperties, recordAnalyticsLaunch, createRunQualityTracker, createFeatureAnalytics, createFeatureToolObserver, recordDesktopAutomationLifecycle, createUpdateAnalytics } from "@openwork/product-analytics";
import { recordInspectorEvent } from "./app-inspector";
import { resolvePosthogKey } from "./analytics-key";

const ENV_POSTHOG_HOST = String(import.meta.env.VITE_OPENWORK_POSTHOG_HOST ?? "").trim();
const ENV_APP_VERSION = String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim();

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// Packaged releases use the default publishable key; dev builds stay silent
// unless VITE_OPENWORK_POSTHOG_KEY is set. Set it to "" to disable analytics
// in any build. The inspector mirror still records events locally either way.
const POSTHOG_KEY = resolvePosthogKey(import.meta.env.VITE_OPENWORK_POSTHOG_KEY, import.meta.env.DEV);
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

const queue: QueuedEvent[] = [];
let initialized = false;
let launch: ReturnType<typeof recordAnalyticsLaunch> | undefined;
let sessionId: string | undefined;
let signedIn = false;

function telemetryAllowedForInstall(): boolean {
  try {
    return externalTelemetryAllowed({
      flavor: readDesktopDistributionInfo().flavor,
      selfHostedControlPlane: isSelfHostedControlPlane(),
    });
  } catch {
    return false;
  }
}

export function isAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (!telemetryAllowedForInstall()) return false;
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return true;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "analyticsEnabled" in parsed) {
      return parsed.analyticsEnabled !== false;
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
  initAnalytics();
  return {
    app_version: ENV_APP_VERSION || null,
    platform: typeof navigator === "undefined" ? null : navigator.platform || null,
    ...analyticsRuntimeProperties(
      typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__?.meta,
      import.meta.env.VITE_OPENWORK_OFFICIAL_RELEASE === "1",
      typeof navigator === "undefined" ? "" : navigator.platform,
    ),
    ...(launch ? analyticsLaunchProperties(launch) : {}),
    $session_id: sessionId ?? null,
    signed_in: signedIn,
  };
}

/**
 * Queue an analytics event. Always mirrored to the local inspector;
 * only sent over the network when enabled and a key is configured.
 */
export function captureAnalyticsEvent(event: string, properties: AnalyticsProperties = {}) {
  try {
    const eventProperties = { ...baseProperties(), ...properties };
    recordInspectorEvent(`analytics.${event}`, eventProperties);
    if (!POSTHOG_KEY || !isAnalyticsEnabled()) return;

    queue.push({
      event,
      properties: eventProperties,
      timestamp: new Date().toISOString(),
    });
    if (queue.length >= MAX_BATCH) void flushAnalytics();
  } catch {
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
  if (!isAnalyticsEnabled()) {
    queue.length = 0;
    return;
  }
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
  let storage: Storage | undefined;
  try { storage = window.localStorage; } catch { }
  launch = recordAnalyticsLaunch(storage);
  try { sessionId = crypto.randomUUID(); } catch { sessionId = undefined; }
  const refreshSignedIn = () => {
    try { signedIn = Boolean(readDenSettings().authToken); } catch { signedIn = false; }
  };
  refreshSignedIn();
  window.addEventListener(denSettingsChangedEvent, refreshSignedIn);

  setInterval(() => void flushAnalytics(), FLUSH_INTERVAL_MS);

  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAnalytics();
  });

  window.addEventListener(denSessionUpdatedEvent, (event: CustomEvent<DenSessionUpdatedDetail>) => {
    if (event.detail?.status === "signed_out") signedIn = false;
    if (event.detail?.status !== "success") return;
    signedIn = true;
    const userId = event.detail.user?.id?.trim() ?? "";
    if (userId) identify(userId);
    captureAnalyticsEvent("cloud_signed_in", {});
  });
}

export const taskRunQuality = createRunQualityTracker(() => typeof window === "undefined" ? undefined : window.localStorage);
export const featureAnalytics = createFeatureAnalytics(captureAnalyticsEvent);
export const observeFeatureTool = createFeatureToolObserver(featureAnalytics);
export const observeDesktopAutomationLifecycle = (event: unknown) => recordDesktopAutomationLifecycle(featureAnalytics, event);
export const updateAnalytics = createUpdateAnalytics(
  () => typeof window === "undefined" ? undefined : window.localStorage,
  captureAnalyticsEvent,
);

export function captureOnboardingEvent(event: `onboarding_${string}`, properties: AnalyticsProperties = {}) {
  if (taskRunQuality.isFirstRun()) captureAnalyticsEvent(event, properties);
}
