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

/** The analytics screen filters by the "project" dimension only. */
export const PROJECT_DIMENSION = "project";

const REQUEST_TIMEOUT_MS = 12000;

/**
 * GET an org-scoped telemetry endpoint. Network errors and non-2xx responses
 * collapse to null; the zod parse at each call site turns that into the
 * screen's empty state instead of a crash.
 */
async function getTelemetryPayload(path: string): Promise<unknown> {
  try {
    const { response, payload } = await requestJson(path, { method: "GET" }, REQUEST_TIMEOUT_MS);
    return response.ok ? payload : null;
  } catch {
    return null;
  }
}

function lastSeenTime(item: TelemetryDimensionListItem): number {
  const time = Date.parse(item.lastSeenAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Project filter options, most recently active first, then alphabetical. */
export function useProjectOptions(enabled: boolean): TelemetryDimensionListItem[] {
  const { data } = useQuery({
    queryKey: ["telemetry", "dimensions", PROJECT_DIMENSION],
    enabled,
    queryFn: async () => {
      const search = new URLSearchParams({ type: PROJECT_DIMENSION });
      const payload = await getTelemetryPayload(`/v1/telemetry/dimensions?${search}`);
      const parsed = telemetryDimensionListResponseSchema.safeParse(payload);
      return parsed.success ? parsed.data.items : [];
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
  return useQuery({
    queryKey: ["telemetry", "analytics", PROJECT_DIMENSION, projectValue || "all"],
    enabled,
    queryFn: async (): Promise<TelemetryAnalyticsResponse | null> => {
      const search = projectValue
        ? `?${new URLSearchParams({ dimensionType: PROJECT_DIMENSION, dimensionValue: projectValue })}`
        : "";
      const payload = await getTelemetryPayload(`/v1/telemetry/analytics${search}`);
      const parsed = telemetryAnalyticsResponseSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
  });
}
