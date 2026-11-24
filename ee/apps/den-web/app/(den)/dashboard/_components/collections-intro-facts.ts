import type { CollectionsFacts } from "../_features/feature-intros/intros/collections";
import type { DenMarketplace } from "./marketplace-data";
import { visibleCountFact } from "../_features/feature-intros/model";

export function isBuiltInCollection(marketplace: Pick<DenMarketplace, "name" | "logoUrl">): boolean {
  return marketplace.name === "OpenWork Marketplace" && marketplace.logoUrl === "/openwork-mark.svg";
}

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
