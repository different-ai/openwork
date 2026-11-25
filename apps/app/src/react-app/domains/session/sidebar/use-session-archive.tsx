import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Archive, ArchiveRestore } from "lucide-react";

import { createClient, unwrap } from "@/app/lib/opencode";
import { hasTerminalSessionReply, holdSessionWork, interruptSessionTurn, sessionHasPendingSubmission, sessionNeedsStop } from "@/app/lib/opencode-interruption";
import { setSessionArchived } from "@/app/lib/opencode-session";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { readSessionTree } from "@/app/lib/session-ownership";
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
import { isOrphanedInteraction, terminalToolCallIds } from "../sync/orphaned-interactions";
import { applySessionArchived } from "../sync/session-sync";

export type SessionArchiveToggle = { archived: boolean; toggle: () => void };

export type ArchiveRequester = { sessionId: string; title: string | null };

type ArchiveTarget = {
  workspace: RouteWorkspace; endpoint: ResolvedWorkspaceEndpoint; sessionId: string; title: string; draftScope: string | null;
  requestedBy: ArchiveRequester | null;
};

export type ArchiveSessionOutcome =
  | { kind: "done" | "cancelled" }
  | { kind: "verification_failed" | "archive_outcome_unknown"; message: string }
  | { kind: "target_working" | "self_archive_while_working"; sessionId: string; title: string };

export type ArchiveSessionRef = { workspaceId: string; sessionId: string };

type BatchEntry = { target: ArchiveTarget; undo?: { workspaceId: string; sessionId: string; fromKey: string; landingKey: string | null } | null };

export type ArchiveSessionOptions = {
  signal?: AbortSignal;
  requester?: { sessionId: string };
  refuseWorking?: boolean;
};

function archiveClient(endpoint: ResolvedWorkspaceEndpoint, directory: string) {
  return isOpencodeV2BaseUrl(endpoint.opencodeBaseUrl)
    ? createClientV2(endpoint.opencodeBaseUrl, directory, { token: endpoint.token })
    : createClient(endpoint.opencodeBaseUrl, directory, { token: endpoint.token, mode: "openwork" }, { desktopTransport: "main" });
}

