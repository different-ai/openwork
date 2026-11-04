"use client";

import { KeyRound, UsersRound } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { type AuthSecurityTab, getAuthSecurityRoute, getScimRoute, getSsoRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { FeatureIntroGate, useFeatureIntroRuntime, useFeatureIntroUnseen, type FeatureIntroKey } from "../_features/feature-intros";
import type { AuthSecurityFacts } from "../_features/feature-intros/intros/auth-security";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useAuthSecurityIntroFacts } from "./auth-security-intro-facts";
import { ScimScreen } from "./scim-screen";
import { SsoScreen } from "./sso-screen";

const AUTH_SECURITY_TABS: readonly TabItem<AuthSecurityTab>[] = [
  { value: "sso", label: "Single sign-on (SSO)", icon: KeyRound },
  { value: "scim", label: "User provisioning (SCIM)", icon: UsersRound },
];

/** Each tab's feature intro, for its unseen dot (DESIGN.md I9). */
const AUTH_SECURITY_TAB_INTROS: Record<AuthSecurityTab, FeatureIntroKey> = {
  sso: "auth-security.sso",
  scim: "auth-security.scim",
};

const DEFAULT_TAB: AuthSecurityTab = "sso";

function readTab(value: string | null): AuthSecurityTab {
  return AUTH_SECURITY_TABS.find((item) => item.value === value)?.value ?? DEFAULT_TAB;
}

/** Same query, minus our own `tab` and `setup`, so other deep-link parameters survive a redirect. */
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

/**
 * Settings › Auth & Security (feature `authSecuritySettings`): single sign-on
 * and user provisioning as tabs (`?tab=sso`, the default, and `?tab=scim`),
 * each the existing screen embedded. With the feature off this route sends
 * people to the separate SSO and SCIM pages, so links work either way.
 */
export function AuthSecurityScreen() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const router = useRouter();
  const searchParams = useSearchParams();
  const introUnseen = useFeatureIntroUnseen();
  const introsEnabled = useFeatureIntroRuntime().enabled;
  const featureOn = orgFeatureEnabled(orgContext, "authSecuritySettings");
  const tab = readTab(searchParams.get("tab"));
  const setupMode = searchParams.get("setup") === "1";

  const loadedFacts = useAuthSecurityIntroFacts(introsEnabled && featureOn && !setupMode);
  // What the tabs report after a change here wins over the section's first load.
  const [reported, setReported] = useState<AuthSecurityFacts>({});
  const reportFacts = useCallback((facts: AuthSecurityFacts) => {
    setReported((current) => ({ ...current, ...facts }));
  }, []);
  const sectionFacts = loadedFacts ? { ...loadedFacts, ...reported } : null;

  useEffect(() => {
    if (!orgContext || featureOn) return;
    router.replace(withQuery(tab === "scim" ? getScimRoute(orgSlug) : getSsoRoute(orgSlug), carriedParams(new URLSearchParams(searchParams.toString()))));
  }, [featureOn, orgContext, orgSlug, router, searchParams, tab]);

  // Until the organization (and so the feature) is known, or while sending people to the old page.
  if (!orgContext || !featureOn) return null;

  function setTab(next: AuthSecurityTab) {
    const params = carriedParams(new URLSearchParams(searchParams.toString()));
    router.push(withQuery(getAuthSecurityRoute(orgSlug, next === DEFAULT_TAB ? undefined : next), params), { scroll: false });
  }

  const page = (
    <DashboardPageTemplate title="Auth & Security" description={null}>
      <div data-testid="auth-security-tabs" className="mb-6">
        <UnderlineTabs
          tabs={AUTH_SECURITY_TABS.map((item) => ({ ...item, unseen: introUnseen(AUTH_SECURITY_TAB_INTROS[item.value]) }))}
          activeTab={tab}
          onChange={setTab}
        />
      </div>
      <div
        key={tab}
        role="tabpanel"
        aria-label={AUTH_SECURITY_TABS.find((item) => item.value === tab)?.label}
        data-testid={`auth-security-panel-${tab}`}
      >
        {tab === "sso"
          ? <SsoScreen embedded setupMode={setupMode} onIntroFacts={reportFacts} />
          : <ScimScreen embedded setupMode={setupMode} onIntroFacts={reportFacts} />}
      </div>
    </DashboardPageTemplate>
  );

  // `?setup=1` comes from an intro's action and goes straight to the form (DESIGN.md I5).
  if (setupMode) return page;
  // Nothing set up yet (no SSO connection, no SCIM connector): the section intro replaces the page (DESIGN.md I2).
  return <FeatureIntroGate introKey="auth-security" facts={sectionFacts}>{page}</FeatureIntroGate>;
}
