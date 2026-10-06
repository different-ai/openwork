import type { LicenseCheckRequestV2, LicenseCheckResponseAny } from "@openwork/license-contracts/license"

export type LicenseScope = { readonly organizationId: string } | { readonly instance: true }

export interface LicenseRequestContext {
  readonly baseUrl: string
  readonly instanceId: string
  readonly version: string
  currentUsers(scope: LicenseScope): Promise<number>
}

export type LicenseCheckResult =
  /** Already schema-validated. */
  | { readonly kind: "ok"; readonly response: LicenseCheckResponseAny }
  /** The credential was refused: starts the transition, never treated as an outage. */
  | { readonly kind: "rejected"; readonly status: 401 | 403 }
  /** Network error, 5xx or timeout: changes nothing. */
  | { readonly kind: "unavailable"; readonly error: string }
  /** The stub client (until Phase 5). */
  | { readonly kind: "disabled" }

export interface LicenseClient {
  /** `true` only for the stub, so production can refuse to run license mode with it. */
  readonly disabled?: boolean
  check(request: LicenseCheckRequestV2, scope: LicenseScope): Promise<LicenseCheckResult>
}

/** The only production client until Phase 5 ships the HTTP client. */
export function createDisabledLicenseClient(): LicenseClient {
  return {
    disabled: true,
    check: async () => ({ kind: "disabled" }),
  }
}
