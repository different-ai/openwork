"use client";

import { getOrgAccessFlags } from "../../_lib/den-org";
import { useFeatureIntro } from "../_features/feature-intros";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { DashboardOverviewScreen } from "./dashboard-overview-screen";
import { MemberDashboardScreen } from "./member-dashboard-screen";

export function DashboardHomeScreen() {
  const { orgContext, orgBusy, mutationBusy } = useOrgDashboard();
  useFeatureIntro("home", orgContext ? {} : null);

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
    orgContext.currentMember.permissions,
  );

  return access.isAdmin ? <DashboardOverviewScreen /> : <MemberDashboardScreen />;
}
