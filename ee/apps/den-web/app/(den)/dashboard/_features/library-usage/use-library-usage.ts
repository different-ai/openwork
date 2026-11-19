"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { getOrgAccessFlags } from "../../../_lib/den-org";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import {
  libraryUsageBreakdownPath,
  libraryUsageBreakdownSchema,
  libraryUsagePath,
  libraryUsageReportSchema,
  type LibraryUsageGrouping,
  type LibraryUsageKind,
  type LibraryUsageScope,
  type LibraryUsageWindow,
} from "./library-usage-data";

/** True when the signed-in member can view usage analytics. */
export function useLibraryUsageAvailable() {
  const { orgContext } = useOrgDashboard();
  const member = orgContext?.currentMember;
  return member ? getOrgAccessFlags(member.role, member.isOwner, member.permissions).canViewUsageAnalytics : false;
}

export function useLibraryUsage(kind: LibraryUsageKind, days: LibraryUsageWindow) {
  const { orgId, orgContext, orgBusy, orgError, mutationBusy } = useOrgDashboard();
  const available = useLibraryUsageAvailable();
  const enabled = Boolean(orgId && orgContext?.organization.id === orgId && available && !orgBusy && !orgError && mutationBusy !== "switch-organization");

  return useQuery({
    queryKey: ["library-usage", orgId, orgContext?.currentMember.id, kind, days],
    enabled,
    queryFn: async ({ signal }) => {
      if (!orgId) throw new Error("Library usage needs a workspace.");
      const { response, payload } = await requestJson(libraryUsagePath(kind, days), { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 20_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Could not load usage (${response.status}).`));
      return libraryUsageReportSchema.parse(payload);
    },
    // Keep the last counts while switching range; never show another view's rows.
    placeholderData: (previous) => previous?.kind === kind ? keepPreviousData(previous) : undefined,
    retry: false,
    staleTime: 60_000,
  });
}

/** One item's or one person's uses grouped by member, item or day. */
export function useLibraryUsageBreakdown(kind: LibraryUsageKind, days: LibraryUsageWindow, groupBy: LibraryUsageGrouping, scope: LibraryUsageScope) {
  const { orgId, orgContext, orgBusy, orgError, mutationBusy } = useOrgDashboard();
  const available = useLibraryUsageAvailable();
  const enabled = Boolean(orgId && orgContext?.organization.id === orgId && available && !orgBusy && !orgError && mutationBusy !== "switch-organization");
  const scopeKey = "itemId" in scope ? `item:${scope.itemId}` : `member:${scope.memberId}`;

  return useQuery({
    queryKey: ["library-usage-breakdown", orgId, orgContext?.currentMember.id, kind, days, groupBy, scopeKey],
    enabled,
    queryFn: async ({ signal }) => {
      if (!orgId) throw new Error("Library usage needs a workspace.");
      const { response, payload } = await requestJson(libraryUsageBreakdownPath(kind, days, groupBy, scope), { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 20_000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Could not load usage (${response.status}).`));
      return { scopeKey, groupBy, ...libraryUsageBreakdownSchema.parse(payload) };
    },
    // Keep the last counts while switching range, never another item's, person's or grouping's.
    placeholderData: (previous) => previous?.kind === kind && previous.scopeKey === scopeKey && previous.groupBy === groupBy ? keepPreviousData(previous) : undefined,
    retry: false,
    staleTime: 60_000,
  });
}
