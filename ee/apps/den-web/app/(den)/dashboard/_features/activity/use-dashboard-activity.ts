"use client";

import { useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { getOrgAccessFlags } from "../../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useDenFlow } from "../../../_providers/den-flow-provider";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { fetchDashboardActivity } from "./activity-data";

export function useDashboardActivity() {
  const dashboard = useOrgDashboard();
  const { user } = useDenFlow();
  const { orgId, orgSlug, orgContext, orgBusy, orgError, mutationBusy } = dashboard;
  const member = orgContext?.currentMember;
  const isAdmin = member ? getOrgAccessFlags(member.role, member.isOwner, member.permissions).isAdmin : false;
  const enabled = Boolean(
    user && member?.userId === user.id && orgId && orgContext?.organization.id === orgId &&
    isAdmin && !orgBusy && !orgError && mutationBusy !== "switch-organization",
  );

  return useQuery({
    // Include both identity and readiness: neither an organization switch nor a
    // membership/permission change may display another scope's cached rows.
    queryKey: ["dashboard-activity", orgId, user?.id, member?.id, member?.permissions ?? null, enabled],
    enabled,
    queryFn: async ({ signal }) => {
      if (!enabled || !orgId) throw new Error("Activity requires an active workspace administrator.");
      return fetchDashboardActivity({
        orgSlug,
        signal,
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
    // Den computes the newest entries in one bounded read. Refresh on returning
    // to the dashboard or focusing it rather than polling.
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}
