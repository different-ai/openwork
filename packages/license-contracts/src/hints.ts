import { z } from "zod"
import { licenseCheckRequestSchemaV2, licenseCheckResponseSchemaV2 } from "./license"

const timestamp = z.iso.datetime({ offset: true })

/**
 * Optional Cloud push hint, license server → Den (D8). Carries no
 * entitlements, only "re-check these orgs now". Signed with HMAC-SHA256 over
 * `${t}.${rawBody}` in `ENTITLEMENT_HINT_SIGNATURE_HEADER` (`t=<unix seconds>,v1=<hex>`).
 */
export const entitlementInvalidationHintSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hintId: z.uuid(),
  organizationIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  issuedAt: timestamp,
})
export type EntitlementInvalidationHint = z.infer<typeof entitlementInvalidationHintSchema>

export const ENTITLEMENT_HINT_SIGNATURE_HEADER = "OpenWork-Signature"
export const ENTITLEMENT_HINT_TOLERANCE_SECONDS = 300

/** Optional batch check for Cloud load (hosted credential only). */
export const licenseCheckBatchRequestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  baseUrl: z.url(),
  instanceId: licenseCheckRequestSchemaV2.shape.instanceId,
  version: licenseCheckRequestSchemaV2.shape.version,
  organizations: z.array(z.strictObject({
    organizationId: z.string().min(1).max(200),
    currentUsers: z.number().int().nonnegative(),
  })).min(1).max(100),
})
export type LicenseCheckBatchRequest = z.infer<typeof licenseCheckBatchRequestSchema>

export const licenseCheckBatchResponseSchema = z.object({
  schemaVersion: z.literal(2),
  checkedAt: timestamp,
  results: z.array(z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), organizationId: z.string(), response: licenseCheckResponseSchemaV2 }),
    z.object({
      ok: z.literal(false),
      organizationId: z.string(),
      error: z.enum(["organization_scope_denied", "invalid_organization", "unavailable"]),
    }),
  ])),
})
export type LicenseCheckBatchResponse = z.infer<typeof licenseCheckBatchResponseSchema>
