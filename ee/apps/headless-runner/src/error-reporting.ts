/**
 * Opt-in error reports to Sentry that run on both hosts (Node and celld cells, where Sentry's Node SDK can't run):
 * each report is one event in one envelope, posted with `fetch` to the DSN's project. Nothing is sent without
 * HEADLESS_SENTRY_DSN, so self-hosted runners never report anywhere they weren't told to.
 *
 * Reports carry stable codes, ids and counts only: never prompts, messages, tool inputs or outputs, tokens or
 * credentials. Sending is fire-and-forget with a short timeout; it never throws and drops the report on failure.
 */

export type ErrorReportingConfig = {
  dsn: string
  environment?: string
  release?: string
  /** HEADLESS_RUNNER_VERSION, tagged on every report. */
  runnerVersion?: string
}

export type ParsedDsn = { envelopeUrl: string; publicKey: string }

/** `https://<key>@<host>[/<path>]/<project>` to the project's envelope endpoint, or null if it isn't a DSN. */
export function parseDsn(dsn: string): ParsedDsn | null {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  const segments = url.pathname.split("/").filter(Boolean)
  const project = segments.pop()
  if (!url.username || !project || !/^\d+$/.test(project)) return null
  const prefix = segments.length ? `/${segments.join("/")}` : ""
  return { envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`, publicKey: decodeURIComponent(url.username) }
}

export type ErrorReport = {
  /** The stable code: a turn's error (`model_http_429`, `mcp_unavailable`, `turn_timeout`) or `request_failed`. */
  code: string
  /** Groups reports into issues; defaults to the code. */
  kind?: string
  level?: "error" | "warning"
  /** Ids, codes and counts only. */
  tags?: Record<string, string | number | boolean | null | undefined>
  /** Contributes its type, Node error code and stack frames; its message only when it is a plain code. */
  error?: unknown
}

export type ErrorReporter = {
  readonly enabled: boolean
  /** Resolves once sent or dropped; never rejects. Callers may leave it running. */
  report: (report: ErrorReport) => Promise<void>
}

export type ErrorReporterDeps = { fetch?: typeof fetch; timeoutMs?: number; now?: () => number }

const SDK = { name: "openwork.headless-runner", version: "1.0.0" }
const DEFAULT_TIMEOUT_MS = 3_000
const MAX_TAG_LENGTH = 200
const MAX_STACK_LINES = 30
/** Our own codes pass (`runner_error`, `ERR_SQLITE_ERROR`); any other text could hold content. */
const CODE_LIKE = /^[A-Za-z0-9_.:-]{1,120}$/
const TAG_KEY = /^[A-Za-z0-9_.:-]{1,32}$/

const disabled: ErrorReporter = { enabled: false, report: async () => undefined }

export const safeMessage = (value: string) => (CODE_LIKE.test(value) ? value : "[redacted]")

function exceptionOf(error: unknown) {
  if (!(error instanceof Error)) return null
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined
  // Only the "at ..." lines: the first line of a stack repeats the message.
  const stack = (error.stack ?? "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_STACK_LINES)
    .map((line) => line.trim())
  return {
    type: CODE_LIKE.test(error.name) ? error.name : "Error",
    value: safeMessage(error.message),
    ...(code && CODE_LIKE.test(code) ? { errorCode: code } : {}),
    stack,
  }
}

function tagsOf(report: ErrorReport, config: ErrorReportingConfig) {
  const tags: Record<string, string> = {}
  for (const [key, value] of Object.entries(report.tags ?? {})) {
    if (value === undefined || value === null || !TAG_KEY.test(key)) continue
    tags[key] = String(value).slice(0, MAX_TAG_LENGTH)
  }
  tags.errorCode = report.code.slice(0, MAX_TAG_LENGTH)
  if (config.runnerVersion) tags.runnerVersion = config.runnerVersion.slice(0, MAX_TAG_LENGTH)
  return tags
}

/** The Sentry event for one report. Exported for tests. */
export function buildEvent(report: ErrorReport, config: ErrorReportingConfig, eventId: string, nowMs: number) {
  const exception = exceptionOf(report.error)
  const kind = report.kind ?? report.code
  return {
    event_id: eventId,
    timestamp: nowMs / 1000,
    platform: "javascript",
    level: report.level ?? "error",
    logger: "headless-runner",
    ...(config.environment ? { environment: config.environment } : {}),
    ...(config.release ? { release: config.release } : {}),
    message: { formatted: `${kind}: ${report.code}` },
    tags: tagsOf(report, config),
    fingerprint: [kind, report.code],
    ...(exception
      ? {
          exception: { values: [{ type: exception.type, value: exception.value, mechanism: { type: "generic", handled: true } }] },
          extra: { ...(exception.errorCode ? { errorCode: exception.errorCode } : {}), ...(exception.stack.length ? { stack: exception.stack } : {}) },
        }
      : {}),
    sdk: SDK,
  }
}

/** One event in one envelope: header, item header, event. Exported for tests. */
export function buildEnvelope(event: ReturnType<typeof buildEvent>, dsn: string, sentAt: string) {
  const payload = JSON.stringify(event)
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: sentAt, dsn, sdk: SDK }),
    JSON.stringify({ type: "event", content_type: "application/json", length: new TextEncoder().encode(payload).length }),
    payload,
  ].join("\n")
}

/** A reporter for the config; without a (valid) DSN, one that sends nothing. */
export function createErrorReporter(config: ErrorReportingConfig | undefined, deps: ErrorReporterDeps = {}): ErrorReporter {
  const target = config ? parseDsn(config.dsn) : null
  if (!config || !target) return disabled
  const send = deps.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const auth = `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=${SDK.name}/${SDK.version}`
  return {
    enabled: true,
    report: async (report) => {
      try {
        const at = now()
        const event = buildEvent(report, config, crypto.randomUUID().replaceAll("-", ""), at)
        const response = await send(target.envelopeUrl, {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": auth },
          body: buildEnvelope(event, config.dsn, new Date(at).toISOString()),
          signal: AbortSignal.timeout(timeoutMs),
        })
        await response.body?.cancel().catch(() => undefined)
      } catch {
        // Dropped: a report must never break or slow what it describes.
      }
    },
  }
}
