import { organizationFeatureEnabled } from "./features.js"
import { STOCK_BRAND } from "./white-label-policy.js"
export { STOCK_BRAND, BRAND_METADATA_KEYS, projectBrandMetadata } from "./white-label-policy.js"

/** Ownership comes from the validated install-link record, never from caller claims. */
export async function projectConnectClaims<T extends { brand: { appName: string; logoUrl: string | null; iconUrl: string | null } }>(claims: T, organizationId: string) {
  const whiteLabelEnabled = await organizationFeatureEnabled(organizationId, "whiteLabel")
  return { ...claims, brand: whiteLabelEnabled ? claims.brand : { ...STOCK_BRAND }, whiteLabelEnabled }
}
