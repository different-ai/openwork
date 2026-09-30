import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type { Event } from "@sentry/node"
import type { MiddlewareHandler } from "hono"
import { z } from "zod"
import type { AppLogger } from "./logger.js"

export const SCIM_DIAGNOSTIC_OP = "scim.diagnostic"
export const SCIM_DIAGNOSTIC_MESSAGE = "SCIM diagnostic request completed"
const orgIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const expirySchema = z.iso.datetime({ offset: true }).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u)

type DebugEnv = Readonly<Record<string, string | undefined>>
type DiagnosticFields = {
  "organization.id": string
  http_method: string
  scim_operation: string
  api_request_id?: string
  proxy_request_id?: string
  http_status_code?: number
  duration_ms?: number
  better_auth_ms?: number
  den_mirror_ms?: number
  scim_outcome?: string
}
type DiagnosticContext = { organizationId: string; fields: DiagnosticFields }
const diagnosticContext = new AsyncLocalStorage<DiagnosticContext>()

// Re-read on admission AND sampling. Invalid configuration disables only this
// opt-in feature; it must never prevent authentication or API startup.
export function readScimDebugOrgIds(env: DebugEnv = process.env, now = Date.now()): string[] {
  if ((env.SENTRY_DEBUG_ORG_IDS?.length ?? 0) > 12_900) return []
  const ids = env.SENTRY_DEBUG_ORG_IDS?.split(",").map((id) => id.trim()) ?? []
  const expiry = env.SENTRY_DEBUG_ORGS_EXPIRES_AT
  if (!ids.length || ids.length > 100 || ids.some((id) => !orgIdPattern.test(id))
    || !expiry || !expirySchema.safeParse(expiry).success
    || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= now) {
    return []
  }
  return ids
}

export function sampleScimDiagnosticTrace(context: {
  attributes?: Readonly<Record<string, unknown>>
  parentSampled?: boolean
}, baseline: number): number {
  if (context.attributes?.["sentry.op"] === SCIM_DIAGNOSTIC_OP) {
    const verified = diagnosticContext.getStore()
    return verified
      && context.attributes["organization.id"] === verified.organizationId
      && readScimDebugOrgIds().includes(verified.organizationId) ? 1 : 0
  }
  // Match the original tracesSampleRate precedence. SDK 10.64's
  // inheritOrSampleWith instead prioritizes DSC rates over parent decisions.
  return context.parentSampled === undefined ? baseline : Number(context.parentSampled)
}

function correlationFields(request: Request, requestId: unknown) {
  const reference = request.headers.get("x-request-id")
  return {
    api_request_id: typeof requestId === "string" && /^req_[0-9a-hjkmnp-tv-z]{26}$/u.test(requestId)
      ? requestId : undefined,
    // A proxy reference is client-controlled correlation, NEVER authority. Even
    // syntactically valid arbitrary text is hashed rather than exported verbatim.
    proxy_request_id: reference && /^[A-Za-z0-9_-]{1,128}$/u.test(reference)
      ? `sha256:${createHash("sha256").update(reference).digest("hex")}` : undefined,
  }
}

function requestOperation(request: Request) {
  const match = /^\/api\/auth\/scim\/v2\/(Users|Groups)(\/[^/]+)?$/u.exec(new URL(request.url).pathname)
  if (!match) return null
  const operation = request.method === "GET" ? (match[2] ? "get" : "list")
    : request.method === "POST" ? "create"
      : request.method === "PUT" ? "replace"
        : request.method === "PATCH" ? "patch"
          : request.method === "DELETE" ? "delete" : null
  return operation ? `${match[1]}.${operation}` : null
}

// Existing logger calls inside the diagnostic boundary must not leak error
// messages or SQL via innocently named fields. Only our constructed fields pass.
export function currentScimDiagnosticFields() {
  const current = diagnosticContext.getStore()
  return current ? { ...current.fields } : undefined
}

export function timeScimDiagnosticStage<T>(
  stage: "better_auth_ms" | "den_mirror_ms",
  run: () => Promise<T>,
): Promise<T> {
  const current = diagnosticContext.getStore()
  if (!current || !readScimDebugOrgIds().includes(current.organizationId)) return run()
  const startedAt = performance.now()
  return (async () => {
    try {
      return await run()
    } finally {
      if (readScimDebugOrgIds().includes(current.organizationId)) {
        current.fields[stage] = Math.round(((current.fields[stage] ?? 0) + performance.now() - startedAt) * 100) / 100
      }
    }
  })()
}

export function sanitizeScimDiagnosticLog<L extends { message: string; attributes?: Readonly<Record<string, unknown>> }>(
  log: L,
  hasScopeAttributes: boolean,
): L | null {
  const current = diagnosticContext.getStore()
  if (!current) return log
  // SDK v10 merges scope attributes AFTER beforeSendLog. Even their names can
  // contain PII, so fail closed instead of trying to redact only their values.
  if (hasScopeAttributes || !readScimDebugOrgIds().includes(current.organizationId)) return null
  log.message = log.message === SCIM_DIAGNOSTIC_MESSAGE ? log.message : "SCIM diagnostic request activity"
  log.attributes = { ...current.fields }
  return log
}

