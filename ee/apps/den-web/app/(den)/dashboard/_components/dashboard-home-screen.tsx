"use client";

import { getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { DashboardOverviewScreen } from "./dashboard-overview-screen";
import { MemberDashboardScreen } from "./member-dashboard-screen";

export function DashboardHomeScreen() {
  const { orgBusy, orgContext, mutationBusy } = useOrgDashboard();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );

  // Switching keeps the old orgContext until the new one loads; route switches
  // through the placeholder so admin/member home layouts don't hard-swap and jump.
  if (orgBusy || mutationBusy === "switch-organization" || !orgContext) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-6 text-[14px] text-gray-500">
        Loading your workspace...
      </div>
    );
  }

  return access.isAdmin ? <DashboardOverviewScreen /> : <MemberDashboardScreen />;
}
