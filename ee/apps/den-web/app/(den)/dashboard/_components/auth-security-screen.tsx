"use client";

import { KeyRound, SlidersHorizontal, UsersRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { type AuthSecurityTab, getAuthSecurityRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AuthSecurityGeneral } from "./auth-security-general";
import { ScimScreen } from "./scim-screen";
import { SsoScreen } from "./sso-screen";

const TABS: readonly TabItem<AuthSecurityTab>[] = [
  { value: "general", label: "General", icon: SlidersHorizontal },
  { value: "sso", label: "Single sign-on (SSO)", icon: KeyRound },
  { value: "scim", label: "User provisioning (SCIM)", icon: UsersRound },
];

function readTab(value: string | null): AuthSecurityTab {
  return TABS.find((item) => item.value === value)?.value ?? TABS[0].value;
}

function carriedParams(searchParams: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(searchParams.toString());
  params.delete("tab");
  params.delete("setup");
  return params;
}

function withQuery(route: string, params: URLSearchParams): string {
  const query = params.toString();
  if (!query) return route;
  return `${route}${route.includes("?") ? "&" : "?"}${query}`;
}

export function AuthSecurityScreen() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();
  const defaultTab = TABS[0].value;
  const tab = readTab(searchParams.get("tab"));

  if (!orgContext) return null;

  function setTab(next: AuthSecurityTab) {
    const params = carriedParams(new URLSearchParams(searchParams.toString()));
    router.push(withQuery(getAuthSecurityRoute(orgSlug, next === defaultTab ? undefined : next), params), { scroll: false });
  }

  return (
    <DashboardPageTemplate title="Auth & Security" description={null}>
      <div data-testid="auth-security-tabs" className="mb-6">
        <UnderlineTabs
          tabs={TABS}
          activeTab={tab}
          onChange={setTab}
        />
      </div>
      <div
        key={tab}
        role="tabpanel"
        aria-label={TABS.find((item) => item.value === tab)?.label}
        data-testid={`auth-security-panel-${tab}`}
      >
        {tab === "general"
          ? <AuthSecurityGeneral />
          : tab === "sso"
            ? <SsoScreen />
            : <ScimScreen />}
      </div>
    </DashboardPageTemplate>
  );
}
