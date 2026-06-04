/** @jsxImportSource react */
import { useCallback, useMemo } from "react";

import type { createClient } from "../../../../app/lib/opencode";
import type { OpenworkServerClient, OpenworkWorkspaceInfo } from "../../../../app/lib/openwork-server";
import { setSessionArchived } from "../../../../app/lib/opencode-session";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { useSessionManagementStore } from "../sidebar/session-management-store";

type SessionLike = {
  id?: string;
  title?: string;
  time?: {
    updated?: number;
    created?: number;
  };
};

type SessionControlWorkspace = OpenworkWorkspaceInfo & {
  displayNameResolved?: string;
};

type UseSessionControlActionsInput = {
  workspaces: SessionControlWorkspace[];
  sessionsByWorkspaceId: Record<string, SessionLike[]>;
  selectedWorkspaceId: string;
  selectedWorkspaceRoot: string;
  selectedSessionId: string | null;
  canCreateTask: boolean;
  openworkClient: OpenworkServerClient | null;
  opencodeClient: ReturnType<typeof createClient> | null;
  navigateToSession: (sessionId: string) => void;
  navigateToSessionRoot: () => void;
  createTaskInWorkspace: (workspaceId: string) => Promise<unknown> | unknown;
  openModelPicker: () => void;
  refreshRouteState: () => Promise<unknown> | unknown;
};

function workspaceLabel(workspace: SessionControlWorkspace) {
  return workspace.displayName?.trim() || workspace.name?.trim() || workspace.path?.trim() || "workspace";
}

function findSessionWorkspace(
  workspaces: SessionControlWorkspace[],
  sessionsByWorkspaceId: Record<string, SessionLike[]>,
  sessionId: string,
) {
  return workspaces.find((workspace) => (
    sessionsByWorkspaceId[workspace.id] ?? []
  ).some((session) => session.id === sessionId));
}

