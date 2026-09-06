/**
 * Errors the orchestrator raises on its own behalf (as opposed to
 * `RuntimeProviderError`, which a provider raises). Den classifies startup
 * failures from `code`.
 */
export type CloudRuntimeErrorCode =
  | "instance_missing"
  | "runtime_health_timeout"
  | "runtime_start_failed"
  | "checkpoint_not_restored"
  | "instance_start_failed"

export class CloudRuntimeError extends Error {
  readonly code: CloudRuntimeErrorCode

  constructor(code: CloudRuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = "CloudRuntimeError"
    this.code = code
  }
}

export function isCloudRuntimeError(error: unknown): error is CloudRuntimeError {
  return error instanceof CloudRuntimeError
    || (error instanceof Error && error.name === "CloudRuntimeError" && "code" in error)
}

export function cloudRuntimeErrorCode(error: unknown): CloudRuntimeErrorCode | null {
  return isCloudRuntimeError(error) ? error.code : null
}

/** The worker has no live instance (no record, or the host no longer knows it). */
export function isCloudRuntimeInstanceMissingError(error: unknown) {
  return cloudRuntimeErrorCode(error) === "instance_missing"
}
