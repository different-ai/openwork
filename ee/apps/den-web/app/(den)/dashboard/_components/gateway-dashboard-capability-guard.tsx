"use client";

import { Fragment } from "react";
import { LockKeyhole } from "lucide-react";
import { DenNotice } from "../../_components/ui/notice";
import { gatewayAreaLockedMessage, getGatewayDashboardAccess, type GatewayDashboardArea } from "../_lib/gateway-dashboard-access";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function useGatewayDashboardAccess(area: GatewayDashboardArea = "any") {
  return getGatewayDashboardAccess(useOrgDashboard(), area);
}

export function GatewayDashboardCapabilityGuard({ area, children }: { area: GatewayDashboardArea; children: React.ReactNode }) {
  const dashboard = useOrgDashboard();
  const access = getGatewayDashboardAccess(dashboard, area);

  if (dashboard.orgError && access !== "checking") {
    return <DenNotice tone="error" message={dashboard.orgError} />;
  }

  if (access === "denied") {
    return (
      <div data-testid="gateway-access-state" data-access-state="denied">
        <DenNotice tone="neutral" icon={LockKeyhole} message={gatewayAreaLockedMessage(area)} />
      </div>
    );
  }

  if (access !== "enabled") {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 text-[14px] text-gray-500" data-testid="gateway-access-state" data-access-state={access}>
        {access === "checking" ? "Checking workspace access..."
          : "This feature is not part of your deployment system, please ask an instance admin to configure deployment"}
      </div>
    );
  }

  // A new organization must not inherit provider/editor state from another one.
  return <Fragment key={dashboard.orgId}>{children}</Fragment>;
}
