import { z } from "zod"

/**
 * Local stand-in for the `@openwork/license-contracts/org-modules` schemas.
 *
 * TODO(W0-01): once `packages/license-contracts` lands, delete this file and
 * re-export `organizationModulesSchema`, `OrganizationModules`,
 * `entitlementSnapshotSchema` and `EntitlementSnapshot` from it. The shapes
 * below match W0-01 field for field (minus the dropped `legacyCapabilities`
 * mirror, see the modules README rule R7), except that the entitlement
 * snapshot is kept opaque until its contract exists.
 */

const isoTimestampSchema = z.iso.datetime({ offset: true })

/** Cloud per-org / self-hosted instance entitlement snapshot. Opaque until W0-01. */
export const entitlementSnapshotSchema = z.record(z.string(), z.unknown())
export type EntitlementSnapshot = z.infer<typeof entitlementSnapshotSchema>

/** The `organization.modules` column document (discovery §7.2). */
export const organizationModulesSchema = z.object({
  schemaVersion: z.literal(1),
  /** Bumped by exactly 1 on every write; the memo/cache key (§7.3). */
  revision: z.number().int().nonnegative(),
  /** Org opt-outs. Plain strings so retired or unknown ids survive a downgrade. */
  disabled: z.array(z.string()).max(128),
  /** Last toggle change; entitlement and legacy writes leave it untouched. */
  updatedAt: isoTimestampSchema,
  /** Member id of the last toggle change, `null` for system writes. */
  updatedBy: z.string().nullable(),
  /** Cloud only (D23). */
  entitlement: entitlementSnapshotSchema.optional(),
})
export type OrganizationModules = z.infer<typeof organizationModulesSchema>
