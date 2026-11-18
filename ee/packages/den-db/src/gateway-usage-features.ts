import type { FeatureDatabase } from "./organization-features"

/** Compatibility for gateway callers: provider usage limits are generally available on every deployment. */
export async function gatewayProviderUsageLimitsEnabled(
  _database: FeatureDatabase,
  _organizationId: string,
): Promise<boolean> {
  return true
}
