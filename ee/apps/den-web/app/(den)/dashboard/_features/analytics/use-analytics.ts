"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  telemetryAnalyticsResponseSchema,
  telemetryDimensionListResponseSchema,
  type TelemetryAnalyticsResponse,
  type TelemetryDimensionListItem,
} from "@openwork-ee/telemetry-contracts";
import { requestJson } from "../../../_lib/den-flow";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";

/** The analytics screen filters by the "project" dimension only. */
export const PROJECT_DIMENSION = "project";

const REQUEST_TIMEOUT_MS = 12000;

async function getTelemetryPayload(path: string): Promise<unknown> {
  const { response, payload } = await requestJson(path, { method: "GET" }, REQUEST_TIMEOUT_MS);
  if (!response.ok) throw new Error("Could not load analytics. Try again.");
  return payload;
}

function lastSeenTime(item: TelemetryDimensionListItem): number {
  const time = Date.parse(item.lastSeenAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Project filter options, most recently active first, then alphabetical. */
export function useProjectOptions(enabled: boolean): TelemetryDimensionListItem[] {
  const { activeOrg } = useOrgDashboard();
  const { data } = useQuery({
    queryKey: ["telemetry", activeOrg?.id, "dimensions", PROJECT_DIMENSION],
    enabled: enabled && Boolean(activeOrg?.id),
    queryFn: async () => {
      const search = new URLSearchParams({ type: PROJECT_DIMENSION });
      const payload = await getTelemetryPayload(`/v1/telemetry/dimensions?${search}`);
      return telemetryDimensionListResponseSchema.parse(payload).items;
    },
  });

  return useMemo(() => {
    const items = data ?? [];
    return [...items].sort(
      (a, b) => lastSeenTime(b) - lastSeenTime(a) || a.label.localeCompare(b.label),
    );
  }, [data]);
}

/** Org usage analytics, optionally narrowed to one project. */
export function useAnalytics(enabled: boolean, projectValue: string) {
  const { activeOrg } = useOrgDashboard();
  return useQuery({
    queryKey: ["telemetry", activeOrg?.id, "analytics", PROJECT_DIMENSION, projectValue || "all"],
    enabled: enabled && Boolean(activeOrg?.id),
    refetchInterval: 30_000,
    queryFn: async (): Promise<TelemetryAnalyticsResponse> => {
      const search = projectValue
        ? `?${new URLSearchParams({ dimensionType: PROJECT_DIMENSION, dimensionValue: projectValue })}`
        : "";
      const payload = await getTelemetryPayload(`/v1/telemetry/analytics${search}`);
      return telemetryAnalyticsResponseSchema.parse(payload);
    },
  });
}
