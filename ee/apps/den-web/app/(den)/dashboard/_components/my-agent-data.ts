"use client";

import {
  memberAgentChecksSchema,
  memberAgentSavedSchema,
  memberAgentViewSchema,
  type MemberAgentCheck,
  type MemberAgentInput,
  type MemberAgentView,
} from "@openwork/types/den/workbot-proactive";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const agentPath = "/v1/me/agent";

export function myAgentQueryKey(orgId: string): string[] {
  return ["me-agent", orgId];
}

async function fetchAgent(orgId: string, signal: AbortSignal, toolCounts: "cached" | "discover"): Promise<MemberAgentView> {
  const { response, payload } = await requestJson(`${agentPath}?toolCounts=${toolCounts}`, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal }, 15000);
  if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load your agent (${response.status}).`));
  const parsed = memberAgentViewSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Your agent returned an unexpected response.");
  return parsed.data;
}

export function useMyAgent(orgId: string, enabled = true) {
  return useQuery({
    queryKey: myAgentQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    refetchInterval: 60_000,
    queryFn: ({ signal }) => fetchAgent(orgId, signal, "cached"),
  });
}

export function useMyAgentToolCounts(orgId: string, view: MemberAgentView | undefined) {
  const missing = (view?.sources ?? []).filter((source) => source.readTools === null
    && source.connections.some((connection) => connection.state === "connected")).map((source) => source.id).sort();
  return useQuery({
    queryKey: [...myAgentQueryKey(orgId), "tool-counts", missing],
    enabled: Boolean(orgId) && missing.length > 0,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const detail = await fetchAgent(orgId, signal, "discover");
      return Object.fromEntries((detail.sources ?? []).map((source) => [source.id, source.readTools]));
    },
  });
}

export function useMyAgentChecks(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...myAgentQueryKey(orgId), "checks"],
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: async ({ signal }): Promise<MemberAgentCheck[]> => {
      const { response, payload } = await requestJson(`${agentPath}/checks?days=7`, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal }, 15000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load this week's checks (${response.status}).`));
      const parsed = memberAgentChecksSchema.safeParse(payload);
      if (!parsed.success) throw new Error("This week's checks returned an unexpected response.");
      return parsed.data.checks;
    },
  });
}

export function useSaveMyAgent(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  const key = myAgentQueryKey(orgId);
  return useMutation({
    mutationKey: [...key, "save"],
    retry: false,
    mutationFn: async (changes: MemberAgentInput | MemberAgentInput[]) => {
      for (const change of Array.isArray(changes) ? changes : [changes]) {
        await runReauthableAction("save-my-agent", async () => {
          const { response, payload } = await requestJson(agentPath, { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(change) }, 15000);
          if (!response.ok) throw getRequestError(payload, response, `Couldn't save (${response.status}).`);
          const parsed = memberAgentSavedSchema.safeParse(payload);
          if (!parsed.success) throw new Error("Couldn't verify the saved settings.");
          await queryClient.cancelQueries({ queryKey: key, exact: true });
          queryClient.setQueryData<MemberAgentView>(key, parsed.data);
        });
      }
    },
    onError: () => { void queryClient.invalidateQueries({ queryKey: key, exact: true }); },
  });
}
