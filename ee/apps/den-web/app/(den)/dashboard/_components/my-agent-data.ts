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

/**
 * My agent (`workbotProactive`): the member's own agent, read from and changed through `/v1/me/agent`, the same
 * API chat uses through Connect. A change here is saved as from the page.
 */

const agentPath = "/v1/me/agent";

export function myAgentQueryKey(orgId: string): string[] {
  return ["me-agent", orgId];
}

export function useMyAgent(orgId: string, enabled = true) {
  return useQuery({
    queryKey: myAgentQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    // Checks land in the background; keep the last check current while the page is open.
    refetchInterval: 60_000,
    queryFn: async ({ signal }): Promise<MemberAgentView> => {
      const { response, payload } = await requestJson(agentPath, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal }, 15000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't load your agent (${response.status}).`));
      const parsed = memberAgentViewSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Your agent returned an unexpected response.");
      return parsed.data;
    },
  });
}

/** The week's checks, for "Earlier this week"; loaded when it is opened. */
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

/** Saves one change and shows the agent as Den saved it. */
export function useSaveMyAgent(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  const key = myAgentQueryKey(orgId);
  return useMutation({
    mutationKey: [...key, "save"],
    retry: false,
    mutationFn: async (change: MemberAgentInput): Promise<MemberAgentView | null> => {
      const result: { saved: MemberAgentView | null } = { saved: null };
      await runReauthableAction("save-my-agent", async () => {
        const { response, payload } = await requestJson(agentPath, { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(change) }, 15000);
        if (!response.ok) throw getRequestError(payload, response, `Couldn't save (${response.status}).`);
        const parsed = memberAgentSavedSchema.safeParse(payload);
        result.saved = parsed.success ? parsed.data : null;
      });
      return result.saved;
    },
    onSuccess: (saved) => {
      if (saved) queryClient.setQueryData<MemberAgentView>(key, saved);
      else void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
