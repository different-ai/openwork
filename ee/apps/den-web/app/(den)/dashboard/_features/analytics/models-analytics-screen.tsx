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
import { AnalyticsEmptyState, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "./analytics-layout";
import { UsageLimitsCard } from "./usage-limits-card";

export function ModelsAnalyticsScreen() {
  const { activeOrg, orgContext } = useOrgDashboard();
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

  return <div className={analyticsPageClass}>
    <AnalyticsPageHeader orgSlug={activeOrg?.slug} active="models" title="Models & usage"
      description="Understand your team’s OpenWork Models activity, consumption, and shared limits."
      caption="Included with OpenWork Models · Task analytics requires your team’s opt-in" />
    {!runtimeConfigLoaded ? <p role="status">Loading model usage…</p> : !hosted ? (
      <div className={analyticsSurfaceClass}><AnalyticsEmptyState title="OpenWork Models is available on OpenWork Cloud">
        Usage &amp; adoption covers activity across your connected providers.
      </AnalyticsEmptyState></div>
    ) : <>
      {status.isError ? <DenNotice tone="error" message="Could not load model usage. Refresh this page to try again." /> : null}
      {status.isPending ? <p role="status" className="text-sm text-[#637291]">Loading model usage…</p> : null}
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
