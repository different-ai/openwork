"use client";

import { Shield } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { getBillingRoute, getOrgAccessFlags, orgFeatureEnabled, permissionLockReason } from "../../_lib/den-org";
import { FeatureIntroGate } from "../_features/feature-intros";
import type { AuthSecurityFacts, AuthSecuritySsoState } from "../_features/feature-intros/intros/auth-security";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ssoIntroState, ssoIntroStateForConnections } from "./auth-security-intro-facts";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { LEGACY_SSO_ENDPOINTS, SsoConnectionPanel } from "./sso-connection-panel";
import { SsoConnectionsManager } from "./sso-connections-manager";
import { SsoRequirementSection } from "./sso-requirement-section";

const SSO_DESCRIPTION = "Configure one enterprise SSO connection per workspace and share the generated sign-in URL with your team.";
const SSO_MULTIPLE_DESCRIPTION = "Connect each identity provider your people sign in with. Everyone on a connection's domains can use it.";

/** The page shell on its own route; inside Auth & Security the tab names it, so no second title (P2). */
function SsoFrame({ embedded, description, children }: { embedded: boolean; description: string; children: ReactNode }) {
  if (embedded) return <div data-testid="sso-tab-content">{children}</div>;
  return <DashboardPageTemplate icon={Shield} title="SSO" description={description}>{children}</DashboardPageTemplate>;
}

export type SsoScreenProps = {
  /** Shown as the Single sign-on tab of Settings › Auth & Security. */
  embedded?: boolean;
  /** `?setup=1` from an intro's action: open the setup form instead of the intro (DESIGN.md I5). */
  setupMode?: boolean;
  /** Latest setup facts, so the Auth & Security section intro follows changes made here. */
  onIntroFacts?: (facts: AuthSecurityFacts) => void;
};

/** SSO settings: the single connection, or every connection with multipleSsoConnections. */
export function SsoScreen({ embedded = false, setupMode = false, onIntroFacts }: SsoScreenProps = {}) {
  const { orgContext } = useOrgDashboard();
  const [introState, setIntroState] = useState<AuthSecuritySsoState | null>(null);
  const access = useMemo(
    () => getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role, orgContext?.currentMember.permissions],
  );

  // Feature intro facts (DESIGN.md I2) once the connections have loaded; embedded in Auth & Security only.
  const ssoIncluded = orgContext?.entitlements.sso;
  useEffect(() => {
    if (!embedded || !introState || ssoIncluded === undefined) return;
    onIntroFacts?.({ sso: introState, ssoIncluded });
  }, [embedded, introState, ssoIncluded, onIntroFacts]);
  // `?setup=1` skips the intro that stands in for an empty form; a saved connection still gets its banner.
  const introFacts = embedded && introState && ssoIncluded !== undefined && !(setupMode && introState === "none")
    ? { sso: introState, ssoIncluded }
    : null;

  if (!orgContext) {
    return (
      <SsoFrame embedded={embedded} description="Set up enterprise single sign-on for this workspace.">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">Loading organization details...</div>
      </SsoFrame>
    );
  }

  const multiple = orgFeatureEnabled(orgContext, "multipleSsoConnections");
  const ssoSettingsOnSsoPage = orgFeatureEnabled(orgContext, "ssoSettingsOnSsoPage");

  return (
    <SsoFrame embedded={embedded} description={multiple ? SSO_MULTIPLE_DESCRIPTION : SSO_DESCRIPTION}>
      {!access.canViewSso ? (
        <div className="rounded-[28px] border border-[var(--dls-border)] bg-[var(--dls-hover)] px-6 py-5 text-[14px] text-[var(--dls-text-primary)]">{permissionLockReason("sso.view")}</div>
      ) : (
        <FeatureIntroGate introKey="auth-security.sso" facts={introFacts}>
          {!orgContext.entitlements.sso ? (
            <EnterprisePlanNotice feature="SSO" plan="team" billingHref={getBillingRoute(orgContext.organization.slug)} />
          ) : null}
          {!access.canManageSso ? (
            <div className="mb-6 rounded-[24px] border border-[var(--dls-border)] bg-[var(--dls-hover)] px-5 py-4 text-[14px] text-[var(--dls-text-primary)]">
              {`Read only. ${permissionLockReason("sso.manage")}`}
            </div>
          ) : null}

          {ssoSettingsOnSsoPage ? <SsoRequirementSection /> : null}

          {multiple ? (
            <SsoConnectionsManager setupMode={setupMode} onConnectionsChange={(connections) => setIntroState(ssoIntroStateForConnections(connections))} />
          ) : (
            <SsoConnectionPanel endpoints={LEGACY_SSO_ENDPOINTS} onConnectionChange={(connection) => setIntroState(ssoIntroState(connection))} />
          )}
        </FeatureIntroGate>
      )}
    </SsoFrame>
  );
}
