"use client";

import { useQuery } from "@tanstack/react-query";
import { workbotUsageResponseSchema } from "@openwork/types/den/workbot-usage";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useLibraryUsageAvailable } from "../library-usage/use-library-usage";

/** Whether this member has permission to view Workbot's cost analytics. */
export function useWorkbotUsageAvailable() {
  return useLibraryUsageAvailable();
}

/** What Workbot spent on models over the last 30 days. */
export function useWorkbotUsage() {
  const { orgId, orgContext, orgBusy, orgError, mutationBusy } = useOrgDashboard();
  const available = useWorkbotUsageAvailable();
  const enabled = Boolean(orgId && orgContext?.organization.id === orgId && available && !orgBusy && !orgError && mutationBusy !== "switch-organization");

  return useQuery({
    queryKey: ["workbot-usage", orgId, orgContext?.currentMember.id],
    enabled,
    queryFn: async ({ signal }) => {
      if (!orgId) throw new Error("Workbot usage needs a workspace.");
      const { response, payload } = await requestJson("/v1/workbot-usage", { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 20_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Could not load Workbot usage (${response.status}).`));
      return workbotUsageResponseSchema.parse(payload);
    },
    retry: false,
    staleTime: 60_000,
  });
}
