export type MarketplaceDeliveryActionKind = "cloud_active" | "cloud_active_local_copy";

export function shouldShowExtensionsMarketplacePane() {
  return true;
}

export function resolveMarketplaceDeliveryAction(input: {
  importedLocally: boolean;
}): MarketplaceDeliveryActionKind {
  return input.importedLocally ? "cloud_active_local_copy" : "cloud_active";
}