export function sanitizeScimDiagnosticEvent<E extends Event>(event: E): E | null {
  const trace = event.contexts?.trace
  if (trace?.op !== SCIM_DIAGNOSTIC_OP) return event
  const data = trace.data
  const organizationId = data?.["organization.id"]
  if (event.type !== "transaction" || typeof organizationId !== "string"
    || !readScimDebugOrgIds().includes(organizationId)) return null

  const fields: Record<string, string | number> = { "organization.id": organizationId }
  const method = data?.http_method
  const operation = data?.scim_operation
  if (typeof method === "string" && /^(GET|POST|PUT|PATCH|DELETE)$/u.test(method)) fields.http_method = method
  if (typeof operation === "string" && /^(Users|Groups)\.(list|get|create|replace|patch|delete)$/u.test(operation)) fields.scim_operation = operation
  const requestId = data?.api_request_id
  if (typeof requestId === "string" && /^req_[0-9a-hjkmnp-tv-z]{26}$/u.test(requestId)) fields.api_request_id = requestId
  const reference = data?.proxy_request_id
  if (typeof reference === "string" && /^sha256:[a-f0-9]{64}$/u.test(reference)) fields.proxy_request_id = reference
  const status = data?.http_status_code
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) fields.http_status_code = status
  for (const key of ["duration_ms", "better_auth_ms", "den_mirror_ms"]) {
    const duration = data?.[key]
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) fields[key] = duration
  }
  const outcome = data?.scim_outcome
  if (typeof outcome === "string" && /^(success|conflict|rejected|server_error|exception)$/u.test(outcome)) fields.scim_outcome = outcome

  // Rebuild, rather than blacklist: this also discards future SDK fields,
  // inherited request data, breadcrumbs, SQL child spans, and dynamic baggage.
  const safe: Event = {
    type: "transaction",
    event_id: event.event_id,
    start_timestamp: event.start_timestamp,
    timestamp: event.timestamp,
    transaction: "SCIM diagnostic",
    contexts: { trace: {
      trace_id: trace.trace_id,
      span_id: trace.span_id,
      op: SCIM_DIAGNOSTIC_OP,
      data: fields,
    } },
    spans: [],
  }
  for (const key of Object.keys(event)) Reflect.deleteProperty(event, key)
  Object.assign(event, safe)
  return event
}

export function createScimDiagnosticsMiddleware(input: {
  resolveProvider: (token: string) => Promise<{ organizationId: string | null } | null>
  logger: AppLogger
}): MiddlewareHandler {
  return async (c, next) => {
    const operation = requestOperation(c.req.raw)
    if (!operation || !readScimDebugOrgIds().length) return next()
    const token = /^Bearer\s+(.+)$/iu.exec(c.req.header("authorization")?.trim() ?? "")?.[1]?.trim()
    if (!token) return next()

    // This is an observability probe, not a replacement auth gate. On lookup
    // failure or invalid tokens, let the original handler decide the response.
    const provider = await input.resolveProvider(token).catch(() => null)
    if (!provider?.organizationId || !readScimDebugOrgIds().includes(provider.organizationId)) return next()
    const organizationId = provider.organizationId

    const fields: DiagnosticFields = {
      "organization.id": organizationId,
      http_method: c.req.method,
      scim_operation: operation,
      ...correlationFields(c.req.raw, c.get("requestId")),
    }
    const Sentry = await import("@sentry/node").catch(() => null)
    if (!Sentry) return next()
    return diagnosticContext.run({ organizationId, fields }, () =>
      Sentry.withIsolationScope((isolationScope) => {
        isolationScope.clear()
        return Sentry.withScope((scope) => {
          scope.clear()
          scope.addEventProcessor((event, hint) => {
            hint.attachments = []
            // Completion logs carry safe outcomes. Do not export raw exceptions
            // captured by dependencies within this separate diagnostic trace.
            return event.contexts?.trace?.op === SCIM_DIAGNOSTIC_OP
              ? sanitizeScimDiagnosticEvent(event) : null
          })
          return Sentry.startNewTrace(() => Sentry.startSpan({
            name: "SCIM diagnostic",
            op: SCIM_DIAGNOSTIC_OP,
            attributes: { ...fields },
          }, async (span) => {
            const startedAt = performance.now()
            try {
              await next()
              fields.http_status_code = c.res.status
              fields.scim_outcome = c.res.status === 409 ? "conflict"
                : c.res.status >= 500 ? "server_error"
                  : c.res.status >= 400 ? "rejected" : "success"
            } catch (error) {
              fields.scim_outcome = "exception"
              throw error
            } finally {
              fields.duration_ms = Math.round((performance.now() - startedAt) * 100) / 100
              span.setAttributes(fields)
              if (readScimDebugOrgIds().includes(organizationId)) {
                // No response cloning: do not consume, buffer, or delay streams.
                // Status alone cannot identify a conflict's underlying cause.
                try { input.logger.warn(SCIM_DIAGNOSTIC_MESSAGE, fields) } catch { /* Telemetry cannot change a SCIM response. */ }
              }
            }
          }))
        })
      }),
    )
  }
}
