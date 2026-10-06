import { licenseCheckResponseSchemaAny, normalizeLicenseCheckResponse } from "@openwork/license-contracts/license"
import type { EntitlementInput } from "@openwork/license-contracts/resolver"

export const DEV_OVERRIDE_ENV = "DEN_LICENSE_DEV_OVERRIDE"

/**
 * `DEN_LICENSE_DEV_OVERRIDE`: a license check response (v1 or v2, parsed with
 * the same schema as the license server's answer, discovery §9), normalized
 * into a `static` entitlement. Never allowed in production.
 */
export function parseDevOverride(raw: string): Extract<EntitlementInput, { source: "static" }> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`${DEV_OVERRIDE_ENV} must be a JSON license check response`)
  }
  const parsed = licenseCheckResponseSchemaAny.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${DEV_OVERRIDE_ENV} is not a valid license check response: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`)
  }
  const license = normalizeLicenseCheckResponse(parsed.data)
  return { source: "static", modules: license.modules, featureFlags: license.featureFlags }
}
