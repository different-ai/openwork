/** @jsxImportSource react */
import { useCallback, useMemo } from "react";

import type { createClient } from "../../../../app/lib/opencode";
import type { OpenworkServerClient, OpenworkWorkspaceInfo } from "../../../../app/lib/openwork-server";
import { deleteRouteSession } from "../../../shell/route-workspaces";
import type { ResolvedWorkspaceEndpoint } from "../../../../app/lib/workspace-endpoint";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { useSessionManagementStore } from "../sidebar/session-management-store";
import type { ArchiveSessionOptions, ArchiveSessionOutcome } from "../sidebar/use-session-archive";
import { useSessionActivityStore } from "../status/session-activity-store";
import { isSameWorkbenchSession, useWorkbenchStore } from "../chat/workbench-store";
import { controlWorkspaceLabel as workspaceLabel, listControlSessions, type ControlSessionLike as SessionLike } from "./list-control-sessions";

type SessionControlWorkspace = OpenworkWorkspaceInfo & {
  displayNameResolved: string;
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
  archiveDisabledReason?: string;
  endpointForWorkspace: (workspace: SessionControlWorkspace | null | undefined) => ResolvedWorkspaceEndpoint | null;
  navigateToSession: (sessionId: string) => void;
  navigateToSessionRoot: () => void;
  createTaskInWorkspace: (workspaceId: string) => Promise<string | null> | string | null;
  openModelPicker: () => void;
  refreshRouteState: () => Promise<unknown> | unknown;
  archiveSession: (sessionId: string, archived: boolean, options?: ArchiveSessionOptions) => Promise<ArchiveSessionOutcome>;
};

