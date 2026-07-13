export type ObservabilityBackend = "none" | "otel" | "sentry"
export type ObservabilityEnv = Record<string, string | undefined>

export type OTelProtocol = "http/protobuf"
export type OTelSignal = "traces" | "metrics" | "logs"
export type OTelSignalExporter = "otlp" | "none"
export type OTelEndpointSource = "default" | "base" | "signal"
export type OTelSampler =
  | "always_on"
  | "always_off"
  | "traceidratio"
  | "parentbased_always_on"
  | "parentbased_always_off"
  | "parentbased_traceidratio"

export type OTelSamplerConfig = {
  name: OTelSampler
  ratio: number
  argument?: string
}

export type OTelSignalConfig = {
  exporter: OTelSignalExporter
  protocol: OTelProtocol
  endpoint?: string
  endpointSource: OTelEndpointSource
}

export type OTelObservabilityConfig = {
  protocol: OTelProtocol
  baseEndpoint?: string
  sampler: OTelSamplerConfig
  signals: {
    traces: OTelSignalConfig
    metrics: OTelSignalConfig
    logs: OTelSignalConfig
  }
}

export type SentryBuildVariableValues = {
  SENTRY_ORG?: string
  SENTRY_PROJECT?: string
  SENTRY_URL?: string
  SENTRY_RELEASE?: string
  SENTRY_ENVIRONMENT?: string
  SENTRY_DIST?: string
}

export type SentryBuildVariables = {
  values: SentryBuildVariableValues
  redactedKeys: string[]
}

export type SentryObservabilityConfig = {
  dsn: string
  tracesSampleRate: number
}

type BaseObservabilityConfig = {
  serviceName: string
  sentryBuild: SentryBuildVariables
}

export type NoneObservabilityConfig = BaseObservabilityConfig & {
  backend: "none"
}

export type OTelBackendObservabilityConfig = BaseObservabilityConfig & {
  backend: "otel"
  otel: OTelObservabilityConfig
}

export type SentryBackendObservabilityConfig = BaseObservabilityConfig & {
  backend: "sentry"
  sentry: SentryObservabilityConfig
}

export type ObservabilityConfig =
  | NoneObservabilityConfig
  | OTelBackendObservabilityConfig
  | SentryBackendObservabilityConfig

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export type JsonObject = {
  readonly [key: string]: JsonValue | undefined
}

export type JsonStdoutLogger = {
  log: (level: StructuredLogLevel, message: string, fields?: JsonObject) => void
  debug: (message: string, fields?: JsonObject) => void
  info: (message: string, fields?: JsonObject) => void
  warn: (message: string, fields?: JsonObject) => void
  error: (message: string, fields?: JsonObject) => void
  child: (fields: JsonObject) => JsonStdoutLogger
}

export type StructuredLogLevel = "debug" | "info" | "warn" | "error"

export type JsonStdoutLoggerOptions = {
  serviceName: string
  fields?: JsonObject
  now?: () => Date
  write?: (line: string) => void
}

export class ObservabilityConfigError extends Error {
  readonly envKey?: string

  constructor(message: string, envKey?: string) {
    super(envKey ? `${envKey}: ${message}` : message)
    this.name = "ObservabilityConfigError"
    this.envKey = envKey
  }
}

const OTEL_DEFAULT_PROTOCOL: OTelProtocol = "http/protobuf"

function envValue(env: ObservabilityEnv, key: string): string | undefined {
  const value = env[key]
  if (value === undefined) {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function parseBackend(env: ObservabilityEnv): ObservabilityBackend {
  const backend = envValue(env, "DEN_OBSERVABILITY_BACKEND")
  if (backend === undefined) {
    return "none"
  }

  switch (backend) {
    case "none":
    case "otel":
    case "sentry":
      return backend
    default:
      throw new ObservabilityConfigError(
        "must be one of none, otel, sentry",
        "DEN_OBSERVABILITY_BACKEND",
      )
  }
}

function requireServiceName(serviceName: string): string {
  const trimmed = serviceName.trim()
  if (!trimmed) {
    throw new ObservabilityConfigError("service name is required")
  }
  return trimmed
}

function validateHttpUrl(value: string, envKey: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ObservabilityConfigError("must be an absolute http(s) URL", envKey)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ObservabilityConfigError("must use http or https", envKey)
  }
  if (!parsed.hostname) {
    throw new ObservabilityConfigError("must include a hostname", envKey)
  }

  return value
}

function validateSentryDsn(value: string): string {
  validateHttpUrl(value, "SENTRY_DSN")

  const parsed = new URL(value)
  if (!parsed.username) {
    throw new ObservabilityConfigError("must include a public key", "SENTRY_DSN")
  }

  const projectId = parsed.pathname.split("/").filter(Boolean).at(-1)
  if (!projectId) {
    throw new ObservabilityConfigError("must include a project id", "SENTRY_DSN")
  }

  return value
}

function parseUnitInterval(raw: string, envKey: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ObservabilityConfigError("must be a number from 0 through 1", envKey)
  }
  return value
}

