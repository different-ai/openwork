import { getManagedBrandAssetFromMetadata } from "./den-org";

export const DEFAULT_FAVICON_URL = "/openwork-mark.svg";

export function getBrandFavicon(metadata: string | null | undefined) {
  const icon = getManagedBrandAssetFromMetadata(metadata ?? null, "icon");
  return {
    href: icon?.url ?? DEFAULT_FAVICON_URL,
    type: icon?.contentType,
  };
}
