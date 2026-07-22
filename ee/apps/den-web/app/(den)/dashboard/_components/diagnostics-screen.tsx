"use client";

import { Activity } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { EgressDiagnosticsCard } from "./egress-diagnostics-card";

export function DiagnosticsScreen() {
  return (
    <DashboardPageTemplate
      icon={Activity}
      title="Diagnostics"
      description="Run controlled support checks from the same network path used by enterprise connectors."
      colors={["#CFFAFE", "#0F172A", "#0E7490", "#F0FDFA"]}
    >
      <EgressDiagnosticsCard canRun />
    </DashboardPageTemplate>
  );
}
