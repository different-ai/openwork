"use client";

import {
  gatewayUsageLimitPolicySchema,
  gatewayUsagePolicyWriteSchema,
  gatewayUsageResetRequestSchema,
  gatewayUsageResetPageSchema,
  type GatewayUsageResetPage,
  gatewayUsageStatusSchema,
  type GatewayUsageLimitPolicy,
  type GatewayUsagePolicyWrite,
} from "@openwork/types/den/gateway-usage-limits";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";

const policiesPath = "/v1/gateway/usage-limit-policies";
const membersPath = "/v1/gateway/usage-limits/members";
const resetsPath = "/v1/gateway/usage-limit-reset-requests";
const policiesSchema = z.object({ policies: z.array(gatewayUsageLimitPolicySchema) });
const assignmentsSchema: z.ZodType<Pick<GatewayUsageLimitPolicy, "assignments">> = z.object({
  assignments: z.array(z.object({ id: z.string(), memberId: z.string().nullable(), teamId: z.string().nullable(), organization: z.boolean().default(false) })),
});
const membersSchema = z.object({ members: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })) });
export type GatewayUsageMember = z.infer<typeof membersSchema>["members"][number];

export function gatewayLimitsKey(orgId: string): string[] {
  return ["gateway-usage-limits", orgId];
}

export class GatewayLimitsRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class GatewayLimitsWriteUncertainError extends Error {
  constructor() {
    super("The update’s outcome could not be verified. Close this dialog and refresh the current state before attempting another update; it may already have succeeded.");
  }
}

async function requestLimits<T>(orgId: string, path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
  const isWrite = Boolean(init.method && init.method !== "GET");
  const { response, payload } = await requestJson(path, {
    ...init,
    method: init.method ?? "GET",
    headers: { [ORG_SCOPE_HEADER]: orgId },
    cache: "no-store",
  }, 15000).catch((error: unknown) => {
    if (isWrite) throw new GatewayLimitsWriteUncertainError();
    throw error;
  });
  if (!response.ok) {
    const message = getErrorMessage(payload, "Could not load or update Gateway usage limits.");
    throw new GatewayLimitsRequestError(response.status === 409
      ? `${message} This policy or request has changed. Refresh and review the latest state before trying again.`
      : message, response.status);
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    if (isWrite) throw new GatewayLimitsWriteUncertainError();
    throw new Error("Gateway usage limits returned an invalid response. Refresh to verify the current state.");
  }
  return result.data;
}

const queryDefaults = { retry: false, staleTime: 0, gcTime: 0 };

export function useGatewayPolicies(orgId: string) {
  return useQuery({ ...queryDefaults, queryKey: [...gatewayLimitsKey(orgId), "policies"],
    queryFn: ({ signal }) => requestLimits(orgId, policiesPath, policiesSchema, { signal }),
  });
}

export function useGatewayAssignments(orgId: string, policyId: string) {
  return useQuery({ ...queryDefaults, queryKey: [...gatewayLimitsKey(orgId), "assignments", policyId],
    queryFn: ({ signal }) => requestLimits(orgId, `${policiesPath}/${encodeURIComponent(policyId)}/assignments`, assignmentsSchema, { signal }),
  });
}

export function useGatewayMembers(orgId: string, query: string) {
  return useQuery({ ...queryDefaults, queryKey: [...gatewayLimitsKey(orgId), "members", query],
    queryFn: ({ signal }) => requestLimits(orgId, `${membersPath}?${new URLSearchParams({ query })}`, membersSchema, { signal }),
  });
}

export function useGatewayMemberUsage(orgId: string, memberId: string) {
  return useQuery({ ...queryDefaults, queryKey: [...gatewayLimitsKey(orgId), "usage", memberId], enabled: Boolean(memberId),
    queryFn: async ({ signal }) => {
      const status = await requestLimits(orgId, `${membersPath}/${encodeURIComponent(memberId)}`, gatewayUsageStatusSchema, { signal });
      if (status.organizationId !== orgId || status.memberId !== memberId) throw new Error("Gateway usage returned a different member or organization. Refresh to try again.");
      if ((status.state === "unlimited") !== (status.buckets.length === 0)) throw new Error("Gateway usage returned inconsistent limits. Refresh to try again.");
      return status;
    },
  });
}

export function useGatewayResetHistoryAvailable(orgId: string) {
  return useQuery({
    ...queryDefaults,
    queryKey: [...gatewayLimitsKey(orgId), "reset-history-available"],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ view: "history", limit: "1" });
      const page = await requestLimits(orgId, `${resetsPath}?${params}`, gatewayUsageResetPageSchema, { signal });
      if (page.view !== "history" || page.limit !== 1) {
        throw new Error("Could not verify previous increase requests. Refresh to try again.");
      }
      return page.requests.length > 0;
    },
  });
}

