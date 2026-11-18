/**
 * Desktop startup report: how long this launch took from process start until
 * it was connected to the member's Den (window shown → engine ready → signed
 * in → organization tools loaded), sent once per launch to
 * POST /v1/diagnostics/desktop-startup so admins see it in
 * Settings › Diagnostics.
 *
 * Desktop only, and only when the app starts with a Den session (cloud or
 * self-hosted). A member who is not signed in sends nothing. The report holds
 * step timings, the app version, the platform and a failure reason: no paths,
 * URLs, emails or message content. Den attributes the organization and member
 * from the session that sends it.
 *
 * The in-progress report is kept in localStorage (STARTUP_PENDING_STORAGE_KEY)
 * so a launch that quit, crashed or could not reach Den is sent on a later
 * launch, once that launch has signed in to the same Den. Sending is one
 * attempt with a short timeout; nothing here blocks the UI or throws.
 */
import {
  DESKTOP_STARTUP_STEPS,
  desktopStartupFailureReasonSchema,
  desktopStartupPlatformSchema,
  desktopStartupReportSchema,
  desktopStartupStepSchema,
  type DesktopStartupFailureReason,
  type DesktopStartupPlatform,
  type DesktopStartupReport,
  type DesktopStartupStep,
} from "@openwork/types/den/diagnostics";
import { z } from "zod";

import { createDenClient, readDenSettings } from "./den";
import { appBuildInfo, startupTimings, type DesktopStartupTimings } from "./desktop";
import { isDesktopRuntime } from "./runtime-env";

export const STARTUP_PENDING_STORAGE_KEY = "openwork.startup.pending";
/** A launch that is not connected this long after process start is reported as timed out. */
export const STARTUP_DEADLINE_MS = 120_000;
export const STARTUP_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_SEND_TIMEOUT_MS = 5_000;
const STARTUP_TIMINGS_TIMEOUT_MS = 3_000;
const MAX_STEP_MS = 3_600_000;

/** Steps the renderer observes; the window step comes from the main process. */
export type StartupRendererStep = Exclude<DesktopStartupStep, "window">;

export type StartupDenSession = {
  baseUrl: string;
  organizationId: string | null;
};

export type StartupReportTarget = {
  denBaseUrl: string;
  organizationId: string | null;
};

/** sent: delivered. drop: Den refused it for good (e.g. a Den without the endpoint). retry: keep it for a later launch. */
export type StartupSendOutcome = "sent" | "drop" | "retry";

type StartupStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StartupDiagnosticsDeps = {
  enabled: () => boolean;
  readTimings: () => Promise<DesktopStartupTimings | null>;
  readAppVersion: () => Promise<string | null>;
  readPlatform: () => string | null;
  send: (report: DesktopStartupReport, target: StartupReportTarget) => Promise<StartupSendOutcome>;
  storage: () => StartupStorage | null;
  now: () => number;
  /** Fallback launch start when the main process has no timings: this document's start. */
  timeOrigin: () => number;
  randomId: () => string;
  schedule: (run: () => void, delayMs: number) => () => void;
};

export type StartupDiagnostics = {
  /** The Den session found when the app checked it; null when there is no session token. */
  denSession: (session: StartupDenSession | null) => void;
  markStep: (step: StartupRendererStep, context?: { organizationId?: string | null }) => void;
  fail: (step: DesktopStartupStep, reason: DesktopStartupFailureReason) => void;
  /** A load of the organization's tools failed; reported if none succeeds before the deadline. */
  orgToolsFailed: () => void;
  /** Settles once queued storage and network work is done. */
  idle: () => Promise<void>;
};

const startupTimingsSchema = z.object({
  processStartedAt: z.number().positive(),
  windowShownAt: z.number().nullable(),
  engineSettledAt: z.number().nullable(),
  engine: z.enum(["ready", "failed", "skipped"]).nullable(),
});

const pendingStartupRecordSchema = z.object({
  version: z.literal(1),
  /** Main-process start of the launch (epoch ms); identifies it across renderer reloads. */
  launchStartedAt: z.number(),
  denBaseUrl: z.string().min(1),
  organizationId: z.string().nullable(),
  savedAt: z.number(),
  finished: z.boolean(),
  /** False when the main process had no timings, so a missing window step is not a failure. */
  measuresWindow: z.boolean(),
  /** The wire report once finished; before that, `reason` may hold a recorded hint. */
  report: z.object({
    attemptId: z.string(),
    appVersion: z.string(),
    platform: desktopStartupPlatformSchema,
    observedAt: z.string(),
    success: z.boolean(),
    steps: desktopStartupReportSchema.shape.steps,
    failedStep: desktopStartupStepSchema.nullable(),
    reason: desktopStartupFailureReasonSchema.nullable(),
  }),
});
type PendingStartupRecord = z.infer<typeof pendingStartupRecordSchema>;
type StepTimes = DesktopStartupReport["steps"];

