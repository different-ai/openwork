"use client";

import { useMemo, useState } from "react";
import { brandIconCandidates } from "../../_lib/brand-icon";

export type DenBrandMarkProps = {
  name: string;
  /** Simple Icons slug, when the brand is known by name rather than by URL. */
  simpleIconSlug?: string;
  /** Any URL owned by the brand (docs, console, API). Used for the favicon fallback. */
  serviceUrl?: string | null;
  iconUrl?: string;
  className?: string;
  imageClassName?: string;
};

/**
 * Brand tile that walks the shared icon ladder and ends on a monogram, so a
 * provider without a usable logo still reads as a deliberate mark.
 */
export function DenBrandMark({
  name,
  simpleIconSlug,
  serviceUrl,
  iconUrl,
  className = "h-10 w-10 rounded-[12px]",
  imageClassName = "h-5 w-5",
}: DenBrandMarkProps) {
  const candidates = useMemo(
    () => brandIconCandidates({ iconUrl, simpleIconSlug, serviceUrl }),
    [iconUrl, simpleIconSlug, serviceUrl],
  );
  const [failedCount, setFailedCount] = useState(0);
  const src = candidates[failedCount];
  const monogram = name.trim().charAt(0).toUpperCase();

  return (
    <span className={`flex shrink-0 items-center justify-center border border-gray-100 bg-white ${className}`}>
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          aria-hidden
          loading="lazy"
          onError={() => setFailedCount((count) => count + 1)}
          className={`object-contain ${imageClassName}`}
        />
      ) : (
        <span aria-hidden className="text-[13px] font-semibold text-gray-500">
          {monogram}
        </span>
      )}
    </span>
  );
}
