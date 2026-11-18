"use client";

import {
  GATEWAY_MEMBER_USAGE_DAYS,
  gatewayMemberUsageResponseSchema,
  type GatewayMemberUsageResponse,
} from "@openwork/types/den/gateway-member-usage";
import { gatewayUsageResetRequestSchema, gatewayUsageStatusSchema, type GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";

/**
 * The member's own usage for My Usage: their spend limits
 * (`GET /v1/gateway/usage-limits/me`), their past 30 days by model with the
 * models they can use (`GET /v1/gateway/usage/me`), and asking for more
 * (`POST /v1/gateway/usage-limit-reset-requests`). Never another member's data.
 */

export function myUsageKey(orgId: string): string[] {
  return ["my-usage", orgId];
}

const queryDefaults = { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false } as const;

async function requestOwn<T>(orgId: string, path: string, schema: z.ZodType<T>, fallback: string, init: RequestInit = {}): Promise<T> {
  const { response, payload } = await requestJson(path, {
    ...init,
    method: init.method ?? "GET",
    headers: { [ORG_SCOPE_HEADER]: orgId },
    cache: "no-store",
  }, 15_000);
  if (!response.ok) throw new Error(getErrorMessage(payload, fallback));
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error(`${fallback} The response was not what this page expects.`);
  return parsed.data;
}

/** Days in a response must be the asked-for UTC days, oldest first, each adding up to the totals. */
export function myUsageConsistent(data: GatewayMemberUsageResponse): boolean {
  const { usage } = data;
  const from = Date.parse(`${usage.from}T00:00:00Z`);
  const seriesIds = new Set(usage.series.map((series) => series.id));
  return usage.groupBy === "model"
    && usage.daily.length === usage.days
    && usage.daily[usage.daily.length - 1]?.date === usage.to
    && usage.daily.every((day, index) => day.date === new Date(from + index * 86_400_000).toISOString().slice(0, 10)
      && Object.keys(day.values).every((id) => seriesIds.has(id))
      && Object.keys(day.costValues).every((id) => seriesIds.has(id)))
    && usage.daily.reduce((sum, day) => sum + day.totalTokens, 0) === usage.totalTokens
    && usage.daily.reduce((sum, day) => sum + day.totalCostMicroUsd, 0) === usage.totalCostMicroUsd;
}

export function useMyGatewayUsage(orgId: string) {
  return useQuery({
    ...queryDefaults,
    queryKey: [...myUsageKey(orgId), "usage"],
    queryFn: async ({ signal }) => {
      const data = await requestOwn(orgId, `/v1/gateway/usage/me?days=${GATEWAY_MEMBER_USAGE_DAYS}`, gatewayMemberUsageResponseSchema,
        "Couldn’t load your usage.", { signal });
      if (!myUsageConsistent(data)) throw new Error("Your usage came back with totals that don’t add up. Try again.");
      return data;
    },
  });
}

export function useMyGatewayLimits(orgId: string) {
  return useQuery({
    ...queryDefaults,
    queryKey: [...myUsageKey(orgId), "limits"],
    queryFn: async ({ signal }) => {
      const status = await requestOwn(orgId, "/v1/gateway/usage-limits/me", gatewayUsageStatusSchema,
        "Couldn’t load your spend limits. This doesn’t mean you have no limit.", { signal });
      if (status.organizationId !== orgId) throw new Error("Your spend limits came back for a different organization. Refresh to try again.");
      return status;
    },
  });
}

/** Ask an admin for more on one used-up bucket. Admins answer in AI Gateway › Limits. */
export function useAskForMoreUsage(orgId: string) {
  const client = useQueryClient();
  const limitsKey = [...myUsageKey(orgId), "limits"];
  return useMutation({
    mutationKey: [...myUsageKey(orgId), "ask"],
    retry: false,
    mutationFn: (input: { bucketId: string; reason: string }) => requestOwn(orgId, "/v1/gateway/usage-limit-reset-requests", gatewayUsageResetRequestSchema,
      "Your request couldn’t be sent.", { method: "POST", body: JSON.stringify({ bucketId: input.bucketId, reason: input.reason.trim() }) }),
    onSuccess: (request) => {
      // Show "waiting for an admin" at once; the refetch below confirms it.
      client.setQueryData<GatewayUsageStatus>(limitsKey, (status) => {
        if (!status) return status;
        const pending = <T extends { id: string }>(bucket: T) => bucket.id === request.bucketId ? { ...bucket, canRequestReset: false, resetRequestStatus: request.status } : bucket;
        return { ...status, buckets: status.buckets.map(pending), ...(status.providers ? { providers: status.providers.map((provider) => ({ ...provider, buckets: provider.buckets.map(pending) })) } : {}) };
      });
    },
    onSettled: () => client.invalidateQueries({ queryKey: limitsKey, exact: true }),
  });
}
