export type ManagedModelsDenialCode =
  | "managed_models_disabled_for_dpa"
  | "managed_models_policy_unavailable"

export type ManagedModelsPolicy =
  | { allowed: true }
  | { allowed: false; code: ManagedModelsDenialCode; message: string }

export class ManagedModelsPolicyError extends Error {
  readonly code: ManagedModelsDenialCode
  readonly status: 403 | 503

  constructor(code: ManagedModelsDenialCode) {
    super(code === "managed_models_disabled_for_dpa"
      ? "Company-provided OpenWork Models are unavailable for this organization because a DPA is signed. Permitted customer-key providers and AI Gateway may still be used."
      : "Company-provided OpenWork Models policy could not be verified. Please try again later.")
    this.name = "ManagedModelsPolicyError"
    this.code = code
    this.status = code === "managed_models_disabled_for_dpa" ? 403 : 503
  }
}

export function readOrganizationMetadata(input: unknown): Record<string, unknown> {
  if (input === null || input === undefined) return {}
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Organization metadata must be a JSON object.")
  }
  return Object.fromEntries(Object.entries(value))
}

export function evaluateManagedModelsPolicy(metadata: unknown): ManagedModelsPolicy {
  let parsed: Record<string, unknown>
  try {
    parsed = readOrganizationMetadata(metadata)
    if ("dpaSigned" in parsed && typeof parsed.dpaSigned !== "boolean") {
      throw new Error("dpaSigned must be a boolean when present.")
    }
  } catch {
    const error = new ManagedModelsPolicyError("managed_models_policy_unavailable")
    return { allowed: false, code: error.code, message: error.message }
  }
  if (parsed.dpaSigned === true) {
    const error = new ManagedModelsPolicyError("managed_models_disabled_for_dpa")
    return { allowed: false, code: error.code, message: error.message }
  }
  return { allowed: true }
}

export function assertManagedModelsAllowed(metadata: unknown): void {
  const policy = evaluateManagedModelsPolicy(metadata)
  if (!policy.allowed) throw new ManagedModelsPolicyError(policy.code)
}
