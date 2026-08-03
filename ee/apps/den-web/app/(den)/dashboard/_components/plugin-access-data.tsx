"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type PluginAccessRole = "viewer" | "editor" | "manager";

export type PluginAccessGrant = {
  id: string;
  orgMembershipId: string | null;
  teamId: string | null;
  orgWide: boolean;
  role: PluginAccessRole;
  createdByOrgMembershipId: string;
  createdAt: string;
  removedAt: string | null;
};

export const pluginAccessQueryKeys = {
  all: ["plugin-access"],
  detail: (pluginId: string) => [...pluginAccessQueryKeys.all, pluginId],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = readString(value);
  return parsed ?? undefined;
}

function readRole(value: unknown): PluginAccessRole | null {
  if (value === "viewer" || value === "editor" || value === "manager") return value;
  return null;
}

function parsePluginAccessGrant(value: unknown): PluginAccessGrant | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const orgMembershipId = readNullableString(value.orgMembershipId);
  const teamId = readNullableString(value.teamId);
  const role = readRole(value.role);
  const createdByOrgMembershipId = readString(value.createdByOrgMembershipId);
  const createdAt = readString(value.createdAt);
  const removedAt = readNullableString(value.removedAt);
  const targetCount = (orgMembershipId ? 1 : 0) + (teamId ? 1 : 0) + (value.orgWide === true ? 1 : 0);
  if (
    !id
    || orgMembershipId === undefined
    || teamId === undefined
    || typeof value.orgWide !== "boolean"
    || !role
    || !createdByOrgMembershipId
    || !createdAt
    || removedAt === undefined
    || targetCount !== 1
  ) {
    return null;
  }
  return {
    id,
    orgMembershipId,
    teamId,
    orgWide: value.orgWide,
    role,
    createdByOrgMembershipId,
    createdAt,
    removedAt,
  };
}

export function usePluginAccess(pluginId: string) {
  return useQuery({
    enabled: Boolean(pluginId),
    queryKey: pluginAccessQueryKeys.detail(pluginId),
    queryFn: async (): Promise<PluginAccessGrant[]> => {
      const { response, payload } = await requestJson(
        `/v1/plugins/${encodeURIComponent(pluginId)}/access`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load plugin access (${response.status}).`));
      }
      const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
      return items
        .map(parsePluginAccessGrant)
        .filter((grant): grant is PluginAccessGrant => grant !== null && grant.removedAt === null);
    },
  });
}

type GrantPluginAccessBody =
  | { orgMembershipId: string; teamId?: never; orgWide?: never; role: PluginAccessRole }
  | { orgMembershipId?: never; teamId: string; orgWide?: never; role: PluginAccessRole }
  | { orgMembershipId?: never; teamId?: never; orgWide: true; role: PluginAccessRole };

export function useGrantPluginAccess() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { pluginId: string; body: GrantPluginAccessBody }) => {
      await runReauthableAction("grant-plugin-access", async () => {
        const { response, payload } = await requestJson(
          `/v1/plugins/${encodeURIComponent(input.pluginId)}/access`,
          { method: "POST", body: JSON.stringify(input.body) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to grant plugin access (${response.status}).`);
        }
      });
      return input.pluginId;
    },
    onSuccess: (pluginId) => {
      queryClient.invalidateQueries({ queryKey: pluginAccessQueryKeys.detail(pluginId) });
    },
  });
}

export function useRevokePluginAccess() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { pluginId: string; grantId: string }) => {
      await runReauthableAction("revoke-plugin-access", async () => {
        const { response, payload } = await requestJson(
          `/v1/plugins/${encodeURIComponent(input.pluginId)}/access/${encodeURIComponent(input.grantId)}`,
          { method: "DELETE" },
          15000,
        );
        if (response.status !== 204 && !response.ok) {
          throw getRequestError(payload, response, `Failed to revoke plugin access (${response.status}).`);
        }
      });
      return input.pluginId;
    },
    onSuccess: (pluginId) => {
      queryClient.invalidateQueries({ queryKey: pluginAccessQueryKeys.detail(pluginId) });
    },
  });
}
