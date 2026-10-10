"use client";

import { useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useDenFlow } from "../../../_providers/den-flow-provider";
import { getGatewayDashboardAccess } from "../../_lib/gateway-dashboard-access";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { fetchDashboardActivity, type ActivityVersions } from "./activity-data";

export function useDashboardActivity() {
  const dashboard = useOrgDashboard();
  const { user } = useDenFlow();
  const { orgId, orgSlug, orgContext, orgBusy, orgError, mutationBusy } = dashboard;
  const member = orgContext?.currentMember;
  const isAdmin = member ? getOrgAccessFlags(member.role, member.isOwner, member.permissions).isAdmin : false;
  const enabled = Boolean(
    user && member?.userId === user.id && orgId && orgContext?.organization.id === orgId &&
    isAdmin && orgFeatureEnabled(orgContext, "dashboardActivity") && !orgBusy && !orgError && mutationBusy !== "switch-organization",
  );
  const gatewayEnabled = getGatewayDashboardAccess(dashboard, "providers") === "enabled";

  return useQuery({
    // Include both identity and readiness: neither an organization switch nor a
    // membership/permission change may display another scope's cached rows.
    queryKey: ["dashboard-activity", orgId, user?.id, member?.id, enabled, gatewayEnabled],
    enabled,
    queryFn: async ({ signal, client }) => {
      if (!enabled || !orgId) throw new Error("Activity requires an active workspace administrator.");
      const versionKey = (skillId: string, latestVersionId: string) =>
        ["dashboard-activity-versions", orgId, user?.id, member?.id, skillId, latestVersionId];
      return fetchDashboardActivity({
        orgSlug,
        gatewayEnabled,
        signal,
        versionCache: {
          get: (skillId, latestVersionId) => client.getQueryData<ActivityVersions>(versionKey(skillId, latestVersionId)),
          set: (skillId, latestVersionId, versions) => {
            client.setQueryData(versionKey(skillId, latestVersionId), versions);
          },
        },
        request: async (path, requestSignal) => {
          requestSignal.throwIfAborted();
          // requestJson delegates the deadline when a caller supplies a signal.
          const controller = new AbortController();
          const cancel = () => controller.abort(requestSignal.reason);
          requestSignal.addEventListener("abort", cancel, { once: true });
          const timeout = setTimeout(() => controller.abort(), 30_000);
          try {
            const { response, payload } = await requestJson(path, {
              method: "GET",
              headers: { [ORG_SCOPE_HEADER]: orgId },
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new Error(getErrorMessage(payload, `Could not load workspace activity (${response.status}).`));
            }
            return payload;
          } finally {
            clearTimeout(timeout);
            requestSignal.removeEventListener("abort", cancel);
          }
        },
      });
    },
    // A rejection leaves TanStack Query's complete previous data intact. Do not
    // catch errors into []: initial errors and genuinely empty snapshots differ.
    retry: false,
    staleTime: 60_000,
    // Existing content APIs are not cheap metadata reads. Refresh on returning
    // to the dashboard/focusing it, not a full organization scan every minute.
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}
