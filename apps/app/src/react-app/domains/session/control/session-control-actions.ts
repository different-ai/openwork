/** @jsxImportSource react */
import { useCallback, useMemo } from "react";

import { createClient, unwrap } from "../../../../app/lib/opencode";
import { normalizeDirectoryPath } from "../../../../app/utils";
import { setSessionModel } from "../../../../app/lib/opencode-session";
import { createClientV2, isOpencodeV2BaseUrl } from "../../../../app/lib/opencode-v2-adapter";
import { openworkCatalogModels, openworkModelsListArgsSchema, type OpenworkCatalogModel } from "@openwork/types/openwork-affordance";
import type { OpenworkServerClient, OpenworkWorkspaceInfo } from "../../../../app/lib/openwork-server";
import { deleteRouteSession, routeSessionEndpoint } from "../../../shell/route-workspaces";
import type { ResolvedWorkspaceEndpoint } from "../../../../app/lib/workspace-endpoint";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import { useCheckDesktopRestriction } from "../../cloud/desktop-config-provider";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { filterEntitledModelOptions } from "../../connections/provider-auth/provider-policy";
import { filterCloudManagedModelOptions } from "../../connections/provider-auth/assigned-model-options";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import { useSessionManagementStore } from "../sidebar/session-management-store";
import { readSessionSettled, sessionActivityAt, settleSession, unsettleSession } from "../sidebar/session-settle";
import { isActiveWorkSessionStatus, isNeedsAttentionSessionStatus } from "../sidebar/utils";
import { useSessionModelStore } from "../surface/session-model-store";
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
  /** Workspaces where the sidebar offers Settle (the rollout flag and OpenCode v2). */
  settleWorkspaceIds?: ReadonlySet<string>;
  /** The sidebar's session status, including background work and pending requests. */
  sessionStatusById?: Readonly<Record<string, string>>;
  endpointForWorkspace: (workspace: SessionControlWorkspace | null | undefined) => ResolvedWorkspaceEndpoint | null;
  navigateToSession: (sessionId: string) => void;
  navigateToSessionRoot: () => void;
  createTaskInWorkspace: (workspaceId: string) => Promise<string | null> | string | null;
  openModelPicker: () => void;
  refreshRouteState: () => Promise<unknown> | unknown;
  reloadWorkspaceSessions: (workspaceId: string) => Promise<void>;
  archiveSession: (sessionId: string, archived: boolean, options?: ArchiveSessionOptions) => Promise<ArchiveSessionOutcome>;
};

