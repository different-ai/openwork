/** @jsxImportSource react */
import { useCallback, useMemo } from "react";

import { createClient, unwrap } from "../../../../app/lib/opencode";
import { openworkCatalogModels, openworkModelsListArgsSchema, openworkSessionModelPreflightArgsSchema, resolveOpenworkModel, type OpenworkCatalogModel } from "@openwork/types/openwork-affordance";
import type { OpenworkServerClient, OpenworkWorkspaceInfo } from "../../../../app/lib/openwork-server";
import { deleteRouteSession } from "../../../shell/route-workspaces";
import type { ResolvedWorkspaceEndpoint } from "../../../../app/lib/workspace-endpoint";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { useCheckDesktopRestriction } from "../../cloud/desktop-config-provider";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { filterEntitledModelOptions } from "../../connections/provider-auth/provider-policy";
import { filterCloudManagedModelOptions } from "../../connections/provider-auth/assigned-model-options";
import { createSessionModelActions, localSessionModel } from "./session-model-actions";
import { useSessionManagementStore } from "../sidebar/session-management-store";
import type { ArchiveSessionOptions, ArchiveSessionOutcome } from "../sidebar/use-session-archive";
import { useSessionActivityStore } from "../status/session-activity-store";
import { selectSessionAttention } from "../status/session-attention";
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
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const { isSignedIn } = useDenAuth();

  const createTaskControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.create_task",
    label: "Create a new task",
    description: "Create a new session in the selected workspace and open it in the person's focused pane. Use session.create to start sessions without changing what is on screen.",
    effects: { data: "write", ui: "navigate", external: false },
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

  const workspaceModels = useCallback(async (workspace: SessionControlWorkspace) => {
    const endpoint = endpointForWorkspace(workspace);
    if (!endpoint) throw new Error("Workspace runtime is not connected");
    const client = createClient(endpoint.opencodeBaseUrl, workspace.path, { mode: "openwork", token: endpoint.token });
    return openworkCatalogModels(unwrap(await client.provider.list({ directory: workspace.path })));
  }, [endpointForWorkspace]);
  const availableWorkspaceModels = useCallback(async (workspace: SessionControlWorkspace) => {
    const options = (await workspaceModels(workspace)).map((model) => ({ ...model, providerID: model.providerId }));
    return filterEntitledModelOptions(filterCloudManagedModelOptions(options, isSignedIn), {
      restrictToCloud: checkDesktopRestriction({ restriction: "allowCustomProviders" }),
      checkRestriction: checkDesktopRestriction,
    }).map(({ providerID, ...model }) => ({ ...model, available: true }));
  }, [workspaceModels, isSignedIn, checkDesktopRestriction]);
  const modelActions = useMemo(() => createSessionModelActions({
    workspaces,
    catalog: availableWorkspaceModels,
    sessions: async (workspace) => {
      const endpoint = endpointForWorkspace(workspace);
      if (!endpoint) throw new Error("Workspace runtime is not connected");
      const client = createClient(endpoint.opencodeBaseUrl, workspace.path, { mode: "openwork", token: endpoint.token });
      const sessions = unwrap(await client.session.list({ directory: workspace.path, limit: 10_000 }));
      if (sessions.length >= 10_000) throw new Error("Session inventory is incomplete; no selections changed.");
      return sessions;
    },
  }), [workspaces, availableWorkspaceModels, endpointForWorkspace]);
  useControlAction(useMemo<OpenworkControlAction>(() => ({
    id: "session.set_model", label: "Choose a session model",
    description: "Save a local model and variant for next send. No engine binding or global default changes. dryRun previews without saving; repick to undo.",
    effects: { data: "write", ui: "none", external: false }, sideEffect: "mutation",
    args: [{ name: "sessionId", type: "string", required: true }, { name: "model", type: "object" }, { name: "alias", type: "string" }, { name: "dryRun", type: "boolean" }],
    execute: modelActions.setModel,
  }), [modelActions]));
  useControlAction(useMemo<OpenworkControlAction>(() => ({
    id: "session.rebind_model", label: "Repick matching sessions",
    description: "Save locally for next send on all unarchived sessions in this workspace whose effective binding matches from (local choice wins). dryRun previews the exact set. No engine binding or global default changes; repick to undo.",
    effects: { data: "write", ui: "none", external: false }, sideEffect: "mutation",
    args: [{ name: "workspaceId", type: "string", required: true }, { name: "from", type: "object", required: true }, { name: "to", type: "object", required: true }, { name: "dryRun", type: "boolean" }],
    execute: modelActions.rebindModel,
  }), [modelActions]));
  useControlAction(useMemo<OpenworkControlAction>(() => ({
    id: "session.model_preflight", label: "Check next-send model", kind: "query",
    description: "Validate the local override, otherwise the supplied engine binding, against the effective workspace catalog. Does not send or change selection.",
    effects: { data: "read", ui: "none", external: false }, sideEffect: "none",
    args: [{ name: "workspaceId", type: "string", required: true }, { name: "sessionId", type: "string", required: true }, { name: "model", type: "object", required: true }],
    execute: async (rawArgs) => {
      const args = openworkSessionModelPreflightArgsSchema.parse(rawArgs);
      const workspace = workspaces.find((entry) => entry.id === args.workspaceId);
      if (!workspace) throw new Error("Workspace was not found.");
      const catalog = await availableWorkspaceModels(workspace);
      const selected = localSessionModel(args.sessionId) ?? args.model;
      if (!selected) throw new Error("Select a model with session.set_model before sending.");
      return { ok: true, workspaceId: workspace.id, sessionId: args.sessionId, model: resolveOpenworkModel(selected, catalog) };
    },
  }), [workspaces, availableWorkspaceModels]));
  useControlAction(useMemo<OpenworkControlAction>(() => ({
    id: "models.list",
    label: "List workspace models",
    description: "Effective available connected picker models with providerId/modelId, displayName, providerName and available:true. Requires an existing renderer host; reads any workspace without focus or navigation. Assigned models not yet engine-connected are omitted.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    args: [{ name: "workspaceId", type: "string", required: true, description: "Workspace id or display name." }],
    execute: async (rawArgs) => {
      const { workspaceId } = openworkModelsListArgsSchema.parse(rawArgs);
      const matches = workspaces.filter((workspace) => workspace.id === workspaceId || workspaceLabel(workspace).toLowerCase() === workspaceId.toLowerCase());
      const workspace = matches[0];
      if (matches.length !== 1 || !workspace) throw new Error("Workspace is missing or ambiguous; pass its exact id.");
      const models = await availableWorkspaceModels(workspace);
      return { ok: true, workspaceId: workspace.id, models };
    },
  }), [availableWorkspaceModels, workspaces]));

  const listSessionsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.list_sessions",
    label: "List available sessions",
    description: "Return every loaded session across workspaces (pinned first, then newest). Entries include `pinned`, `status` (idle, thinking, responding, waiting, compacting, error), `working` (own work or known busy/waiting descendants), `descendantActivity` ({ busy, waiting, unknown } counts), `inventoryComplete` (false when referenced descendant activity is unreadable; unknown alone does not imply working) and `model` ({ providerId, modelId, variant, displayName?, providerName? }: the model and reasoning effort the session is bound to, null before any model is bound). Check `working` before session.archive. Pass `limit` to cap the count or `workspaceId` to narrow to one workspace.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    args: [
      { name: "limit", type: "number", required: false, description: "Maximum sessions to return. Omit to return all loaded sessions." },
      { name: "workspaceId", type: "string", required: false, description: "Workspace ID or display name. Omit to include every workspace." },
    ],
    execute: async (args) => {
      const query = stringArg(args, "workspaceId").toLowerCase();
      const targets = workspaces.filter((workspace) => !query || workspace.id.toLowerCase() === query || workspaceLabel(workspace).toLowerCase() === query);
      const modelCatalogByWorkspaceId: Record<string, OpenworkCatalogModel[]> = {};
      await Promise.all(targets.map(async (workspace) => {
        modelCatalogByWorkspaceId[workspace.id] = await workspaceModels(workspace).catch(() => []);
      }));
      const activity = useSessionActivityStore.getState();
      const attentionByWorkspaceId = new Map<string, ReturnType<typeof selectSessionAttention>>();
      return listControlSessions(args, {
        workspaces,
        sessionsByWorkspaceId,
        pinnedIds,
        modelCatalogByWorkspaceId,
        statusFor: activity.getStatus,
        attentionFor: (workspaceId, sessionId) => {
          let attention = attentionByWorkspaceId.get(workspaceId);
          if (!attention) {
            const runtimeId = endpointForWorkspace(workspaces.find((workspace) => workspace.id === workspaceId))?.workspaceId;
            const ids = runtimeId && runtimeId !== workspaceId ? [workspaceId, runtimeId] : [workspaceId];
            attention = selectSessionAttention(
              (sessionsByWorkspaceId[workspaceId] ?? []).flatMap((session) => (session.id ? [{ ...session, id: session.id }] : [])),
              (id) => ids.map((wid) => activity.statusesByWorkspaceId[wid]?.[id]).find((status) => status !== undefined),
              (id) => ids.map((wid) => activity.waitingByWorkspaceId[wid]?.[id]).find((kind) => kind !== undefined),
              (id) => ids.flatMap((wid) => activity.recordsByWorkspaceId[wid]?.[id]?.childSessionIds ?? []),
            );
            attentionByWorkspaceId.set(workspaceId, attention);
          }
          return attention.get(sessionId);
        },
      });
    },
  }), [endpointForWorkspace, pinnedIds, sessionsByWorkspaceId, workspaceModels, workspaces]);
  useControlAction(listSessionsControlAction);

  const openSessionControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.open",
    label: "Open a session by ID",
    description: "Show a session to the person: focus it if visible, else open it in the focused pane. Only for when they should see it; use session.read to inspect and session.send to message a session without opening it.",
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
  return { modelActions, availableWorkspaceModels };
}
