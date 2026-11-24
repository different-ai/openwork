"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { type AuthSecurityTab, getAuthSecurityRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function AuthSecurityLegacyRoute({ tab }: { tab: AuthSecurityTab }) {
  const { orgSlug, orgContext } = useOrgDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!orgContext) return;
    const params = new URLSearchParams({ tab });
    searchParams.forEach((value, key) => {
      if (key !== "tab") params.append(key, value);
    });
    router.replace(`${getAuthSecurityRoute(orgSlug)}?${params.toString()}`);
  }, [orgContext, orgSlug, router, searchParams, tab]);

  return null;
}
