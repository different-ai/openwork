"use client";

import { buttonVariants } from "../../_components/ui/button";

const ENTERPRISE_CONTACT_URL =
  process.env.NEXT_PUBLIC_ENTERPRISE_CONTACT_URL || "https://openworklabs.com/enterprise#book";

type Props = {
  feature: string;
};

export function EnterprisePlanNotice(props: Props) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-[28px] border border-amber-200 bg-amber-50 px-6 py-5">
      <div className="min-w-[260px] flex-1 text-[14px] text-amber-900">
        <p className="font-semibold">{props.feature} is part of the Enterprise plan.</p>
        <p className="mt-1">
          Your current configuration keeps working — upgrading unlocks SSO / SAML with SCIM,
          desktop policies, and managed deployment.
        </p>
      </div>
      <a
        href={ENTERPRISE_CONTACT_URL}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: "primary" })}
      >
        Talk to us for Enterprise pricing
      </a>
    </div>
  );
}
