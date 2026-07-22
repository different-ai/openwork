import type { Context, Env, Hono, MiddlewareHandler } from "hono"
import type { JsonObject, ObservabilityBackend, ObservabilityConfig, StructuredLogLevel } from "@openwork-ee/utils/observability"
import { observabilityConfig } from "./config.js"
import { normalizedHonoRoute } from "./hono-route.js"
import { sanitizeExceptionForTelemetry, sanitizeFields, sanitizeText, stripUrlQuery } from "./safe-fields.js"

type RuntimeState = {
  initialized: boolean
  backend: ObservabilityBackend
  config: ObservabilityConfig
  honoMiddlewares: MiddlewareHandler[]
  honoMiddlewareFactory?: <E extends Env>(app: Hono<E>) => MiddlewareHandler<E>
  emitProviderLog?: (level: StructuredLogLevel, message: string, fields: JsonObject) => void
  getTraceContext?: () => JsonObject | undefined
  captureException?: (error: unknown, fields?: JsonObject) => void
  attachRequestContext?: (fields: JsonObject) => void
  shutdown?: () => Promise<void>
}

type SentryRequestEvent = {
  request?: {
    url?: string
    query_string?: unknown
    cookies?: unknown
    headers?: unknown
    data?: unknown
  }
}

type SentryBreadcrumbPayload = {
  message?: string
  data?: Readonly<Record<string, unknown>>
}

type SentryExceptionPayload = {
  values?: Array<{
    type?: string
    value?: string
    stacktrace?: {
      frames?: Array<{
        abs_path?: string
        filename?: string
        function?: string
        module?: string
        context_line?: string
        pre_context?: string[]
        post_context?: string[]
        vars?: Readonly<Record<string, unknown>>
      }>
    }
  }>
}

type SentryEventPayload = SentryRequestEvent & {
  message?: string
  transaction?: string
  exception?: SentryExceptionPayload
  breadcrumbs?: SentryBreadcrumbPayload[]
  contexts?: Readonly<Record<string, unknown>>
  extra?: Readonly<Record<string, unknown>>
  tags?: Readonly<Record<string, unknown>>
  user?: Readonly<Record<string, unknown>>
}

type SentrySpanPayload = {
  data?: Readonly<Record<string, unknown>>
  description?: string
}

type SentryLogPayload = {
  attributes?: Readonly<Record<string, unknown>>
  message?: string
  body?: unknown
}

type SentryScope = {
  setContext: (key: string, context: JsonObject) => void
  setTag: (key: string, value: string) => void
}

const TEXT_URL_PATTERN = /https?:\/\/[^\s)"'<>\]}]+/giu

declare global {
  var __denApiObservabilityRuntime: RuntimeState | undefined
}

function createInitialRuntimeState(): RuntimeState {
  return {
    initialized: false,
    backend: observabilityConfig.backend,
    config: observabilityConfig,
    honoMiddlewares: [],
  }
}

export function getRuntimeState(): RuntimeState {
  globalThis.__denApiObservabilityRuntime ??= createInitialRuntimeState()
  return globalThis.__denApiObservabilityRuntime
}

function signalConfig(signal: "traces" | "metrics" | "logs") {
  if (observabilityConfig.backend !== "otel") {
    return null
  }
  return observabilityConfig.otel.signals[signal]
}

function exporterOptions(endpoint: string | undefined) {
  return endpoint ? { url: endpoint } : undefined
}

function healthPath(path: string) {
  return path === "/health" || path === "/ready"
}

