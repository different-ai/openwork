import type { OpenworkSessionModel } from "@openwork/types/openwork-affordance";

import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { SessionActivityStatus } from "../status/session-activity-store";

export type ControlSessionWorkspace = {
  id: string;
  name?: string | null;
  path?: string | null;
  displayName?: string | null;
};

/**
 * The engine's session-level model as it arrives on the session record:
 * bound at creation or by the last prompt, `variant` being the reasoning
 * effort. The pinned SDK types predate this field, so it is declared here.
 */
export type ControlSessionEngineModel = {
  id?: string;
  providerID?: string;
  variant?: string | null;
};

export type ControlSessionLike = {
  id?: string;
  title?: string;
  /** Set on delegated (sub-agent) sessions; their pending requests roll up to this parent. */
  parentID?: string | null;
  time?: {
    updated?: number;
    created?: number;
    archived?: number;
  };
  model?: ControlSessionEngineModel | null;
};

export type ListedControlSession = {
  sessionId: string;
  title: string;
  workspace: string;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  /** Live activity, the same source as the sidebar indicator. */
  status: SessionActivityStatus;
  /** True while a turn, subtask, compaction, permission, or question is still open. */
  working: boolean;
  /** Model and reasoning effort the session is bound to; null before any model is bound. */
  model: OpenworkSessionModel | null;
};

export type ListControlSessionsState = {
  workspaces: ControlSessionWorkspace[];
  sessionsByWorkspaceId: Record<string, ControlSessionLike[]>;
  pinnedIds: readonly string[];
  statusFor: (workspaceId: string, sessionId: string) => SessionActivityStatus;
};

/** Anything but a finished or failed turn still needs Stop before archive. */
export function isWorkingStatus(status: SessionActivityStatus): boolean {
  return status !== "idle" && status !== "error";
}

/**
 * Session-level model from the engine record, or null when none was ever
 * bound. The engine writes the literal variant "default" for a turn that
 * named none; agents read null for that, the composer pill's value.
 */
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

/**
 * `session.list_sessions`: sessions the app already holds in memory, pinned
 * first then newest first. `args` is the raw control-action payload; the list
 * is only truncated when it carries a positive integer `limit`, and an
 * unknown `workspaceId` yields no sessions rather than another workspace's.
 * A silent cap here made large workspaces impossible to inventory.
 */
export function listControlSessions(args: unknown, state: ListControlSessionsState): ListedControlSession[] {
  const record = argsRecord(args);
  const workspaceQuery = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  const limit = record.limit;
  const out: ListedControlSession[] = [];
  for (const workspace of state.workspaces) {
    if (workspaceQuery && !matchesWorkspace(workspace, workspaceQuery)) continue;
    for (const session of state.sessionsByWorkspaceId[workspace.id] ?? []) {
      const sessionId = session.id?.trim() ?? "";
      if (!sessionId) continue;
      const archived = typeof session.time?.archived === "number" && session.time.archived > 0;
      if (record.archived === "exclude" && archived) continue;
      if (record.archived === "only" && !archived) continue;
      const status = state.statusFor(workspace.id, sessionId);
      out.push({
        sessionId,
        title: getDisplaySessionTitle(session.title ?? ""),
        workspace: controlWorkspaceLabel(workspace),
        updatedAt: session.time?.updated ?? session.time?.created ?? 0,
        pinned: state.pinnedIds.includes(sessionId),
        archived,
        status,
        working: isWorkingStatus(status),
        model: controlSessionModel(session),
      });
    }
  }
  out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? out.slice(0, limit) : out;
}
