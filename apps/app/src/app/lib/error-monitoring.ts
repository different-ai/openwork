/**
 * Web error monitoring for the OpenWork web deployment (Sentry, zero-dependency).
 *
 * Principles (mirrors `analytics.ts`):
 * - Detection-first: report that a web instance failed to boot or hit an
 *   uncaught error. Only the error type, message, stack text, page URL, and
 *   coarse build context are sent — never chat content, file contents,
 *   prompts, or tokens.
 * - Fire-and-forget: monitoring must never break or slow the app.
 * - Off by default: active only when the build is the web deployment
 *   (`VITE_OPENWORK_DEPLOYMENT=web`), `VITE_OPENWORK_SENTRY_DSN` is set, and
 *   the page is not running inside Electron (the desktop app keeps its own
 *   consent-gated telemetry in `apps/desktop/electron/sentry.mjs`).
 * - Respects the same `analyticsEnabled` preference as product analytics.
 *
 * The pre-boot half lives as an inline script in `index.html` so a bundle
 * that never loads is still reported; once this module starts it takes over
 * via `window.__openworkWebErrorMonitorActive`.
 */
import { isAnalyticsEnabled } from "./analytics";
import { getOpenWorkDeployment } from "./openwork-deployment";
import { isElectronRuntime } from "./runtime-env";

declare global {
  interface Window {
    __openworkWebErrorMonitorActive?: boolean;
  }
}

const MAX_EVENTS_PER_SESSION = 10;

export type SentryDsnTarget = {
  envelopeUrl: string;
};

/** Parse a Sentry DSN into its envelope ingest URL. Returns null when unusable. */
export function parseSentryDsn(dsn: string): SentryDsnTarget | null {
  const match = /^https:\/\/([\w.-]+)@([\w.-]+(?::\d+)?)\/(\d+)$/.exec(dsn.trim());
  if (!match) return null;
  const [, publicKey, host, projectId] = match;
  return {
    envelopeUrl: `https://${host}/api/${projectId}/envelope/?sentry_key=${publicKey}&sentry_version=7`,
  };
}

export type WebErrorMonitoringGate = {
  dsn: string;
  deployment: string;
  electronRuntime: boolean;
};

/** Pure gate: web deployment only, never inside Electron, and a parseable DSN. */
export function shouldMonitorWebErrors(input: WebErrorMonitoringGate): boolean {
  return input.deployment === "web" && !input.electronRuntime && parseSentryDsn(input.dsn) !== null;
}

/**
 * Strip query and fragment before reporting: sign-in and deep-link URLs can
 * carry credentials (`grant`, `openworkToken`, `accessToken`) that must never
 * leave the page.
 */
export function sanitizePageUrl(href: string): string {
  try {
    const url = new URL(href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

export type WebErrorInput = {
  type: string;
  message: string;
  stack?: string;
  url: string;
  release?: string;
  phase: "boot" | "runtime";
};

export type WebErrorEvent = {
  event_id: string;
  timestamp: number;
  platform: "javascript";
  level: "error";
  environment: "web";
  release?: string;
  tags: { boot_phase: "boot" | "runtime" };
  request: { url: string };
  exception: { values: [{ type: string; value: string }] };
  extra?: { stack: string };
};

function newEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Build a minimal Sentry error event. Only error identity + coarse context. */
export function buildWebErrorEvent(input: WebErrorInput): WebErrorEvent {
  const event: WebErrorEvent = {
    event_id: newEventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: "web",
    tags: { boot_phase: input.phase },
    request: { url: input.url },
    exception: { values: [{ type: input.type, value: input.message.slice(0, 1000) }] },
  };
  if (input.release) event.release = input.release;
  if (input.stack) event.extra = { stack: input.stack.slice(0, 8000) };
  return event;
}

/** Serialize an event into a Sentry envelope body. */
export function buildSentryEnvelope(event: WebErrorEvent): string {
  const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: "event" });
  return `${header}\n${itemHeader}\n${JSON.stringify(event)}`;
}

let started = false;
let sentCount = 0;
const seenErrors = new Set<string>();

function deliver(target: SentryDsnTarget, input: WebErrorInput) {
  if (sentCount >= MAX_EVENTS_PER_SESSION) return;
  if (!isAnalyticsEnabled()) return;
  const dedupeKey = `${input.type}:${input.message}`;
  if (seenErrors.has(dedupeKey)) return;
  seenErrors.add(dedupeKey);
  sentCount += 1;
  try {
    void fetch(target.envelopeUrl, {
      method: "POST",
      keepalive: true,
      body: buildSentryEnvelope(buildWebErrorEvent(input)),
    }).catch(() => {
      // Network failure — drop silently. Monitoring must never surface errors.
    });
  } catch {
    // fetch unavailable — drop silently.
  }
}

function resourceUrl(target: EventTarget | null): string | null {
  if (target instanceof HTMLScriptElement && target.src) return sanitizePageUrl(target.src) || null;
  if (target instanceof HTMLLinkElement && target.href) return sanitizePageUrl(target.href) || null;
  return null;
}

/**
 * One-time setup. Called first thing from the app entry so uncaught errors,
 * unhandled rejections (including a failed bootstrap await), and lazy-chunk
 * load failures are reported for web deployments.
 */
export function startWebErrorMonitoring() {
  if (started || typeof window === "undefined") return;
  const dsn = String(import.meta.env.VITE_OPENWORK_SENTRY_DSN ?? "").trim();
  const gate: WebErrorMonitoringGate = {
    dsn,
    deployment: getOpenWorkDeployment(),
    electronRuntime: isElectronRuntime(),
  };
  if (!shouldMonitorWebErrors(gate)) return;
  const target = parseSentryDsn(dsn);
  if (!target) return;

  started = true;
  // Hand off from the pre-boot beacon in index.html.
  window.__openworkWebErrorMonitorActive = true;
  const release = String(import.meta.env.VITE_OPENWORK_BUILD_SHA ?? "").trim()
    || String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim();

  window.addEventListener(
    "error",
    (event) => {
      const failedResource = resourceUrl(event.target);
      if (failedResource) {
        deliver(target, {
          type: "ResourceLoadFailure",
          message: `failed to load ${failedResource}`,
          url: sanitizePageUrl(window.location.href),
          release,
          phase: "runtime",
        });
        return;
      }
      if (!(event instanceof ErrorEvent) || !event.message) return;
      deliver(target, {
        type: event.error instanceof Error ? event.error.name : "Error",
        message: event.message,
        stack: event.error instanceof Error ? event.error.stack : undefined,
        url: sanitizePageUrl(window.location.href),
        release,
        phase: "runtime",
      });
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    deliver(target, {
      type: reason instanceof Error ? reason.name : "UnhandledRejection",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      url: sanitizePageUrl(window.location.href),
      release,
      phase: "runtime",
    });
  });
}
