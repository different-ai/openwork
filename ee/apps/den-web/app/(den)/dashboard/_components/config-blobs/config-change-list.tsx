"use client";

import type { ConfigChangeRequestSummary } from "@openwork/types/den/config-blobs";
import { DenButton } from "../../../_components/ui/button";
import { DenChip } from "../../../_components/ui/chip";
import { DenList, DenListRow } from "../../../_components/ui/list-row";
import { DenNotice } from "../../../_components/ui/notice";
import { getConfigChangeRequestRoute } from "../../../_lib/den-org";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useConfigChangeRequests } from "./config-blobs-data";
import { formatRelativeTime } from "./config-blobs-model";
import { ConfigCounts, ConfigRowSkeleton, ConfigStatusChip } from "./config-blobs-parts";

export function changeRequestTitle(request: Pick<ConfigChangeRequestSummary, "title" | "source" | "revertsChangeRequestId">): string {
  if (request.title) return request.title;
  if (request.source === "revert") return "Revert of an earlier change";
  return request.source === "api" ? "Import from the API" : "Import";
}

export function changeRequestByline(request: ConfigChangeRequestSummary): string {
  const who = request.createdBy.apiKeyName
    ? `API key ${request.createdBy.apiKeyName}`
    : request.createdBy.name ?? "Someone";
  const from = request.sourceOrganization ? ` from ${request.sourceOrganization.name}${request.sourceDeployment === "self_hosted" ? " (self-hosted)" : ""}` : "";
  const areas = `${request.areas.length} ${request.areas.length === 1 ? "area" : "areas"}`;
  return `${who}${from}, ${formatRelativeTime(request.createdAt)}. ${areas}, ${request.mode === "mirror" ? "mirror" : "merge"}`;
}

export function ConfigChangeList({ state, emptyMessage }: { state: "open" | "closed"; emptyMessage: string }) {
  const { orgId, activeOrg } = useOrgDashboard();
  const query = useConfigChangeRequests(orgId, state);

  if (query.isError) {
    return <DenNotice tone="error" message={query.error.message} action={<DenButton variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</DenButton>} />;
  }
  if (query.isPending) {
    return <DenList>{[0, 1, 2].map((index) => <ConfigRowSkeleton key={index} />)}</DenList>;
  }
  const requests = query.data.changeRequests;
  if (requests.length === 0) {
    return <p className="py-6 text-[13px] text-gray-500" data-testid={`config-${state}-empty`}>{emptyMessage}</p>;
  }

  return (
    <DenList>
      {requests.map((request) => {
        const blocking = request.summary?.blocking ?? 0;
        return (
          <DenListRow
            key={request.id}
            href={getConfigChangeRequestRoute(activeOrg?.slug, request.id)}
            title={changeRequestTitle(request)}
            chips={(
              <>
                <ConfigStatusChip status={request.status} />
                {request.status === "needs_review" && blocking > 0 ? <DenChip tone="neutral">{blocking} to decide</DenChip> : null}
              </>
            )}
            meta={changeRequestByline(request)}
            action={<ConfigCounts summary={request.summary} />}
            dataAttributes={{ "data-testid": "config-change-row", "data-change-request-id": request.id }}
          />
        );
      })}
    </DenList>
  );
}