function stringField(fields: JsonObject, key: string) {
  const value = fields[key]
  return typeof value === "string" ? value : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function recordStringField(fields: Readonly<Record<string, unknown>> | undefined, key: string) {
  const value = fields?.[key]
  return typeof value === "string" ? value : undefined
}

function recordNumberField(fields: Readonly<Record<string, unknown>> | undefined, key: string) {
  const value = fields?.[key]
  return typeof value === "number" ? value : undefined
}

export function parseSentryTraceHeader(header: string | undefined): JsonObject | undefined {
  if (!header) {
    return undefined
  }

  const [traceId, spanId] = header.split("-")
  if (!traceId || !spanId) {
    return { sentry_trace: header }
  }

  return {
    trace_id: traceId,
    span_id: spanId,
    sentry_trace: header,
  }
}

function honoSpanName(c: Context) {
  return `${c.req.method} ${normalizedHonoRoute(c)}`
}

async function startOtel(state: RuntimeState) {
  if (observabilityConfig.backend !== "otel") {
    return
  }

  const [
    api,
    apiLogs,
    sdkNode,
    traceExporterModule,
    metricsExporterModule,
    logsExporterModule,
    sdkMetrics,
    sdkLogs,
    sdkTrace,
    honoOtel,
    semanticConventions,
  ] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/api-logs"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/exporter-metrics-otlp-proto"),
    import("@opentelemetry/exporter-logs-otlp-proto"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/sdk-trace-node"),
    import("@hono/otel"),
    import("@opentelemetry/semantic-conventions"),
  ])

  const traces = signalConfig("traces")
  const metrics = signalConfig("metrics")
  const logs = signalConfig("logs")
  const spanProcessors = traces?.exporter === "otlp"
    ? [new sdkTrace.BatchSpanProcessor(new traceExporterModule.OTLPTraceExporter(exporterOptions(traces.endpoint)))]
    : []
  const metricReaders = metrics?.exporter === "otlp"
    ? [new sdkMetrics.PeriodicExportingMetricReader({
        exporter: new metricsExporterModule.OTLPMetricExporter(exporterOptions(metrics.endpoint)),
      })]
    : []
  const logRecordProcessors = logs?.exporter === "otlp"
    ? [new sdkLogs.BatchLogRecordProcessor({
        exporter: new logsExporterModule.OTLPLogExporter(exporterOptions(logs.endpoint)),
      })]
    : []

  const sampler = (() => {
    switch (observabilityConfig.otel.sampler.name) {
      case "always_on":
        return new sdkTrace.AlwaysOnSampler()
      case "always_off":
        return new sdkTrace.AlwaysOffSampler()
      case "traceidratio":
        return new sdkTrace.TraceIdRatioBasedSampler(observabilityConfig.otel.sampler.ratio)
      case "parentbased_always_on":
        return new sdkTrace.ParentBasedSampler({ root: new sdkTrace.AlwaysOnSampler() })
      case "parentbased_always_off":
        return new sdkTrace.ParentBasedSampler({ root: new sdkTrace.AlwaysOffSampler() })
      case "parentbased_traceidratio":
        return new sdkTrace.ParentBasedSampler({
          root: new sdkTrace.TraceIdRatioBasedSampler(observabilityConfig.otel.sampler.ratio),
        })
    }
  })()

  const sdk = new sdkNode.NodeSDK({
    serviceName: observabilityConfig.serviceName,
    sampler,
    instrumentations: [],
    spanProcessors,
    metricReaders,
    logRecordProcessors,
  })
  sdk.start()

  const providerLogger = apiLogs.logs.getLogger(observabilityConfig.serviceName)

  const honoOtelMiddleware = honoOtel.httpInstrumentationMiddleware({
    captureRequestHeaders: [],
    captureResponseHeaders: [],
    serviceName: observabilityConfig.serviceName,
    spanNameFactory: honoSpanName,
  })
  state.honoMiddlewares.push(async (c, next) => {
    if (healthPath(c.req.path)) {
      await next()
      return
    }

    await honoOtelMiddleware(c, next)
  })
  state.honoMiddlewares.push(async (c, next) => {
    try {
      await next()
    } finally {
      const span = api.trace.getActiveSpan()
      if (span) {
        span.setAttribute(semanticConventions.ATTR_URL_FULL, stripUrlQuery(c.req.url))
      }
    }
  })
  state.emitProviderLog = (level, message, fields) => {
    const severityNumber = (() => {
      switch (level) {
        case "debug":
          return apiLogs.SeverityNumber.DEBUG
        case "info":
          return apiLogs.SeverityNumber.INFO
        case "warn":
          return apiLogs.SeverityNumber.WARN
        case "error":
          return apiLogs.SeverityNumber.ERROR
      }
    })()
    providerLogger.emit({
      body: message,
      severityNumber,
      severityText: level,
      attributes: fields,
      context: api.context.active(),
    })
  }
  state.getTraceContext = () => {
    const span = api.trace.getActiveSpan()
    if (!span) {
      return undefined
    }
    const context = span.spanContext()
    return {
      trace_id: context.traceId,
      span_id: context.spanId,
    }
  }
  state.captureException = (error) => {
    const span = api.trace.getActiveSpan()
    if (span) {
      const sanitized = sanitizeExceptionForTelemetry(error)
      span.recordException(sanitized)
      span.setStatus({ code: api.SpanStatusCode.ERROR })
    }
  }
  state.attachRequestContext = (fields) => {
    const span = api.trace.getActiveSpan()
    if (!span) {
      return
    }

    const requestId = stringField(fields, "request_id")
    const route = stringField(fields, "http_route")
    if (requestId) {
      span.setAttribute("request.id", requestId)
    }
    if (route) {
      span.setAttribute(semanticConventions.ATTR_HTTP_ROUTE, route)
    }
  }
  state.shutdown = () => sdk.shutdown()
}

function denApiContext(contexts: Readonly<Record<string, unknown>> | undefined) {
  const context = contexts?.den_api
  return isRecord(context) ? context : undefined
}

