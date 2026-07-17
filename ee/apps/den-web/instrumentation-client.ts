import * as Sentry from "@sentry/nextjs";

import { parseBrowserObservabilityEnv } from "./observability/browser-config";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
  scrubText,
  scrubUnknownRecord,
} from "./observability/scrub";

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
