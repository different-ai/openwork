import { create } from "zustand";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { workspaceServerId } from "@/app/lib/workspace-endpoint";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { settleQuestionState } from "../sync/session-sync";
import type { AttentionTarget } from "./session-attention";
import { questionReplyOwnerKey } from "./question-reply-registry";

export type SessionAttentionOwners = {
  workspaces: RouteWorkspace[];
  endpointForWorkspace: (workspace: RouteWorkspace) => ResolvedWorkspaceEndpoint | null;
  cacheOwners?: Map<string, string | null>;
};

const runtimeCacheOwners = new Map<string, string | null>();

/** The legacy activity cache has no server namespace and also receives desktop
 * aliases. Never read or settle a key shared by different workspace owners.
 */
export function sessionAttentionCacheIds(input: SessionAttentionOwners): Record<string, string | null> {
  const owners = input.workspaces.map(workspace => {
    const endpoint = input.endpointForWorkspace(workspace);
    return { workspaceId: workspace.id, runtimeId: endpoint?.workspaceId ?? workspaceServerId(workspace),
      owner: endpoint ? questionReplyOwnerKey({ endpoint }) : null };
  });
  const history = input.cacheOwners ?? runtimeCacheOwners;
  for (const owner of owners) {
    if (!owner.owner) continue;
    for (const id of new Set([owner.workspaceId, owner.runtimeId])) {
      if (!history.has(id)) history.set(id, owner.owner);
      else if (history.get(id) !== owner.owner) history.set(id, null);
    }
  }
  // Removing a colliding alias cannot make its already contaminated cache safe.
  // This quarantine lives as long as the in-memory activity cache, until reload.
  return Object.fromEntries(owners.map(owner => [owner.workspaceId,
    owner.owner && history.get(owner.workspaceId) === owner.owner && history.get(owner.runtimeId) === owner.owner
      && !owners.some(other => other !== owner && other.owner !== owner.owner
      && [owner.workspaceId, owner.runtimeId].some(id => id === other.workspaceId || id === other.runtimeId))
      ? owner.runtimeId : null]));
}

export function resolveSessionAttentionTarget(input: SessionAttentionOwners, args: { workspaceId: string; sessionId: string }): AttentionTarget {
  const workspace = input.workspaces.find(workspace => workspace.id === args.workspaceId);
  const endpoint = workspace && input.endpointForWorkspace(workspace);
  const cacheId = sessionAttentionCacheIds(input)[args.workspaceId];
  if (!workspace || !endpoint || !workspace.path || cacheId !== endpoint.workspaceId) {
    throw new Error("The exact workspace is disconnected or its runtime cache owner is ambiguous.");
  }
  return { ...args, directory: workspace.path, endpoint };
}

export function settleSessionAttentionQuestion(input: SessionAttentionOwners, target: AttentionTarget, requestId: string) {
  const current = resolveSessionAttentionTarget(input, target);
  if (questionReplyOwnerKey(current) !== questionReplyOwnerKey(target)) throw new Error("Workspace owner changed.");
  settleQuestionState(current.endpoint.workspaceId, current.sessionId, requestId);
}

// A route publishes only owner-to-cache IDs, never clients, tokens, or content.
export const useSessionAttentionOwners = create<{ cacheIds: Record<string, string | null> }>(() => ({ cacheIds: {} }));
