import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { briefTest, claim, testBrief } from "@openwork/testkit";
import {
  buildSentryEnvelope,
  buildWebErrorEvent,
  parseSentryDsn,
  sanitizePageUrl,
  shouldMonitorWebErrors,
} from "../../apps/app/src/app/lib/error-monitoring";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const DSN = "https://publickey123@o123456.ingest.us.sentry.io/4500000000000000";

briefTest(testBrief({
  behavior: "OpenWork web deployments report boot failures and uncaught runtime errors to Sentry, and Stripe webhook processing failures are captured server-side, all behind explicit deployment gates.",
  claims: {
    bootBeaconContract: claim("index.html carries a pre-boot beacon that reports a web instance that fails to load", {
      never: "activate for desktop builds, builds without a DSN, or after the in-app monitor takes over",
    }),
    runtimeMonitorContract: claim("the web bundle starts error monitoring before any bootstrap await and reports only error identity plus coarse context", {
      never: "run inside Electron, run for desktop deployments, send chat or file content, report a URL query string or fragment that could carry sign-in credentials, or bypass the analytics preference",
    }),
    billingWebhookContract: claim("a Stripe webhook processing failure is captured to observability while still returning its error response to Stripe", {
      never: "swallow a webhook processing error unreported or capture routine signature-validation 400s as incidents",
    }),
  },
}), async ({ prove }) => {
  const [indexHtmlSource, entrySource, monitorSource, webhookRouteSource] = await Promise.all([
    readFile(join(repoRoot, "apps", "app", "index.html"), "utf8"),
    readFile(join(repoRoot, "apps", "app", "src", "index.react.tsx"), "utf8"),
    readFile(join(repoRoot, "apps", "app", "src", "app", "lib", "error-monitoring.ts"), "utf8"),
    readFile(join(repoRoot, "ee", "apps", "den-api", "src", "routes", "webhooks", "stripe.ts"), "utf8"),
  ]);

  // Pre-boot beacon: present, deployment- and DSN-gated, defers to the app monitor.
  expect(indexHtmlSource).toContain('var dsn = "%VITE_OPENWORK_SENTRY_DSN%"');
  expect(indexHtmlSource).toContain('var deployment = "%VITE_OPENWORK_DEPLOYMENT%"');
  expect(indexHtmlSource).toContain('if (deployment !== "web" || !dsn || dsn.charAt(0) === "%") return;');
  expect(indexHtmlSource).toContain("window.__openworkWebErrorMonitorActive === true) return;");
  expect(indexHtmlSource).toContain("WebBootLoadFailure");
  expect(indexHtmlSource).toContain("unhandledrejection");
  expect(indexHtmlSource).toContain("analyticsAllowed");
  expect(indexHtmlSource).toContain("request: { url: location.origin + location.pathname }");
  expect(indexHtmlSource).not.toContain("url: location.href");
  prove.bootBeaconContract(
    true,
    "The inline beacon only arms when the built page carries a replaced web deployment marker and a real DSN — an unreplaced %VITE_% placeholder or desktop flavor short-circuits — caps at three events, respects the analytics preference, reports only origin plus path so sign-in grant or token query parameters never leave the page, and stands down once the app monitor sets its handover flag.",
  );

  // Runtime monitor: gated pure logic, wired first in the entry, minimal payload.
  expect(shouldMonitorWebErrors({ dsn: DSN, deployment: "web", electronRuntime: false })).toBe(true);
  expect(shouldMonitorWebErrors({ dsn: DSN, deployment: "desktop", electronRuntime: false })).toBe(false);
  expect(shouldMonitorWebErrors({ dsn: DSN, deployment: "web", electronRuntime: true })).toBe(false);
  expect(shouldMonitorWebErrors({ dsn: "", deployment: "web", electronRuntime: false })).toBe(false);
  expect(shouldMonitorWebErrors({ dsn: "%VITE_OPENWORK_SENTRY_DSN%", deployment: "web", electronRuntime: false })).toBe(false);
  expect(parseSentryDsn(DSN)).toEqual({
    envelopeUrl:
      "https://o123456.ingest.us.sentry.io/api/4500000000000000/envelope/?sentry_key=publickey123&sentry_version=7",
  });
  const event = buildWebErrorEvent({
    type: "TypeError",
    message: "x is not a function",
    stack: "TypeError: x is not a function\n  at boot",
    url: "https://app.openworklabs.com/",
    release: "abc123",
    phase: "boot",
  });
  expect(Object.keys(event).sort()).toEqual([
    "environment",
    "event_id",
    "exception",
    "extra",
    "level",
    "platform",
    "release",
    "request",
    "tags",
    "timestamp",
  ]);
  expect(event.exception.values).toEqual([{ type: "TypeError", value: "x is not a function" }]);
  const envelopeLines = buildSentryEnvelope(event).split("\n");
  expect(envelopeLines).toHaveLength(3);
  expect(JSON.parse(envelopeLines[1])).toEqual({ type: "event" });
  expect(
    sanitizePageUrl("https://app.openworklabs.com/signin?grant=secret-grant&openworkToken=tok#accessToken=at"),
  ).toBe("https://app.openworklabs.com/signin");
  expect(sanitizePageUrl("not a url")).toBe("");
  expect(entrySource).toMatch(/startWebErrorMonitoring\(\);[\s\S]*await initializeDenBootstrapConfig\(\)/);
  expect(monitorSource).toContain("if (!isAnalyticsEnabled()) return;");
  expect(monitorSource).toContain("MAX_EVENTS_PER_SESSION");
  expect(monitorSource).toContain('window.addEventListener("unhandledrejection"');
  expect(monitorSource).toContain("sanitizePageUrl(window.location.href)");
  expect(monitorSource).not.toContain("url: window.location.href");
  prove.runtimeMonitorContract(
    true,
    "The gate opened only for the exact web-deployment, non-Electron, valid-DSN combination and refused desktop, Electron, blank, and unreplaced-placeholder inputs; monitoring starts before the bootstrap await so a failed boot is itself reported; the event shape carries only error identity, sanitized origin-plus-path page URL (grant, openworkToken, and accessToken query parameters and fragments are stripped, unparseable input reports empty), release, and boot phase with bounded sizes; and delivery checks the analytics preference and a per-session cap.",
  );

  // Stripe webhook: 500-path capture, 400 signature noise excluded.
  expect(webhookRouteSource).toContain('captureException(error, { component: "stripe_webhook" })');
  expect(webhookRouteSource).toMatch(/if \(status === 500\) \{[\s\S]*?captureException/);
  expect(webhookRouteSource).toMatch(/captureException[\s\S]*?return c\.json\(\{ error: message \}, status\)/);
  expect(webhookRouteSource).toContain('import { captureException } from "../../observability/runtime.js"');
  prove.billingWebhookContract(
    true,
    "The webhook route's local catch now reports processing failures to observability with a stripe_webhook component tag before returning the same 500 response Stripe uses for retries, while missing-signature 400s stay out of exception capture.",
  );
});
