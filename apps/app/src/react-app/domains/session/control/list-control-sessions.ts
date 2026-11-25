import type { SessionLink } from "@openwork/types/session-link";
import { labelOpenworkSessionModel, type OpenworkCatalogModel, type OpenworkSessionActivityInventory, type OpenworkSessionModel } from "@openwork/types/openwork-affordance";

import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { SessionActivityStatus } from "../status/session-activity-store";
import { selectSessionAttention, type SessionAttention } from "../status/session-attention";

export type ControlSessionWorkspace = {
  id: string;
  name?: string | null;
  path?: string | null;
  displayName?: string | null;
};

export type ControlSessionEngineModel = {
  id?: string;
  providerID?: string;
  variant?: string | null;
};

export type ControlSessionLike = {
  id?: string;
  title?: string;
  parentID?: string | null;
  time?: {
    updated?: number;
    created?: number;
    archived?: number;
  };
  model?: ControlSessionEngineModel | null;
  openworkSessionLink?: SessionLink | null;
};

export type ListedControlSession = OpenworkSessionActivityInventory & {
  sessionId: string;
  title: string;
  workspace: string;
  updatedAt: number;
  pinned: boolean;
  status: SessionActivityStatus;
  model: OpenworkSessionModel | null;
};

export type ListControlSessionsState = {
  workspaces: ControlSessionWorkspace[];
  sessionsByWorkspaceId: Record<string, ControlSessionLike[]>;
  pinnedIds: readonly string[];
  modelCatalogByWorkspaceId?: Record<string, readonly OpenworkCatalogModel[]>;
  statusFor: (workspaceId: string, sessionId: string) => SessionActivityStatus;
  attentionFor?: (workspaceId: string, sessionId: string) => SessionAttention | undefined;
};

export function isWorkingStatus(status: SessionActivityStatus): boolean {
  return status !== "idle" && status !== "error";
}

export function controlSessionModel(session: ControlSessionLike): OpenworkSessionModel | null {
  const model = session.model;
  const providerId = model?.providerID?.trim();
  const modelId = model?.id?.trim();
  if (!providerId || !modelId) return null;
  const variant = model?.variant?.trim();
  return { providerId, modelId, variant: variant && variant !== "default" ? variant : null };
}

export function controlWorkspaceLabel(workspace: ControlSessionWorkspace) {
  return workspace.displayName?.trim() || workspace.name?.trim() || workspace.path?.trim() || "workspace";
}

function matchesWorkspace(workspace: ControlSessionWorkspace, query: string) {
  const lower = query.toLowerCase();
  return workspace.id.toLowerCase() === lower || controlWorkspaceLabel(workspace).toLowerCase() === lower;
}

function argsRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

export function listControlSessions(args: unknown, state: ListControlSessionsState): ListedControlSession[] {
  const record = argsRecord(args);
  const workspaceQuery = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  const limit = record.limit;
  const out: ListedControlSession[] = [];
  for (const workspace of state.workspaces) {
    if (workspaceQuery && !matchesWorkspace(workspace, workspaceQuery)) continue;
    const sessions = state.sessionsByWorkspaceId[workspace.id] ?? [];
    const attention = state.attentionFor ? undefined : selectSessionAttention(
      sessions.flatMap((session) => session.id ? [{ ...session, id: session.id }] : []),
      (id) => state.statusFor(workspace.id, id),
      () => undefined,
    );
    for (const session of sessions) {
      const sessionId = session.id?.trim() ?? "";
      if (!sessionId) continue;
      const activity = state.attentionFor?.(workspace.id, sessionId) ?? attention?.get(sessionId);
      if (!activity) continue;
      out.push({
        sessionId,
        title: getDisplaySessionTitle(session.title ?? ""),
        workspace: controlWorkspaceLabel(workspace),
        updatedAt: session.time?.updated ?? session.time?.created ?? 0,
        pinned: state.pinnedIds.includes(sessionId),
        status: activity.status,
        working: activity.working,
        descendantActivity: activity.descendantActivity,
        inventoryComplete: activity.inventoryComplete,
        model: labelOpenworkSessionModel(controlSessionModel(session), state.modelCatalogByWorkspaceId?.[workspace.id] ?? []),
      });
    }
  }
  out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? out.slice(0, limit) : out;
}
