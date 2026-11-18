"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { type AccessDraft, EMPTY_ACCESS } from "./access-summary";
import { libraryQueryKeys } from "./library-data";
import { mcpConnectionQueryKeys, useReplaceMcpConnectionAccess } from "./mcp-connections-data";
import { type GrantPluginAccessBody, type PluginAccessGrant, pluginAccessQueryKeys, useGrantPluginAccess, useRevokePluginAccess } from "./plugin-access-data";
import { pluginQueryKeys } from "./plugin-data";

export function draftFromPluginGrants(grants: readonly PluginAccessGrant[] | undefined): AccessDraft {
  if (!grants) return EMPTY_ACCESS;
  const active = grants.filter((grant) => grant.removedAt === null);
  return {
    orgWide: active.some((grant) => grant.orgWide),
    memberIds: [...new Set(active.flatMap((grant) => grant.orgMembershipId ? [grant.orgMembershipId] : []))],
    teamIds: [...new Set(active.flatMap((grant) => grant.teamId ? [grant.teamId] : []))],
  };
}

/** Moves a plugin's grants to the draft: grants what is new, revokes what was removed. */
export function useSavePluginAccess() {
  const queryClient = useQueryClient();
  const grant = useGrantPluginAccess();
  const revoke = useRevokePluginAccess();

  return useCallback(async (input: {
    pluginId: string;
    grants: readonly PluginAccessGrant[];
    next: AccessDraft;
    /** The owner's own grant is never removed from here. */
    ownerId: string | null;
  }) => {
    const { pluginId, next, ownerId } = input;
    const grants = input.grants.filter((entry) => entry.removedAt === null);
    const current = draftFromPluginGrants(grants);
    const revokes = grants.filter((entry) => {
      if (entry.orgWide) return !next.orgWide;
      if (entry.orgMembershipId) return entry.orgMembershipId !== ownerId && !next.memberIds.includes(entry.orgMembershipId);
      if (entry.teamId) return !next.teamIds.includes(entry.teamId);
      return false;
    });
    const adds: GrantPluginAccessBody[] = [];
    if (next.orgWide && !current.orgWide) adds.push({ orgWide: true, role: "viewer" });
    for (const orgMembershipId of next.memberIds.filter((id) => !current.memberIds.includes(id))) adds.push({ orgMembershipId, role: "viewer" });
    for (const teamId of next.teamIds.filter((id) => !current.teamIds.includes(id))) adds.push({ teamId, role: "viewer" });
    for (const body of adds) await grant.mutateAsync({ pluginId, body });
    for (const entry of revokes) await revoke.mutateAsync({ pluginId, grantId: entry.id });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: pluginAccessQueryKeys.detail(pluginId) }),
      queryClient.invalidateQueries({ queryKey: pluginQueryKeys.summaries() }),
      queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items }),
    ]);
  }, [grant, queryClient, revoke]);
}

export function useSaveConnectionAccess() {
  const queryClient = useQueryClient();
  const replace = useReplaceMcpConnectionAccess();
  return useCallback(async (connectionId: string, next: AccessDraft) => {
    await replace.mutateAsync({ connectionId, access: next });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all }),
      queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items }),
    ]);
  }, [queryClient, replace]);
}