const ARCHIVE_TARGET_WORKING_HINT = "This session is still working. If the user wants it closed, ask them to stop it in the app (or wait until session.list_sessions reports working=false), then archive. If not, leave it running.";
const SELF_ARCHIVE_WHILE_WORKING_HINT = "A working session cannot archive itself. Finish the turn so your conclusions can be reviewed; the reviewer archives.";

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
    endpointForWorkspace,
    navigateToSession,
    navigateToSessionRoot,
    openModelPicker,
    openworkClient,
    opencodeClient,
    archiveDisabledReason,
    refreshRouteState,
    selectedSessionId,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionsByWorkspaceId,
    workspaces,
    archiveSession,
  } = input;
  const pinnedIds = useSessionManagementStore((s) => s.pinnedIds);

  const createTaskControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.create_task",
    label: "Create a new task",
    description: "Create a new session in the selected workspace.",
    sideEffect: "mutation",
    disabled: !canCreateTask || !selectedWorkspaceId,
    execute: async () => {
      if (!selectedWorkspaceId) throw new Error("Cannot create a task without a selected workspace.");
      const sessionId = await createTaskInWorkspace(selectedWorkspaceId);
      if (sessionId === null) throw new Error("Task creation did not return a session ID.");
      return sessionId;
    },
  }), [canCreateTask, createTaskInWorkspace, selectedWorkspaceId]);
  useControlAction(createTaskControlAction);

  const listSessionsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.list_sessions",
    label: "List available sessions",
    description: "Return every loaded session across workspaces (pinned first, then newest). Entries include `pinned`, `status` (idle, thinking, responding, waiting, compacting, error) and `working` (true while a turn, subtask, permission, or question is still open). Check `working` before session.archive. Pass `limit` to cap the count or `workspaceId` to narrow to one workspace.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    args: [
      { name: "limit", type: "number", required: false, description: "Maximum sessions to return. Omit to return all loaded sessions." },
      { name: "workspaceId", type: "string", required: false, description: "Workspace ID or display name. Omit to include every workspace." },
    ],
    execute: (args) => listControlSessions(args, {
      workspaces,
      sessionsByWorkspaceId,
      pinnedIds,
      statusFor: (workspaceId, sessionId) => useSessionActivityStore.getState().getStatus(workspaceId, sessionId),
    }),
  }), [pinnedIds, sessionsByWorkspaceId, workspaces]);
  useControlAction(listSessionsControlAction);

  const openSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.open",
    label: "Open a session by ID",
    description: "Focus a visible session or reuse its existing tab. Use list_sessions first to get the session ID.",
    effects: { data: "none", ui: "navigate", external: false },
    sideEffect: "navigation",
    requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true, description: "Session ID from session.list_sessions." }],
    execute: (args) => {
      const sessionId = stringArg(args, "sessionId");
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      const targetWorkspace = findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
      const workbench = useWorkbenchStore.getState();
      if (targetWorkspace) {
        const target = { workspaceId: targetWorkspace.id, sessionId };
        if (isSameWorkbenchSession(target, workbench.primary)) {
          workbench.focusPane("primary");
          return { ok: true, sessionId, reused: "primary-pane" };
        }
        if (isSameWorkbenchSession(target, workbench.secondary)) {
          workbench.focusPane("secondary");
          return { ok: true, sessionId, reused: "secondary-pane" };
        }
      }
      navigateToSession(sessionId);
      return {
        ok: true,
        sessionId,
        reused: targetWorkspace && workbench.tabs.some((tab) => isSameWorkbenchSession(tab, {
          workspaceId: targetWorkspace.id,
          sessionId,
        })) ? "tab" : "new-tab",
      };
    },
  }), [navigateToSession, sessionsByWorkspaceId, workspaces]);
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
      const endpoint = endpointForWorkspace(targetWorkspace);
      if (!endpoint) return { ok: false, error: "Workspace runtime is not connected" };
      await deleteRouteSession(endpoint, sessionId);
      if (selectedSessionId === sessionId) {
        navigateToSessionRoot();
      }
      await refreshRouteState();
      return { ok: true, sessionId, deleted: true };
    },
  }), [endpointForWorkspace, navigateToSessionRoot, openworkClient, refreshRouteState, selectedSessionId, sessionsByWorkspaceId, workspaces]);
  useControlAction(deleteSessionControlAction);

  const modelPickerControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.model_picker.open",
    label: "Open the model picker",
    description: "Open the current session model picker.",
    effects: { data: "none", ui: "dialog", external: false },
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
    description: "Toggle pin on a session. Pinned sessions appear in a global section at the top of the sidebar.",
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
    description: archiveDisabledReason ?? "Archive an idle session, preserving context. Check `working` in session.list_sessions first. A working session is not archived: the result is code target_working (if the user wants it closed, ask them to stop it in the app, then archive once working is false; otherwise leave it running). A session cannot archive itself or its parent during its own turn (code self_archive_while_working): finish the turn; the reviewer archives. Pass archived=false to restore without restarting work.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "sessionId", type: "string", required: true, description: "Session ID." },
      { name: "archived", type: "boolean", required: true, description: "true to archive, false to unarchive." },
    ],
    disabled: !opencodeClient || Boolean(archiveDisabledReason),
    execute: async (args, helpers) => {
      const sessionId = stringArg(args, "sessionId");
      const archived = booleanArg(args, "archived");
      if (archiveDisabledReason) return { ok: false, error: archiveDisabledReason };
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      const requestedBy = helpers.origin?.sessionId;
      const outcome = await archiveSession(sessionId, archived, {
        ...(requestedBy ? { requester: { sessionId: requestedBy } } : {}),
        refuseWorking: helpers.bridged,
      });
      if (outcome.kind === "done") return { ok: true, sessionId, archived };
      if (outcome.kind === "target_working") {
        return { ok: false, code: outcome.kind, sessionId, title: outcome.title, error: `"${outcome.title}" is still working; it was not archived.`, hint: ARCHIVE_TARGET_WORKING_HINT };
      }
      if (outcome.kind === "self_archive_while_working") {
        return { ok: false, code: outcome.kind, sessionId, title: outcome.title, error: "A working session cannot archive itself.", hint: SELF_ARCHIVE_WHILE_WORKING_HINT };
      }
      return { ok: false, sessionId, error: "Session archive was cancelled or could not be confirmed" };
    },
  }), [archiveDisabledReason, archiveSession, opencodeClient]);
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
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
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
