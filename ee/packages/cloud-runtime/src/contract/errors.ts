/**
 * The only error a provider may let escape. Den classifies startup failures
 * from `code`, so a new host never needs Den to learn its message strings.
 */
export type RuntimeProviderErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "rate_limited"
  | "capacity"
  | "transient"
  | "timeout"
  | "auth"
  | "unknown"

const retryableByDefault: ReadonlySet<RuntimeProviderErrorCode> = new Set([
  "invalid_state",
  "rate_limited",
  "transient",
  "timeout",
])

export class RuntimeProviderError extends Error {
  readonly code: RuntimeProviderErrorCode
  readonly retryable: boolean
  readonly providerId: string

  constructor(input: {
    providerId: string
    code: RuntimeProviderErrorCode
    message: string
    retryable?: boolean
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "RuntimeProviderError"
    this.code = input.code
    this.providerId = input.providerId
    this.retryable = input.retryable ?? retryableByDefault.has(input.code)
  }
}

export function isRuntimeProviderError(error: unknown): error is RuntimeProviderError {
  return error instanceof RuntimeProviderError
    || (error instanceof Error && error.name === "RuntimeProviderError" && "code" in error)
}

export function runtimeProviderErrorCode(error: unknown): RuntimeProviderErrorCode | null {
  return isRuntimeProviderError(error) ? error.code : null
}
