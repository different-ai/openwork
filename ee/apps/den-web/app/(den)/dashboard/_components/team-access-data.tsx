"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type TeamPluginAccessEdge = "direct_team" | "via_catalog" | "org_wide";
export type TeamPluginAccessRole = "viewer" | "editor" | "manager";

export type TeamPluginAccessItem = {
  plugin: {
    id: string;
    name: string;
    componentCount: number;
  };
  edge: TeamPluginAccessEdge;
  marketplace: {
    id: string;
    name: string;
  } | null;
  role: TeamPluginAccessRole;
  grantedBy: {
    orgMembershipId: string;
    name: string;
  } | null;
  grantedAt: string;
  grantId: string | null;
};

export const teamAccessQueryKeys = {
  all: ["team-access"],
  detail: (teamId: string) => ["team-access", "detail", teamId],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseEdge(value: unknown): TeamPluginAccessEdge | null {
  if (value === "direct_team" || value === "via_catalog" || value === "org_wide") {
    return value;
  }
  return null;
}

function parseRole(value: unknown): TeamPluginAccessRole | null {
  if (value === "viewer" || value === "editor" || value === "manager") {
    return value;
  }
  return null;
}

function parseTeamPluginAccessItem(entry: unknown): TeamPluginAccessItem | null {
  if (!isRecord(entry) || !isRecord(entry.plugin)) return null;

  const pluginId = asString(entry.plugin.id);
  const pluginName = asString(entry.plugin.name);
  const componentCount = entry.plugin.componentCount;
  const edge = parseEdge(entry.edge);
  const role = parseRole(entry.role);
  const grantedAt = asString(entry.grantedAt);
  if (
    !pluginId
    || !pluginName
    || typeof componentCount !== "number"
    || !Number.isFinite(componentCount)
    || componentCount < 0
    || !edge
    || !role
    || !grantedAt
  ) {
    return null;
  }

  let marketplace: TeamPluginAccessItem["marketplace"] = null;
  if (entry.marketplace !== null) {
    if (!isRecord(entry.marketplace)) return null;
    const id = asString(entry.marketplace.id);
    const name = asString(entry.marketplace.name);
    if (!id || !name) return null;
    marketplace = { id, name };
  }
  if (edge === "via_catalog" && !marketplace) return null;

  let grantedBy: TeamPluginAccessItem["grantedBy"] = null;
  if (entry.grantedBy !== null) {
    if (!isRecord(entry.grantedBy)) return null;
    const orgMembershipId = asString(entry.grantedBy.orgMembershipId);
    const name = asString(entry.grantedBy.name);
    if (!orgMembershipId || !name) return null;
    grantedBy = { orgMembershipId, name };
  }

  const grantId = entry.grantId === null ? null : asString(entry.grantId);
  if (entry.grantId !== null && !grantId) return null;

  return {
    plugin: { id: pluginId, name: pluginName, componentCount },
    edge,
    marketplace,
    role,
    grantedBy,
    grantedAt,
    grantId,
  };
}

export function useTeamPluginAccess(teamId: string) {
  return useQuery({
    queryKey: teamAccessQueryKeys.detail(teamId),
    queryFn: async (): Promise<TeamPluginAccessItem[]> => {
      const { response, payload } = await requestJson(
        `/v1/teams/${encodeURIComponent(teamId)}/plugin-access`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load team access (${response.status}).`));
      }

      const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
      return items
        .map(parseTeamPluginAccessItem)
        .filter((item): item is TeamPluginAccessItem => item !== null);
    },
  });
}

export function useRevokeTeamPluginAccess() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { teamId: string; pluginId: string; grantId: string }) => {
      await runReauthableAction("revoke-team-plugin-access", async () => {
        const { response, payload } = await requestJson(
          `/v1/plugins/${encodeURIComponent(input.pluginId)}/access/${encodeURIComponent(input.grantId)}`,
          { method: "DELETE" },
          15000,
        );
        if (response.status !== 204 && !response.ok) {
          throw getRequestError(payload, response, `Failed to revoke access (${response.status}).`);
        }
      });
      return input.teamId;
    },
    onSuccess: (teamId) => {
      queryClient.invalidateQueries({ queryKey: teamAccessQueryKeys.detail(teamId) });
    },
  });
}
