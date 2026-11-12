"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { type AuthSecurityTab, getAuthSecurityRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/**
 * The old Settings › SSO and Settings › SCIM pages: they send people to the
 * matching Auth & Security tab, keeping any other query parameters.
 */
export function AuthSecurityLegacyRoute({ tab }: { tab: AuthSecurityTab }) {
  const { orgSlug, orgContext } = useOrgDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // Until the organization is known, its route is not.
    if (!orgContext) return;
    const params = new URLSearchParams({ tab });
    searchParams.forEach((value, key) => {
      if (key !== "tab") params.append(key, value);
    });
    router.replace(`${getAuthSecurityRoute(orgSlug)}?${params.toString()}`);
  }, [orgContext, orgSlug, router, searchParams, tab]);

  return null;
}
