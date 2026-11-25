import type { ErrorEvent } from "@sentry/node"
import type { Config } from "./config.js"

export type WorkbotErrorCode =
  | "route_error"
  | "sign_in_unavailable"
  | "sign_in_failed"
  | "token_refresh_failed"
  | "den_unavailable"
  | "runner_unreachable"
  | "runner_http_5xx"
  | "events_relay_failed"

export type ErrorTags = Record<string, string | number | boolean | undefined>

type Reporter = { capture: (code: WorkbotErrorCode, error: unknown, tags: ErrorTags) => void; close: () => Promise<void> }
let reporter: Reporter | null = null

const CODE_LIKE = /^[A-Za-z0-9_.:-]{1,120}$/
export const safeMessage = (value: string) => (CODE_LIKE.test(value) ? value : "[redacted]")

const MAX_TAG_LENGTH = 200
const LEFT_OUT_INTEGRATIONS = new Set(["Http", "NodeFetch", "Console", "ContextLines", "RequestData", "LocalVariables", "LocalVariablesAsync", "ProcessSession"])

export function scrubEvent<Event extends ErrorEvent>(event: Event): Event {
  if (event.request) {
    let path: string | undefined
    try {
      path = event.request.url ? new URL(event.request.url, "http://workbot.invalid").pathname : undefined
    } catch {
      path = undefined
    }
    event.request = { method: event.request.method, ...(path ? { url: path } : {}) }
  }
  delete event.user
  delete event.breadcrumbs
  delete event.extra
  if (event.message) event.message = safeMessage(event.message)
  if (event.logentry) delete event.logentry
  for (const entry of event.exception?.values ?? []) {
    if (entry.value) entry.value = safeMessage(entry.value)
    for (const frame of entry.stacktrace?.frames ?? []) {
      delete frame.vars
      delete frame.context_line
      delete frame.pre_context
      delete frame.post_context
    }
  }
  const tags: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(event.tags ?? {})) {
    if (typeof value === "string") tags[key] = value.slice(0, MAX_TAG_LENGTH)
    else if (typeof value === "number" || typeof value === "boolean") tags[key] = value
  }
  tags.errorCode ??= "unhandled"
  event.tags = tags
  return event
}

export async function initErrorReporting(config: Config["errorReporting"]) {
  if (!config || reporter) return
  const Sentry = await import("@sentry/node")
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    defaultIntegrations: false,
    integrations: Sentry.getDefaultIntegrationsWithoutPerformance().filter((integration) => !LEFT_OUT_INTEGRATIONS.has(integration.name)),
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    attachStacktrace: false,
    maxValueLength: 2_000,
    normalizeDepth: 4,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: () => null,
  })
  reporter = {
    capture: (code, error, tags) => {
      Sentry.withScope((scope) => {
        scope.setTag("errorCode", code)
        for (const [key, value] of Object.entries(tags)) if (value !== undefined) scope.setTag(key, String(value).slice(0, MAX_TAG_LENGTH))
        scope.setFingerprint(["{{ default }}", code])
        if (error instanceof Error) Sentry.captureException(error)
        else Sentry.captureMessage(code, "error")
      })
    },
    close: async () => {
      await Sentry.close(2_000)
    },
  }
}

export function reportError(code: WorkbotErrorCode, error?: unknown, tags: ErrorTags = {}) {
  try {
    reporter?.capture(code, error, tags)
  } catch {
  }
}

export async function closeErrorReporting() {
  await reporter?.close().catch(() => undefined)
}

export function runnerRoute(url: string) {
  try {
    const { pathname } = new URL(url)
    return pathname
      .split("/")
      .map((segment) => (segment === "" || /^v\d+$/.test(segment) || /^[a-z-]+$/.test(segment) ? segment : ":id"))
      .join("/")
  } catch {
    return "unknown"
  }
}

const requestUrl = (input: Parameters<typeof fetch>[0]) => (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)

export function observedRunnerFetch(report: typeof reportError = reportError, base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET")
    const route = runnerRoute(requestUrl(input))
    try {
      const response = await base(input, init)
      if (response.status >= 500) report("runner_http_5xx", undefined, { status: response.status, method, route })
      return response
    } catch (error) {
      const signal = init?.signal
      const timedOut = signal?.aborted === true && signal.reason instanceof Error && signal.reason.name === "TimeoutError"
      if (!signal?.aborted || timedOut) report("runner_unreachable", error, { method, route, reason: timedOut ? "timeout" : "network" })
      throw error
    }
  }
}