function parseOtelProtocol(env: ObservabilityEnv, envKey: string, fallback: OTelProtocol): OTelProtocol {
  const protocol = envValue(env, envKey)
  if (protocol === undefined) {
    return fallback
  }

  if (protocol === "http/protobuf") {
    return protocol
  }

  throw new ObservabilityConfigError("must be http/protobuf", envKey)
}

function parseOtelExporter(env: ObservabilityEnv, envKey: string): OTelSignalExporter {
  const exporter = envValue(env, envKey)
  if (exporter === undefined) {
    return "otlp"
  }

  switch (exporter) {
    case "otlp":
    case "none":
      return exporter
    default:
      throw new ObservabilityConfigError("must be otlp or none", envKey)
  }
}

function parseOtelSamplerName(env: ObservabilityEnv): OTelSampler {
  const sampler = envValue(env, "OTEL_TRACES_SAMPLER")
  if (sampler === undefined) {
    return "parentbased_always_on"
  }

  switch (sampler) {
    case "always_on":
    case "always_off":
    case "traceidratio":
    case "parentbased_always_on":
    case "parentbased_always_off":
    case "parentbased_traceidratio":
      return sampler
    default:
      throw new ObservabilityConfigError(
        "must be a standard OpenTelemetry sampler",
        "OTEL_TRACES_SAMPLER",
      )
  }
}

function isRatioSampler(sampler: OTelSampler): boolean {
  return sampler === "traceidratio" || sampler === "parentbased_traceidratio"
}

function parseOtelSampler(env: ObservabilityEnv): OTelSamplerConfig {
  const name = parseOtelSamplerName(env)
  const rawArgument = envValue(env, "OTEL_TRACES_SAMPLER_ARG")

  if (isRatioSampler(name)) {
    const ratio = rawArgument === undefined ? 1 : parseUnitInterval(rawArgument, "OTEL_TRACES_SAMPLER_ARG")
    return { name, ratio, argument: String(ratio) }
  }

  if (rawArgument !== undefined) {
    throw new ObservabilityConfigError(
      "is only supported for traceidratio samplers",
      "OTEL_TRACES_SAMPLER_ARG",
    )
  }

  if (name === "always_off" || name === "parentbased_always_off") {
    return { name, ratio: 0 }
  }

  return { name, ratio: 1 }
}

function otelSignalPath(signal: OTelSignal): string {
  switch (signal) {
    case "traces":
      return "/v1/traces"
    case "metrics":
      return "/v1/metrics"
    case "logs":
      return "/v1/logs"
  }
}

function appendOtelSignalPath(baseEndpoint: string, signal: OTelSignal): string {
  const parsed = new URL(baseEndpoint)
  const basePath = parsed.pathname.replace(/\/+$/u, "")
  parsed.pathname = `${basePath}${otelSignalPath(signal)}`
  return parsed.toString()
}

function otelSignalEnv(signal: OTelSignal): {
  endpoint: string
  exporter: string
  protocol: string
} {
  switch (signal) {
    case "traces":
      return {
        endpoint: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        exporter: "OTEL_TRACES_EXPORTER",
        protocol: "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
      }
    case "metrics":
      return {
        endpoint: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        exporter: "OTEL_METRICS_EXPORTER",
        protocol: "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
      }
    case "logs":
      return {
        endpoint: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        exporter: "OTEL_LOGS_EXPORTER",
        protocol: "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
      }
  }
}

function parseOtelSignal(
  env: ObservabilityEnv,
  signal: OTelSignal,
  protocol: OTelProtocol,
  baseEndpoint: string | undefined,
): OTelSignalConfig {
  const keys = otelSignalEnv(signal)
  const endpointOverride = envValue(env, keys.endpoint)

  let endpoint: string | undefined
  let endpointSource: OTelEndpointSource = "default"
  if (endpointOverride !== undefined) {
    endpoint = validateHttpUrl(endpointOverride, keys.endpoint)
    endpointSource = "signal"
  } else if (baseEndpoint !== undefined) {
    endpoint = appendOtelSignalPath(baseEndpoint, signal)
    endpointSource = "base"
  }

  return {
    exporter: parseOtelExporter(env, keys.exporter),
    protocol: parseOtelProtocol(env, keys.protocol, protocol),
    endpoint,
    endpointSource,
  }
}

function validateOtelSignalEndpoint(signal: OTelSignal, config: OTelSignalConfig): void {
  if (config.exporter === "none" || config.endpoint !== undefined) {
    return
  }

  throw new ObservabilityConfigError(
    "is required when the signal exporter is otlp",
    otelSignalEnv(signal).endpoint,
  )
}

