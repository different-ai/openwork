"use client";

import {
  normalizeAgentPermissionSettings,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const AGENT_PERMISSIONS_PATH = "/v1/agent-permissions";

/** "everyone" or a team's id. */
export type AgentPermissionScopeId = string;
export const EVERYONE_SCOPE: AgentPermissionScopeId = "everyone";

export type AgentPermissionPolicy = {
  scopeId: AgentPermissionScopeId;
  teamId: string | null;
  name: string;
  memberCount: number | null;
  settings: AgentPermissionSettings;
  updatedAt: string | null;
};

export type AgentPermissionPolicies = {
  everyone: AgentPermissionPolicy;
  teams: AgentPermissionPolicy[];
  canEdit: boolean;
};

const policySchema = z.object({
  teamId: z.string().nullable(),
  name: z.string(),
  memberCount: z.number().int().nullable(),
  settings: z.unknown(),
  updatedAt: z.string().nullable(),
});

const listSchema = z.object({
  everyone: policySchema,
  teams: z.array(policySchema),
  canEdit: z.boolean(),
});

function toPolicy(policy: z.infer<typeof policySchema>): AgentPermissionPolicy {
  return {
    scopeId: policy.teamId ?? EVERYONE_SCOPE,
    teamId: policy.teamId,
    name: policy.name,
    memberCount: policy.memberCount,
    // Stored settings are already valid; normalizing keeps an older server's
    // unknown permissions out of the editor instead of failing the page.
    settings: normalizeAgentPermissionSettings(policy.settings),
    updatedAt: policy.updatedAt,
  };
}

export function agentPermissionsQueryKey(orgId: string): string[] {
  return ["agent-permissions", orgId];
}

export function useAgentPermissions(orgId: string) {
  return useQuery({
    queryKey: agentPermissionsQueryKey(orgId),
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }): Promise<AgentPermissionPolicies> => {
      const { response, payload } = await requestJson(
        AGENT_PERMISSIONS_PATH,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Couldn't load agent permissions (${response.status}).`));
      }
      const parsed = listSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Agent permissions returned an unexpected response.");
      return {
        everyone: toPolicy(parsed.data.everyone),
        teams: parsed.data.teams.map(toPolicy),
        canEdit: parsed.data.canEdit,
      };
    },
  });
}

export class AgentPermissionPlanRequiredError extends Error {}

function scopePath(scopeId: AgentPermissionScopeId): string {
  return scopeId === EVERYONE_SCOPE
    ? `${AGENT_PERMISSIONS_PATH}/everyone`
    : `${AGENT_PERMISSIONS_PATH}/teams/${encodeURIComponent(scopeId)}`;
}

/** Saves each scope's settings in turn; the first failure stops and is thrown. */
export function useSaveAgentPermissions(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationKey: [...agentPermissionsQueryKey(orgId), "save"],
    retry: false,
    mutationFn: async (changes: { scopeId: AgentPermissionScopeId; settings: AgentPermissionSettings }[]) => {
      await runReauthableAction("save-agent-permissions", async () => {
        for (const change of changes) {
          const { response, payload } = await requestJson(
            scopePath(change.scopeId),
            {
              method: "PUT",
              headers: { [ORG_SCOPE_HEADER]: orgId, "content-type": "application/json" },
              body: JSON.stringify({ settings: change.settings }),
            },
            15000,
          );
          if (response.status === 402) throw new AgentPermissionPlanRequiredError("Agent permissions are part of the Enterprise plan.");
          if (!response.ok) throw getRequestError(payload, response, `Couldn't save agent permissions (${response.status}).`);
        }
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentPermissionsQueryKey(orgId) }),
  });
}
