/** @jsxImportSource react */
import { useMemo } from "react";

import type { createClient } from "../../../../app/lib/opencode";
import type { OpenworkServerClient, OpenworkWorkspaceInfo } from "../../../../app/lib/openwork-server";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";

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

export function useSessionControlActions(input: UseSessionControlActionsInput) {
  const createTaskControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.create_task",
    label: "Create a new task",
    description: "Create a new session in the selected workspace.",
    sideEffect: "mutation",
    disabled: !input.canCreateTask || !input.selectedWorkspaceId,
    execute: async () => {
      if (!input.selectedWorkspaceId) return false;
      await input.createTaskInWorkspace(input.selectedWorkspaceId);
      return true;
    },
  }), [input]);
  useControlAction(createTaskControlAction);

  const listSessionsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.list_sessions",
    label: "List available sessions",
    description: "Return the list of sessions across workspaces so the user can ask to open one by name.",
    sideEffect: "none",
    execute: () => {
      const out: { sessionId: string; title: string; workspace: string; updatedAt: number }[] = [];
      for (const workspace of input.workspaces) {
        const list = input.sessionsByWorkspaceId[workspace.id] ?? [];
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
  }), [input]);
  useControlAction(listSessionsControlAction);

  const openSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.open",
    label: "Open a session by ID",
    description: "Navigate to a specific session. Use list_sessions first to get the session ID.",
    sideEffect: "navigation",
    requiresArgs: true,
    execute: (args) => {
      const sessionId = typeof args === "object" && args && "sessionId" in args && typeof (args as { sessionId?: unknown }).sessionId === "string"
        ? (args as { sessionId: string }).sessionId.trim()
        : "";
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      input.navigateToSession(sessionId);
      return { ok: true, navigatedTo: sessionId };
    },
  }), [input]);
  useControlAction(openSessionControlAction);

  const renameSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.rename",
    label: "Rename a session",
    description: "Rename a session by ID. Use list_sessions first to match the title the user said.",
    sideEffect: "mutation",
    requiresArgs: true,
    disabled: !input.opencodeClient,
    execute: async (args) => {
      const payload = args && typeof args === "object" ? args as { sessionId?: unknown; title?: unknown } : {};
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      const title = typeof payload.title === "string" ? payload.title.trim() : "";
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (!title) return { ok: false, error: "title is required" };
      if (!input.opencodeClient) return { ok: false, error: "OpenCode client is not connected" };

      const targetWorkspace = findSessionWorkspace(input.workspaces, input.sessionsByWorkspaceId, sessionId);
      await input.opencodeClient.session.update({
        sessionID: sessionId,
        title,
        directory: targetWorkspace?.path || input.selectedWorkspaceRoot || undefined,
      });
      await input.refreshRouteState();
      return { ok: true, sessionId, title };
    },
  }), [input]);
  useControlAction(renameSessionControlAction);

  const deleteSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.delete",
    label: "Delete a session",
    description: "Delete a session by ID. Destructive: only run after explicit user confirmation.",
    sideEffect: "mutation",
    requiresArgs: true,
    requiresConfirmation: true,
    disabled: !input.openworkClient,
    execute: async (args) => {
      const payload = args && typeof args === "object" ? args as { sessionId?: unknown; confirmed?: unknown } : {};
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      const confirmed = payload.confirmed === true;
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (!confirmed) return { ok: false, error: "Deletion requires confirmed: true after explicit user confirmation" };
      if (!input.openworkClient) return { ok: false, error: "OpenWork server is not connected" };

      const targetWorkspace = findSessionWorkspace(input.workspaces, input.sessionsByWorkspaceId, sessionId);
      if (!targetWorkspace) return { ok: false, error: "Session was not found in the current session list" };
      await input.openworkClient.deleteSession(targetWorkspace.id, sessionId);
      if (input.selectedSessionId === sessionId) {
        input.navigateToSessionRoot();
      }
      await input.refreshRouteState();
      return { ok: true, sessionId, deleted: true };
    },
  }), [input]);
  useControlAction(deleteSessionControlAction);

  const modelPickerControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.model_picker.open",
    label: "Open the model picker",
    description: "Open the current session model picker.",
    sideEffect: "none",
    disabled: !input.selectedWorkspaceId,
    execute: input.openModelPicker,
  }), [input]);
  useControlAction(modelPickerControlAction);
}
