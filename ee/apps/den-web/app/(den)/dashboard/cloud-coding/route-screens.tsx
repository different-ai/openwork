"use client";

import { CloudCodingApprovalScreen } from "../_components/cloud-coding/cloud-coding-approval-screen";
import { CloudCodingLinkScreen } from "../_components/cloud-coding/cloud-coding-link-screen";
import { CloudCodingScreen } from "../_components/cloud-coding/cloud-coding-screen";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export function CloudCodingRoute() {
  const { orgId } = useOrgDashboard();
  return orgId ? <CloudCodingScreen key={orgId} orgId={orgId} /> : null;
}

export function CloudCodingLinkRoute() {
  const { orgId } = useOrgDashboard();
  return orgId ? <CloudCodingLinkScreen key={orgId} orgId={orgId} /> : null;
}

export function CloudCodingApprovalRoute({ approvalId }: { approvalId: string }) {
  const { orgId } = useOrgDashboard();
  return orgId ? <CloudCodingApprovalScreen key={`${orgId}:${approvalId}`} orgId={orgId} approvalId={approvalId} /> : null;
}