function parseOtelConfig(env: ObservabilityEnv): OTelObservabilityConfig {
  const protocol = parseOtelProtocol(env, "OTEL_EXPORTER_OTLP_PROTOCOL", OTEL_DEFAULT_PROTOCOL)
  const rawBaseEndpoint = envValue(env, "OTEL_EXPORTER_OTLP_ENDPOINT")
  const baseEndpoint = rawBaseEndpoint === undefined
    ? undefined
    : validateHttpUrl(rawBaseEndpoint, "OTEL_EXPORTER_OTLP_ENDPOINT")
  const sampler = parseOtelSampler(env)

  const signals = {
    traces: parseOtelSignal(env, "traces", protocol, baseEndpoint),
    metrics: parseOtelSignal(env, "metrics", protocol, baseEndpoint),
    logs: parseOtelSignal(env, "logs", protocol, baseEndpoint),
  }

  validateOtelSignalEndpoint("traces", signals.traces)
  validateOtelSignalEndpoint("metrics", signals.metrics)
  validateOtelSignalEndpoint("logs", signals.logs)

  return {
    protocol,
    baseEndpoint,
    sampler,
    signals,
  }
}

function parseSentryConfig(env: ObservabilityEnv): SentryObservabilityConfig {
  const dsn = envValue(env, "SENTRY_DSN")
  if (dsn === undefined) {
    throw new ObservabilityConfigError(
      "is required when DEN_OBSERVABILITY_BACKEND=sentry",
      "SENTRY_DSN",
    )
  }

  const sampleRate = envValue(env, "SENTRY_TRACES_SAMPLE_RATE")

  return {
    dsn: validateSentryDsn(dsn),
    tracesSampleRate: sampleRate === undefined
      ? 1
      : parseUnitInterval(sampleRate, "SENTRY_TRACES_SAMPLE_RATE"),
  }
}

function parseSentryBuildVariables(
  env: ObservabilityEnv,
  options: { validateUrls: boolean },
): SentryBuildVariables {
  const values: SentryBuildVariableValues = {}
  const org = envValue(env, "SENTRY_ORG")
  const project = envValue(env, "SENTRY_PROJECT")
  const url = envValue(env, "SENTRY_URL")
  const release = envValue(env, "SENTRY_RELEASE")
  const environment = envValue(env, "SENTRY_ENVIRONMENT")
  const dist = envValue(env, "SENTRY_DIST")
  const authToken = envValue(env, "SENTRY_AUTH_TOKEN")

  if (org !== undefined) {
    values.SENTRY_ORG = org
  }
  if (project !== undefined) {
    values.SENTRY_PROJECT = project
  }
  if (url !== undefined) {
    values.SENTRY_URL = options.validateUrls ? validateHttpUrl(url, "SENTRY_URL") : url
  }
  if (release !== undefined) {
    values.SENTRY_RELEASE = release
  }
  if (environment !== undefined) {
    values.SENTRY_ENVIRONMENT = environment
  }
  if (dist !== undefined) {
    values.SENTRY_DIST = dist
  }

  return {
    values,
    redactedKeys: authToken === undefined ? [] : ["SENTRY_AUTH_TOKEN"],
  }
}

export function parseObservabilityEnv(
  env: ObservabilityEnv,
  options: { serviceName: string },
): ObservabilityConfig {
  const serviceName = requireServiceName(options.serviceName)
  const backend = parseBackend(env)
  const sentryBuild = parseSentryBuildVariables(env, { validateUrls: backend === "sentry" })

  switch (backend) {
    case "none":
      return { backend, serviceName, sentryBuild }
    case "otel":
      return { backend, serviceName, sentryBuild, otel: parseOtelConfig(env) }
    case "sentry":
      return { backend, serviceName, sentryBuild, sentry: parseSentryConfig(env) }
  }
}

function defaultWrite(line: string): void {
  console.log(line)
}

function mergeJsonFields(first: JsonObject | undefined, second: JsonObject | undefined): JsonObject {
  return {
    ...(first ?? {}),
    ...(second ?? {}),
  }
}

export function createJsonStdoutLogger(options: JsonStdoutLoggerOptions): JsonStdoutLogger {
  const serviceName = requireServiceName(options.serviceName)
  const write = options.write ?? defaultWrite
  const now = options.now ?? (() => new Date())
  const baseFields = options.fields

  const log = (level: StructuredLogLevel, message: string, fields?: JsonObject) => {
    const entry: JsonObject = {
      ...mergeJsonFields(baseFields, fields),
      timestamp: now().toISOString(),
      level,
      service: serviceName,
      message,
    }

    write(JSON.stringify(entry))
  }

  return {
    log,
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    child: (fields) => createJsonStdoutLogger({
      serviceName,
      fields: mergeJsonFields(baseFields, fields),
      now,
      write,
    }),
  }
}
