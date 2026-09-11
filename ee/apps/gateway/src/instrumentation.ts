import "./load-env.js"
import { init } from "@sentry/hono/node"
import { httpIntegration } from "@sentry/node"

const dsn = process.env.SENTRY_DSN?.trim()
const defaultTracesSampleRate = 0.01

type SentryStructuredLogLevel = "debug" | "info" | "warn" | "error"
type SentryLogLevel = SentryStructuredLogLevel | "off"

const logLevelPriority: Record<SentryStructuredLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export const isSentryEnabled = Boolean(dsn)

export function parseUnitIntervalEnv(value: string | undefined, envKey: string, fallback: number) {
  const trimmed = value?.trim()
  if (!trimmed) {
    return fallback
  }

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${envKey} must be a number from 0 through 1`)
  }
  return parsed
}

export function parseSentryLogLevel(value: string | undefined): SentryLogLevel {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return "warn"
  }

  switch (normalized) {
    case "debug":
    case "info":
    case "warn":
    case "error":
    case "off":
      return normalized
    default:
      throw new Error("SENTRY_LOG_LEVEL must be one of debug, info, warn, error, off")
  }
}

export const sentryTracesSampleRate = parseUnitIntervalEnv(
  process.env.SENTRY_TRACES_SAMPLE_RATE,
  "SENTRY_TRACES_SAMPLE_RATE",
  defaultTracesSampleRate,
)
export const sentryLogLevel = parseSentryLogLevel(process.env.SENTRY_LOG_LEVEL)

export function shouldEmitSentryLog(level: SentryStructuredLogLevel) {
  if (sentryLogLevel === "off") {
    return false
  }
  return logLevelPriority[level] >= logLevelPriority[sentryLogLevel]
}

function healthPath(urlPath: string) {
  const path = urlPath.split(/[?#]/u, 1)[0]
  return path === "/health" || path === "/ready"
}

if (dsn) {
  init({
    dsn,
    tracesSampleRate: sentryTracesSampleRate,
    enableLogs: sentryLogLevel !== "off",
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
    integrations(defaults) {
      return [
        ...defaults.filter((integration) => integration.name !== "Http"),
        httpIntegration({
          ignoreIncomingRequests: (urlPath) => healthPath(urlPath),
          maxIncomingRequestBodySize: "none",
          ignoreIncomingRequestBody: () => true,
        }),
      ]
    },
  })
}
