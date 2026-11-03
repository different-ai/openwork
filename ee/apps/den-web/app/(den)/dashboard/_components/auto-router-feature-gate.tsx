"use client";

import { DenNotice } from "../../_components/ui/notice";
import { orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

/** Smart Router pages exist only for organizations with the Smart Model Router feature (`autoRouter`). */
export function SmartRouterFeatureGate({ children }: { children: React.ReactNode }) {
  const { orgContext } = useOrgDashboard();
  if (!orgContext) return null;
  if (!orgFeatureEnabled(orgContext, "autoRouter")) {
    return <DenNotice tone="neutral" message="Smart Routers aren't turned on for your organization yet. Ask OpenWork to turn on the Smart Model Router." />;
  }
  return <>{children}</>;
}
