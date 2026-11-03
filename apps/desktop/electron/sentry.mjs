import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let sentry = null;
let initialized = false;
let telemetryActive = false;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_PENDING_STARTUP_CAPTURES = 5;

/**
 * Holds a few reports made before a signed-in session exists, so a failure
 * early in a launch (the runtime boot) is sent once the member's session is
 * known instead of being dropped. Oldest entries go first when full.
 */
export function createPendingCaptureQueue({ max = MAX_PENDING_STARTUP_CAPTURES } = {}) {
  let pending = [];
  return {
    add(error, context) {
      pending.push({ error, context });
      if (pending.length > max) pending = pending.slice(pending.length - max);
    },
    drain() {
      const drained = pending;
      pending = [];
      return drained;
    },
    size: () => pending.length,
  };
}

const pendingStartupCaptures = createPendingCaptureQueue();

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces each given folder with its label, in either slash style and any
 * letter case. Longer folders are replaced first, so a workspace inside the
 * home folder reads "<workspace>" rather than "~/…".
 */
export function redactPaths(text, replacements) {
  const entries = [];
  for (const { path, label } of replacements) {
    const root = String(path ?? "").trim().replace(/[\\/]+$/, "");
    if (root.length < 2) continue;
    for (const variant of new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])) {
      entries.push({ variant, label });
    }
  }
  entries.sort((left, right) => right.variant.length - left.variant.length);
  let result = String(text ?? "");
  for (const { variant, label } of entries) {
    result = result.replace(new RegExp(escapeRegExp(variant), "gi"), label);
  }
  return result;
}

/** Replaces the member's home folder (which holds their account name) with "~". */
export function redactHomePath(text, home = homedir()) {
  return redactPaths(text, [{ path: home, label: "~" }]);
}

/**
 * A copy of a startup error that is safe to report: the member's workspace
 * folders become "<workspace>" and their home folder "~".
 */
export function startupErrorForReport(error, { home = homedir(), workspacePaths = [] } = {}) {
  const replacements = [
    ...workspacePaths.map((path) => ({ path, label: "<workspace>" })),
    { path: home, label: "~" },
  ];
  const source = error instanceof Error ? error : new Error(String(error));
  const report = new Error(redactPaths(source.message, replacements));
  report.name = source.name;
  if (source.stack) report.stack = redactPaths(source.stack, replacements);
  return report;
}

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeIdentifier(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function resolveOpenworkSentryAppVersion({ app, packageMetadata }) {
  const electronAppVersion = normalizeIdentifier(app?.getVersion?.());
  const packageVersion = normalizeIdentifier(packageMetadata?.version);
  if (app?.isPackaged) return electronAppVersion || packageVersion || "unknown";
  return packageVersion || electronAppVersion || "unknown";
}

export function resolveOpenworkSentryRelease({ appVersion, environmentRelease = process.env.SENTRY_RELEASE }) {
  return normalizeIdentifier(environmentRelease) || `openwork-desktop@${normalizeIdentifier(appVersion) || "unknown"}`;
}

function parseBuildConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const dsn = normalizeIdentifier(parsed?.dsn);
    const tracesSampleRate = Number(parsed?.tracesSampleRate);
    return {
      dsn,
      tracesSampleRate: Number.isFinite(tracesSampleRate) && tracesSampleRate >= 0 && tracesSampleRate <= 1
        ? tracesSampleRate
        : 0.01,
    };
  } catch {
    return { dsn: null, tracesSampleRate: 0.01 };
  }
}

function readBuildConfig(app) {
  if (app.isPackaged) {
    return parseBuildConfig(resolve(process.resourcesPath, "openwork-sentry.json"));
  }
  return parseBuildConfig(resolve(__dirname, "..", ".electron-runtime", "openwork-sentry.json"));
}

export async function initOpenworkSentry({ app, distribution, packageMetadata }) {
  const buildConfig = readBuildConfig(app);
  const dsn = buildConfig.dsn;
  if (!dsn || envFlagEnabled("OPENWORK_DESKTOP_SENTRY_DISABLED")) return false;

  sentry = await import("@sentry/electron/main");
  const appVersion = resolveOpenworkSentryAppVersion({ app, packageMetadata });
  const release = resolveOpenworkSentryRelease({ appVersion });
  const sampleRate = buildConfig.tracesSampleRate;

  sentry.init({
    dsn,
    release,
    environment: process.env.OPENWORK_DESKTOP_SENTRY_ENVIRONMENT?.trim() || (app.isPackaged ? "production" : "development"),
    sendDefaultPii: false,
    integrations: (defaultIntegrations) => defaultIntegrations.filter(
      (integration) => !["BrowserWindowSession", "ElectronMinidump", "MainProcessSession", "SentryMinidump"].includes(integration.name),
    ),
    tracesSampler: () => telemetryActive ? sampleRate : 0,
    beforeSend: (event) => telemetryActive ? event : null,
    beforeSendTransaction: (event) => telemetryActive ? event : null,
    initialScope: {
      tags: {
        app: "desktop",
        app_version: appVersion,
        distribution: distribution.flavor,
        packaged: String(app.isPackaged),
      },
      contexts: {
        app: {
          app_identifier: distribution.appIdentifier,
          app_name: distribution.appName,
          app_version: appVersion,
        },
      },
    },
  });

  initialized = true;
  globalThis.__openworkDesktopTelemetry = {
    captureException,
    clearSession: clearOpenworkSentrySession,
    setSession: setOpenworkSentrySession,
  };
  return true;
}

export function setOpenworkSentrySession(input) {
  const userId = normalizeIdentifier(input?.userId);
  const orgId = normalizeIdentifier(input?.orgId);
  if (!initialized || !sentry || !userId || !orgId) return false;

  telemetryActive = true;
  sentry.setUser({ id: userId });
  sentry.setTag("org_id", orgId);
  sentry.setContext("openwork_cloud", {
    organization_id: orgId,
    user_id: userId,
  });
  for (const { error, context } of pendingStartupCaptures.drain()) {
    captureException(error, context);
  }
  return true;
}

export function clearOpenworkSentrySession() {
  telemetryActive = false;
  // A signed-out member's early failures are not sent for a later session.
  pendingStartupCaptures.drain();
  if (!initialized || !sentry) return false;

  sentry.setUser(null);
  sentry.setContext("openwork_cloud", null);
  return true;
}

export function captureException(error, context = {}) {
  if (!initialized || !sentry || !telemetryActive) return false;

  sentry.withScope((scope) => {
    if (context.surface) scope.setTag("surface", String(context.surface));
    if (context.route) scope.setTag("route", String(context.route));
    if (context.method) scope.setTag("method", String(context.method));
    sentry.captureException(error);
  });
  return true;
}

/**
 * Reports a failure that can happen before the renderer has confirmed the
 * member's session, such as the runtime boot that leaves the "OpenWork
 * couldn't start" screen. Sent now when a session is active; otherwise held
 * and sent when one starts. Like every desktop report, nothing is sent for a
 * member who never signs in. Pass the member's workspace folders so they are
 * redacted along with the home folder.
 */
export function captureStartupException(error, context = {}, { workspacePaths = [] } = {}) {
  if (!initialized || !sentry) return false;
  const report = startupErrorForReport(error, { workspacePaths });
  if (telemetryActive) return captureException(report, context);
  pendingStartupCaptures.add(report, context);
  return false;
}
