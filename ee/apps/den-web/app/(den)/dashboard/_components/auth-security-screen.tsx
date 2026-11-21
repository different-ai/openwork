"use client";

import { KeyRound, SlidersHorizontal, UsersRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { type AuthSecurityTab, getAuthSecurityRoute } from "../../_lib/den-org";
import { FeatureIntroGate, useFeatureIntroRuntime, useFeatureIntroUnseen, type FeatureIntroKey } from "../_features/feature-intros";
import type { AuthSecurityFacts } from "../_features/feature-intros/intros/auth-security";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { AuthSecurityGeneral } from "./auth-security-general";
import { useAuthSecurityIntroFacts } from "./auth-security-intro-facts";
import { ScimScreen } from "./scim-screen";
import { SsoScreen } from "./sso-screen";

const TABS: readonly TabItem<AuthSecurityTab>[] = [
  { value: "general", label: "General", icon: SlidersHorizontal },
  { value: "sso", label: "Single sign-on (SSO)", icon: KeyRound },
  { value: "scim", label: "User provisioning (SCIM)", icon: UsersRound },
];

const AUTH_SECURITY_TAB_INTROS: Partial<Record<AuthSecurityTab, FeatureIntroKey>> = {
  sso: "auth-security.sso",
  scim: "auth-security.scim",
};

function readTab(value: string | null): AuthSecurityTab {
  return TABS.find((item) => item.value === value)?.value ?? TABS[0].value;
}

function tabUnseen(introUnseen: (key: FeatureIntroKey) => boolean, tab: AuthSecurityTab) {
  const intro = AUTH_SECURITY_TAB_INTROS[tab];
  return intro ? introUnseen(intro) : false;
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
  const introUnseen = useFeatureIntroUnseen();
  const introsEnabled = useFeatureIntroRuntime().enabled;
  const defaultTab = TABS[0].value;
  const tab = readTab(searchParams.get("tab"));
  const setupMode = searchParams.get("setup") === "1";

  const loadedFacts = useAuthSecurityIntroFacts(introsEnabled && Boolean(orgContext) && !setupMode);
  const [reported, setReported] = useState<AuthSecurityFacts>({});
  const reportFacts = useCallback((facts: AuthSecurityFacts) => {
    setReported((current) => ({ ...current, ...facts }));
  }, []);
  const sectionFacts = loadedFacts ? { ...loadedFacts, ...reported } : null;

  if (!orgContext) return null;

  function setTab(next: AuthSecurityTab) {
    const params = carriedParams(new URLSearchParams(searchParams.toString()));
    router.push(withQuery(getAuthSecurityRoute(orgSlug, next === defaultTab ? undefined : next), params), { scroll: false });
  }

  const page = (
    <DashboardPageTemplate title="Auth & Security" description={null}>
      <div data-testid="auth-security-tabs" className="mb-6">
        <UnderlineTabs
          tabs={TABS.map((item) => ({ ...item, unseen: tabUnseen(introUnseen, item.value) }))}
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
            ? <SsoScreen setupMode={setupMode} onIntroFacts={reportFacts} />
            : <ScimScreen setupMode={setupMode} onIntroFacts={reportFacts} />}
      </div>
    </DashboardPageTemplate>
  );

  if (setupMode || tab === "general") return page;
  return <FeatureIntroGate introKey="auth-security" facts={sectionFacts}>{page}</FeatureIntroGate>;
}