function objectArgs(args: unknown) {
  return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

function stringArg(args: unknown, name: string) {
  const value = objectArgs(args)[name];
  return typeof value === "string" ? value.trim() : "";
}

function booleanArg(args: unknown, name: string) {
  return objectArgs(args)[name] === true;
}

export function useSessionControlActions(input: UseSessionControlActionsInput) {
  const {
    canCreateTask,
    createTaskInWorkspace,
    navigateToSession,
    navigateToSessionRoot,
    openModelPicker,
    openworkClient,
    opencodeClient,
    refreshRouteState,
    selectedSessionId,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionsByWorkspaceId,
    workspaces,
  } = input;

  const createTaskControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.create_task",
    label: "Create a new task",
    description: "Create a new session in the selected workspace.",
    sideEffect: "mutation",
    disabled: !canCreateTask || !selectedWorkspaceId,
    execute: async () => {
      if (!selectedWorkspaceId) return false;
      await createTaskInWorkspace(selectedWorkspaceId);
      return true;
    },
  }), [canCreateTask, createTaskInWorkspace, selectedWorkspaceId]);
  useControlAction(createTaskControlAction);

  const listSessionsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.list_sessions",
    label: "List available sessions",
    description: "Return the list of sessions across workspaces so the user can ask to open one by name.",
    sideEffect: "none",
    execute: () => {
      const out: { sessionId: string; title: string; workspace: string; updatedAt: number }[] = [];
      for (const workspace of workspaces) {
        const list = sessionsByWorkspaceId[workspace.id] ?? [];
        for (const session of list) {
          const sessionId = session.id?.trim() ?? "";
          if (!sessionId) continue;
          const title = getDisplaySessionTitle(session.title ?? "");
          const updatedAt = session.time?.updated ?? session.time?.created ?? 0;
          out.push({ sessionId, title, workspace: workspaceLabel(workspace), updatedAt });
        }
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt);
      return out.slice(0, 30);
    },
  }), [sessionsByWorkspaceId, workspaces]);
  useControlAction(listSessionsControlAction);

  const openSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.open",
    label: "Open a session by ID",
    description: "Navigate to a specific session. Use list_sessions first to get the session ID.",
    sideEffect: "navigation",
    requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true, description: "Session ID from session.list_sessions." }],
    execute: (args) => {
      const sessionId = stringArg(args, "sessionId");
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      navigateToSession(sessionId);
      return { ok: true, navigatedTo: sessionId };
    },
  }), [navigateToSession]);
  useControlAction(openSessionControlAction);

  const renameSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.rename",
    label: "Rename a session",
    description: "Rename a session by ID. Use list_sessions first to match the title the user said.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "sessionId", type: "string", required: true, description: "Session ID from session.list_sessions." },
      { name: "title", type: "string", required: true, description: "New session title." },
    ],
    disabled: !opencodeClient,
    execute: async (args) => {
      const sessionId = stringArg(args, "sessionId");
      const title = stringArg(args, "title");
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (!title) return { ok: false, error: "title is required" };
      if (!opencodeClient) return { ok: false, error: "OpenCode client is not connected" };

      const targetWorkspace = findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
      await opencodeClient.session.update({
        sessionID: sessionId,
        title,
        directory: targetWorkspace?.path || selectedWorkspaceRoot || undefined,
      });
      await refreshRouteState();
      return { ok: true, sessionId, title };
    },
  }), [opencodeClient, refreshRouteState, selectedWorkspaceRoot, sessionsByWorkspaceId, workspaces]);
  useControlAction(renameSessionControlAction);

  const deleteSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.delete",
    label: "Delete a session",
    description: "Delete a session by ID. Destructive: only run after explicit user confirmation.",
    sideEffect: "mutation",
    requiresArgs: true,
    requiresConfirmation: true,
    args: [
      { name: "sessionId", type: "string", required: true, description: "Session ID from session.list_sessions." },
      { name: "confirmed", type: "boolean", required: true, description: "Must be true after explicit user confirmation." },
    ],
    disabled: !openworkClient,
    execute: async (args) => {
      const sessionId = stringArg(args, "sessionId");
      const confirmed = booleanArg(args, "confirmed");
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (!confirmed) return { ok: false, error: "Deletion requires confirmed: true after explicit user confirmation" };
      if (!openworkClient) return { ok: false, error: "OpenWork server is not connected" };

      const targetWorkspace = findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
      if (!targetWorkspace) return { ok: false, error: "Session was not found in the current session list" };
      await openworkClient.deleteSession(targetWorkspace.id, sessionId);
      if (selectedSessionId === sessionId) {
        navigateToSessionRoot();
      }
      await refreshRouteState();
      return { ok: true, sessionId, deleted: true };
    },
  }), [navigateToSessionRoot, openworkClient, refreshRouteState, selectedSessionId, sessionsByWorkspaceId, workspaces]);
  useControlAction(deleteSessionControlAction);

  const modelPickerControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.model_picker.open",
    label: "Open the model picker",
    description: "Open the current session model picker.",
    sideEffect: "none",
    disabled: !selectedWorkspaceId,
    execute: openModelPicker,
  }), [openModelPicker, selectedWorkspaceId]);
  useControlAction(modelPickerControlAction);

  // ---------------------------------------------------------------------------
  // Session management control actions (pin, archive, groups)
  // ---------------------------------------------------------------------------

  const store = useSessionManagementStore;

  /** Resolve a workspace ID from user input. Falls back to selectedWorkspaceId
   *  if the input is empty or doesn't match any known workspace (e.g. if the
   *  caller passes a display name instead of the actual ID). */
  const resolveWorkspaceId = useCallback((input: string | undefined): string | undefined => {
    if (!input) return selectedWorkspaceId || undefined;
    // Exact match on ID.
    if (workspaces.some((ws) => ws.id === input)) return input;
    // Fuzzy match on display name / path — return the first matching workspace ID.
    const byName = workspaces.find(
      (ws) =>
        (ws.displayName?.trim() || ws.name?.trim() || ws.path?.trim() || "").toLowerCase() === input.toLowerCase(),
    );
    if (byName) return byName.id;
    // Unknown — fall back to selected.
    return selectedWorkspaceId || undefined;
  }, [selectedWorkspaceId, workspaces]);

  const pinControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.pin",
    label: "Pin or unpin a session",
    description: "Toggle pin on a session. Pinned sessions float to the top of the sidebar.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true, description: "Session ID to pin/unpin." }],
    execute: (args) => {
      const sessionId = stringArg(args, "sessionId");
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      store.getState().togglePin(sessionId);
      const pinned = store.getState().pinnedIds.includes(sessionId);
      return { ok: true, sessionId, pinned };
    },
  }), []);
  useControlAction(pinControlAction);

  const archiveControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.archive",
    label: "Archive or unarchive a session",
    description: "Archive a session (non-destructive, preserves context). Archived sessions move to the Archived section. Pass archived=false to unarchive.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "sessionId", type: "string", required: true, description: "Session ID." },
      { name: "archived", type: "boolean", required: true, description: "true to archive, false to unarchive." },
    ],
    disabled: !opencodeClient,
    execute: async (args) => {
      const sessionId = stringArg(args, "sessionId");
      const archived = booleanArg(args, "archived");
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (!opencodeClient) return { ok: false, error: "OpenCode client is not connected" };
      const targetWorkspace = findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
      await setSessionArchived(opencodeClient, sessionId, archived, targetWorkspace?.path || selectedWorkspaceRoot || undefined);
      await refreshRouteState();
      return { ok: true, sessionId, archived };
    },
  }), [opencodeClient, refreshRouteState, selectedWorkspaceRoot, sessionsByWorkspaceId, workspaces]);
  useControlAction(archiveControlAction);

  const groupCreateControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.group.create",
    label: "Create a session group",
    description: "Create a new group (folder/separator) in the current workspace sidebar. Sessions can then be moved into it.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "label", type: "string", required: true, description: "Group name (e.g. 'Done', 'In progress', 'Backlog')." },
      { name: "workspaceId", type: "string", required: false, description: "Workspace ID. Defaults to the selected workspace." },
    ],
    disabled: !selectedWorkspaceId,
    execute: (args) => {
      const label = stringArg(args, "label");
      const wsId = resolveWorkspaceId(stringArg(args, "workspaceId"));
      if (!label) return { ok: false, error: "label is required" };
      if (!wsId) return { ok: false, error: "No workspace selected" };
      store.getState().createGroup(wsId, label);
      const created = store.getState().groupsByWorkspace[wsId];
      const newGroup = created?.groups[created.groups.length - 1];
      return { ok: true, workspaceId: wsId, label, groupId: newGroup?.id ?? null };
    },
  }), [resolveWorkspaceId]);
  useControlAction(groupCreateControlAction);

  const groupMoveControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.group.move",
    label: "Move a session to a group",
    description: "Assign a session to a group (folder). Pass groupId=null or omit to remove from current group. Use session.group.list to see available groups.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "sessionId", type: "string", required: true, description: "Session ID." },
      { name: "groupId", type: "string", required: false, description: "Group ID to move into. Omit or null to ungrouped." },
      { name: "workspaceId", type: "string", required: false, description: "Workspace ID. Defaults to session's workspace." },
    ],
    execute: (args) => {
      const sessionId = stringArg(args, "sessionId");
      const groupId = stringArg(args, "groupId") || null;
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      const targetWorkspace = findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
      const wsId = resolveWorkspaceId(stringArg(args, "workspaceId")) || targetWorkspace?.id;
      if (!wsId) return { ok: false, error: "Could not determine workspace" };
      store.getState().assignGroup(wsId, sessionId, groupId);
      return { ok: true, sessionId, groupId, workspaceId: wsId };
    },
  }), [resolveWorkspaceId, sessionsByWorkspaceId, workspaces]);
  useControlAction(groupMoveControlAction);

  const groupRemoveControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.group.remove",
    label: "Remove a session group",
    description: "Remove a group from the workspace. Sessions in the group become ungrouped (not deleted).",
    sideEffect: "mutation",
    requiresConfirmation: true,
    requiresArgs: true,
    args: [
      { name: "groupId", type: "string", required: true, description: "Group ID to remove." },
      { name: "workspaceId", type: "string", required: false, description: "Workspace ID. Defaults to selected." },
      { name: "confirmed", type: "boolean", required: true, description: "Must be true." },
    ],
    disabled: !selectedWorkspaceId,
    execute: (args) => {
      const groupId = stringArg(args, "groupId");
      const confirmed = booleanArg(args, "confirmed");
      const wsId = resolveWorkspaceId(stringArg(args, "workspaceId"));
      if (!groupId) return { ok: false, error: "groupId is required" };
      if (!confirmed) return { ok: false, error: "Requires confirmed: true" };
      if (!wsId) return { ok: false, error: "No workspace selected" };
      store.getState().removeGroup(wsId, groupId);
      return { ok: true, groupId, workspaceId: wsId };
    },
  }), [resolveWorkspaceId]);
  useControlAction(groupRemoveControlAction);

  const groupListControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.group.list",
    label: "List session groups",
    description: "List all groups in a workspace with their IDs and labels.",
    sideEffect: "none",
    args: [{ name: "workspaceId", type: "string", required: false, description: "Workspace ID. Defaults to selected." }],
    execute: (args) => {
      const wsId = resolveWorkspaceId(stringArg(args, "workspaceId"));
      if (!wsId) return { ok: false, error: "No workspace selected" };
      const state = store.getState().groupsByWorkspace[wsId];
      return {
        ok: true,
        workspaceId: wsId,
        groups: (state?.groups ?? []).map((g) => ({ id: g.id, label: g.label })),
        assignments: state?.assignments ?? {},
      };
    },
  }), [resolveWorkspaceId]);
  useControlAction(groupListControlAction);
}
