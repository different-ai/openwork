import {
  DaytonaAuthenticationError,
  DaytonaBadGatewayError,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaConnectionTimeoutError,
  DaytonaForbiddenError,
  DaytonaInternalServerError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError,
} from "@daytonaio/sdk"
import { RuntimeProviderError, isRuntimeProviderError, type RuntimeProviderErrorCode } from "@openwork-ee/cloud-runtime/contract"

const transientMarkers = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "fetch failed",
  "network",
  "socket hang up",
  "temporarily unavailable",
  "timeout",
]

function message(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
}

function statusCode(error: unknown) {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : null
}

export function classifyDaytonaError(error: unknown): RuntimeProviderErrorCode {
  const text = message(error)
  const status = statusCode(error)

  if (error instanceof DaytonaNotFoundError || status === 404 || text.includes("not found") || text.includes("404")) {
    return "not_found"
  }
  if (error instanceof DaytonaConflictError || status === 409) {
    return text.includes("state change") && text.includes("progress") ? "invalid_state" : "conflict"
  }
  if (error instanceof DaytonaRateLimitError || status === 429 || /\b429\b|rate[ -]?limit|too many requests/.test(text)) {
    return "rate_limited"
  }
  if (error instanceof DaytonaAuthenticationError || error instanceof DaytonaForbiddenError || status === 401 || status === 403) {
    return "auth"
  }
  if (/quota|capacity|insufficient (cpu|memory|disk)|resource exhausted|no available/.test(text)) {
    return "capacity"
  }
  if (error instanceof DaytonaTimeoutError || error instanceof DaytonaConnectionTimeoutError) {
    return "timeout"
  }
  if (
    error instanceof DaytonaInternalServerError
    || error instanceof DaytonaBadGatewayError
    || error instanceof DaytonaServiceUnavailableError
    || error instanceof DaytonaConnectionError
    || (status !== null && status >= 500)
    || /\b5\d\d\b/.test(text)
    || transientMarkers.some((marker) => text.includes(marker))
  ) {
    return "transient"
  }
  return "unknown"
}

/** Wrap anything the SDK throws into the contract's error taxonomy. */
export function toRuntimeProviderError(error: unknown, providerId: string): RuntimeProviderError {
  if (isRuntimeProviderError(error)) return error
  return new RuntimeProviderError({
    providerId,
    code: classifyDaytonaError(error),
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  })
}