function denApiContextString(contexts: Readonly<Record<string, unknown>> | undefined, key: string) {
  return recordStringField(denApiContext(contexts), key)
}

function safeRoutePath(route: string | undefined) {
  if (!route) {
    return undefined
  }
  return route === "unmatched" || route === "/*" ? "/unmatched" : route
}

function sanitizedRequestUrl(value: string, route: string | undefined) {
  const safeUrl = stripUrlQuery(value)
  const routePath = safeRoutePath(route)
  if (!routePath) {
    return safeUrl
  }

  try {
    const url = new URL(safeUrl)
    url.pathname = routePath
    return url.toString()
  } catch {
    return routePath
  }
}

function isHttpMethod(value: string) {
  switch (value) {
    case "CONNECT":
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "PATCH":
    case "POST":
    case "PUT":
    case "TRACE":
      return true
    default:
      return false
  }
}

function httpMethodFromName(value: string) {
  const method = value.split(/\s+/u)[0]
  return method && isHttpMethod(method) ? method : undefined
}

function sanitizeNameWithRoute(value: string, route: string | undefined) {
  const method = httpMethodFromName(value)
  const routePath = safeRoutePath(route)
  if (method && routePath) {
    return `${method} ${routePath === "/unmatched" ? "unmatched" : routePath}`
  }
  return sanitizeText(value)
}

function sanitizeSentryText(value: string, route: string | undefined) {
  const safeText = sanitizeText(value)
  if (!safeRoutePath(route)) {
    return safeText
  }
  return safeText.replace(TEXT_URL_PATTERN, (match) => sanitizedRequestUrl(match, route))
}

function sanitizeSentryEventRequest(event: SentryRequestEvent, route: string | undefined) {
  if (event.request?.url) {
    event.request.url = sanitizedRequestUrl(event.request.url, route)
  }
  if (event.request) {
    delete event.request.query_string
    delete event.request.cookies
    delete event.request.headers
    delete event.request.data
  }
}

function sanitizeSentryException(exception: SentryExceptionPayload | undefined, route: string | undefined) {
  for (const entry of exception?.values ?? []) {
    if (entry.type) {
      entry.type = sanitizeSentryText(entry.type, route)
    }
    if (entry.value) {
      entry.value = sanitizeSentryText(entry.value, route)
    }
    for (const frame of entry.stacktrace?.frames ?? []) {
      if (frame.abs_path) {
        frame.abs_path = sanitizeText(frame.abs_path)
      }
      if (frame.filename) {
        frame.filename = sanitizeText(frame.filename)
      }
      if (frame.function) {
        frame.function = sanitizeText(frame.function)
      }
      if (frame.module) {
        frame.module = sanitizeText(frame.module)
      }
      delete frame.context_line
      delete frame.pre_context
      delete frame.post_context
      delete frame.vars
    }
  }
}

export function sanitizeSentryBreadcrumb<Breadcrumb extends SentryBreadcrumbPayload>(breadcrumb: Breadcrumb, route?: string): Breadcrumb {
  if (breadcrumb.message) {
    breadcrumb.message = sanitizeSentryText(breadcrumb.message, route)
  }
  breadcrumb.data = sanitizeFields(breadcrumb.data) ?? {}
  return breadcrumb
}

function sanitizeSentryBreadcrumbs(breadcrumbs: SentryBreadcrumbPayload[] | undefined, route: string | undefined) {
  for (const breadcrumb of breadcrumbs ?? []) {
    sanitizeSentryBreadcrumb(breadcrumb, route)
  }
}

export function sanitizeSentryEvent<Event extends SentryEventPayload>(event: Event): Event {
  const route = denApiContextString(event.contexts, "http_route")
  sanitizeSentryEventRequest(event, route)
  if (event.message) {
    event.message = sanitizeSentryText(event.message, route)
  }
  if (event.transaction) {
    event.transaction = sanitizeNameWithRoute(event.transaction, route)
  }
  sanitizeSentryException(event.exception, route)
  sanitizeSentryBreadcrumbs(event.breadcrumbs, route)
  event.contexts = sanitizeFields(event.contexts) ?? {}
  event.extra = sanitizeFields(event.extra) ?? {}
  event.tags = sanitizeFields(event.tags) ?? {}
  delete event.user
  return event
}

export function sanitizeSentrySpan<Span extends SentrySpanPayload>(span: Span): Span {
  const route = recordStringField(span.data, "http.route")
  if (span.description) {
    span.description = sanitizeNameWithRoute(span.description, route)
  }
  const data = sanitizeFields(span.data)
  const dataRoute = recordStringField(data, "http.route")
  span.data = dataRoute === "/*" ? { ...data, "http.route": "unmatched" } : data ?? {}
  return span
}

