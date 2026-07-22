"use client";

import { useState } from "react";

export type OrganizationBrand = {
  appName: string;
  logoUrl: string | null;
  iconUrl: string | null;
};

export function OrganizationBrandIdentity({
  organizationName,
  brand,
  className = "",
}: {
  organizationName: string;
  brand: OrganizationBrand;
  className?: string;
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const showLogo = Boolean(brand.logoUrl && brand.logoUrl !== failedLogoUrl);
  const showIcon = Boolean(brand.iconUrl && brand.iconUrl !== failedIconUrl);

  if (showLogo && brand.logoUrl) {
    return (
      // Organization assets may be served by private on-prem hosts that are
      // intentionally absent from this deployment's image allowlist.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={brand.logoUrl}
        alt={`${organizationName} logo`}
        className={`inline-block max-h-[1.08em] max-w-[12rem] shrink-0 object-contain align-middle ${className}`}
        onError={() => setFailedLogoUrl(brand.logoUrl)}
      />
    );
  }

  return (
    <span className={`inline ${className}`}>
      {showIcon && brand.iconUrl ? (
        // See the private-host note above.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={brand.iconUrl}
          alt=""
          className="mr-[0.24em] inline-block size-[1em] rounded-[0.22em] object-contain align-[-0.12em]"
          onError={() => setFailedIconUrl(brand.iconUrl)}
        />
      ) : null}
      <span>{organizationName}</span>
    </span>
  );
}
