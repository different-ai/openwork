"use client";

import { buttonVariants } from "../../_components/ui/button";

const ENTERPRISE_CONTACT_URL =
  process.env.NEXT_PUBLIC_ENTERPRISE_CONTACT_URL || "https://openworklabs.com/enterprise#book";

type Props = {
  feature: string;
  /** Lowest plan that includes the feature. Team features link to billing; Enterprise features link to sales. */
  plan?: "team" | "enterprise";
  /** Billing page for the Team upgrade. Required when plan is "team". */
  billingHref?: string;
};

export function EnterprisePlanNotice(props: Props) {
  if (props.plan === "team") {
    return (
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-[28px] border border-[var(--dls-border)] bg-[var(--dls-hover)] px-6 py-5">
        <div className="min-w-[260px] flex-1 text-[14px] text-amber-900">
          <p className="font-semibold">{props.feature} is part of the Team plan.</p>
          <p className="mt-1">Your current configuration keeps working. Upgrade to Team to add or change it.</p>
        </div>
        <a href={props.billingHref ?? "/dashboard"} className={buttonVariants({ variant: "primary" })}>
          Upgrade to Team
        </a>
      </div>
    );
  }

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-[28px] border border-[var(--dls-border)] bg-[var(--dls-hover)] px-6 py-5">
      <div className="min-w-[260px] flex-1 text-[14px] text-amber-900">
        <p className="font-semibold">{props.feature} is part of the Enterprise plan.</p>
        <p className="mt-1">
          Your current configuration keeps working — upgrading unlocks SCIM, enforced SSO,
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
