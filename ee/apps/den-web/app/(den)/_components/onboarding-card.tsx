"use client";

import { useState, type ReactNode } from "react";
import { OrganizationBrandIdentity, type OrganizationBrand } from "./organization-brand-identity";

const OPENWORK_MARK_SRC = "/openwork-mark.svg";

export type OnboardingCardOrganization = {
  name: string;
  brand: OrganizationBrand;
};

function BrandIcon({ iconUrl }: { iconUrl: string | null }) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  const iconSrc = iconUrl && iconUrl !== failedIconUrl ? iconUrl : OPENWORK_MARK_SRC;
  const isFallbackIcon = iconSrc === OPENWORK_MARK_SRC;

  return (
    // Organization assets may be served by private on-prem hosts that are
    // intentionally absent from this deployment's image allowlist.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={iconSrc}
      alt=""
      width={26}
      height={26}
      className={`size-[26px] shrink-0 object-contain ${isFallbackIcon ? "" : "rounded-md"}`}
      aria-hidden="true"
      onError={() => {
        if (!isFallbackIcon) {
          setFailedIconUrl(iconSrc);
        }
      }}
    />
  );
}

function BrandLabel({ organization }: { organization: OnboardingCardOrganization | null }) {
  if (!organization) {
    return <span>OpenWork Cloud</span>;
  }

  if (organization.brand.logoUrl) {
    return (
      <OrganizationBrandIdentity
        organizationName={organization.name}
        brand={organization.brand}
        className="max-h-6"
      />
    );
  }

  return <span>{organization.name}</span>;
}

export function OnboardingCard({
  organization,
  children,
}: {
  organization: OnboardingCardOrganization | null;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-8 rounded-[1.75rem] border border-slate-200/80 bg-white p-6 sm:p-8 md:p-10 sm:gap-10">
      <div className="flex min-w-0 items-center gap-2.5">
        <BrandIcon iconUrl={organization?.brand.iconUrl ?? null} />
        <div className="min-w-0 text-[15px] font-semibold tracking-tight text-slate-950">
          <BrandLabel organization={organization} />
        </div>
      </div>

      <div className="grid gap-5">
        {children}
      </div>
    </div>
  );
}
