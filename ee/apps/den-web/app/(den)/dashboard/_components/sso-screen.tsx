"use client";

import { useMemo } from "react";
import { getBillingRoute, getOrgAccessFlags, permissionLockReason } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { SsoConnectionsManager } from "./sso-connections-manager";
import { SsoRequirementSection } from "./sso-requirement-section";

export function SsoScreen() {
  const { orgContext } = useOrgDashboard();
  const access = useMemo(
    () => getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions),
    [orgContext?.currentMember.isOwner, orgContext?.currentMember.role, orgContext?.currentMember.permissions],
  );

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
        <>
          {!orgContext.entitlements.sso ? (
            <EnterprisePlanNotice feature="SSO" plan="team" billingHref={getBillingRoute(orgContext.organization.slug)} />
          ) : null}
          {!access.canManageSso ? (
            <div className="mb-6 rounded-[24px] border border-[var(--dls-border)] bg-[var(--dls-hover)] px-5 py-4 text-[14px] text-[var(--dls-text-primary)]">
              {`Read only. ${permissionLockReason("sso.manage")}`}
            </div>
          ) : null}

          <SsoRequirementSection />

          <SsoConnectionsManager />
        </>
      )}
    </div>
  );
}
