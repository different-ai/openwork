import type { CollectionsFacts } from "../_features/feature-intros/intros/collections";
import type { DenMarketplace } from "./marketplace-data";
import { visibleCountFact } from "../_features/feature-intros/model";

/**
 * The OpenWork Marketplace Den seeds into every organization
 * (`DEFAULT_OPENWORK_MARKETPLACE_*` in den-api default-marketplaces.ts). The list
 * doesn't flag it, so it is known by its seeded name and logo.
 */
export function isBuiltInCollection(marketplace: Pick<DenMarketplace, "name" | "logoUrl">): boolean {
  return marketplace.name === "OpenWork Marketplace" && marketplace.logoUrl === "/openwork-mark.svg";
}

/**
 * Facts for Collections from the active collections list; null until it has loaded.
 * The list only holds collections this person has a role on unless they have
 * `sharing.manage_all` (`seesAllCollections`), so then an empty count stays unknown.
 */
export function collectionsIntroFacts(
  marketplaces: readonly Pick<DenMarketplace, "name" | "logoUrl">[] | undefined,
  seesAllCollections: boolean,
): CollectionsFacts | null {
  if (!marketplaces) return null;
  return {
    collections: visibleCountFact(marketplaces.length, seesAllCollections),
    ownCollections: visibleCountFact(marketplaces.filter((marketplace) => !isBuiltInCollection(marketplace)).length, seesAllCollections),
  };
}
