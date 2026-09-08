import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import { createClient, unwrap } from "@/app/lib/opencode";
import { abortSession, setSessionArchived } from "@/app/lib/opencode-session";
import { getNativeSessionMessages } from "@/app/lib/opencode-session-native";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "@/components/ui/sonner";
import type { RouteSession, RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { readLastSessionFor, writeLastSessionFor } from "@/react-app/shell/session-memory";
import { workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { useWorkbenchStore } from "../chat/workbench-store";
import { useSessionActivityStore } from "../status/session-activity-store";
import { getComposerQueuedDrafts, useComposerStateStore } from "../surface/composer-state-store";
import { consumeComposerAutoSend, hasComposerAutoSend } from "../surface/composer-auto-send";
import { dispatchQueuedDrain, getQueuedDrainState } from "../surface/queued-drain-machine";
import {
  blockSessionWork, confirmSessionCommandsStopped, hasPendingSessionSend, hasTerminalReply,
  queuedMessageId, reconcileSessionCommands, releaseSessionWork, settleSessionSends,
} from "../surface/session-work-guard";
import { clearQueuedSendContext } from "../sync/queued-send-context";

type ArchiveTarget = { workspace: RouteWorkspace; endpoint: ResolvedWorkspaceEndpoint; sessionId: string };

export function useSessionArchive(input: {
  workspaces: RouteWorkspace[];
  sessionsByWorkspaceId: Record<string, RouteSession[]>;
  endpointForWorkspace: (workspace: RouteWorkspace) => ResolvedWorkspaceEndpoint | null;
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  navigateToWorkspaceSession: (workspaceId: string, sessionId: string | null, options?: { replace: boolean }) => void;
  reloadWorkspaceSessions: (workspaceId: string) => Promise<unknown>;
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
    if (!undo.landingKey && location.pathname === workspaceSessionRoute(undo.workspaceId, null)) {
      undo.landingKey = location.key;
    } else {
      undoNavigation.current = null;
    }
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
    if (mounted.current) {
      setTarget(null);
      setError(null);
    }
    pending.current?.(archived);
    pending.current = null;
  }

  async function archive(target: ArchiveTarget, confirmed: boolean) {
    if (busy.current) return false;
    busy.current = true;
    const { workspace, endpoint, sessionId } = target;
    const baseUrl = endpoint.opencodeBaseUrl;
    const client = createClient(baseUrl, workspace.path, { token: endpoint.token, mode: "openwork" });
    let archived = false;
    let stopConfirmed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sessionIds: string[] = [];
    try {
      const controller = new AbortController();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Stopping could not be confirmed. The session has not been archived. Try again."));
        }, 15_000);
      });
      const options = { signal: controller.signal };
      const readTree = async () => {
        const ids = [sessionId];
        for (let index = 0; index < ids.length; index += 1) {
          const children = unwrap(await client.session.children({ sessionID: ids[index], directory: workspace.path }, options));
          for (const child of children) if (!ids.includes(child.id)) ids.push(child.id);
        }
        return ids;
      };
      sessionIds = await Promise.race([readTree(), timeout]);
      const localWork = sessionIds.some(id =>
        getComposerQueuedDrafts(useComposerStateStore.getState(), id).length > 0
        || hasComposerAutoSend(id) || hasPendingSessionSend(baseUrl, id));
      if (!confirmed && localWork) {
        if (mounted.current) setTarget(target);
        else closeDialog(false);
        return false;
      }
      // Use the same tree for admission guards, cancellation, abort and proof.
      // Cancelling local drafts must not erase a proxy admission's unknown fate.
      for (const id of sessionIds) blockSessionWork(baseUrl, id);
      if (confirmed) {
        if (mounted.current) { setStopping(true); setError(null); }
        for (const id of sessionIds) {
          consumeComposerAutoSend(id);
          for (const item of getComposerQueuedDrafts(useComposerStateStore.getState(), id)) {
            for (const attachment of item.draft.attachments) {
              if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
            }
          }
          useComposerStateStore.getState().clearQueuedDrafts(id);
          dispatchQueuedDrain(id, { type: "queue_cancelled" });
        }
        await Promise.race([Promise.all(sessionIds.map(id => settleSessionSends(baseUrl, id))), timeout]);
      }
      const readWorking = async () => {
        const permissions = unwrap(await client.permission.list({ directory: workspace.path }, options));
        const questions = unwrap(await client.question.list({ directory: workspace.path }, options));
        const observations = [];
        for (const id of sessionIds) {
          const messages = await getNativeSessionMessages(endpoint, id, options);
          const permissionsV2 = await client.v2.session.permission.list({ sessionID: id }, options);
          if (permissionsV2.error) {
            // Shipped engines can expose only the legacy permissions API.
            // Other failures are not evidence that an approval is absent.
            if (permissionsV2.response.status !== 404) unwrap(permissionsV2);
          }
          observations.push({ id, messages, permissionV2: !permissionsV2.error && unwrap(permissionsV2).data.length > 0 });
        }
        const statuses = unwrap(await client.session.status({ directory: workspace.path }, options));
        return observations.map(({ id, messages, permissionV2 }) => {
          const phase = getQueuedDrainState(id).phase;
          const terminalObserved = "itemId" in phase && hasTerminalReply(messages, queuedMessageId(phase.itemId));
          const idle = (statuses[id]?.type ?? "idle") === "idle";
          if (idle) dispatchQueuedDrain(id, { type: "idle_reconciled", observedAt: Date.now(), terminalObserved });
          else dispatchQueuedDrain(id, { type: "busy_observed" });
          const commands = reconcileSessionCommands(baseUrl, id, messages);
          const remaining = getQueuedDrainState(id).phase;
          return {
            id,
            active: !idle || permissionV2
              || permissions.some(request => request.sessionID === id)
              || questions.some(request => request.sessionID === id)
              || [workspace.id, endpoint.workspaceId].some(workspaceId =>
                useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[id]?.compacting),
            unsettled: commands.pending || remaining.kind === "sending" || remaining.kind === "awaiting_observation",
            unobserved: commands.unobserved || remaining.kind === "sending"
              || (remaining.kind === "awaiting_observation"
                && !messages.some(({ info }) => info.id === queuedMessageId(remaining.itemId))),
          };
        });
      };
      let working = await Promise.race([readWorking(), timeout]);
      if (!confirmed && working.some(state => state.active || state.unsettled)) {
        if (mounted.current) setTarget(target);
        else closeDialog(false);
        return false;
      }
      if (confirmed) {
        // Poll for an observable engine admission/terminal reply, never infer
        // dispatch from elapsed idle time. The deadline only decides failure.
        while (working.some(state => state.unobserved || (state.unsettled && !state.active))) {
          await Promise.race([new Promise(resolve => setTimeout(resolve, 250)), timeout]);
          working = await Promise.race([readWorking(), timeout]);
        }
        for (const id of [...sessionIds].reverse()) {
          working = await Promise.race([readWorking(), timeout]);
          if (working.some(state => state.unobserved)) throw new Error("An admission is still unconfirmed.");
          if (!working.find(state => state.id === id)?.active) continue;
          const stopped = await Promise.race([abortSession(client, id, workspace.path, {
            source: "session.archive", initiator: "user", reason: "stop and archive conversation",
          }, options), timeout]);
          if (!stopped) throw new Error("The engine did not confirm cancellation.");
          working = await Promise.race([readWorking(), timeout]);
          if (working.find(state => state.id === id)?.active) throw new Error("The task is still active.");
          confirmSessionCommandsStopped(baseUrl, id);
          dispatchQueuedDrain(id, { type: "stop_confirmed" });
        }
        working = await Promise.race([readWorking(), timeout]);
        if (working.some(state => state.active || state.unsettled)) {
          throw new Error("Stopping could not be confirmed. The session has not been archived. Try again.");
        }
      }
      const finalSessionIds = await Promise.race([readTree(), timeout]);
      if (finalSessionIds.some(id => !sessionIds.includes(id))) {
        throw new Error("A new child task appeared. Try again to include it.");
      }
      // A fresh idle after submissions settle also covers a run that finished
      // while the confirmation was open. Never interpret abort:false as idle.
      stopConfirmed = true;
      clearTimeout(timer);
      await setSessionArchived(client, sessionId, true, workspace.path);
      archived = true;
      for (const id of sessionIds) {
        dispatchQueuedDrain(id, { type: "queue_cancelled" });
        clearQueuedSendContext(id);
      }
      if (readLastSessionFor(workspace.id) === sessionId) writeLastSessionFor(workspace.id, null);
      useWorkbenchStore.getState().archiveTab({ workspaceId: workspace.id, sessionId });
      const route = current.current;
      const navigated = mounted.current && route.input.selectedWorkspaceId === workspace.id && route.input.selectedSessionId === sessionId;
      const undo = navigated ? { workspaceId: workspace.id, sessionId, fromKey: route.location.key, landingKey: null } : null;
      if (undo) undoNavigation.current = undo;
      if (navigated) route.input.navigateToWorkspaceSession(workspace.id, null, { replace: true });
      closeDialog(true);
      toast.success("Session archived", {
        duration: 10_000,
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await setSessionArchived(client, sessionId, false, workspace.path);
                releaseSessionWork(baseUrl, sessionId);
                const now = current.current;
                if (mounted.current && undo && undoNavigation.current === undo
                  && now.input.selectedWorkspaceId === workspace.id && !now.input.selectedSessionId
                  && now.location.pathname === workspaceSessionRoute(workspace.id, null)
                  && (now.location.key === undo.landingKey || now.location.key === undo.fromKey)) {
                  undoNavigation.current = null;
                  writeLastSessionFor(workspace.id, sessionId);
                  now.input.navigateToWorkspaceSession(workspace.id, sessionId, { replace: true });
                }
                if (mounted.current) await now.input.reloadWorkspaceSessions(workspace.id);
              } catch (error) {
                toast.error("Could not restore session", { description: error instanceof Error ? error.message : String(error) });
              }
            })();
          },
        },
      });
      if (mounted.current) await current.current.input.reloadWorkspaceSessions(workspace.id);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mounted.current && confirmed && !archived) {
        setError(stopConfirmed
          ? "The task stopped, but the session could not be archived. Try again."
          : "Stopping could not be confirmed. The session has not been archived. Try again.");
        console.warn("[session-archive] stop and archive failed", error);
      }
      else {
        toast.error(archived ? "Could not refresh sessions" : "Could not archive session", { description: message });
        closeDialog(archived);
      }
      return archived;
    } finally {
      clearTimeout(timer);
      for (const id of sessionIds) releaseSessionWork(baseUrl, id);
      busy.current = false;
      if (mounted.current) setStopping(false);
    }
  }

  async function archiveSession(sessionId: string, archived: boolean): Promise<boolean> {
    if (busy.current || pending.current) return false;
    const workspace = input.workspaces.find((workspace) =>
      input.sessionsByWorkspaceId[workspace.id]?.some((session) => session.id === sessionId));
    const endpoint = workspace && input.endpointForWorkspace(workspace);
    if (!workspace || !endpoint) {
      toast.error("The session's workspace is not connected. Try again when it reconnects.");
      return false;
    }
    if (!archived) {
      try {
        await setSessionArchived(createClient(endpoint.opencodeBaseUrl, workspace.path, {
          token: endpoint.token, mode: "openwork",
        }), sessionId, false, workspace.path);
        releaseSessionWork(endpoint.opencodeBaseUrl, sessionId);
        await input.reloadWorkspaceSessions(workspace.id);
        return true;
      } catch (error) {
        toast.error("Could not restore session", { description: error instanceof Error ? error.message : String(error) });
        return false;
      }
    }
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      void archive({ workspace, endpoint, sessionId }, false);
    });
  }

  return {
    archiveSession,
    archiveDialog: (
      <AlertDialog open={target !== null} onOpenChange={(open) => { if (!open && !busy.current) closeDialog(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This session is still working</AlertDialogTitle>
            <AlertDialogDescription>
              Stop the current task and archive this conversation? Changes already made won’t be undone. Actions already submitted to external services may still complete.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>Keep session open</AlertDialogCancel>
            <AlertDialogAction disabled={stopping} onClick={() => { if (target) void archive(target, true); }}>
              {stopping ? "Stopping…" : "Stop and archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}
