"use client";

import {
  cloudCodingInstallCompleteInputSchema,
  cloudCodingInstallStartInputSchema,
  cloudCodingInstallationChoicesSchema,
  cloudCodingOverviewSchema,
  cloudCodingPushApprovalSchema,
  cloudCodingPushDecisionInputSchema,
  cloudCodingRedirectSchema,
  cloudCodingSettingsInputSchema,
  type CloudCodingOverview,
  type CloudCodingPushDecisionInput,
  type CloudCodingSettingsInput,
} from "@openwork/types/den/cloud-coding";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getRequestError, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";

const base = "/v1/cloud-coding";
const overviewKey = (orgId: string) => ["cloud-coding", orgId, "overview"] as const;
const approvalKey = (orgId: string, approvalId: string) => ["cloud-coding", orgId, "approval", approvalId] as const;
const approvalPath = (id: string) => `/approvals/${encodeURIComponent(id)}`;
const emailSentSchema = z.object({ sent: z.literal(true) });
const noContentSchema = z.null();

export class CloudCodingApprovalUnavailable extends Error {}

function useCloudCodingRequest(orgId: string) {
  const { runReauthableAction } = useOrgDashboard();
  return async function request<T>(path: string, schema: z.ZodType<T>, fallback: string, options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
    approval?: boolean;
  } = {}): Promise<T> {
    const result: { parsed?: { data: T } } = {};
    await runReauthableAction(`cloud-coding:${options.method ?? "GET"}:${path}`, async () => {
      const { response, payload } = await requestJson(`${base}${path}`, {
        method: options.method ?? "GET",
        headers: { [ORG_SCOPE_HEADER]: orgId },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        signal: options.signal,
      });
      if (!response.ok) {
        const error = getRequestError(payload, response, fallback);
        if (options.approval && response.status === 404) throw new CloudCodingApprovalUnavailable(error.message);
        throw error;
      }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new Error(fallback);
      result.parsed = parsed;
    });
    if (!result.parsed) throw new Error(fallback);
    return result.parsed.data;
  };
}

export function useCloudCodingOverview(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  return useQuery({
    queryKey: overviewKey(orgId),
    queryFn: ({ signal }) => request("", cloudCodingOverviewSchema, "Couldn't load Cloud coding. Try again.", { signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useCloudCodingInstallations(orgId: string, enabled: boolean) {
  const request = useCloudCodingRequest(orgId);
  return useQuery({
    queryKey: ["cloud-coding", orgId, "installations"],
    queryFn: ({ signal }) => request("/github/installations", cloudCodingInstallationChoicesSchema, "Couldn't load GitHub accounts. Try again.", { signal }),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useCloudCodingSettings(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  const queryClient = useQueryClient();
  const key = overviewKey(orgId);
  return useMutation({
    mutationFn: (change: CloudCodingSettingsInput) => request("/settings", cloudCodingOverviewSchema, "Couldn't save Cloud coding settings. Try again.", {
      method: "PUT", body: cloudCodingSettingsInputSchema.parse(change),
    }),
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<CloudCodingOverview>(key);
      if (previous && change.enabled !== undefined) {
        queryClient.setQueryData<CloudCodingOverview>(key, { ...previous, enabled: change.enabled });
      }
      return { previous };
    },
    onError: (_error, change, context) => {
      if (change.enabled !== undefined && context?.previous) {
        const enabled = context.previous.enabled;
        queryClient.setQueryData<CloudCodingOverview>(key, (current) => current && { ...current, enabled });
      }
    },
    onSuccess: (overview) => { queryClient.setQueryData(key, overview); },
  });
}

export function useCloudCodingInstallStart(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  return useMutation({ mutationFn: (existing: boolean) => request("/github/install/start", cloudCodingRedirectSchema, "Couldn't open GitHub. Try again.", {
    method: "POST", body: cloudCodingInstallStartInputSchema.parse(existing ? { existing: true } : {}),
  }) });
}

export function useCloudCodingInstallComplete(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (installationId: number) => request("/github/install/complete", cloudCodingOverviewSchema, "Couldn't connect that GitHub account. Try again.", {
      method: "POST", body: cloudCodingInstallCompleteInputSchema.parse({ installationId }),
    }),
    onSuccess: (overview) => { queryClient.setQueryData(overviewKey(orgId), overview); },
  });
}

export function useCloudCodingSync(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => request("/github/sync", cloudCodingOverviewSchema, "Couldn't refresh repositories from GitHub. Try again.", { method: "POST" }),
    onSuccess: (overview) => { queryClient.setQueryData(overviewKey(orgId), overview); },
  });
}

export function useCloudCodingLinkStart(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  return useMutation({ mutationFn: () => request("/github/link/start", cloudCodingRedirectSchema, "Couldn't open GitHub. Try again.", { method: "POST" }) });
}

export function useCloudCodingUnlink(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => request("/github/link", noContentSchema, "Couldn't unlink GitHub. Try again.", { method: "DELETE" }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: overviewKey(orgId) }); },
  });
}

export function useCloudCodingSendLink(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  return useMutation({ mutationFn: (memberId: string) => request(`/people/${encodeURIComponent(memberId)}/send-link`, emailSentSchema, "Couldn't send the GitHub link. Try again.", { method: "POST" }) });
}

export function useCloudCodingAdminRequest(orgId: string) {
  const request = useCloudCodingRequest(orgId);
  return useMutation({ mutationFn: () => request("/admin-requests", emailSentSchema, "Couldn't ask your admins. Try again.", { method: "POST" }) });
}

export function useCloudCodingApproval(orgId: string, approvalId: string) {
  const request = useCloudCodingRequest(orgId);
  return useQuery({
    queryKey: approvalKey(orgId, approvalId),
    staleTime: 0,
    queryFn: ({ signal }) => request(approvalPath(approvalId), cloudCodingPushApprovalSchema, "Couldn't load this request. Try again.", { signal, approval: true }),
    refetchInterval: ({ state }) => {
      const approval = state.data;
      return !approval?.pullRequest && (approval?.status === "approved" || approval?.status === "pushed") && !(state.error instanceof CloudCodingApprovalUnavailable) ? 3000 : false;
    },
    retry: false,
  });
}

export function useCloudCodingDecision(orgId: string, approvalId: string) {
  const request = useCloudCodingRequest(orgId);
  const queryClient = useQueryClient();
  const key = approvalKey(orgId, approvalId);
  return useMutation({
    mutationFn: (decision: CloudCodingPushDecisionInput["decision"]) => request(`${approvalPath(approvalId)}/decision`, cloudCodingPushApprovalSchema, "Couldn't save your decision. Try again.", {
      method: "POST", body: cloudCodingPushDecisionInputSchema.parse({ decision }), approval: true,
    }),
    onMutate: async () => { await queryClient.cancelQueries({ queryKey: key }); },
    onSuccess: (approval) => { queryClient.setQueryData(key, approval); },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: key }); },
  });
}
