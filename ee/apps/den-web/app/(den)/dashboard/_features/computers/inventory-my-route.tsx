"use client";

import { DenSkeleton } from "../../../_components/ui/skeleton";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { RowListSkeleton } from "./computer-rows";
import { MyInventoryScreen } from "./inventory-my-screen";
import { MyComputersScreen } from "./my-computers-screen";

export function MyComputersInventoryRoute() {
  const { orgId, orgContext, orgSlug } = useOrgDashboard();
  if (!orgId || !orgContext || orgId !== orgContext.organization.id) return <div aria-busy="true" aria-label="My Computers"><DenSkeleton className="mb-8 h-6 w-36" /><RowListSkeleton rows={3} /></div>;
  if (!orgFeatureEnabled(orgContext, "computers")) return <MyComputersScreen />;
  const { currentMember, organization } = orgContext;
  const access = getOrgAccessFlags(currentMember.role, currentMember.isOwner, currentMember.permissions);
  return <MyInventoryScreen key={`${orgId}:${currentMember.id}`} scope={{ orgId, memberId: currentMember.id, admin: false, orgName: organization.name }}
    orgSlug={orgSlug} canViewComputers={access.canViewComputers} />;
}
