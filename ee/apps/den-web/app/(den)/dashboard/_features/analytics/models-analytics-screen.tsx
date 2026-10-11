"use client";

import { useQuery } from "@tanstack/react-query";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { getInferenceRoute } from "../../../_lib/den-org";
import { parseInferencePayload } from "../../../_lib/inference-status";
import { useDenFlow } from "../../../_providers/den-flow-provider";
import { ModelsAnalyticsPanel } from "../../_components/models-analytics-panel";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { AnalyticsEmptyState, AnalyticsErrorState, AnalyticsLoading, AnalyticsPageHeader, analyticsPageClass, analyticsIntegratedPageClass, analyticsSurfaceClass, useAnalyticsIntegrated } from "./analytics-layout";
import { UsageLimitsCard } from "./usage-limits-card";

export function ModelsAnalyticsScreen() {
  const { activeOrg, orgContext } = useOrgDashboard();
  const integrated = useAnalyticsIntegrated();
  const { runtimeConfig, runtimeConfigLoaded } = useDenFlow();
  const hosted = runtimeConfigLoaded && runtimeConfig.orgMode === "multi_org";
  const status = useQuery({
    queryKey: ["models-usage-limits", orgContext?.organization.id],
    enabled: hosted && Boolean(orgContext),
    refetchInterval: 30_000,
    queryFn: async () => {
      const { response, payload } = await requestJson("/v1/inference", { method: "GET" }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Could not load model usage."));
      const parsed = parseInferencePayload(payload);
      if (!parsed) throw new Error("Could not load model usage.");
      return parsed;
    },
  });

  return <div className={integrated ? analyticsIntegratedPageClass : analyticsPageClass}>
    <AnalyticsPageHeader orgSlug={activeOrg?.slug} active="models" title="Models & usage" />
    {!runtimeConfigLoaded ? integrated ? <AnalyticsLoading label="Loading model usage" /> : <p role="status">Loading model usage…</p> : !hosted ? (
      <div className={analyticsSurfaceClass}><AnalyticsEmptyState title="OpenWork Models is available on OpenWork Cloud">
        Usage &amp; adoption covers activity across your connected providers.
      </AnalyticsEmptyState></div>
    ) : <>
      {status.isError ? integrated && !status.data ? <AnalyticsErrorState title="Couldn't load model usage" onRetry={() => void status.refetch()} retrying={status.isFetching} /> : <DenNotice tone={integrated ? "neutral" : "error"} presentation={integrated ? "inline" : "panel"} message={integrated ? "Couldn't refresh. Showing the last usage." : "Could not load model usage. Refresh this page to try again."} action={integrated ? <DenButton variant="secondary" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>Retry</DenButton> : undefined} /> : null}
      {status.isPending ? integrated ? <AnalyticsLoading label="Loading model usage" /> : <p role="status" className="text-sm text-[#637291]">Loading model usage…</p> : null}
      {status.data?.enabled && status.data.subscribed ? <>
        <UsageLimitsCard buckets={status.data.buckets} />
        <ModelsAnalyticsPanel key={orgContext?.organization.id} />
      </> : status.data ? <div className={analyticsSurfaceClass}>
        <AnalyticsEmptyState title="Model insights are included with OpenWork Models"
          action={<DenButton href={getInferenceRoute(activeOrg?.slug)}>Set up OpenWork Models</DenButton>}>
          Enable OpenWork Models for your workspace to see shared limits and choose whether to collect task analytics.
        </AnalyticsEmptyState>
      </div> : null}
    </>}
  </div>;
}
