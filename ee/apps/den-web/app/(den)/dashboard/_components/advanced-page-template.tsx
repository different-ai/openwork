"use client";

import { Laptop, Palette, Store } from "lucide-react";
import { useRouter } from "next/navigation";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import {
  getBrandAppearanceRoute,
  getDesktopPoliciesRoute,
  getMarketplacesRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type AdvancedTab = "collections" | "desktop-policies" | "brand-appearance";

const ADVANCED_TABS: readonly TabItem<AdvancedTab>[] = [
  { value: "collections", label: "Collections", icon: Store },
  { value: "desktop-policies", label: "Desktop policies", icon: Laptop },
  { value: "brand-appearance", label: "Brand appearance", icon: Palette },
];

const ADVANCED_DESCRIPTIONS: Record<AdvancedTab, string> = {
  collections: "Collections contain plugins. The built-in OpenWork collection and assigned collections show up inside the desktop app after sign-in.",
  "desktop-policies": "Control which desktop capabilities are available to the whole org, specific members, or teams.",
  "brand-appearance": "Customize how your workspace appears across OpenWork.",
};

export function AdvancedPageTemplate({ tab, children }: { tab: AdvancedTab; children: React.ReactNode }) {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();

  function routeFor(next: AdvancedTab) {
    const routes: Record<AdvancedTab, string> = {
      collections: getMarketplacesRoute(orgSlug),
      "desktop-policies": getDesktopPoliciesRoute(orgSlug),
      "brand-appearance": getBrandAppearanceRoute(orgSlug),
    };
    return routes[next];
  }

  return (
    <DashboardPageTemplate
      title="Advanced"
      description={ADVANCED_DESCRIPTIONS[tab]}
      colors={["#F1F5F9", "#0F172A", "#475569", "#CBD5E1"]}
    >
      <div data-testid="advanced-tabs" className="mb-6">
        <UnderlineTabs
          tabs={ADVANCED_TABS}
          activeTab={tab}
          onChange={(next) => router.push(routeFor(next))}
        />
      </div>
      {children}
    </DashboardPageTemplate>
  );
}
