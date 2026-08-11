"use client";

import { Laptop } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DesktopPoliciesSection } from "./desktop-policies-section";

export function DesktopPoliciesScreen() {
  return (
    <DashboardPageTemplate
      icon={Laptop}
      title="Desktop controls"
      description="Control which desktop capabilities are available to the whole org, specific members, or teams."
      colors={["#F8FAFC", "#0F172A", "#38BDF8", "#A78BFA"]}
    >
      <DesktopPoliciesSection />
    </DashboardPageTemplate>
  );
}
