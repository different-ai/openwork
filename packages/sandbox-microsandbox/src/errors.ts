import { SandboxError, isSandboxError, type SandboxErrorCode } from "@openwork/sandbox"

export const MICROSANDBOX_PROVIDER_ID = "microsandbox"

type Mapping = { code: SandboxErrorCode; retryable?: boolean }

/** microsandbox error codes (`MicrosandboxError.code`) to the OpenWork taxonomy. */
const MAPPINGS: Readonly<Record<string, Mapping>> = {
  sandboxNotFound: { code: "not_found" },
  sandboxReplaced: { code: "not_found" },
  sandboxAlreadyExists: { code: "conflict" },
  sandboxNotRunning: { code: "invalid_state" },
  sandboxStillRunning: { code: "invalid_state" },
  // A command that ran out of time is over; running it again is the caller's decision.
  execTimeout: { code: "timeout", retryable: false },
  stopTimeout: { code: "timeout" },
  sandboxStopTimedOut: { code: "timeout" },
  createCancelled: { code: "timeout" },
  portInUse: { code: "transient" },
  // The runtime is absent or incomplete on this computer. Retrying cannot help.
  runtimeNotInstalled: { code: "invalid_state", retryable: false },
  runtimeIncomplete: { code: "invalid_state", retryable: false },
  libkrunfwNotFound: { code: "invalid_state", retryable: false },
  unsupported: { code: "invalid_state", retryable: false },
  unsupportedOperation: { code: "invalid_state", retryable: false },
  notLocal: { code: "invalid_state", retryable: false },
  invalidConfig: { code: "invalid_state", retryable: false },
  imageNotFound: { code: "invalid_state", retryable: false },
}

function nativeCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) return null
  return typeof error.code === "string" ? error.code : null
}

/** The host port chosen for a preview was taken before the sandbox could bind it. */
export function isPortInUse(error: unknown) {
  return nativeCode(error) === "portInUse"
}

/** The only error shape the adapter lets escape. */
export function microsandboxError(error: unknown): SandboxError {
  if (isSandboxError(error)) return error
  const mapping = MAPPINGS[nativeCode(error) ?? ""] ?? { code: "unknown" }
  return new SandboxError({
    providerId: MICROSANDBOX_PROVIDER_ID,
    code: mapping.code,
    ...(mapping.retryable === undefined ? {} : { retryable: mapping.retryable }),
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  })
}
