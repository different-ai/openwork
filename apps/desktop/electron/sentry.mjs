import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let sentry = null;
let initialized = false;
let telemetryActive = false;
const __dirname = dirname(fileURLToPath(import.meta.url));
const GPU_ABNORMAL_EXIT_WINDOW_MS = 60_000;

function envFlagEnabled(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function normalizeIdentifier(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function isNoisyGpuAbnormalExitEvent(event) {
  return event?.level === "warning"
    && event?.message === "'GPU' process exited with 'abnormal-exit'"
    && event?.tags?.["event.process"] === "GPU";
}

export function createGpuAbnormalExitSuppressor({
  now = Date.now,
  windowMs = GPU_ABNORMAL_EXIT_WINDOW_MS,
} = {}) {
  let suppressedAt = null;
  return (event) => {
    if (!isNoisyGpuAbnormalExitEvent(event)) return false;
    const observedAt = now();
    if (suppressedAt !== null && observedAt - suppressedAt < windowMs) return false;
    suppressedAt = observedAt;
    return true;
  };
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
  const suppressGpuAbnormalExit = createGpuAbnormalExitSuppressor();

  sentry.init({
    dsn,
    release,
    environment: process.env.OPENWORK_DESKTOP_SENTRY_ENVIRONMENT?.trim() || (app.isPackaged ? "production" : "development"),
    sendDefaultPii: false,
    integrations: (defaultIntegrations) => defaultIntegrations.filter(
      (integration) => !["BrowserWindowSession", "ElectronMinidump", "MainProcessSession", "SentryMinidump"].includes(integration.name),
    ),
    tracesSampler: () => telemetryActive ? sampleRate : 0,
    beforeSend: (event) => telemetryActive && !suppressGpuAbnormalExit(event) ? event : null,
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
  return true;
}

export function clearOpenworkSentrySession() {
  telemetryActive = false;
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
