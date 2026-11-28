"use client";

import { DenSkeleton } from "../../../_components/ui/skeleton";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { RowListSkeleton } from "./computer-rows";
import { ComputersScreen } from "./computers-screen";
import { OrganizationInventoryScreen } from "./inventory-admin-screen";

export function ComputersInventoryRoute() {
  const { orgId, orgContext, orgSlug } = useOrgDashboard();
  if (!orgId || !orgContext || orgId !== orgContext.organization.id) return <div aria-busy="true" aria-label="Computers"><DenSkeleton className="mb-8 h-6 w-32" /><RowListSkeleton rows={5} /></div>;
  if (!orgFeatureEnabled(orgContext, "computers")) return <ComputersScreen />;
  const { currentMember, organization } = orgContext;
  const access = getOrgAccessFlags(currentMember.role, currentMember.isOwner, currentMember.permissions);
  if (!access.canViewComputers) return <ComputersScreen />;
  return <OrganizationInventoryScreen key={`${orgId}:${currentMember.id}`} scope={{ orgId, memberId: currentMember.id, admin: true, orgName: organization.name }}
    orgSlug={orgSlug} canDisconnect={access.canDisconnectComputers} />;
}