export function useGatewayResetRequests(orgId: string, view: GatewayUsageResetPage["view"]) {
  const client = useQueryClient();
  const queryKey = [...gatewayLimitsKey(orgId), "reset-requests", view];
  const query = useInfiniteQuery({
    ...queryDefaults,
    queryKey,
    initialPageParam: "",
    queryFn: async ({ signal, pageParam }) => {
      const params = new URLSearchParams({ view, limit: "50" });
      if (pageParam) params.set("cursor", pageParam);
      const page = await requestLimits(orgId, `${resetsPath}?${params}`, gatewayUsageResetPageSchema, { signal });
      if (page.view !== view || page.limit !== 50 || page.hasMore !== Boolean(page.nextCursor)
        || (page.hasMore && (!page.requests.length || page.nextCursor === pageParam))) {
        throw new Error("Gateway increase requests returned inconsistent pagination. Refresh from the first page.");
      }
      return page;
    },
    getNextPageParam: (page) => page.hasMore ? page.nextCursor : undefined,
  });
  return { ...query, restart: () => client.resetQueries({ queryKey, exact: true }) };
}

export type GatewayLimitsAction =
  | { type: "save"; policy?: Pick<GatewayUsageLimitPolicy, "id" | "revision">; body: GatewayUsagePolicyWrite }
  | { type: "archive"; policy: Pick<GatewayUsageLimitPolicy, "id" | "revision"> }
  | { type: "assign"; policyId: string; target: { memberId: string } | { teamId: string } | { organization: true } }
  | { type: "unassign"; policyId: string; assignmentId: string }
  | { type: "approve" | "deny"; requestId: string };

export async function mutateGatewayLimits(orgId: string, action: GatewayLimitsAction) {
  if (action.type === "save") {
    const body = gatewayUsagePolicyWriteSchema.parse(action.body);
    return requestLimits(orgId, action.policy ? `${policiesPath}/${encodeURIComponent(action.policy.id)}` : policiesPath, gatewayUsageLimitPolicySchema, {
      method: action.policy ? "PATCH" : "POST",
      body: JSON.stringify(action.policy ? { ...body, revision: action.policy.revision } : body),
    });
  }
  if (action.type === "archive") return requestLimits(orgId, `${policiesPath}/${encodeURIComponent(action.policy.id)}/archive`, gatewayUsageLimitPolicySchema, {
    method: "POST", body: JSON.stringify({ revision: action.policy.revision }),
  });
  if (action.type === "assign") return requestLimits(orgId, `${policiesPath}/${encodeURIComponent(action.policyId)}/assignments`, gatewayUsageLimitPolicySchema, {
    method: "POST", body: JSON.stringify(action.target),
  });
  if (action.type === "unassign") return requestLimits(orgId, `${policiesPath}/${encodeURIComponent(action.policyId)}/assignments/${encodeURIComponent(action.assignmentId)}`, gatewayUsageLimitPolicySchema, { method: "DELETE" });
  return requestLimits(orgId, `${resetsPath}/${encodeURIComponent(action.requestId)}/${action.type}`, gatewayUsageResetRequestSchema, { method: "POST", body: "{}" });
}

export function useGatewayLimitsMutation(orgId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...gatewayLimitsKey(orgId), "write"],
    mutationFn: (action: GatewayLimitsAction) => mutateGatewayLimits(orgId, action),
    retry: false,
    onSettled: () => client.invalidateQueries({ queryKey: gatewayLimitsKey(orgId) }),
  });
}

export function microUsdDecimal(value: number): string {
  const amount = BigInt(value);
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${amount / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function formatLimitMoney(value: number): string {
  const [whole, fraction = ""] = microUsdDecimal(Math.abs(value)).split(".");
  return `${value < 0 ? "−" : ""}$${BigInt(whole).toLocaleString("en-US")}.${fraction.padEnd(2, "0")}`;
}

export function newGatewayPolicy(): GatewayUsagePolicyWrite {
  return { name: "", hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "" }] };
}

export function editGatewayPolicy(policy: GatewayUsageLimitPolicy): GatewayUsagePolicyWrite {
  return { name: policy.name, hardLimit: policy.hardLimit, allowRequestReset: policy.allowRequestReset,
    limits: policy.limits.map((limit) => ({ timeframe: limit.timeframe, costUsd: microUsdDecimal(limit.costLimitMicroUsd) })),
  };
}
