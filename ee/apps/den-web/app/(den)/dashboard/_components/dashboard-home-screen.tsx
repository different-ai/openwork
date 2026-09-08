"use client";

import { getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { DashboardOverviewScreen } from "./dashboard-overview-screen";
import { MemberDashboardScreen } from "./member-dashboard-screen";

export function DashboardHomeScreen() {
  const { orgContext, mutationBusy } = useOrgDashboard();

  // A workspace switch keeps the previous orgContext around while the next one
  // loads. Keep refreshes in place, but avoid showing the wrong home while switching.
  const switching = mutationBusy === "switch-organization";
  if (!orgContext || switching) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-6 text-[14px] text-gray-500">
        Loading your workspace...
      </div>
    );
  }

  const access = getOrgAccessFlags(
    orgContext.currentMember.role,
    orgContext.currentMember.isOwner,
    orgContext.roles,
  );

  return access.isAdmin ? <DashboardOverviewScreen /> : <MemberDashboardScreen />;
}
