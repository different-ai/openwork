"use client";

import { getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { DashboardOverviewScreen } from "./dashboard-overview-screen";
import { MemberDashboardScreen } from "./member-dashboard-screen";

export function DashboardHomeScreen() {
  const { orgContext, orgBusy, mutationBusy } = useOrgDashboard();

  // A workspace switch keeps the previous orgContext around while the next one
  // loads. Rendering the neutral placeholder during that window (and while the
  // directory is loading) avoids flashing the wrong admin/member home layout.
  const switching = mutationBusy === "switch-organization";
  if (!orgContext || orgBusy || switching) {
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