export function sanitizeSentryLog<Log extends SentryLogPayload>(log: Log): Log {
  const attributes = sanitizeFields(log.attributes)
  log.attributes = attributes ?? {}
  if (log.message) {
    log.message = sanitizeText(log.message)
  }
  if (typeof log.body === "string") {
    log.body = sanitizeText(log.body)
  } else if (log.body !== undefined) {
    log.body = sanitizeFields({ body: log.body })?.body
  }
  return log
}

function sentryRequestContext(fields: JsonObject): JsonObject | undefined {
  const requestId = stringField(fields, "request_id")
  const route = stringField(fields, "http_route")
  const status = recordNumberField(fields, "http_status_code")
  if (!requestId && !route && status === undefined) {
    return undefined
  }

  return {
    request_id: requestId,
    http_route: route,
    http_status_code: status,
  }
}

async function startSentry(state: RuntimeState) {
  if (observabilityConfig.backend !== "sentry") {
    return
  }

  const Sentry = await import("@sentry/hono/node")
  const release = observabilityConfig.sentryBuild.values.SENTRY_RELEASE
  const environment = observabilityConfig.sentryBuild.values.SENTRY_ENVIRONMENT
  const dist = observabilityConfig.sentryBuild.values.SENTRY_DIST

  Sentry.init({
    dsn: observabilityConfig.sentry.dsn,
    tracesSampleRate: observabilityConfig.sentry.tracesSampleRate,
    release,
    environment,
    dist,
    enableLogs: true,
    attachStacktrace: false,
    maxValueLength: 2_000,
    normalizeDepth: 4,
    normalizeMaxBreadth: 100,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      httpBodies: [],
      httpHeaders: { request: false, response: false },
      cookies: false,
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: sanitizeSentryEvent,
    beforeSendSpan: sanitizeSentrySpan,
    beforeSendLog: sanitizeSentryLog,
    beforeBreadcrumb: (breadcrumb) => sanitizeSentryBreadcrumb(breadcrumb),
  })

  state.honoMiddlewareFactory = (app) => {
    const sentryMiddleware = Sentry.sentry(app)
    return async (c, next) => {
      if (healthPath(c.req.path)) {
        await next()
        return
      }

      await sentryMiddleware(c, next)
    }
  }
  state.emitProviderLog = (level, message, fields) => {
    switch (level) {
      case "debug":
        Sentry.logger.debug(message, fields)
        return
      case "info":
        Sentry.logger.info(message, fields)
        return
      case "warn":
        Sentry.logger.warn(message, fields)
        return
      case "error":
        Sentry.logger.error(message, fields)
        return
    }
  }
  state.shutdown = async () => {
    await Sentry.close(2_000)
  }
  state.getTraceContext = () => {
    try {
      return parseSentryTraceHeader(Sentry.getTraceData()["sentry-trace"])
    } catch {
      return undefined
    }
  }
  state.attachRequestContext = (fields) => {
    const requestId = stringField(fields, "request_id")
    const route = stringField(fields, "http_route")
    const requestContext = sentryRequestContext(fields)
    if (requestContext) {
      Sentry.getCurrentScope().setContext("den_api", requestContext)
      Sentry.getIsolationScope().setContext("den_api", requestContext)
    }
    if (requestId) {
      Sentry.setAttribute("request.id", requestId)
      Sentry.setTag("request_id", requestId)
    }
    if (route) {
      Sentry.setAttribute("http.route", route)
    }
  }
  state.captureException = (error, fields) => {
    const sanitizedError = sanitizeExceptionForTelemetry(error)
    Sentry.withScope((scope: SentryScope) => {
      scope.setContext("den_api", fields ?? {})
      const requestId = fields ? stringField(fields, "request_id") : undefined
      if (requestId) {
        scope.setTag("request_id", requestId)
      }
      Sentry.captureException(sanitizedError)
    })
  }
}

export async function initializeObservability() {
  const state = getRuntimeState()
  if (state.initialized) {
    return state
  }

  state.initialized = true
  try {
    switch (observabilityConfig.backend) {
      case "none":
        return state
      case "otel":
        await startOtel(state)
        return state
      case "sentry":
        await startSentry(state)
        return state
    }
  } catch (error) {
    state.initialized = false
    throw error
  }
}

export function captureException(error: unknown, fields?: Readonly<Record<string, unknown>>) {
  const safeFields = sanitizeFields(fields)
  getRuntimeState().captureException?.(error, safeFields)
}

export function attachRequestContext(fields: Readonly<Record<string, unknown>>) {
  const safeFields = sanitizeFields(fields)
  if (safeFields) {
    getRuntimeState().attachRequestContext?.(safeFields)
  }
}

export async function shutdownObservability() {
  const state = getRuntimeState()
  await state.shutdown?.()
}
