"use client";

import Link from "next/link";
import { buttonVariants } from "../../_components/ui/button";

type Props = {
  feature: string;
  ssoAddon?: boolean;
};

export function EnterprisePlanNotice(props: Props) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-[28px] border border-amber-200 bg-amber-50 px-6 py-5">
      <div className="min-w-[260px] flex-1 text-[14px] text-amber-900">
        <p className="font-semibold">{props.ssoAddon ? "SSO is available with Enterprise or the Team SSO add-on." : `${props.feature} is part of the Enterprise plan.`}</p>
        <p className="mt-1">
          {props.ssoAddon ? "Add SSO / SAML to Team for $300 per organization per month, or choose Enterprise at $40 per user per month." : "Choose Enterprise at $40 per user per month to unlock SSO, analytics, desktop policies, and branding."}
        </p>
      </div>
      <Link href="/dashboard/billing" className={buttonVariants({ variant: "primary" })}>
        View plans and add-ons
      </Link>
    </div>
  );
}
