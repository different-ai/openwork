"use client";

import { useMemo, useState } from "react";
import { brandIconCandidates } from "../../_lib/brand-icon";

export type DenBrandMarkProps = {
  name: string;
  simpleIconSlug?: string;
  serviceUrl?: string | null;
  iconUrl?: string;
  className?: string;
  imageClassName?: string;
};

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
  const [failedUrls, setFailedUrls] = useState<string[]>([]);
  const src = candidates.find((candidate) => !failedUrls.includes(candidate));
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
          onError={() => setFailedUrls((urls) => urls.includes(src) ? urls : [...urls, src])}
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