const ARCHIVE_TARGET_WORKING_HINT = "This session is still working. If the user wants it closed, ask them to stop it in the app (or wait until session.list_sessions reports working=false), then archive. If not, leave it running.";
const SELF_ARCHIVE_WHILE_WORKING_HINT = "A working session cannot archive itself. Finish the turn so your conclusions can be reviewed; the reviewer archives.";
const SETTLE_TARGET_WORKING_HINT = "Working sessions stay in view. Settle it once session.list_sessions reports working=false, or leave it.";
const SETTLE_TARGET_WAITING_HINT = "The session is waiting on the person. Answer its pending request (session.question.list / session.question.answer) only with the person's own answer, or ask them; then settle it.";

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
    settleWorkspaceIds,
    sessionStatusById,
    refreshRouteState,
    reloadWorkspaceSessions,
    selectedSessionId,
    selectedWorkspaceId,
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
    // Read the catalog from the engine chat runs on, as session creation does:
    // v2's catalog can differ from v1's while both engines run.
    const engine = await routeSessionEndpoint(endpoint);
    const catalog = isOpencodeV2BaseUrl(engine.opencodeBaseUrl)
      ? await createClientV2(engine.opencodeBaseUrl, workspace.path, { token: engine.token }).provider.list({ directory: workspace.path })
      : await createClient(engine.opencodeBaseUrl, workspace.path, { mode: "openwork", token: engine.token }).provider.list({ directory: workspace.path });
    return openworkCatalogModels(unwrap(catalog));
  }, [endpointForWorkspace]);
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
      const options = (await workspaceModels(workspace)).map((model) => ({ ...model, providerID: model.providerId }));
      const models = filterEntitledModelOptions(filterCloudManagedModelOptions(options, isSignedIn), {
        restrictToCloud: checkDesktopRestriction({ restriction: "allowCustomProviders" }),
        checkRestriction: checkDesktopRestriction,
      }).map(({ providerID, ...model }) => ({ ...model, available: true }));
      return { ok: true, workspaceId: workspace.id, models };
    },
  }), [checkDesktopRestriction, isSignedIn, workspaceModels, workspaces]));

  const listSessionsControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.list_sessions",
    label: "List available sessions",
    description: "Return every loaded session across workspaces (pinned first, then newest). Entries include `pinned`, `settled` (on the sidebar's Settled row; see session.settle), `status` (idle, thinking, responding, waiting, compacting, error), `working` (own work or known busy/waiting descendants), `descendantActivity` ({ busy, waiting, unknown } counts), `inventoryComplete` (false when referenced descendant activity is unreadable; unknown alone does not imply working) and `model` ({ providerId, modelId, variant, displayName?, providerName? }: the model and reasoning effort the session is bound to, null before any model is bound). Check `working` before session.archive. Pass `limit` to cap the count or `workspaceId` to narrow to one workspace.",
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
        settledFor: (workspaceId, session) => Boolean(settleWorkspaceIds?.has(workspaceId))
          && readSessionSettled(session, sessionStatusById?.[session.id] ?? activity.getStatus(workspaceId, session.id)),
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
  }), [endpointForWorkspace, pinnedIds, sessionStatusById, sessionsByWorkspaceId, settleWorkspaceIds, workspaceModels, workspaces]);
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
    execute: async (args) => {
      const sessionId = stringArg(args, "sessionId");
      const title = stringArg(args, "title");
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (!title) return { ok: false, error: "title is required" };

      const targetWorkspace = findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
      if (!targetWorkspace) return { ok: false, error: "Session was not found in the current session list" };
      const endpoint = endpointForWorkspace(targetWorkspace);
      if (!endpoint) return { ok: false, error: "Workspace runtime is not connected" };
      const engine = await routeSessionEndpoint(endpoint);
      const client = isOpencodeV2BaseUrl(engine.opencodeBaseUrl)
        ? createClientV2(engine.opencodeBaseUrl, targetWorkspace.path, { token: engine.token })
        : createClient(engine.opencodeBaseUrl, targetWorkspace.path, { mode: "openwork", token: engine.token });
      unwrap(await client.session.update({ sessionID: sessionId, title, directory: targetWorkspace.path }));
      await reloadWorkspaceSessions(targetWorkspace.id);
      return { ok: true, sessionId, title };
    },
  }), [endpointForWorkspace, reloadWorkspaceSessions, sessionsByWorkspaceId, workspaces]);
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

  const sessionSetModelControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.set_model",
    label: "Set a session model",
    description: "Rebind one existing session to an exact available providerId/modelId without opening it or starting inference. Requires an idle, unarchived session on OpenCode v2; any connected workspace can be targeted. Returns the verified new binding.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "sessionId", type: "string", required: true, description: "Session ID from session.list_sessions." },
      { name: "workspaceId", type: "string", required: false, description: "Workspace ID or display name. Required when the session is not in the loaded inventory." },
      { name: "providerId", type: "string", required: true, description: "Exact providerId from models.list." },
      { name: "modelId", type: "string", required: true, description: "Exact modelId from models.list." },
      { name: "variant", type: "string", required: false, description: "Optional reasoning / effort variant. Omit or pass null for the provider default." },
    ],
    execute: async (args) => {
      const sessionId = stringArg(args, "sessionId");
      const workspaceQuery = stringArg(args, "workspaceId");
      const providerId = stringArg(args, "providerId");
      const modelId = stringArg(args, "modelId");
      const rawVariant = objectArgs(args).variant;
      const variant = rawVariant === null ? null : typeof rawVariant === "string" ? rawVariant.trim() || null : undefined;
      const requestedVariant = variant === "default" ? null : variant ?? null;
      if (rawVariant !== undefined && rawVariant !== null && typeof rawVariant !== "string") {
        return { ok: false, error: "variant must be a string or null." };
      }
      if (variant && variant.length > 60) return { ok: false, error: "variant must be at most 60 characters." };
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (!providerId) return { ok: false, error: "providerId is required" };
      if (!modelId) return { ok: false, error: "modelId is required" };

      const targetWorkspace = workspaceQuery
        ? workspaces.find((workspace) => workspace.id === workspaceQuery || workspaceLabel(workspace).toLowerCase() === workspaceQuery.toLowerCase())
        : findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
      if (!targetWorkspace) return { ok: false, error: workspaceQuery ? "Workspace was not found; pass its exact id." : "Session was not found in the current session list; pass workspaceId." };
      const endpoint = endpointForWorkspace(targetWorkspace);
      if (!endpoint) return { ok: false, error: "Workspace runtime is not connected" };
      const engine = await routeSessionEndpoint(endpoint);
      if (!isOpencodeV2BaseUrl(engine.opencodeBaseUrl)) {
        return { ok: false, error: "Session model reassignment requires the OpenCode v2 session API." };
      }
      const client = createClientV2(engine.opencodeBaseUrl, targetWorkspace.path, { token: engine.token });
      const session = unwrap(await client.session.get({ sessionID: sessionId, directory: targetWorkspace.path }));
      if (normalizeDirectoryPath(session.directory) !== normalizeDirectoryPath(targetWorkspace.path)) {
        return { ok: false, error: "Session does not belong to the requested workspace." };
      }
      if ((session.time?.archived ?? 0) > 0) return { ok: false, error: "Archived sessions cannot be reassigned." };
      const status = unwrap(await client.session.status({ directory: targetWorkspace.path }));
      if (status[sessionId]?.type === "busy") return { ok: false, error: "Working sessions cannot be reassigned. Wait until the session is idle." };

      const catalog = filterEntitledModelOptions(filterCloudManagedModelOptions(
        (await workspaceModels(targetWorkspace)).map((model) => ({ ...model, providerID: model.providerId })),
        isSignedIn,
      ), {
        restrictToCloud: checkDesktopRestriction({ restriction: "allowCustomProviders" }),
        checkRestriction: checkDesktopRestriction,
      });
      const match = catalog.find((model) => model.providerId === providerId && model.modelId === modelId);
      if (!match) return { ok: false, error: `Unavailable model: ${providerId}/${modelId}. Use models.list for this workspace.` };
      await setSessionModel(client, sessionId, { providerID: providerId, modelID: modelId }, variant);
      const rebound = unwrap(await client.session.get({ sessionID: sessionId, directory: targetWorkspace.path }));
      const reboundVariant = rebound.model?.variant === "default" ? null : rebound.model?.variant ?? null;
      if (rebound.model?.providerID !== providerId || rebound.model.id !== modelId
        || reboundVariant !== requestedVariant) {
        return { ok: false, error: "Session model readback did not match the requested binding." };
      }
      // The composer sends its remembered choice before each v2 prompt. Keep
      // that choice in sync only after persistence is verified, or reopening
      // this conversation could silently overwrite the recovered binding.
      useSessionModelStore.getState().setModel(sessionId, { providerID: providerId, modelID: modelId }, reboundVariant);
      useSessionModelStore.getState().setVariant(sessionId, reboundVariant);
      return {
        ok: true,
        sessionId,
        workspaceId: targetWorkspace.id,
        model: {
          providerId: rebound.model.providerID,
          modelId: rebound.model.id,
          variant: reboundVariant,
          displayName: match.displayName,
          providerName: match.providerName,
        },
      };
    },
  }), [checkDesktopRestriction, endpointForWorkspace, isSignedIn, sessionsByWorkspaceId, workspaceModels, workspaces]);
  useControlAction(sessionSetModelControlAction);

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
    description: "Toggle pin on a loaded, unarchived session. Pinned sessions appear at the top of the sidebar. An existing pin can always be removed, including a stale pin.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [{ name: "sessionId", type: "string", required: true, description: "Session ID to pin/unpin." }],
    execute: (args) => {
      const sessionId = stringArg(args, "sessionId");
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (!store.getState().pinnedIds.includes(sessionId)) {
        const workspace = findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
        const session = workspace && sessionsByWorkspaceId[workspace.id]?.find(session => session.id === sessionId);
        if (!session) return { ok: false, error: "Session was not found in the current session list" };
        if ((session.time?.archived ?? 0) > 0) return { ok: false, error: "Archived sessions cannot be pinned. Unarchive the session first." };
      }
      store.getState().togglePin(sessionId);
      const pinned = store.getState().pinnedIds.includes(sessionId);
      return { ok: true, sessionId, pinned };
    },
  }), [sessionsByWorkspaceId, workspaces]);
  useControlAction(pinControlAction);

  const settleControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.settle",
    label: "Settle or un-settle a session",
    description: "Settle a finished session: it leaves the active sidebar list for its workspace's collapsed Settled row and comes back on its own with any new activity. Pass settled=false to bring it back now. Only idle top-level sessions in OpenCode v2 workspaces settle; a session that is working (code target_working) or waiting on the person (code target_waiting) is not settled. Settling also unpins it and clears unread. Settled state is kept on this device only. Read `settled` in session.list_sessions.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "sessionId", type: "string", required: true, description: "Session ID from session.list_sessions." },
      { name: "settled", type: "boolean", required: true, description: "true to settle, false to bring it back." },
    ],
    disabled: !settleWorkspaceIds?.size,
    execute: (args) => {
      const sessionId = stringArg(args, "sessionId");
      const settled = objectArgs(args).settled;
      if (!sessionId) return { ok: false, error: "sessionId is required" };
      if (typeof settled !== "boolean") return { ok: false, error: "settled must be true or false" };
      const workspace = findSessionWorkspace(workspaces, sessionsByWorkspaceId, sessionId);
      const found = workspace && sessionsByWorkspaceId[workspace.id]?.find((session) => session.id === sessionId);
      if (!workspace || !found) return { ok: false, error: "Session was not found in the current session list" };
      if (!settleWorkspaceIds?.has(workspace.id)) return { ok: false, code: "unavailable", sessionId, error: "Settle is available only in OpenCode v2 workspaces." };
      if ((found.time?.archived ?? 0) > 0) return { ok: false, sessionId, error: "Archived sessions cannot be settled. Unarchive the session first." };
      if (found.parentID?.trim()) return { ok: false, sessionId, error: "Sub-agent sessions are not listed on their own; settle the parent session." };
      const session = { ...found, id: sessionId };
      const title = getDisplaySessionTitle(session.title ?? "");
      const status = sessionStatusById?.[sessionId] ?? useSessionActivityStore.getState().getStatus(workspace.id, sessionId);
      const current = readSessionSettled(session, status);
      if (current === settled) return { ok: true, sessionId, settled, unchanged: true };
      if (settled) {
        if (isActiveWorkSessionStatus(status)) {
          return { ok: false, code: "target_working", sessionId, title, error: `"${title}" is still working; it was not settled.`, hint: SETTLE_TARGET_WORKING_HINT };
        }
        if (isNeedsAttentionSessionStatus(status)) {
          return { ok: false, code: "target_waiting", sessionId, title, error: `"${title}" is waiting on the person; it was not settled.`, hint: SETTLE_TARGET_WAITING_HINT };
        }
        settleSession(sessionId, title, sessionActivityAt(session));
      } else {
        unsettleSession(sessionId, title);
      }
      return { ok: true, sessionId, settled: readSessionSettled(session, status) };
    },
  }), [sessionStatusById, sessionsByWorkspaceId, settleWorkspaceIds, workspaces]);
  useControlAction(settleControlAction);

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
      if (outcome.kind === "verification_failed" || outcome.kind === "archive_outcome_unknown") {
        return { ok: false, code: outcome.kind, sessionId, error: outcome.message };
      }
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