/** App version as Den accepts it: allowed characters only, at most 64. */
export function sanitizeStartupAppVersion(raw: string | null | undefined): string {
  const cleaned = (raw ?? "")
    .trim()
    .replace(/[^0-9A-Za-z.+_-]/g, "-")
    .replace(/^[^0-9A-Za-z]+/, "")
    .slice(0, 64);
  return cleaned || "unknown";
}

export function startupPlatform(raw: string | null | undefined): DesktopStartupPlatform {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "darwin" || value.startsWith("mac")) return "darwin";
  if (value === "win32" || value.startsWith("win")) return "win32";
  if (value.includes("linux")) return "linux";
  return "other";
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  return typeof error.status === "number" ? error.status : null;
}

/** Message, name and code of an error and its causes, for matching transport failures. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    for (const key of ["name", "code", "message"]) {
      const value: unknown = Reflect.get(current, key);
      if (typeof value === "string") parts.push(value);
    }
    current = Reflect.get(current, "cause");
  }
  return parts.join(" ");
}

/** Maps a failed Den request to a startup failure reason. */
export function classifyStartupError(
  error: unknown,
  online: boolean = typeof navigator === "undefined" || navigator.onLine !== false,
): DesktopStartupFailureReason {
  const status = errorStatus(error);
  if (status === 401) return "session_expired";
  if (status !== null && status >= 500) return "server_error";
  if (!online) return "offline";
  const text = errorText(error);
  if (
    /\bCERT_|ERR_CERT|ERR_SSL|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED/.test(text)
    || /certificate/i.test(text)
  ) {
    return "certificate";
  }
  if (/ERR_INTERNET_DISCONNECTED/.test(text)) return "offline";
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|getaddrinfo/.test(text)) return "dns";
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/.test(text)) return "connection_refused";
  if (/ETIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|TimeoutError|AbortError|timed out|timeout/i.test(text)) return "timeout";
  return "unknown";
}

export function startupSendOutcomeForStatus(status: number): StartupSendOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 401 || status === 408 || status === 429 || status >= 500) return "retry";
  return "drop";
}

