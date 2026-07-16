"use client";

import { useEffect } from "react";
import { getManagedBrandAssetFromMetadata } from "../../_lib/den-org";

const DEFAULT_FAVICON_URL = "/openwork-mark.svg";

export function getBrandFavicon(metadata: string | null | undefined) {
  const icon = getManagedBrandAssetFromMetadata(metadata ?? null, "icon");
  return {
    href: icon?.url ?? DEFAULT_FAVICON_URL,
    type: icon?.contentType,
  };
}

export function BrandFavicon({ metadata }: { metadata: string | null | undefined }) {
  const icon = getBrandFavicon(metadata);

  useEffect(() => {
    const favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.href = icon.href;
    if (icon.type) {
      favicon.type = icon.type;
    }
    favicon.dataset.openworkBrandFavicon = "true";
    document.head.append(favicon);

    return () => favicon.remove();
  }, [icon.href, icon.type]);

  return null;
}
