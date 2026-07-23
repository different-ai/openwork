"use client";

import { Activity } from "lucide-react";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EgressDiagnosticsCard } from "./egress-diagnostics-card";

export function DiagnosticsScreen() {
  const { orgContext } = useOrgDashboard();
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles,
  );

  return (
    <DashboardPageTemplate
      icon={Activity}
      title="Diagnostics"
      description="Run controlled support checks from the same network path used by enterprise connectors."
      colors={["#CFFAFE", "#0F172A", "#0E7490", "#F0FDFA"]}
    >
      <EgressDiagnosticsCard canView={access.canViewSettings} canManage={access.canManageSettings} />
    </DashboardPageTemplate>
  );
}
