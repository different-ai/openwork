export type ErrorReportingConfig = {
  dsn: string
  environment?: string
  release?: string
  runnerVersion?: string
}

export type ParsedDsn = { envelopeUrl: string; publicKey: string }

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
  code: string
  kind?: string
  level?: "error" | "warning"
  tags?: Record<string, string | number | boolean | null | undefined>
  error?: unknown
}

export type ErrorReporter = {
  readonly enabled: boolean
  report: (report: ErrorReport) => Promise<void>
}

export type ErrorReporterDeps = { fetch?: typeof fetch; timeoutMs?: number; now?: () => number }

const SDK = { name: "openwork.headless-runner", version: "1.0.0" }
const DEFAULT_TIMEOUT_MS = 3_000
const MAX_TAG_LENGTH = 200
const MAX_STACK_LINES = 30
const CODE_LIKE = /^[A-Za-z0-9_.:-]{1,120}$/
const TAG_KEY = /^[A-Za-z0-9_.:-]{1,32}$/

const disabled: ErrorReporter = { enabled: false, report: async () => undefined }

export const safeMessage = (value: string) => (CODE_LIKE.test(value) ? value : "[redacted]")

function exceptionOf(error: unknown) {
  if (!(error instanceof Error)) return null
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined
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

export function buildEnvelope(event: ReturnType<typeof buildEvent>, dsn: string, sentAt: string) {
  const payload = JSON.stringify(event)
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: sentAt, dsn, sdk: SDK }),
    JSON.stringify({ type: "event", content_type: "application/json", length: new TextEncoder().encode(payload).length }),
    payload,
  ].join("\n")
}

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
      }
    },
  }
}
