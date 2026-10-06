import { z } from "zod"
import { licenseCheckResponseSchemaAny, normalizeLicenseCheckResponse } from "./license"
import type { LicenseEntitlementInput } from "./resolver"

export { computeTransitionStart } from "./resolver"

const timestamp = z.iso.datetime({ offset: true })

/** The last validated license answer for a scope, persisted (Cloud: per org, D23). */
export const entitlementSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  payload: licenseCheckResponseSchemaAny,
  /** Never advanced by failures or restarts. */
  lastVerifiedAt: timestamp,
  nextRefreshAt: timestamp,
  /** First observed transition start, persisted so restarts can't extend grace. */
  transitionStartedAt: timestamp.nullable(),
  /** Set on a 401/403 from the license server: starts the transition. */
  credentialRejectedAt: timestamp.nullable().default(null),
})
export type EntitlementSnapshot = z.infer<typeof entitlementSnapshotSchema>

/** The `organization.modules` column document. */
export const organizationModulesSchema = z.object({
  schemaVersion: z.literal(1),
  /** Bumped on every write; part of the memo key (§7.3). */
  revision: z.number().int().nonnegative(),
  /** Org opt-outs. Strings, so retired or unknown ids survive a downgrade. */
  disabled: z.array(z.string()).max(128),
  /** Last toggle change (not entitlement refreshes). */
  updatedAt: timestamp,
  /** Member id of the last toggle change. */
  updatedBy: z.string().nullable(),
  /** Cloud only (D23). */
  entitlement: entitlementSnapshotSchema.optional(),
  /** Modules whose enable-for-org reconcile finished during their current "on" period (W0-P14). */
  reconciled: z.array(z.string()).max(128).optional(),
})
export type OrganizationModules = z.infer<typeof organizationModulesSchema>

export function entitlementInputFromSnapshot(snapshot: EntitlementSnapshot): LicenseEntitlementInput {
  return {
    source: "license",
    license: normalizeLicenseCheckResponse(snapshot.payload),
    lastVerifiedAt: snapshot.lastVerifiedAt,
    transitionStartedAt: snapshot.transitionStartedAt,
    credentialRejectedAt: snapshot.credentialRejectedAt,
  }
}
