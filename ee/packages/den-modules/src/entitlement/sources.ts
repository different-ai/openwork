import { entitlementInputFromSnapshot, type EntitlementSnapshot } from "@openwork/license-contracts/org-modules"
import type { Deployment } from "@openwork/license-contracts/modules"
import type { EntitlementInput } from "@openwork/license-contracts/resolver"
import type { OrgModulesDocument } from "../org-row"

export type EntitlementMode = "legacy" | "devOverride" | "license"

/**
 * License mode (Phase 5) entitlement input for one org (discovery §7.4):
 * - Cloud: the org's snapshot, or `cloudFreeFallback` until the first check.
 * - Self-hosted: the instance snapshot; no license key, or no snapshot yet,
 *   means `none` (D14: Core only until the license server issues a trial).
 */
export function licenseEntitlementInput(input: {
  deployment: Deployment
  document: OrgModulesDocument
  instanceSnapshot: EntitlementSnapshot | null
  hasLicenseKey: boolean
}): EntitlementInput {
  if (input.deployment === "cloud") {
    const snapshot = input.document.status === "valid" ? input.document.doc.entitlement : undefined
    return snapshot ? entitlementInputFromSnapshot(snapshot) : { source: "cloudFreeFallback" }
  }
  if (!input.hasLicenseKey || input.instanceSnapshot === null) return { source: "none" }
  return entitlementInputFromSnapshot(input.instanceSnapshot)
}

/** A Cloud org whose snapshot is missing or past `nextRefreshAt` gets a background refresh. */
export function orgSnapshotNeedsRefresh(document: OrgModulesDocument, nowMs: number): boolean {
  const snapshot = document.status === "valid" ? document.doc.entitlement : undefined
  if (!snapshot) return true
  const next = Date.parse(snapshot.nextRefreshAt)
  return Number.isNaN(next) || next <= nowMs
}