function sameDenBaseUrl(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function firstUnreachedStep(steps: StepTimes, measuresWindow: boolean): DesktopStartupStep {
  for (const step of DESKTOP_STARTUP_STEPS) {
    if (step === "window" && !measuresWindow) continue;
    if (steps[step] === null) return step;
  }
  return "org_tools";
}

/** A record left by another launch, as the report it stands for. */
function reportFromRecord(record: PendingStartupRecord): DesktopStartupReport {
  if (record.finished) return record.report;
  const failedStep = firstUnreachedStep(record.report.steps, record.measuresWindow);
  const reason = failedStep === "org_tools" && record.report.reason ? record.report.reason : "unknown";
  return { ...record.report, success: false, failedStep, reason };
}

type Launch = {
  startedAt: number;
  fromMain: boolean;
  timings: DesktopStartupTimings | null;
  appVersion: string;
  platform: DesktopStartupPlatform;
};

export function createStartupDiagnostics(deps: StartupDiagnosticsDeps): StartupDiagnostics {
  let initialized = false;
  /** inert: nothing to do this document (web, no session, or already reported). */
  let inert = false;
  /** Whether this document measures the launch; a reloaded document only offers old records. */
  let measuring = false;
  let session: "unknown" | "present" | "absent" = "unknown";
  let denBaseUrl: string | null = null;
  let organizationId: string | null = null;
  let attemptId = "";
  const reached: Record<StartupRendererStep, number | null> = { engine: null, signed_in: null, org_tools: null };
  let outcome: "success" | { failedStep: DesktopStartupStep; reason: DesktopStartupFailureReason } | null = null;
  let orgToolsFailure = false;
  let launch: Launch | null = null;
  let launchLoading: Promise<void> | null = null;
  let stored: PendingStartupRecord | null = null;
  /** A record from another launch (or this launch's finished one), offered once after sign-in. */
  let leftover: PendingStartupRecord | null = null;
  let leftoverOffered = false;
  /** A Den session check succeeded in this document, even after the launch's outcome. */
  let signedIn = false;
  let delivered = false;
  let cancelDeadline: (() => void) | null = null;
  const work = new Set<Promise<unknown>>();

  const track = (task: Promise<unknown>) => {
    const settled = task.catch(() => undefined).finally(() => work.delete(settled));
    work.add(settled);
  };

  const storage = () => {
    try {
      return deps.storage();
    } catch {
      return null;
    }
  };

  const readRecord = (): PendingStartupRecord | null => {
    try {
      const raw = storage()?.getItem(STARTUP_PENDING_STORAGE_KEY);
      if (!raw) return null;
      const parsed = pendingStartupRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const removeRecord = () => {
    try {
      storage()?.removeItem(STARTUP_PENDING_STORAGE_KEY);
    } catch {
      // Storage is best effort.
    }
  };

  /** Clears the slot only while it still holds this report; a newer launch may own it. */
  const clearRecordFor = (id: string) => {
    if (readRecord()?.report.attemptId === id) removeRecord();
  };

  const stop = () => {
    inert = true;
    cancelDeadline?.();
    cancelDeadline = null;
  };

  const withTimeout = <T>(task: Promise<T>, fallback: T): Promise<T> =>
    new Promise<T>((resolve) => {
      const cancel = deps.schedule(() => resolve(fallback), STARTUP_TIMINGS_TIMEOUT_MS);
      task.then(
        (value) => { cancel(); resolve(value); },
        () => { cancel(); resolve(fallback); },
      );
    });

  const readTimings = async (): Promise<DesktopStartupTimings | null> => {
    const value = await withTimeout(deps.readTimings(), null);
    const parsed = startupTimingsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

  const init = () => {
    if (initialized) return;
    initialized = true;
    if (!deps.enabled()) {
      inert = true;
      return;
    }
    stored = readRecord();
    if (stored && deps.now() - stored.savedAt > STARTUP_PENDING_MAX_AGE_MS) {
      removeRecord();
      stored = null;
    }
    if (!stored && storage()?.getItem(STARTUP_PENDING_STORAGE_KEY)) removeRecord();
  };

  const toStepMs = (at: number | null): number | null => {
    if (at === null || !launch) return null;
    return Math.min(MAX_STEP_MS, Math.max(0, Math.round(at - launch.startedAt)));
  };

  const currentSteps = (): StepTimes => {
    const timings = launch?.timings ?? null;
    const mainEngineAt = timings && (timings.engine === "ready" || timings.engine === "skipped")
      ? timings.engineSettledAt
      : null;
    const engineAt = reached.engine === null
      ? null
      : mainEngineAt !== null && mainEngineAt <= reached.engine ? mainEngineAt : reached.engine;
    // A load with the stored session can finish before the session check
    // does; the tools count as loaded once the member is also signed in.
    const orgToolsAt = reached.org_tools === null || reached.signed_in === null
      ? reached.org_tools
      : Math.max(reached.org_tools, reached.signed_in);
    return {
      window: launch?.fromMain ? toStepMs(timings?.windowShownAt ?? null) : null,
      engine: toStepMs(engineAt),
      signed_in: toStepMs(reached.signed_in),
      org_tools: toStepMs(orgToolsAt),
    };
  };

  const currentRecord = (): PendingStartupRecord | null => {
    if (!launch || !denBaseUrl) return null;
    const steps = currentSteps();
    const hint: DesktopStartupFailureReason | null = orgToolsFailure ? "org_unavailable" : null;
    const result = outcome === "success"
      ? { success: true, failedStep: null, reason: null }
      : outcome
        ? { success: false, failedStep: outcome.failedStep, reason: outcome.reason }
        : { success: false, failedStep: null, reason: hint };
    return {
      version: 1,
      launchStartedAt: launch.startedAt,
      denBaseUrl,
      organizationId,
      savedAt: deps.now(),
      finished: outcome !== null,
      measuresWindow: launch.fromMain,
      report: {
        attemptId,
        appVersion: launch.appVersion,
        platform: launch.platform,
        observedAt: new Date(launch.startedAt).toISOString(),
        steps,
        ...result,
      },
    };
  };

  const persist = (record: PendingStartupRecord) => {
    try {
      storage()?.setItem(STARTUP_PENDING_STORAGE_KEY, JSON.stringify(record));
    } catch {
      // Storage is best effort.
    }
  };

  const send = async (report: DesktopStartupReport, target: StartupReportTarget): Promise<StartupSendOutcome> => {
    const parsed = desktopStartupReportSchema.safeParse(report);
    if (!parsed.success) return "drop";
    try {
      return await deps.send(parsed.data, target);
    } catch {
      return "retry";
    }
  };

  const refreshTimings = async () => {
    if (!launch?.fromMain) return;
    const timings = await readTimings();
    if (timings && launch) launch.timings = timings;
  };

  const deliver = async () => {
    await refreshTimings();
    const record = currentRecord();
    if (!record) return;
    persist(record);
    const result = await send(reportFromRecord(record), {
      denBaseUrl: record.denBaseUrl,
      organizationId: record.organizationId,
    });
    if (result !== "retry") clearRecordFor(record.report.attemptId);
  };

  const settle = () => {
    if (inert || !measuring || session !== "present" || !launch) return;
    if (!outcome && reached.engine !== null && reached.signed_in !== null && reached.org_tools !== null) {
      outcome = "success";
    }
    if (outcome) {
      cancelDeadline?.();
      cancelDeadline = null;
      if (!delivered) {
        delivered = true;
        track(deliver());
      }
      return;
    }
    // Hold this launch's record until the last launch's record had its chance
    // to be sent; there is one slot.
    if (leftover && !leftoverOffered) return;
    const record = currentRecord();
    if (record) persist(record);
  };

  const onDeadline = async () => {
    cancelDeadline = null;
    if (inert || outcome) return;
    await refreshTimings();
    if (inert || outcome) return;
    const failedStep = firstUnreachedStep(currentSteps(), Boolean(launch?.fromMain));
    // Loads of the organization's tools failed and none succeeded.
    const reason = failedStep === "org_tools" && orgToolsFailure ? "org_unavailable" : "timeout";
    outcome = { failedStep, reason };
    settle();
  };

  const offerLeftover = async () => {
    await launchLoading;
    const record = leftover;
    if (!record || leftoverOffered || !signedIn || !denBaseUrl) return;
    leftoverOffered = true;
    try {
      if (!sameDenBaseUrl(record.denBaseUrl, denBaseUrl)) return;
      const result = await send(reportFromRecord(record), {
        denBaseUrl: record.denBaseUrl,
        organizationId: record.organizationId,
      });
      if (result !== "retry") clearRecordFor(record.report.attemptId);
    } finally {
      leftover = null;
      settle();
    }
  };

  const resolveLaunch = async () => {
    const [timings, version] = await Promise.all([
      readTimings(),
      withTimeout(deps.readAppVersion(), null),
    ]);
    const startedAt = timings?.processStartedAt ?? deps.timeOrigin();
    const sameLaunch = stored && stored.launchStartedAt === startedAt ? stored : null;
    leftover = stored && !sameLaunch ? stored : null;
    launch = {
      startedAt,
      fromMain: timings !== null,
      timings,
      appVersion: sanitizeStartupAppVersion(version),
      platform: startupPlatform(deps.readPlatform()),
    };

    if (sameLaunch && sameLaunch.finished) {
      // This document is a reload of a launch that already finished; at most
      // its unsent report is offered again.
      leftover = sameLaunch;
    } else if (sameLaunch) {
      // A reload during startup continues the launch's report.
      measuring = true;
      attemptId = sameLaunch.report.attemptId;
      launch.appVersion = sameLaunch.report.appVersion;
      launch.platform = sameLaunch.report.platform;
      const steps = sameLaunch.report.steps;
      for (const step of ["engine", "signed_in", "org_tools"] as const) {
        const storedMs = steps[step];
        const storedAt = storedMs === null ? null : startedAt + storedMs;
        const currentAt = reached[step];
        reached[step] = storedAt === null ? currentAt : currentAt === null ? storedAt : Math.min(storedAt, currentAt);
      }
      orgToolsFailure ||= sameLaunch.report.reason === "org_unavailable";
    } else if (timings && timings.windowShownAt !== null && timings.windowShownAt < deps.timeOrigin()) {
      // A reload of a launch with nothing in progress: the launch was already
      // reported, or it had no Den session. Measuring now would time the reload.
    } else {
      measuring = true;
      attemptId = deps.randomId();
    }

    if (measuring && !outcome) {
      const remaining = Math.max(0, startedAt + STARTUP_DEADLINE_MS - deps.now());
      cancelDeadline = deps.schedule(() => track(onDeadline()), remaining);
    }
    settle();
  };

  const guard = (run: () => void) => {
    try {
      init();
      if (inert) return;
      run();
    } catch {
      // Startup diagnostics never affect the app.
    }
  };

  return {
    denSession(next) {
      guard(() => {
        if (next === null) {
          if (session === "unknown") {
            session = "absent";
            stop();
          } else if (session === "present" && !outcome) {
            // The session ended during startup, e.g. the member signed out.
            outcome = { failedStep: reached.signed_in === null ? "signed_in" : "org_tools", reason: "signed_out" };
            settle();
          }
          return;
        }
        if (session !== "unknown") return;
        session = "present";
        denBaseUrl = next.baseUrl;
        organizationId = next.organizationId;
        launchLoading = resolveLaunch().catch(() => undefined);
        track(launchLoading);
      });
    },

    markStep(step, context) {
      guard(() => {
        if (step === "signed_in") {
          signedIn = true;
          if (context?.organizationId) organizationId = context.organizationId;
        }
        if (!outcome && reached[step] === null) reached[step] = deps.now();
        if (step === "signed_in") track(offerLeftover());
        if (launch?.fromMain && measuring && !outcome) {
          track(refreshTimings().then(settle));
        }
        settle();
      });
    },

    fail(step, reason) {
      guard(() => {
        if (outcome) return;
        if (step !== "window" && reached[step] !== null) return;
        outcome = { failedStep: step, reason };
        settle();
      });
    },

    orgToolsFailed() {
      guard(() => {
        if (outcome || reached.org_tools !== null) return;
        orgToolsFailure = true;
        settle();
      });
    },

    async idle() {
      while (work.size > 0) {
        await Promise.all([...work]);
      }
    },
  };
}

// ── App wiring ─────────────────────────────────────────────────────────────

async function sendStartupReport(
  report: DesktopStartupReport,
  target: StartupReportTarget,
): Promise<StartupSendOutcome> {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  // Only the session of the Den the launch belongs to may send it.
  if (!token || !sameDenBaseUrl(settings.baseUrl, target.denBaseUrl)) return "retry";
  const status = await createDenClient({ baseUrl: settings.baseUrl, token })
    .reportDesktopStartup(report, { organizationId: target.organizationId, timeoutMs: STARTUP_SEND_TIMEOUT_MS });
  return startupSendOutcomeForStatus(status);
}

async function readAppVersion(): Promise<string | null> {
  const build = await appBuildInfo().catch(() => null);
  const version = build?.version?.trim()
    || String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim()
    || (typeof window === "undefined" ? "" : window.__OPENWORK_ELECTRON__?.meta?.version?.trim() ?? "");
  return version || null;
}

function readPlatform(): string | null {
  if (typeof window === "undefined") return null;
  return window.__OPENWORK_ELECTRON__?.meta?.platform
    ?? (typeof navigator === "undefined" ? null : navigator.platform || null);
}

let appStartupDiagnostics: StartupDiagnostics | null = null;

function startupDiagnostics(): StartupDiagnostics {
  appStartupDiagnostics ??= createStartupDiagnostics({
    enabled: isDesktopRuntime,
    readTimings: startupTimings,
    readAppVersion,
    readPlatform,
    send: sendStartupReport,
    storage: () => (typeof window === "undefined" ? null : window.localStorage),
    now: Date.now,
    timeOrigin: () => (typeof performance === "undefined" ? Date.now() : performance.timeOrigin),
    randomId: () => crypto.randomUUID(),
    schedule: (run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    },
  });
  return appStartupDiagnostics;
}

/** Called on each Den session check; null when the app has no session token. */
export function noteStartupDenSession(session: StartupDenSession | null): void {
  startupDiagnostics().denSession(session);
}

export function markStartupStep(step: StartupRendererStep, context?: { organizationId?: string | null }): void {
  startupDiagnostics().markStep(step, context);
}

export function failStartup(step: DesktopStartupStep, reason: DesktopStartupFailureReason): void {
  startupDiagnostics().fail(step, reason);
}

/** The organization's tools are loaded when this load succeeds. */
export function trackStartupOrgTools(loading: Promise<unknown>): void {
  loading.then(
    () => startupDiagnostics().markStep("org_tools"),
    () => startupDiagnostics().orgToolsFailed(),
  );
}
