"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { type AuthSecurityTab, getAuthSecurityRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/**
 * The old Settings › SSO and Settings › SCIM pages. With `authSecuritySettings`
 * on they send people to the matching Auth & Security tab, keeping any other
 * query parameters; off, they render as before.
 */
export function AuthSecurityLegacyRoute({ tab, children }: { tab: AuthSecurityTab; children: ReactNode }) {
  const { orgSlug, orgContext } = useOrgDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();
  const moved = orgFeatureEnabled(orgContext, "authSecuritySettings");

  useEffect(() => {
    if (!moved) return;
    const params = new URLSearchParams({ tab });
    searchParams.forEach((value, key) => {
      if (key !== "tab") params.append(key, value);
    });
    router.replace(`${getAuthSecurityRoute(orgSlug)}?${params.toString()}`);
  }, [moved, orgSlug, router, searchParams, tab]);

  if (moved) return null;
  return <>{children}</>;
}
