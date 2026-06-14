"use client";

import { useState } from "react";
import { Store } from "lucide-react";

/** Marketplace logo with a graceful fallback to the generic store icon. */
export function MarketplaceLogo({
  logoUrl,
  name,
  imgClassName,
  iconClassName,
}: {
  logoUrl: string | null;
  name: string;
  imgClassName: string;
  iconClassName: string;
}) {
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);

  if (!logoUrl || erroredUrl === logoUrl) {
    return <Store className={`${iconClassName} text-gray-700`} aria-hidden />;
  }

  return (
    <img
      src={logoUrl}
      alt={`${name} logo`}
      onError={() => setErroredUrl(logoUrl)}
      className={`${imgClassName} object-contain`}
    />
  );
}
