"use client";

import { useEffect, useMemo, useState } from "react";
import { getBillingRoute, getOrgAccessFlags, permissionLockReason } from "../../_lib/den-org";
import { FeatureIntroGate } from "../_features/feature-intros";
import type { AuthSecurityFacts, AuthSecuritySsoState } from "../_features/feature-intros/intros/auth-security";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ssoIntroStateForConnections } from "./auth-security-intro-facts";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { SsoConnectionsManager } from "./sso-connections-manager";
import { SsoRequirementSection } from "./sso-requirement-section";

export type SsoScreenProps = {
  /** `?setup=1` from an intro's action: open the setup form instead of the intro (DESIGN.md I5). */
  setupMode?: boolean;
  /** Latest setup facts, so the Auth & Security section intro follows changes made here. */
  onIntroFacts?: (facts: AuthSecurityFacts) => void;
};

/**
 * The Single sign-on tab of Settings › Auth & Security: Require SSO and
 * every SSO connection. The tab names it, so no second title (P2).
 */
export function SsoScreen({ setupMode = false, onIntroFacts }: SsoScreenProps = {}) {
  const { orgContext } = useOrgDashboard();
  const [introState, setIntroState] = useState<AuthSecuritySsoState | null>(null);
  const access = useMemo(
    () => getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role, orgContext?.currentMember.permissions],
  );

  // Feature intro facts (DESIGN.md I2) once the connections have loaded.
  const ssoIncluded = orgContext?.entitlements.sso;
  useEffect(() => {
    if (!introState || ssoIncluded === undefined) return;
    onIntroFacts?.({ sso: introState, ssoIncluded });
  }, [introState, ssoIncluded, onIntroFacts]);
  // `?setup=1` skips the intro that stands in for an empty form; a saved connection still gets its banner.
  const introFacts = introState && ssoIncluded !== undefined && !(setupMode && introState === "none")
    ? { sso: introState, ssoIncluded }
    : null;

  if (!orgContext) {
    return (
      <div data-testid="sso-tab-content">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">Loading organization details...</div>
      </div>
    );
  }

  return (
    <div data-testid="sso-tab-content">
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

          <SsoRequirementSection />

          <SsoConnectionsManager setupMode={setupMode} onConnectionsChange={(connections) => setIntroState(ssoIntroStateForConnections(connections))} />
        </FeatureIntroGate>
      )}
    </div>
  );
}
