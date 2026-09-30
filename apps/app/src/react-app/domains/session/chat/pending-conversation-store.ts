import type { Session } from "@opencode-ai/sdk/v2/client";
import { create } from "zustand";
import { snapshotComposerSessionState, type ComposerSessionState } from "../surface/composer-state-store";
import type { NewSessionDestination } from "./new-session-destination";
import { createDraftFirstSend } from "./draft-first-send";
import { useWorkbenchStore, workbenchSessionKey } from "./workbench-store";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { composerAutoSendScopeKey, type ComposerAutoSendPayload } from "../surface/composer-auto-send";

/** Local navigation identity. It is never an engine session ID. */
export type PendingConversation = {
  id: string;
  scope: string | null;
  destination: NewSessionDestination;
  submitted: ComposerSessionState;
  phase: "creating" | "creation-failed" | "persisted";
  error: unknown;
  sessionId?: string;
  /** Bridges publication until the route's session list acknowledges this ID. */
  session?: Session;
  groupAssigned: boolean;
};

export const usePendingConversationStore = create<{ conversations: Record<string, PendingConversation> }>(() => ({ conversations: {} }));
const retries = new Map<string, () => Promise<void>>();
const assignments = new Map<string, Promise<void>>();

/** Sidebar destinations use route IDs; the receiving surface uses server-owned IDs. */
export function pendingConversationAutoSendPayload(entry: PendingConversation, endpoint: Pick<ResolvedWorkspaceEndpoint, "workspaceId" | "opencodeBaseUrl">, sessionId: string): ComposerAutoSendPayload {
  return {
    scopeKey: composerAutoSendScopeKey({ draftScope: entry.scope, workspaceId: endpoint.workspaceId, opencodeBaseUrl: endpoint.opencodeBaseUrl, sessionId }),
    composer: entry.submitted,
  };
}

export function pendingConversationForRoute(conversations: Record<string, PendingConversation>, id: string | null, scope: string | null, workspaceId: string, preparingWorkspace = false) {
  const entry = id ? conversations[id] : undefined;
  return entry?.scope === scope && (entry.destination.workspaceId === workspaceId || preparingWorkspace) ? entry : undefined;
}

export function bindPendingConversationWorkspace(id: string, workspaceId: string) {
  const entry = usePendingConversationStore.getState().conversations[id];
  if (!entry || entry.sessionId || (entry.destination.workspaceId && entry.destination.workspaceId !== workspaceId)) throw new Error("Pending conversation destination changed.");
  update(id, { destination: { ...entry.destination, workspaceId } });
}

export function withPendingSessionPublication(lists: Record<string, Session[]>, conversations: Record<string, PendingConversation>, scope: string | null) {
  const next = { ...lists };
  for (const entry of Object.values(conversations)) {
    if (entry.scope !== scope || !entry.session) continue;
    const workspaceId = entry.destination.workspaceId;
    if (!next[workspaceId]?.some((session) => session.id === entry.sessionId)) next[workspaceId] = [entry.session, ...(next[workspaceId] ?? [])];
  }
  return next;
}

export function withPendingGroupAssignments(assignments: Record<string, string>, conversations: Record<string, PendingConversation>, scope: string | null | undefined, workspaceId: string) {
  const next = { ...assignments };
  for (const entry of Object.values(conversations)) {
    if (entry.scope === scope && entry.destination.workspaceId === workspaceId && entry.sessionId && !entry.groupAssigned && entry.destination.groupId) next[entry.sessionId] = entry.destination.groupId;
  }
  return next;
}

/** Replace only this pending side pane; closing/switching it is a newer intent. */
export function publishPendingSideChat(entry: PendingConversation, session: Session, workspaceTitle?: string) {
  const parent = entry.destination.parent;
  if (!parent) return;
  const workbench = useWorkbenchStore.getState();
  const side = workbench.sideChats[workbenchSessionKey(parent)];
  if (side?.pendingConversationId !== entry.id) return;
  const tab = { workspaceId: entry.destination.workspaceId, workspaceTitle, sessionId: session.id, title: session.title };
  workbench.openTab(tab);
  workbench.setSideChat(parent, tab);
  workbench.focusPane(workbench.focusedPane);
  workbench.closeTab(side);
}

function update(id: string, patch: Partial<PendingConversation>) {
  usePendingConversationStore.setState((state) => {
    const current = state.conversations[id];
    return current ? { conversations: { ...state.conversations, [id]: { ...current, ...patch } } } : state;
  });
}

/** Begin synchronously, before consuming the source draft or starting network work. */
export function beginPendingConversation(input: Pick<PendingConversation, "scope" | "destination" | "submitted">) {
  if (!input.scope) throw new Error("Wait for your account to finish loading before sending.");
  const id = crypto.randomUUID();
  const conversation: PendingConversation = {
    ...input, id, submitted: snapshotComposerSessionState(input.submitted),
    phase: "creating", error: null, groupAssigned: !input.destination.groupId,
  };
  usePendingConversationStore.setState((state) => ({ conversations: { ...state.conversations, [id]: conversation } }));
  return conversation;
}

/** Retries are scoped to this submission, not whichever draft is now on screen. */
export function createPendingConversation<T extends { session: Session }>(id: string, create: () => Promise<T>, publish: (created: T) => void) {
  const once = createDraftFirstSend<T>();
  const run = () => {
    const current = usePendingConversationStore.getState().conversations[id];
    if (!current || current.phase === "persisted") return Promise.resolve();
    update(id, { phase: "creating", error: null });
    return once.run(id, create, async (created) => {
      // Publish the real ID to the sidebar before any assignment/admission work.
      update(id, { phase: "persisted", sessionId: created.session.id, session: created.session, error: null });
      publish(created);
      retries.delete(id);
    }).catch((error: unknown) => {
      // A publication failure must never turn a real session back into a create retry.
      if (!usePendingConversationStore.getState().conversations[id]?.sessionId) update(id, { phase: "creation-failed", error });
      else update(id, { error });
    });
  };
  retries.set(id, run);
  return run();
}

export function retryPendingConversation(id: string) { return retries.get(id)?.() ?? Promise.resolve(); }

export function acknowledgePendingSession(scope: string | null, workspaceId: string, sessionId: string) {
  for (const entry of Object.values(usePendingConversationStore.getState().conversations)) {
    if (entry.scope === scope && entry.destination.workspaceId === workspaceId && entry.sessionId === sessionId && entry.session) update(entry.id, { session: undefined });
  }
}

/** Called by the real session's ordinary send/retry path, never by the hero. */
export async function ensurePendingConversationGroup(scope: string | null, workspaceId: string, sessionId: string, assign: (workspaceId: string, sessionId: string, groupId: string) => Promise<void>) {
  const entry = Object.values(usePendingConversationStore.getState().conversations).find((item) => item.scope === scope && item.destination.workspaceId === workspaceId && item.sessionId === sessionId);
  if (!entry || entry.groupAssigned || !entry.destination.groupId) return;
  const pending = assignments.get(entry.id);
  if (pending) return pending;
  const groupId = entry.destination.groupId;
  const request = Promise.resolve().then(() => assign(workspaceId, sessionId, groupId)).then(() => {
    update(entry.id, { groupAssigned: true, error: null });
  }).catch((error: unknown) => {
    update(entry.id, { error });
    const failure = new Error(error instanceof Error ? error.message : "Group assignment failed", { cause: error });
    failure.name = "SessionGroupAssignmentError";
    throw failure;
  }).finally(() => assignments.delete(entry.id));
  assignments.set(entry.id, request);
  return request;
}
