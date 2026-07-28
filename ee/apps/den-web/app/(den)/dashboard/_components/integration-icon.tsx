"use client";

import { useMemo, useState } from "react";
import { Plug } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { brandIconCandidates } from "../../_lib/brand-icon";

export function IntegrationIcon({
  name,
  iconUrl,
  simpleIconSlug,
  serviceUrl,
  fallbackIcon: FallbackIcon = Plug,
  className = "h-10 w-10 rounded-[12px]",
  imageClassName = "h-5 w-5",
}: {
  name: string;
  iconUrl?: string;
  simpleIconSlug?: string;
  serviceUrl?: string;
  fallbackIcon?: LucideIcon;
  className?: string;
  imageClassName?: string;
}) {
  const candidates = useMemo(
    () => brandIconCandidates({ iconUrl, simpleIconSlug, serviceUrl }),
    [iconUrl, simpleIconSlug, serviceUrl],
  );
  const [failedCount, setFailedCount] = useState(0);
  const src = candidates[failedCount];

  return (
    <div className={`flex shrink-0 items-center justify-center border border-gray-100 bg-white shadow-sm ${className}`}>
      {src ? (
        <img
          key={src}
          src={src}
          alt={`${name} icon`}
          loading="lazy"
          onError={() => setFailedCount((count) => count + 1)}
          className={`object-contain ${imageClassName}`}
        />
      ) : (
        <FallbackIcon className="h-5 w-5 text-gray-500" aria-hidden />
      )}
    </div>
  );
}
