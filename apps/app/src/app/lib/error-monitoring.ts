import { isAnalyticsEnabled } from "./analytics";
import { formatCrashDiagnostic, redactCrashText } from "./crash-diagnostics";
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

export function shouldMonitorWebErrors(input: WebErrorMonitoringGate): boolean {
  return input.deployment === "web" && !input.electronRuntime && parseSentryDsn(input.dsn) !== null;
}

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

export function buildWebErrorEvent(input: WebErrorInput): WebErrorEvent {
  const diagnostic = formatCrashDiagnostic({ name: input.type, message: input.message, stack: input.stack });
  const event: WebErrorEvent = {
    event_id: newEventId(),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: "web",
    tags: { boot_phase: input.phase },
    request: { url: sanitizePageUrl(input.url) },
    exception: { values: [{ type: diagnostic.name, value: diagnostic.message }] },
  };
  if (input.release) event.release = redactCrashText(input.release).slice(0, 100);
  if (diagnostic.stack) event.extra = { stack: diagnostic.stack };
  return event;
}

export function buildSentryEnvelope(event: WebErrorEvent): string {
  const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() });
  const itemHeader = JSON.stringify({ type: "event" });
  return `${header}\n${itemHeader}\n${JSON.stringify(event)}`;
}

let monitor: { target: SentryDsnTarget; release: string } | null = null;
let sentCount = 0;
const seenErrors = new Set<string>();

function deliver(target: SentryDsnTarget, input: WebErrorInput) {
  if (sentCount >= MAX_EVENTS_PER_SESSION) return;
  if (!isAnalyticsEnabled()) return;
  try {
    const event = buildWebErrorEvent(input);
    const { type, value } = event.exception.values[0];
    const dedupeKey = `${type}:${value}`;
    if (seenErrors.has(dedupeKey)) return;
    seenErrors.add(dedupeKey);
    sentCount += 1;
    void fetch(target.envelopeUrl, {
      method: "POST",
      keepalive: true,
      body: buildSentryEnvelope(event),
    }).catch(() => {
    });
  } catch {
  }
}

function resourceUrl(target: EventTarget | null): string | null {
  if (target instanceof HTMLScriptElement && target.src) return sanitizePageUrl(target.src) || null;
  if (target instanceof HTMLLinkElement && target.href) return sanitizePageUrl(target.href) || null;
  return null;
}

export function startWebErrorMonitoring() {
  if (monitor || typeof window === "undefined") return;
  const dsn = String(import.meta.env.VITE_OPENWORK_SENTRY_DSN ?? "").trim();
  const gate: WebErrorMonitoringGate = {
    dsn,
    deployment: getOpenWorkDeployment(),
    electronRuntime: isElectronRuntime(),
  };
  if (!shouldMonitorWebErrors(gate)) return;
  const target = parseSentryDsn(dsn);
  if (!target) return;

  window.__openworkWebErrorMonitorActive = true;
  const release = String(import.meta.env.VITE_OPENWORK_BUILD_SHA ?? "").trim()
    || String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim();
  monitor = { target, release };

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
      const diagnostic = formatCrashDiagnostic(event.error ?? event.message);
      deliver(target, {
        type: diagnostic.name,
        message: diagnostic.message,
        stack: diagnostic.stack,
        url: sanitizePageUrl(window.location.href),
        release,
        phase: "runtime",
      });
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    const diagnostic = formatCrashDiagnostic(reason, "UnhandledRejection");
    deliver(target, {
      type: diagnostic.name,
      message: diagnostic.message,
      stack: diagnostic.stack,
      url: sanitizePageUrl(window.location.href),
      release,
      phase: "runtime",
    });
  });
}

export function reportCaughtWebError(error: unknown) {
  if (!monitor) return;
  try {
    const diagnostic = formatCrashDiagnostic(error);
    deliver(monitor.target, {
      type: diagnostic.name,
      message: diagnostic.message,
      stack: diagnostic.stack,
      url: sanitizePageUrl(window.location.href),
      release: monitor.release,
      phase: "runtime",
    });
  } catch {
  }
}
