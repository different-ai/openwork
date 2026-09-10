import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Archive, ArchiveRestore } from "lucide-react";

import { createClient, unwrap } from "@/app/lib/opencode";
import { hasTerminalSessionReply, holdSessionWork, interruptSessionTurn, sessionHasPendingSubmission, sessionNeedsStop } from "@/app/lib/opencode-interruption";
import { setSessionArchived } from "@/app/lib/opencode-session";
import { isOpencodeV2BaseUrl, V2_SESSION_ARCHIVE_UNAVAILABLE } from "@/app/lib/opencode-v2-adapter";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { RouteSession, RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { readLastSessionFor, writeLastSessionFor } from "@/react-app/shell/session-memory";
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { useWorkbenchStore } from "../chat/workbench-store";
import { useSessionActivityStore } from "../status/session-activity-store";
import { getComposerQueuedDrafts, useComposerStateStore } from "../surface/composer-state-store";
import { composerAutoSendScopeKey, consumeComposerAutoSend, hasComposerAutoSend } from "../surface/composer-auto-send";
import { dispatchQueuedDrain, getQueuedDrainState, hasPendingQueuedAdmission } from "../surface/queued-drain-machine";
import { clearQueuedSendContext } from "../sync/queued-send-context";
import { applySessionArchived } from "../sync/session-sync";

type ArchiveTarget = { workspace: RouteWorkspace; endpoint: ResolvedWorkspaceEndpoint; sessionId: string; title: string; draftScope: string | null };

export function useSessionArchive(input: {
  workspaces: RouteWorkspace[];
  sessionsByWorkspaceId: Record<string, RouteSession[]>;
  endpointForWorkspace: (workspace: RouteWorkspace) => ResolvedWorkspaceEndpoint | null;
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  draftScope: string | null;
  navigateToWorkspaceSession: (workspaceId: string, sessionId: string | null, options?: { replace: boolean }) => void;
  reloadWorkspaceSessions: (workspaceId: string) => Promise<unknown>;
  onArchivedChange: (workspaceId: string, sessionId: string, archived: boolean) => void;
}) {
  const location = useLocation();
  const current = useRef({ input, location });
  current.current = { input, location };
  const [target, setTarget] = useState<ArchiveTarget | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const pending = useRef<((archived: boolean) => void) | null>(null);
  const undoNavigation = useRef<{
    workspaceId: string; sessionId: string; fromKey: string; landingKey: string | null;
  } | null>(null);

  useEffect(() => {
    const undo = undoNavigation.current;
    if (!undo || location.key === undo.fromKey || undo.landingKey === location.key) return;
    if (!undo.landingKey && location.pathname === workspaceSessionRoute(undo.workspaceId, null)) undo.landingKey = location.key;
    else undoNavigation.current = null;
  }, [location.key, location.pathname]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      undoNavigation.current = null;
      pending.current?.(false);
      pending.current = null;
    };
  }, []);

  function closeDialog(archived: boolean) {
    if (mounted.current) { setTarget(null); setError(null); }
    pending.current?.(archived);
    pending.current = null;
  }

  async function restore(target: ArchiveTarget, announce: boolean, undo?: typeof undoNavigation.current) {
    const { workspace, endpoint, sessionId } = target;
    try {
      await setSessionArchived(createClient(endpoint.opencodeBaseUrl, workspace.path, { token: endpoint.token, mode: "openwork" }), sessionId, false, workspace.path);
      await Promise.all([...new Set([workspace.id, endpoint.workspaceId])].map(id => applySessionArchived(id, sessionId, false)));
      const now = current.current;
      if (mounted.current) now.input.onArchivedChange(workspace.id, sessionId, false);
      if (mounted.current && undo && undoNavigation.current === undo
        && now.input.selectedWorkspaceId === workspace.id && !now.input.selectedSessionId
        && now.location.pathname === workspaceSessionRoute(workspace.id, null)
        && (now.location.key === undo.landingKey || now.location.key === undo.fromKey)) {
        undoNavigation.current = null;
        writeLastSessionFor(workspace.id, sessionId);
        now.input.navigateToWorkspaceSession(workspace.id, sessionId, { replace: true });
      }
      if (mounted.current) await now.input.reloadWorkspaceSessions(workspace.id);
      if (announce) showUndo(target, false);
      return true;
    } catch (error) {
      toast.error(t("session_management.unarchive_failed"), { description: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  function showUndo(target: ArchiveTarget, archived: boolean, undo?: typeof undoNavigation.current) {
    const message = archived ? t("session_management.session_archived", { title: target.title }) : t("session_management.session_unarchived");
    toast.undo(<span title={message}>{message}</span>, {
      id: `session-archive:${target.sessionId}`,
      icon: archived ? Archive : ArchiveRestore,
      undo: { label: t("common.undo"), onClick: () => {
        if (archived) void restore(target, false, undo);
        else if (mounted.current) void archiveSession(target.sessionId, true);
      } },
      view: { label: t("common.view"), onClick: () => {
        if (mounted.current) current.current.input.navigateToWorkspaceSession(target.workspace.id, target.sessionId);
      } },
      closeLabel: t("common.close"),
    });
  }

  async function archive(target: ArchiveTarget, confirmed: boolean) {
    if (busy.current) return;
    busy.current = true;
    const { workspace, endpoint, sessionId, draftScope } = target;
    const baseUrl = endpoint.opencodeBaseUrl;
    const client = createClient(baseUrl, workspace.path, { token: endpoint.token, mode: "openwork" });
    const releases = new Map<string, () => void>();
    const controller = new AbortController();
    const deadline = Date.now() + 15_000;
    const timer = setTimeout(() => controller.abort(new Error("Stopping could not be confirmed before the deadline.")), 15_000);
    const options = { signal: controller.signal };
    const scopes = (id: string) => [...new Set([workspace.id, endpoint.workspaceId])].map(workspaceId =>
      composerAutoSendScopeKey({ draftScope, opencodeBaseUrl: baseUrl, workspaceId, sessionId: id }));
    const localWork = (id: string) => getComposerQueuedDrafts(useComposerStateStore.getState(), id).length > 0
      || hasComposerAutoSend(id) || scopes(id).some(scope => hasComposerAutoSend(id, scope));
    const hold = (id: string) => { if (!releases.has(id)) releases.set(id, holdSessionWork(baseUrl, id)); };
    const cancelLocal = (id: string) => {
      consumeComposerAutoSend(id);
      for (const scope of scopes(id)) consumeComposerAutoSend(id, scope);
      for (const item of getComposerQueuedDrafts(useComposerStateStore.getState(), id)) {
        for (const attachment of item.draft.attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      dispatchQueuedDrain(id, { type: "queue_cleared" });
      useComposerStateStore.getState().clearQueuedDrafts(id);
    };
    const stop = (id: string) => {
      const phase = getQueuedDrainState(id).phase;
      return interruptSessionTurn(baseUrl, client, id, workspace.path, {
        timeoutMs: Math.max(1, deadline - Date.now()),
        admissionUnknown: phase.kind === "admission_unknown",
        admissionMessageID: phase.kind === "admission_unknown" ? phase.messageID : undefined,
        onStopped: () => dispatchQueuedDrain(id, { type: "stop_confirmed" }),
      });
    };
    let archived = false;
    try {
      if (isOpencodeV2BaseUrl(baseUrl)) throw new Error(V2_SESSION_ARCHIVE_UNAVAILABLE);
      const readTree = async () => {
        const root = unwrap(await client.session.get({ sessionID: sessionId, directory: workspace.path }, options));
        if (root.id !== sessionId || root.directory !== workspace.path) throw new Error("Could not verify the conversation's workspace.");
        const ids = [sessionId];
        for (let index = 0; index < ids.length; index += 1) {
          const children = unwrap(await client.session.children({ sessionID: ids[index], directory: workspace.path }, options));
          for (const child of children) {
            if (child.parentID !== ids[index] || child.directory !== workspace.path) throw new Error("Could not verify a subtask's owner.");
            if (!ids.includes(child.id)) ids.push(child.id);
            if (ids.length > 256) throw new Error("Too many subtasks to verify safely.");
          }
        }
        return ids;
      };
      // Native Stop reaches the root immediately, concurrent with discovery.
      // Archive also accounts for older/background subtasks that would be hidden.
      let rootStop: Promise<void> | undefined;
      if (confirmed) {
        if (mounted.current) { setStopping(true); setError(null); }
        hold(sessionId);
        cancelLocal(sessionId);
        rootStop = stop(sessionId);
        void rootStop.catch(() => {});
      }
      const ids = await readTree();
      const readWorking = async () => {
        const [permissions, questions] = await Promise.all([
          client.permission.list({ directory: workspace.path }, options).then(unwrap),
          client.question.list({ directory: workspace.path }, options).then(unwrap),
        ]);
        const observations = await Promise.all(ids.map(async id => {
          const [messages, permissionV2] = await Promise.all([
            client.session.messages({ sessionID: id, directory: workspace.path }, options).then(unwrap),
            client.v2.session.permission.list({ sessionID: id }, options),
          ]);
          if (permissionV2.error && permissionV2.response.status !== 404) unwrap(permissionV2);
          return { id, messages, permissionV2: !permissionV2.error && unwrap(permissionV2).data.length > 0 };
        }));
        const observedAt = Date.now();
        const statuses = unwrap(await client.session.status({ directory: workspace.path }, options));
        return observations.filter(({ id, messages, permissionV2 }) => {
          const idle = !statuses[id] || statuses[id].type === "idle";
          const phase = getQueuedDrainState(id).phase;
          const terminalObserved = "messageID" in phase && Boolean(phase.messageID && hasTerminalSessionReply(messages, id, phase.messageID));
          if (idle && phase.kind === "admission_unknown" && terminalObserved) {
            dispatchQueuedDrain(id, { type: "admission_observed", itemId: phase.itemId, messageID: phase.messageID, at: observedAt });
          }
          if (idle) dispatchQueuedDrain(id, { type: "idle_reconciled", observedAt, terminalObserved });
          else dispatchQueuedDrain(id, { type: "busy_observed" });
          return !idle || permissionV2 || permissions.some(request => request.sessionID === id)
            || questions.some(request => request.sessionID === id) || localWork(id)
            || sessionHasPendingSubmission(baseUrl, id, messages) || sessionNeedsStop(baseUrl, id)
            || hasPendingQueuedAdmission(getQueuedDrainState(id))
            || [workspace.id, endpoint.workspaceId].some(workspaceId =>
              useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[id]?.compacting);
        });
      };
      if (!confirmed && (await readWorking()).length > 0) {
        if (mounted.current) setTarget(target);
        else closeDialog(false);
        return;
      }
      for (const id of ids) hold(id);
      if (!confirmed && ids.some(id => localWork(id) || sessionHasPendingSubmission(baseUrl, id)
        || getQueuedDrainState(id).phase.kind === "sending")) {
        if (mounted.current) setTarget(target);
        else closeDialog(false);
        return;
      }
      if (confirmed) {
        for (const id of ids) if (id !== sessionId) cancelLocal(id);
        const working = await readWorking();
        await Promise.all([rootStop, ...working.filter(({ id }) => id !== sessionId).map(({ id }) => stop(id))]);
      }
      const remaining = await readWorking();
      if (remaining.length) {
        if (!confirmed) { if (mounted.current) setTarget(target); else closeDialog(false); return; }
        throw new Error("A task, approval, or message acceptance is still unresolved. Retry Stop when it can be verified.");
      }
      if ((await readTree()).some(id => !ids.includes(id))) throw new Error("A new subtask appeared. Try again to include it.");
      controller.signal.throwIfAborted();
      for (const id of ids) cancelLocal(id);
      await setSessionArchived(client, sessionId, true, workspace.path);
      archived = true;
      await Promise.all([...new Set([workspace.id, endpoint.workspaceId])].map(id => applySessionArchived(id, sessionId, true)));
      if (mounted.current) current.current.input.onArchivedChange(workspace.id, sessionId, true);
      for (const id of ids) clearQueuedSendContext(id);
      if (readLastSessionFor(workspace.id) === sessionId) writeLastSessionFor(workspace.id, null);
      useWorkbenchStore.getState().archiveTab({ workspaceId: workspace.id, sessionId });
      const route = current.current;
      const navigated = mounted.current && route.input.selectedWorkspaceId === workspace.id && route.input.selectedSessionId === sessionId;
      const undo = navigated ? { workspaceId: workspace.id, sessionId, fromKey: route.location.key, landingKey: null } : null;
      if (undo) undoNavigation.current = undo;
      if (navigated) route.input.navigateToWorkspaceSession(workspace.id, null, { replace: true });
      closeDialog(true);
      showUndo(target, true, undo);
      if (mounted.current) await current.current.input.reloadWorkspaceSessions(workspace.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mounted.current && confirmed && !archived) setError(`The session has not been archived. ${message}`);
      else {
        toast.error(archived ? "Could not refresh sessions" : t("session_management.archive_failed"), { description: message });
        closeDialog(archived);
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      for (const release of releases.values()) release();
      busy.current = false;
      if (mounted.current) setStopping(false);
    }
  }

  async function archiveSession(sessionId: string, archived: boolean): Promise<boolean> {
    if (busy.current || pending.current) return false;
    const workspace = input.workspaces.find(workspace => input.sessionsByWorkspaceId[workspace.id]?.some(session => session.id === sessionId));
    const endpoint = workspace && input.endpointForWorkspace(workspace);
    if (!workspace || !endpoint || isOpencodeV2BaseUrl(endpoint.opencodeBaseUrl)) {
      toast.error(endpoint && isOpencodeV2BaseUrl(endpoint.opencodeBaseUrl) ? V2_SESSION_ARCHIVE_UNAVAILABLE : "The session's workspace is not connected.");
      return false;
    }
    const title = input.sessionsByWorkspaceId[workspace.id]?.find(session => session.id === sessionId)?.title?.trim() || t("session.default_title");
    const target = { workspace, endpoint, sessionId, title, draftScope: input.draftScope };
    if (!archived) return restore(target, true);
    return new Promise<boolean>(resolve => {
      pending.current = resolve;
      void archive(target, false);
    });
  }

  return {
    archiveSession,
    archiveDialog: (
      <AlertDialog open={target !== null} onOpenChange={open => { if (!open && !busy.current) closeDialog(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("session_management.archive_working_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("session_management.archive_working_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>{t("session_management.keep_session_open")}</AlertDialogCancel>
            <AlertDialogAction disabled={stopping} onClick={() => { if (target) void archive(target, true); }}>
              {stopping ? t("session_management.stopping") : t("session_management.stop_and_archive")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}
