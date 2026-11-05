import type { CollectionsFacts } from "../_features/feature-intros/intros/collections";
import type { DenMarketplace } from "./marketplace-data";

/**
 * The OpenWork Marketplace Den seeds into every organization
 * (`DEFAULT_OPENWORK_MARKETPLACE_*` in den-api default-marketplaces.ts). The list
 * doesn't flag it, so it is known by its seeded name and logo.
 */
export function isBuiltInCollection(marketplace: Pick<DenMarketplace, "name" | "logoUrl">): boolean {
  return marketplace.name === "OpenWork Marketplace" && marketplace.logoUrl === "/openwork-mark.svg";
}

/** Facts for Collections from the active collections list; null until it has loaded. */
export function collectionsIntroFacts(marketplaces: readonly Pick<DenMarketplace, "name" | "logoUrl">[] | undefined): CollectionsFacts | null {
  if (!marketplaces) return null;
  return {
    collections: marketplaces.length,
    ownCollections: marketplaces.filter((marketplace) => !isBuiltInCollection(marketplace)).length,
  };
}
