/**
 * The only error a provider may let escape. Den classifies startup failures
 * from `code`, so a new host never needs Den to learn its message strings.
 */
export type SandboxErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "rate_limited"
  | "capacity"
  | "transient"
  | "timeout"
  | "auth"
  | "unknown"

const retryableByDefault: ReadonlySet<SandboxErrorCode> = new Set([
  "invalid_state",
  "rate_limited",
  "transient",
  "timeout",
])

export class SandboxError extends Error {
  readonly code: SandboxErrorCode
  readonly retryable: boolean
  readonly providerId: string

  constructor(input: {
    providerId: string
    code: SandboxErrorCode
    message: string
    retryable?: boolean
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "SandboxError"
    this.code = input.code
    this.providerId = input.providerId
    this.retryable = input.retryable ?? retryableByDefault.has(input.code)
  }
}

export function isSandboxError(error: unknown): error is SandboxError {
  return error instanceof SandboxError
    || (error instanceof Error && (error.name === "SandboxError" || error.name === "RuntimeProviderError") && "code" in error)
}

export function sandboxErrorCode(error: unknown): SandboxErrorCode | null {
  return isSandboxError(error) ? error.code : null
}

// Compatibility for existing OpenWork Web consumers.
export { SandboxError as RuntimeProviderError, isSandboxError as isRuntimeProviderError, sandboxErrorCode as runtimeProviderErrorCode }
export type RuntimeProviderErrorCode = SandboxErrorCode
