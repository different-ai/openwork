"use client";

import {
  normalizeAgentPermissionSettings,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { getOrgAccessFlags, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { PERMISSION_READ_STALE_TIME } from "./permissions-query-keys";

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

export function agentPermissionsQueryKey(orgId: string, viewerId?: string): string[] {
  return viewerId === undefined ? ["agent-permissions", orgId] : ["agent-permissions", orgId, viewerId];
}

export class AgentPermissionsReadError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function useAgentPermissions(orgId: string, enabled = true) {
  const { orgContext } = useOrgDashboard();
  const client = useQueryClient();
  const viewerId = orgContext?.organization.id === orgId ? orgContext.currentMember.id : "";
  const canRead = Boolean(viewerId && orgContext && orgFeatureEnabled(orgContext, "agentPermissions") && getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canViewAgentPermissions);
  const key = agentPermissionsQueryKey(orgId, viewerId);
  const query = useQuery<AgentPermissionPolicies | null>({
    queryKey: key,
    enabled: enabled && canRead,
    retry: false,
    staleTime: PERMISSION_READ_STALE_TIME,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      const { response, payload } = await requestJson(AGENT_PERMISSIONS_PATH, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal }, 15000);
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) {
          await client.cancelQueries({ queryKey: key, exact: true }, { revert: false });
          client.setQueryData(key, null);
        }
        throw new AgentPermissionsReadError(getErrorMessage(payload, `Couldn't load agent permissions (${response.status}).`), response.status);
      }
      const parsed = listSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Agent permissions returned an unexpected response.");
      return { everyone: toPolicy(parsed.data.everyone), teams: parsed.data.teams.map(toPolicy), canEdit: parsed.data.canEdit };
    },
  });
  const blocked = query.data === null || query.error instanceof AgentPermissionsReadError && [401, 403, 404].includes(query.error.status);
  return { ...query, data: canRead && !blocked ? query.data ?? undefined : undefined, isSuccess: canRead && query.isSuccess && !blocked, isError: query.isError || blocked, error: blocked ? new Error("Couldn't verify access to agent permissions. Try again.") : query.error };
}

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
          if (!response.ok) throw getRequestError(payload, response, `Couldn't save agent permissions (${response.status}).`);
        }
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentPermissionsQueryKey(orgId) }),
  });
}

/** Removes a team's agent permissions, so its members get Everyone's again. */
export function useRemoveTeamAgentPermissions(orgId: string, teamId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationKey: [...agentPermissionsQueryKey(orgId), "remove", teamId],
    retry: false,
    mutationFn: async () => {
      await runReauthableAction("remove-team-agent-permissions", async () => {
        const { response, payload } = await requestJson(
          scopePath(teamId),
          { method: "DELETE", headers: { [ORG_SCOPE_HEADER]: orgId } },
          15000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Couldn't remove these agent permissions (${response.status}).`);
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentPermissionsQueryKey(orgId) }),
  });
}

/** Whether a team has its own agent permissions: a saved record, not Everyone's. */
export function hasTeamRecord(policy: AgentPermissionPolicy): boolean {
  return policy.scopeId !== EVERYONE_SCOPE && policy.updatedAt !== null;
}

/** A team's own agent permissions, counted for lists: "1 override", or null while it follows Everyone. */
export function teamOverrideSummary(policy: AgentPermissionPolicy | undefined): string | null {
  if (!policy || !hasTeamRecord(policy)) return null;
  const count = Object.keys(normalizeAgentPermissionSettings(policy.settings)).length;
  if (count === 0) return null;
  return `${count} ${count === 1 ? "override" : "overrides"}`;
}
