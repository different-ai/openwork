import type { ObservabilityEnv } from "@openwork-ee/utils/observability";
import type { JsonObject, StructuredLogLevel } from "@openwork-ee/utils/observability";
import type * as SentryModule from "@sentry/nextjs";

import { getDenWebObservabilityConfig } from "./server-config";
import { setStructuredLogSink } from "./runtime-logger";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
  scrubText,
  scrubUnknownRecord,
} from "./scrub";

type DisabledSentryDataCollection = {
  userInfo: false;
  genAI: { inputs: false; outputs: false };
  httpBodies: [];
  httpHeaders: { request: false; response: false };
  cookies: false;
  queryParams: false;
  stackFrameVariables: false;
  frameContextLines: 0;
};

const disabledDataCollection: DisabledSentryDataCollection = {
  userInfo: false,
  genAI: { inputs: false, outputs: false },
  httpBodies: [],
  httpHeaders: { request: false, response: false },
  cookies: false,
  queryParams: false,
  stackFrameVariables: false,
  frameContextLines: 0,
};

type SentrySdk = typeof SentryModule;

function logToSentry(
  sentry: SentrySdk,
  level: StructuredLogLevel,
  message: string,
  fields?: JsonObject,
): void {
  switch (level) {
    case "debug":
      sentry.logger.debug(message, fields);
      return;
    case "info":
      sentry.logger.info(message, fields);
      return;
    case "warn":
      sentry.logger.warn(message, fields);
      return;
    case "error":
      sentry.logger.error(message, fields);
      return;
  }
}

export function initSentryRuntime(sentry: SentrySdk, env: ObservabilityEnv = process.env): void {
  const config = getDenWebObservabilityConfig(env);
  if (config.backend !== "sentry") return;

  sentry.init({
    dsn: config.sentry.dsn,
    tracesSampleRate: config.sentry.tracesSampleRate,
    enableLogs: true,
    sendDefaultPii: false,
    dataCollection: disabledDataCollection,
    environment: config.sentryBuild.values.SENTRY_ENVIRONMENT,
    release: config.sentryBuild.values.SENTRY_RELEASE,
    dist: config.sentryBuild.values.SENTRY_DIST,
    sendClientReports: false,
    attachStacktrace: false,
    includeLocalVariables: false,
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

  sentry.setAttributes?.({ service: config.serviceName });
  setStructuredLogSink({
    log: (level, message, fields) => logToSentry(sentry, level, message, fields),
  });
}
