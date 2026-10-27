import type { ErrorEvent } from "@sentry/node"
import type { Config } from "./config.js"

/**
 * Opt-in error reports to Sentry. Nothing loads or is sent unless WORKBOT_SENTRY_DSN is set, so a self-hosted
 * Workbot never reports anywhere it wasn't told to. Reports carry a stable `errorCode` tag and never a message,
 * prompt, file, token, cookie or request body: `scrubEvent` drops anything that could hold them.
 */
export type WorkbotErrorCode =
  /** A route threw: the person got 500 `internal_error`. */
  | "route_error"
  /** Den's sign-in couldn't be discovered when starting to sign in. */
  | "sign_in_unavailable"
  /** Den's callback came back, but exchanging its code or reading who signed in failed. */
  | "sign_in_failed"
  /** Refreshing a signed-in person's Den tokens failed for a reason other than Den signing them out. */
  | "token_refresh_failed"
  /** Den couldn't say who someone is: the page got 503 `den_unavailable`. */
  | "den_unavailable"
  /** The runner couldn't be reached, or didn't answer in time. */
  | "runner_unreachable"
  /** The runner answered with a 5xx. */
  | "runner_http_5xx"
  /** Relaying the runner's live events to the page broke mid-stream. */
  | "events_relay_failed"

export type ErrorTags = Record<string, string | number | boolean | undefined>

type Reporter = { capture: (code: WorkbotErrorCode, error: unknown, tags: ErrorTags) => void; close: () => Promise<void> }
let reporter: Reporter | null = null

/** Our own codes (`den_token_500`, `signed_out`, `ECONNREFUSED`) pass; any other text could hold content. */
const CODE_LIKE = /^[A-Za-z0-9_.:-]{1,120}$/
export const safeMessage = (value: string) => (CODE_LIKE.test(value) ? value : "[redacted]")

const MAX_TAG_LENGTH = 200
/** Integrations that record requests, outgoing calls, console lines, source, variables or sessions. */
const LEFT_OUT_INTEGRATIONS = new Set(["Http", "NodeFetch", "Console", "ContextLines", "RequestData", "LocalVariables", "LocalVariablesAsync", "ProcessSession"])

/**
 * Keeps what helps find a fault (error types, stack frames, our tags, the route) and drops what could identify a
 * person or hold what they wrote: request bodies, headers, cookies and query strings, users, breadcrumbs, extra
 * data, source lines and variables, and any error message that isn't a plain code.
 */
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
  // Crashes Sentry catches by itself (uncaught exceptions) still get a code to alert on.
  tags.errorCode ??= "unhandled"
  event.tags = tags
  return event
}

/** Starts reporting when a DSN is configured; without one, Sentry is never loaded. */
export async function initErrorReporting(config: Config["errorReporting"]) {
  if (!config || reporter) return
  const Sentry = await import("@sentry/node")
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    // Errors only: no tracing, no logs, and none of the integrations that record requests or outgoing calls.
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
        // One issue per code (and, for thrown errors, per place it was thrown).
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

/** Reports one failure under a stable code; a no-op without a DSN, and never throws. */
export function reportError(code: WorkbotErrorCode, error?: unknown, tags: ErrorTags = {}) {
  try {
    reporter?.capture(code, error, tags)
  } catch {
    // Reporting must never break the request it describes.
  }
}

/** Sends what is queued before the process exits. */
export async function closeErrorReporting() {
  await reporter?.close().catch(() => undefined)
}

/** A runner path with its ids taken out (`/v1/sessions/:id/turns`), safe to group and alert on. */
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

/**
 * `fetch` for calls to the runner that reports it unreachable (network errors and timeouts, not requests Workbot
 * cancelled itself) or answering 5xx. Answers and errors pass through unchanged.
 */
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
