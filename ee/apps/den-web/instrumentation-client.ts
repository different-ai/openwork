import * as Sentry from "@sentry/nextjs";
import posthog from "posthog-js";
import { beforeSendPosthog } from "./posthog-privacy";

import { parseBrowserObservabilityEnv } from "./observability/browser-config";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
  scrubText,
  scrubUnknownRecord,
} from "./observability/scrub";

// Official Next.js integration: initialize the bundled SDK before hydration.
// next.config.js exposes a token only for eligible hosted production builds.
const posthogToken = process.env.NEXT_PUBLIC_POSTHOG_KEY;
if (process.env.NODE_ENV === "production" && posthogToken && typeof window !== "undefined"
  && window.location.origin === "https://app.openworklabs.com" && !window.posthog) {
  try {
    posthog.init(posthogToken, {
      api_host: "/ow",
      ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST === "https://eu.i.posthog.com"
        ? "https://eu.posthog.com" : "https://us.posthog.com",
      defaults: "2026-05-30",
      persistence: "localStorage",
      cross_subdomain_cookie: false,
      person_profiles: "identified_only",
      capture_pageview: "history_change",
      capture_pageleave: false,
      autocapture: false,
      rageclick: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_flags: true,
      save_referrer: false,
      save_campaign_params: false,
      before_send: beforeSendPosthog,
    });
    // Compatibility for existing analytics call sites; no auth helpers change.
    window.posthog = posthog;
  } catch {
    // Optional analytics initialization must not prevent application startup.
  }
}

const config = parseBrowserObservabilityEnv({
  backend: process.env.NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND,
  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sentryTracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
});

if (config.backend === "sentry") {
  Sentry.init({
    dsn: config.dsn,
    tracesSampleRate: config.tracesSampleRate,
    enableLogs: true,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      genAI: { inputs: false, outputs: false },
      httpBodies: [],
      httpHeaders: { request: false, response: false },
      cookies: false,
      queryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    sendClientReports: false,
    attachStacktrace: false,
    enableMetrics: false,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
    beforeSendSpan: scrubSentrySpan,
    beforeSendLog: (log) => ({
      ...log,
      message: scrubText(log.message),
      attributes: scrubUnknownRecord(log.attributes),
    }),
    enhanceFetchErrorMessages: false,
    propagateTraceparent: true,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    profileSessionSampleRate: 0,
    profilesSampleRate: 0,
    maxBreadcrumbs: 50,
  });
}

export const onRouterTransitionStart = config.backend === "sentry"
  ? Sentry.captureRouterTransitionStart
  : () => {};
