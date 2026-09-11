"use client";

import type { GatewayUsageGroupBy, GatewayUsageResponse } from "@openwork/types/den/gateway-usage";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";

const groupBySchema = z.enum(["model", "team", "person"]);
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.object({ id: z.string().min(1), label: z.string().min(1) });

const usageResponseSchema: z.ZodType<GatewayUsageResponse> = z.object({
  usage: z.object({
    groupBy: groupBySchema,
    days: z.number().int().min(1).max(366),
    from: z.iso.date(),
    to: z.iso.date(),
    timezone: z.literal("UTC"),
    emptyReason: z.literal("no_teams").optional(),
    totalTokens: countSchema,
    totalCostMicroUsd: countSchema,
    unreportedRequests: countSchema.nullable(),
    unpricedRequests: countSchema.nullable(),
    series: z.array(identitySchema),
    daily: z.array(z.object({
      date: z.iso.date(),
      totalTokens: countSchema,
      values: z.record(z.string(), countSchema),
      totalCostMicroUsd: countSchema,
      costValues: z.record(z.string(), countSchema.nullable()),
    })),
    filterOptions: z.array(identitySchema),
  }),
});

export function useGatewayUsage(orgId: string, groupBy: GatewayUsageGroupBy, filterIds: string[]) {
  return useQuery<GatewayUsageResponse["usage"]>({
    queryKey: ["gateway-usage", orgId, groupBy, [...filterIds].sort()],
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    // Only filter options use this placeholder, never counts or chart data.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === orgId && previous?.groupBy === groupBy ? previous : undefined,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ groupBy, days: "31" });
      if (filterIds.length) params.set("filterIds", [...filterIds].sort().join(","));
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(new DOMException("Gateway usage request timed out. Try again.", "TimeoutError")), 15_000);
      const { response, payload } = await requestJson(`/v1/inference-providers/usage?${params}`, {
        method: "GET",
        headers: { [ORG_SCOPE_HEADER]: orgId },
        signal: controller.signal,
        cache: "no-store",
      }).finally(() => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      });
      if (!response.ok) throw new Error(getErrorMessage(payload, "Could not load Gateway usage. Try again."));
      const parsed = usageResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Gateway usage returned an invalid response. Try again once the usage API is available.");
      const { usage } = parsed.data;
      const seriesIds = new Set(usage.series.map((series) => series.id));
      const from = Date.parse(`${usage.from}T00:00:00Z`);
      const daily = [...usage.daily].sort((a, b) => a.date.localeCompare(b.date));
      // Reject incomplete days or mismatched stacks rather than inventing zeros or totals.
      if (usage.groupBy !== groupBy || usage.days !== 31 || daily.length !== usage.days
        || seriesIds.size !== usage.series.length
        || new Set(usage.filterOptions.map((option) => option.id)).size !== usage.filterOptions.length
        || daily[daily.length - 1]?.date !== usage.to
        || daily.some((day, index) => day.date !== new Date(from + index * 86_400_000).toISOString().slice(0, 10)
           || Object.entries(day.values).some(([id]) => !seriesIds.has(id))
           || Object.keys(day.costValues).some((id) => !seriesIds.has(id))
           || Object.values(day.values).reduce((sum, value) => sum + value, 0) !== day.totalTokens
           || Object.values(day.costValues).reduce((sum: number, value) => sum + (value ?? 0), 0) !== day.totalCostMicroUsd)
        || daily.reduce((sum, day) => sum + day.totalTokens, 0) !== usage.totalTokens
        || daily.reduce((sum, day) => sum + day.totalCostMicroUsd, 0) !== usage.totalCostMicroUsd) {
        throw new Error("Gateway usage returned inconsistent daily totals. Try again.");
      }
      return { ...usage, daily };
    },
  });
}
