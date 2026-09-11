"use client";

import { Fragment, useEffect } from "react";
import { useRouter } from "next/navigation";
import { DenNotice } from "../../_components/ui/notice";
import { getGatewayDashboardAccess } from "../_lib/gateway-dashboard-access";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function useGatewayDashboardAccess() {
  return getGatewayDashboardAccess(useOrgDashboard());
}

export function GatewayDashboardCapabilityGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const dashboard = useOrgDashboard();
  const access = getGatewayDashboardAccess(dashboard);

  useEffect(() => {
    if (access === "denied" && !dashboard.orgError) router.replace("/dashboard");
  }, [access, dashboard.orgError, router]);

  if (dashboard.orgError && access !== "checking") {
    return <DenNotice tone="error" message={dashboard.orgError} />;
  }

  if (access !== "enabled") {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-[14px] text-gray-500" data-testid="gateway-access-state" data-access-state={access}>
        {access === "checking" ? "Checking workspace access..." : access === "unavailable"
          ? "This feature is not part of your deployment system, please ask an instance admin to configure deployment"
          : "Redirecting to your dashboard..."}
      </div>
    );
  }

  // A new organization must not inherit provider/editor state from another one.
  return <Fragment key={dashboard.orgId}>{children}</Fragment>;
}