export function useSessionArchive(input: {
  workspaces: RouteWorkspace[];
  sessionsByWorkspaceId: Record<string, RouteSession[]>;
  endpointForSessionWorkspace: (workspace: RouteWorkspace) => ResolvedWorkspaceEndpoint | null;
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  draftScope: string | null;
  navigateToWorkspaceSession: (workspaceId: string, sessionId: string | null, options?: { replace: boolean }) => void;
  reloadWorkspaceSessions: (workspaceId: string) => Promise<unknown>;
  previewArchivedChange?: (workspaceId: string, sessionId: string, archived: boolean) => () => void;
  onArchivedChange: (workspaceId: string, sessionId: string, archived: boolean, saved: Pick<RouteSession, "time">) => void;
}) {
  const location = useLocation();
  const current = useRef({ input, location });
  current.current = { input, location };
  const [target, setTarget] = useState<ArchiveTarget | null>(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const pending = useRef<((outcome: ArchiveSessionOutcome) => void) | null>(null);
  const settle = (kind: "done" | "cancelled"): ArchiveSessionOutcome => ({ kind });
  const batch = useRef<BatchEntry[] | null>(null);
  const idle = useRef<Promise<void>>(Promise.resolve());
  const undoNavigation = useRef<{
    workspaceId: string; sessionId: string; fromKey: string; landingKey: string | null;
  } | null>(null);

  useLayoutEffect(() => {
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
      if (activeController.current) activeController.current.abort(new Error("Archive cancelled because the view closed."));
      else {
        pending.current?.(settle("cancelled"));
        pending.current = null;
      }
    };
  }, []);

  function closeDialog(outcome: ArchiveSessionOutcome) {
    if (mounted.current) { setTarget(null); setError(null); }
    pending.current?.(outcome);
    pending.current = null;
  }

  function refreshSessions(workspaceId: string) {
    if (!mounted.current) return;
    void current.current.input.reloadWorkspaceSessions(workspaceId).catch(error => {
      if (mounted.current) toast.error("Could not refresh sessions", { description: String(error) });
    });
  }

  function returnToSession(undo: NonNullable<typeof undoNavigation.current>) {
    if (!mounted.current || undoNavigation.current !== undo) return;
    undoNavigation.current = null;
    const now = current.current;
    if (now.input.selectedWorkspaceId !== undo.workspaceId) return;
    if (now.location.key !== undo.fromKey && (now.location.key !== undo.landingKey
      || now.location.pathname !== workspaceSessionRoute(undo.workspaceId, null))) return;
    writeLastSessionFor(undo.workspaceId, undo.sessionId);
    now.input.navigateToWorkspaceSession(undo.workspaceId, undo.sessionId, { replace: true });
  }

  async function restore(target: ArchiveTarget, announce: boolean, undo?: typeof undoNavigation.current) {
    if (!mounted.current || busy.current || pending.current) return false;
    busy.current = true;
    const { workspace, endpoint, sessionId } = target;
    const clearPreview = current.current.input.previewArchivedChange?.(workspace.id, sessionId, false);
    try {
      const saved = await setSessionArchived(archiveClient(endpoint, workspace.path), sessionId, false, workspace.path);
      if (mounted.current) {
        current.current.input.onArchivedChange(workspace.id, sessionId, false, saved);
        if (undo) returnToSession(undo);
      }
    } catch (error) {
      if (mounted.current) toast.error(t("session_management.unarchive_failed"), { description: error instanceof Error ? error.message : String(error) });
      refreshSessions(workspace.id);
      return false;
    } finally {
      if (mounted.current) clearPreview?.();
      busy.current = false;
    }
    void Promise.all([...new Set([workspace.id, endpoint.workspaceId])].map(id => applySessionArchived(id, sessionId, false))).catch(error => {
      if (mounted.current) toast.error("Could not refresh sessions", { description: String(error) });
    });
    refreshSessions(workspace.id);
    if (announce && mounted.current) showUndo(target, false);
    return true;
  }

  function showUndo(target: ArchiveTarget, archived: boolean, undo?: typeof undoNavigation.current) {
    if (batch.current) { batch.current.push({ target, undo }); return; }
    const message = archived ? t("session_management.session_archived", { title: target.title }) : t("session_management.session_unarchived");
    toast.undo(<span title={message}>{message}</span>, {
      id: `session-archive:${target.sessionId}`,
      icon: archived ? Archive : ArchiveRestore,
      undo: { label: t("common.undo"), onClick: () => {
        if (archived) void restore(target, false, undo);
        else if (mounted.current) void archiveSessionInWorkspace(target.workspace.id, target.sessionId, true);
      } },
      view: { label: t("common.view"), onClick: () => {
        if (mounted.current) current.current.input.navigateToWorkspaceSession(target.workspace.id, target.sessionId);
      } },
      closeLabel: t("common.close"),
    });
  }

  async function archive(target: ArchiveTarget, confirmed: boolean, request?: ArchiveSessionOptions) {
    if (busy.current) return;
    busy.current = true;
    let markIdle = () => {};
    idle.current = new Promise<void>(resolve => { markIdle = resolve; });
    let clearPreview: (() => void) | undefined;
    let undo: typeof undoNavigation.current = null;
    let previewStarted = false;
    const startPreview = () => {
      if (previewStarted || !mounted.current) return;
      previewStarted = true;
      const route = current.current;
      clearPreview = route.input.previewArchivedChange?.(target.workspace.id, target.sessionId, true);
      if (route.input.selectedWorkspaceId !== target.workspace.id || route.input.selectedSessionId !== target.sessionId) return;
      undo = { workspaceId: target.workspace.id, sessionId: target.sessionId, fromKey: route.location.key, landingKey: null };
      undoNavigation.current = undo;
      route.input.navigateToWorkspaceSession(target.workspace.id, null, { replace: true });
    };
    const refusal = (kind: "target_working" | "self_archive_while_working"): ArchiveSessionOutcome =>
      ({ kind, sessionId: target.sessionId, title: target.title });
    const askUser = () => {
      if (!mounted.current) return closeDialog(settle("cancelled"));
      if (request?.refuseWorking) return closeDialog(refusal("target_working"));
      setTarget(target);
    };
    const { workspace, endpoint, sessionId, draftScope } = target;
    const baseUrl = endpoint.opencodeBaseUrl;
    const client = archiveClient(endpoint, workspace.path);
    const releases = new Map<string, () => void>();
    const controller = new AbortController();
    activeController.current = controller;
    const budgetMs = request?.refuseWorking ? 3_500 : 15_000;
    const deadline = Date.now() + budgetMs;
    const timeout = () => controller.abort(new Error("Archive operation timed out before it could be confirmed."));
    const timer = setTimeout(timeout, budgetMs);
    const signal = request?.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
    const options = { signal };
    const checkDeadline = () => {
      if (Date.now() >= deadline) timeout();
      signal.throwIfAborted();
    };
    let rejectAborted: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = () => reject(signal.reason);
      signal.addEventListener("abort", rejectAborted, { once: true });
    });
    void aborted.catch(() => {});
    const bounded = async <T,>(operation: Promise<T>): Promise<T> => {
      const result = await Promise.race([operation, aborted]);
      checkDeadline();
      return result;
    };
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
        onStopped: () => { if (!signal.aborted) dispatchQueuedDrain(id, { type: "stop_confirmed" }); },
      });
    };
    let archived = false;
    let patch: ReturnType<typeof setSessionArchived> | undefined;
    try {
      checkDeadline();
      const records = useSessionActivityStore.getState().recordsByWorkspaceId;
      const knownWorking = [workspace.id, endpoint.workspaceId].some(workspaceId => {
        const seen = new Set<string>();
        const working = (id: string): boolean => {
          if (seen.has(id)) return false;
          seen.add(id);
          const record = records[workspaceId]?.[id];
          return localWork(id) || sessionNeedsStop(baseUrl, id) || sessionHasPendingSubmission(baseUrl, id)
            || hasPendingQueuedAdmission(getQueuedDrainState(id))
            || Boolean(record && (record.status !== "idle" && record.status !== "error" || record.childSessionIds.some(working)));
        };
        return working(sessionId);
      });
      if (!confirmed && !request?.refuseWorking && !knownWorking) startPreview();
      const readTree = () => readSessionTree(client, sessionId, workspace.path, options);
      let rootStop: Promise<void> | undefined;
      if (confirmed) {
        if (mounted.current) { setStopping(true); setError(null); }
        hold(sessionId);
        cancelLocal(sessionId);
        rootStop = stop(sessionId);
        void rootStop.catch(() => {});
      }
      const ids = await bounded(readTree());
      if (!confirmed && request?.refuseWorking && target.requestedBy && ids.includes(target.requestedBy.sessionId)) {
        closeDialog(refusal("self_archive_while_working"));
        return;
      }
      const readWorking = async () => {
        const [permissions, questions] = await bounded(Promise.all([
          client.permission.list({ directory: workspace.path }, options).then(unwrap),
          client.question.list({ directory: workspace.path }, options).then(unwrap),
        ]));
        const observations = await bounded(Promise.all(ids.map(async id => {
          const [messages, permissionV2] = await bounded(Promise.all([
            client.session.messages({ sessionID: id, directory: workspace.path }, options).then(unwrap),
            client.v2.session.permission.list({ sessionID: id }, options),
          ]));
          if (permissionV2.error && permissionV2.response?.status !== 404) unwrap(permissionV2);
          return { id, messages, permissionV2: !permissionV2.error && unwrap(permissionV2).data.length > 0 };
        })));
        const observedAt = Date.now();
        const statuses = unwrap(await bounded(client.session.status({ directory: workspace.path }, options)));
        return observations.filter(({ id, messages, permissionV2 }) => {
          const idle = !statuses[id] || statuses[id].type === "idle";
          const phase = getQueuedDrainState(id).phase;
          const terminalObserved = "messageID" in phase && Boolean(phase.messageID && hasTerminalSessionReply(messages, id, phase.messageID));
          if (idle && phase.kind === "admission_unknown" && terminalObserved) {
            dispatchQueuedDrain(id, { type: "admission_observed", itemId: phase.itemId, messageID: phase.messageID, at: observedAt });
          }
          if (idle) dispatchQueuedDrain(id, { type: "idle_reconciled", observedAt, terminalObserved });
          else dispatchQueuedDrain(id, { type: "busy_observed" });
          const terminal = terminalToolCallIds(messages);
          const unanswered = (request: { sessionID: string; tool?: { messageID: string; callID: string } }) =>
            request.sessionID === id && !isOrphanedInteraction(request.tool, terminal);
          return !idle || permissionV2 || permissions.some(unanswered) || questions.some(unanswered) || localWork(id)
            || sessionHasPendingSubmission(baseUrl, id, messages) || sessionNeedsStop(baseUrl, id)
            || hasPendingQueuedAdmission(getQueuedDrainState(id))
            || [workspace.id, endpoint.workspaceId].some(workspaceId =>
              useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[id]?.compacting);
        });
      };
      if (!confirmed && (await bounded(readWorking())).length > 0) {
        askUser();
        return;
      }
      for (const id of ids) hold(id);
      if (!confirmed && ids.some(id => localWork(id) || sessionHasPendingSubmission(baseUrl, id)
        || getQueuedDrainState(id).phase.kind === "sending")) {
        askUser();
        return;
      }
      if (confirmed) {
        for (const id of ids) if (id !== sessionId) cancelLocal(id);
        const working = await bounded(readWorking());
        await bounded(Promise.all([rootStop, ...working.filter(({ id }) => id !== sessionId).map(({ id }) => stop(id))]));
      }
      const remaining = await bounded(readWorking());
      if (remaining.length) {
        if (!confirmed) { askUser(); return; }
        throw new Error("A task, approval, or message acceptance is still unresolved. Retry Stop when it can be verified.");
      }
      if ((await bounded(readTree())).some(id => !ids.includes(id))) throw new Error("A new subtask appeared. Try again to include it.");
      checkDeadline();
      for (const id of ids) cancelLocal(id);
      checkDeadline();
      if (!request?.refuseWorking) startPreview();
      patch = setSessionArchived(client, sessionId, true, workspace.path, options);
      const saved = await bounded(patch);
      archived = true;
      startPreview();
      if (mounted.current) {
        current.current.input.onArchivedChange(workspace.id, sessionId, true, saved);
        clearPreview?.();
        clearPreview = undefined;
      }
      for (const id of ids) clearQueuedSendContext(id);
      if (readLastSessionFor(workspace.id) === sessionId) writeLastSessionFor(workspace.id, null);
      useWorkbenchStore.getState().archiveTab({ workspaceId: workspace.id, sessionId });
      refreshSessions(workspace.id);
      await bounded(Promise.all([...new Set([workspace.id, endpoint.workspaceId])].map(id => applySessionArchived(id, sessionId, true))));
      closeDialog(settle("done"));
      if (mounted.current) showUndo(target, true, undo);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const message = patch && !archived
        ? `Archive outcome is unknown. The request may have been applied; check the session before retrying. ${cause}`
        : cause;
      const outcome: ArchiveSessionOutcome = archived ? settle("done") : {
        kind: patch ? "archive_outcome_unknown" : "verification_failed", message,
      };
      if (patch && !archived) {
        refreshSessions(workspace.id);
        void patch.then(() => refreshSessions(workspace.id), () => {});
      }
      if (mounted.current && confirmed && !archived) {
        setError(patch ? message : `The session has not been archived. ${message}`);
        pending.current?.(outcome);
        pending.current = null;
      } else {
        if (mounted.current) toast.error(archived ? "Could not refresh sessions" : t("session_management.archive_failed"), { description: message });
        closeDialog(outcome);
      }
    } finally {
      if (mounted.current && !archived) {
        clearPreview?.();
        if (undo) returnToSession(undo);
      }
      clearTimeout(timer);
      signal.removeEventListener("abort", rejectAborted);
      controller.abort();
      activeController.current = null;
      for (const release of releases.values()) release();
      busy.current = false;
      markIdle();
      if (mounted.current) setStopping(false);
    }
  }

  function sessionTitle(sessionId: string): string | null {
    for (const workspace of input.workspaces) {
      const session = input.sessionsByWorkspaceId[workspace.id]?.find(session => session.id === sessionId);
      if (session) return session.title?.trim() || t("session.default_title");
    }
    return null;
  }

  function resolveTarget(sessionId: string, options?: ArchiveSessionOptions, workspaceId?: string): ArchiveTarget | { error: string } {
    const input = current.current.input;
    const workspace = input.workspaces.find(workspace => (!workspaceId || workspace.id === workspaceId)
      && input.sessionsByWorkspaceId[workspace.id]?.some(session => session.id === sessionId));
    if (!workspace) return { error: "Session was not found in the current session list" };
    const endpoint = input.endpointForSessionWorkspace(workspace);
    if (!endpoint) return { error: "The session's workspace is not connected." };
    const title = input.sessionsByWorkspaceId[workspace.id]?.find(session => session.id === sessionId)?.title?.trim() || t("session.default_title");
    const requester = options?.requester?.sessionId.trim();
    const requestedBy = requester ? { sessionId: requester, title: sessionTitle(requester) } : null;
    return { workspace, endpoint, sessionId, title, draftScope: input.draftScope, requestedBy };
  }

  function archiveSessionInWorkspace(workspaceId: string, sessionId: string, archived: boolean): Promise<ArchiveSessionOutcome> {
    if (!workspaceId) return Promise.resolve({ kind: "verification_failed", message: "The session's workspace is missing." });
    return archiveOwnedSession(sessionId, archived, undefined, workspaceId);
  }

  function archiveSession(sessionId: string, archived: boolean, options?: ArchiveSessionOptions): Promise<ArchiveSessionOutcome> {
    return archiveOwnedSession(sessionId, archived, options);
  }

  async function archiveOwnedSession(sessionId: string, archived: boolean, options?: ArchiveSessionOptions, workspaceId?: string): Promise<ArchiveSessionOutcome> {
    if (busy.current || pending.current) return settle("cancelled");
    const target = resolveTarget(sessionId, options, workspaceId);
    if ("error" in target) {
      toast.error(target.error);
      return { kind: "verification_failed", message: target.error };
    }
    if (!archived) return settle((await restore(target, true)) ? "done" : "cancelled");
    return new Promise<ArchiveSessionOutcome>(resolve => {
      pending.current = resolve;
      void archive(target, false, options);
    });
  }

  function showBatchUndo(entries: BatchEntry[], archived: boolean) {
    const count = entries.length;
    const message = archived ? t("session_management.sessions_archived", { count }) : t("session_management.sessions_unarchived", { count });
    toast.undo(<span title={message}>{message}</span>, {
      id: `session-archive-batch:${entries.map(({ target }) => target.sessionId).join(",")}`,
      icon: archived ? Archive : ArchiveRestore,
      undo: { label: t("common.undo"), onClick: () => {
        if (!mounted.current) return;
        if (archived) void (async () => { for (const { target, undo } of entries) await restore(target, false, undo); })();
        else void archiveSessionsInWorkspaces(entries.map(({ target }) => ({ workspaceId: target.workspace.id, sessionId: target.sessionId })), true);
      } },
      closeLabel: t("common.close"),
    });
  }

  async function archiveSessionsInWorkspaces(refs: readonly ArchiveSessionRef[], archived: boolean): Promise<ArchiveSessionOutcome[]> {
    if (busy.current || pending.current || batch.current) return [settle("cancelled")];
    const entries: BatchEntry[] = [];
    const outcomes: ArchiveSessionOutcome[] = [];
    batch.current = entries;
    try {
      for (const ref of refs) {
        if (!mounted.current) break;
        outcomes.push(await archiveSessionInWorkspace(ref.workspaceId, ref.sessionId, archived));
        await idle.current;
      }
    } finally {
      batch.current = null;
    }
    if (entries.length > 0 && mounted.current) showBatchUndo(entries, archived);
    return outcomes;
  }

  return {
    archiveSession,
    archiveSessionInWorkspace,
    archiveSessionsInWorkspaces,
    archiveDialog: (
      <AlertDialog open={target !== null} onOpenChange={open => { if (!open && !busy.current) closeDialog(settle("cancelled")); }}>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="min-w-0 max-w-full [overflow-wrap:anywhere]">
              {target ? t("session_management.archive_working_title", { title: target.title }) : null}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("session_management.archive_working_description")}</AlertDialogDescription>
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
