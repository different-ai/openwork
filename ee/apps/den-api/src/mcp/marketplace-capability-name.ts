export const MARKETPLACE_CAPABILITY_PREFIX = "plugin:"

export function buildMarketplaceCapabilityName(pluginId: string, configObjectId: string): string {
  return `${MARKETPLACE_CAPABILITY_PREFIX}${pluginId}:${configObjectId}`
}
