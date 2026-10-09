"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { skillUsagePath, skillUsageReportSchema, type SkillUsageWindow } from "./skill-usage-data";

/** True when the signed-in member can view usage analytics in an organization with Skill usage on. */
export function useSkillUsageAvailable() {
  const { orgContext } = useOrgDashboard();
  const member = orgContext?.currentMember;
  const canView = member ? getOrgAccessFlags(member.role, member.isOwner, member.permissions).canViewUsageAnalytics : false;
  return canView && orgFeatureEnabled(orgContext, "skillUsage");
}

export function useSkillUsage(days: SkillUsageWindow) {
  const { orgId, orgContext, orgBusy, orgError, mutationBusy } = useOrgDashboard();
  const available = useSkillUsageAvailable();
  const enabled = Boolean(orgId && orgContext?.organization.id === orgId && available && !orgBusy && !orgError && mutationBusy !== "switch-organization");

  return useQuery({
    queryKey: ["skill-usage", orgId, orgContext?.currentMember.id, days],
    enabled,
    queryFn: async ({ signal }) => {
      if (!orgId) throw new Error("Skill usage needs a workspace.");
      const { response, payload } = await requestJson(skillUsagePath(days), { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 20_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Could not load skill usage (${response.status}).`));
      return skillUsageReportSchema.parse(payload);
    },
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  });
}
