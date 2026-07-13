import type { JsonObject, JsonValue } from "@openwork-ee/utils/observability"

const REDACTED = "[redacted]"
const MAX_STRING_LENGTH = 2_000
const MAX_DEPTH = 4
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|set-cookie|password|secret|token|api[-_]?key|client[-_]?secret|credential|dsn|email|header|body|query)/iu
const URL_PATTERN = /https?:\/\/[^\s)"'<>\]}]+/giu

function truncate(value: string) {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…`
    : value
}

export function stripUrlQuery(value: string) {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return value
      .replace(/(https?:\/\/)[^/\s@]+@/giu, "$1")
      .replace(/\?[^\s#)"'<>\]}]*/gu, "?[redacted]")
  }
}

export function sanitizeText(value: string) {
  return truncate(value.replace(URL_PATTERN, (match) => stripUrlQuery(match))
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [redacted]")
    .replace(/\b([^\s=]*(?:token|secret|password|api[-_]?key|client[-_]?secret)[^\s=]*=)[^\s&]+/giu, "$1[redacted]"))
}

function isJsonValue(value: JsonValue | undefined): value is JsonValue {
  return value !== undefined
}

export function serializeError(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      name: sanitizeText(error.name),
      message: sanitizeText(error.message),
      stack: error.stack ? sanitizeText(error.stack) : undefined,
      cause: error.cause === undefined ? undefined : sanitizeValue("cause", error.cause, 1),
    }
  }

  return { message: sanitizeText(String(error)) }
}

export function sanitizeExceptionForTelemetry(error: unknown) {
  const serialized = serializeError(error)
  const sanitized = new Error(typeof serialized.message === "string" ? serialized.message : "unknown error")
  sanitized.name = typeof serialized.name === "string" ? serialized.name : "Error"
  if (typeof serialized.stack === "string") {
    sanitized.stack = serialized.stack
  }
  return sanitized
}

function sanitizeValue(key: string, value: unknown, depth: number): JsonValue | undefined {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED
  }

  if (value === undefined) {
    return undefined
  }

  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? sanitizeText(value) : value
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value)
  }

  if (typeof value === "bigint") {
    return value.toString()
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (value instanceof Error) {
    return serializeError(value)
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      return "[array]"
    }
    return value
      .map((entry) => sanitizeValue(key, entry, depth + 1))
      .filter(isJsonValue)
  }

  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) {
      return "[object]"
    }

    const output: Record<string, JsonValue | undefined> = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      output[childKey] = sanitizeValue(childKey, childValue, depth + 1)
    }
    return output
  }

  return sanitizeText(String(value))
}

export function sanitizeFields(fields: Readonly<Record<string, unknown>> | undefined): JsonObject | undefined {
  if (!fields) {
    return undefined
  }

  const output: Record<string, JsonValue | undefined> = {}
  for (const [key, value] of Object.entries(fields)) {
    output[key] = sanitizeValue(key, value, 0)
  }
  return output
}
