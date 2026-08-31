import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import { markTaskRunStart } from "@/app/lib/analytics";
import { createClient } from "@/app/lib/opencode";
import { shellInSession } from "@/app/lib/opencode-session";
import { composeNativeSessionSnapshot } from "@/app/lib/opencode-session-native";
import type { ComposerDraft, ModelRef } from "@/app/types";
import { readStoredDefaultModel } from "@/react-app/kernel/model-config";
import { useSessionActivityStore } from "../status/session-activity-store";
import {
  getComposerQueuedDrafts,
  useComposerStateStore,
} from "../surface/composer-state-store";
import {
  canAdmitNextQueuedItem,
  claimQueuedSend,
  dispatchQueuedDrain,
  getQueuedDrainState,
  nextObservationProbeAt,
  subscribeQueuedDrain,
} from "../surface/queued-drain-machine";
import { getSessionModelSelection, useSessionModelStore } from "../surface/session-model-store";
import { draftToParts } from "./draft-parts";
import { buildOpenworkEnvSystemContext } from "./env-context";
import {
  clearQueuedSendContext,
  getQueuedSendContext,
  subscribeQueuedSendContext,
  type QueuedSendContext,
} from "./queued-send-context";
import { ensureWorkspaceSessionSync, trackWorkspaceSessionSync } from "./session-sync";

type WatchedSession = {
  sessionId: string;
  context: QueuedSendContext;
  releaseWorkspaceSync: () => void;
  releaseSessionSync: () => void;
  unsubscribeDrain: () => void;
  initialStatusController: AbortController;
  probeController: AbortController | null;
  probeTimer: ReturnType<typeof setTimeout> | null;
  lastObservedStatus: SessionStatus | null;
  lastProbeAt: number | null;
  probeInFlight: boolean;
  sendInFlight: boolean;
};

const watchedSessions = new Map<string, WatchedSession>();
let startRefs = 0;
let unsubscribeComposerStore: (() => void) | null = null;
let unsubscribeContexts: (() => void) | null = null;

function sameContext(left: QueuedSendContext, right: QueuedSendContext) {
  return left.workspaceId === right.workspaceId
    && left.workspaceRoot === right.workspaceRoot
    && left.opencodeBaseUrl === right.opencodeBaseUrl
    && left.openworkToken === right.openworkToken
    && left.client === right.client
    && left.agent === right.agent
    && left.variant === right.variant
    && left.model?.providerID === right.model?.providerID
    && left.model?.modelID === right.model?.modelID
    && left.environmentRuntimeKey === right.environmentRuntimeKey;
}

function serializeSDKError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    try {
      const serialized = JSON.stringify(error);
      if (serialized) return serialized;
    } catch {
      const message = Reflect.get(error, "message");
      return typeof message === "string" ? message : String(error);
    }
  }
  return String(error);
}

function readStoredDefaultModelSafely(): ModelRef | null {
  try {
    return readStoredDefaultModel();
  } catch {
    return null;
  }
}

async function performQueuedDraftSend(
  context: QueuedSendContext,
  sessionId: string,
  draft: ComposerDraft,
) {
  const text = draft.text.trim();
  if (!text && draft.attachments.length === 0 && !draft.command) return;

  const sessionModelSelection = getSessionModelSelection(sessionId);
  const sendModel = sessionModelSelection?.model ?? readStoredDefaultModelSafely() ?? context.model;
  const sendVariant = sessionModelSelection ? sessionModelSelection.variant : context.variant;
  const opencodeClient = createClient(
    context.opencodeBaseUrl,
    context.workspaceRoot || undefined,
    { token: context.openworkToken, mode: "openwork" },
  );

  if (draft.mode === "shell") {
    await shellInSession(opencodeClient, sessionId, text);
    return;
  }

  if (draft.command) {
    const result = await opencodeClient.session.command({
      sessionID: sessionId,
      command: draft.command.name,
      arguments: draft.command.arguments,
    });
    if (result.error) throw new Error(serializeSDKError(result.error));
    return;
  }

  const parts = await draftToParts(draft, context.workspaceRoot, sessionId, {
    client: context.client,
    workspaceId: context.workspaceId,
  });
  const envSystemContext = await buildOpenworkEnvSystemContext(context.client, {
    cacheKey: sessionId,
    runtimeKey: context.environmentRuntimeKey,
  });
  const result = await opencodeClient.session.promptAsync({
    sessionID: sessionId,
    parts,
    model: sendModel ?? undefined,
    agent: context.agent ?? undefined,
    ...(sendVariant ? { variant: sendVariant } : {}),
    ...(envSystemContext ? { system: envSystemContext } : {}),
  });
  if (result.error) throw new Error(serializeSDKError(result.error));
  if (sendModel) {
    useSessionModelStore.getState().setModel(sessionId, sendModel, sendVariant ?? null);
  }
}

// Mirrors withoutRevertTarget in ../surface/session-surface.tsx without
// importing the component module.
function withoutRevertTarget(draft: ComposerDraft): ComposerDraft {
  if (!draft.revertMessageId) return draft;
  return { ...draft, revertMessageId: undefined };
}

// Mirrors revokeAttachmentPreview in ../surface/session-surface.tsx, with a
// guard for app-less/node execution.
function revokeAttachmentPreview(attachment: { previewUrl?: string }) {
  if (!attachment.previewUrl || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(attachment.previewUrl);
}

function armObservationProbe(watched: WatchedSession) {
  if (watchedSessions.get(watched.sessionId) !== watched) return;
  if (watched.probeTimer !== null) {
    clearTimeout(watched.probeTimer);
    watched.probeTimer = null;
  }
  if (watched.probeInFlight) return;

  const probeAt = nextObservationProbeAt(
    getQueuedDrainState(watched.sessionId),
    watched.lastProbeAt,
  );
  if (probeAt === null) return;

  watched.probeTimer = setTimeout(() => {
    watched.probeTimer = null;
    const startedAt = Date.now();
    watched.lastProbeAt = startedAt;
    watched.probeInFlight = true;
    const controller = new AbortController();
    watched.probeController = controller;
    void composeNativeSessionSnapshot(
      {
        opencodeBaseUrl: watched.context.opencodeBaseUrl,
        token: watched.context.openworkToken,
      },
      watched.sessionId,
      { limit: 140, signal: controller.signal },
    ).then((snapshot) => {
      if (watchedSessions.get(watched.sessionId) !== watched) return;
      watched.lastObservedStatus = snapshot.status;
      if (snapshot.status.type === "idle") {
        dispatchQueuedDrain(watched.sessionId, {
          type: "idle_reconciled",
          observedAt: startedAt,
        });
      } else {
        dispatchQueuedDrain(watched.sessionId, { type: "busy_observed" });
      }
    }).catch(() => {
      // A spaced retry is armed below from the machine's timing helper.
    }).finally(() => {
      if (watchedSessions.get(watched.sessionId) !== watched) return;
      watched.probeInFlight = false;
      watched.probeController = null;
      armObservationProbe(watched);
    });
  }, Math.max(0, probeAt - Date.now()));
}

function handleObservedStatus(watched: WatchedSession, status: SessionStatus) {
  if (watchedSessions.get(watched.sessionId) !== watched) return;
  watched.lastObservedStatus = status;
  if (status.type !== "idle") {
    dispatchQueuedDrain(watched.sessionId, { type: "busy_observed" });
    return;
  }
  if (getQueuedDrainState(watched.sessionId).phase.kind === "running") {
    dispatchQueuedDrain(watched.sessionId, {
      type: "idle_reconciled",
      observedAt: Date.now(),
    });
  }
  void attemptDrain(watched.sessionId);
}

function releaseWatchedSession(watched: WatchedSession, clearContext: boolean) {
  if (watchedSessions.get(watched.sessionId) === watched) {
    watchedSessions.delete(watched.sessionId);
  }
  if (watched.probeTimer !== null) clearTimeout(watched.probeTimer);
  watched.initialStatusController.abort();
  watched.probeController?.abort();
  watched.unsubscribeDrain();
  watched.releaseSessionSync();
  watched.releaseWorkspaceSync();
  if (clearContext) clearQueuedSendContext(watched.sessionId);
}

function watchSession(sessionId: string, context: QueuedSendContext) {
  const initialStatusController = new AbortController();
  const watched: WatchedSession = {
    sessionId,
    context,
    releaseWorkspaceSync: () => {},
    releaseSessionSync: () => {},
    unsubscribeDrain: () => {},
    initialStatusController,
    probeController: null,
    probeTimer: null,
    lastObservedStatus: null,
    lastProbeAt: null,
    probeInFlight: false,
    sendInFlight: false,
  };
  const input = {
    workspaceId: context.workspaceId,
    baseUrl: context.opencodeBaseUrl,
    openworkToken: context.openworkToken,
    onSessionStatus: (update: { sessionId: string; status: SessionStatus }) => {
      if (update.sessionId === sessionId) handleObservedStatus(watched, update.status);
    },
  };
  watched.releaseWorkspaceSync = ensureWorkspaceSessionSync(input);
  watched.releaseSessionSync = trackWorkspaceSessionSync(input, sessionId);
  watchedSessions.set(sessionId, watched);
  watched.unsubscribeDrain = subscribeQueuedDrain(sessionId, () => {
    armObservationProbe(watched);
    if (watched.lastObservedStatus?.type === "idle") void attemptDrain(sessionId);
  });
  armObservationProbe(watched);

  void composeNativeSessionSnapshot(
    { opencodeBaseUrl: context.opencodeBaseUrl, token: context.openworkToken },
    sessionId,
    { limit: 140, signal: initialStatusController.signal },
  ).then((snapshot) => {
    handleObservedStatus(watched, snapshot.status);
  }).catch(() => {
    // The live workspace stream remains authoritative if this initial read fails.
  });
}

function reconcileWatchedSessions() {
  if (startRefs === 0) return;
  const queuedDrafts = useComposerStateStore.getState().queuedDrafts;

  for (const [sessionId, watched] of [...watchedSessions]) {
    const queuedItems = queuedDrafts[sessionId] ?? [];
    const context = getQueuedSendContext(sessionId);
    if (watched.sendInFlight) continue;
    if (queuedItems.length === 0 || !context) {
      releaseWatchedSession(watched, queuedItems.length === 0);
      continue;
    }
    if (!sameContext(watched.context, context)) {
      releaseWatchedSession(watched, false);
      watchSession(sessionId, context);
    }
  }

  for (const [sessionId, queuedItems] of Object.entries(queuedDrafts)) {
    if (queuedItems.length === 0 || watchedSessions.has(sessionId)) continue;
    const context = getQueuedSendContext(sessionId);
    if (context) watchSession(sessionId, context);
  }

  for (const [sessionId] of [...watchedSessions]) void attemptDrain(sessionId);
}

async function attemptDrain(sessionId: string) {
  const watched = watchedSessions.get(sessionId);
  if (!watched || watched.sendInFlight) return;
  const context = getQueuedSendContext(sessionId);
  const nextItem = getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId)[0];
  if (!context || !nextItem || watched.lastObservedStatus?.type !== "idle") return;
  if (!canAdmitNextQueuedItem(getQueuedDrainState(sessionId))) return;

  const draft = withoutRevertTarget(nextItem.draft);
  // Claim synchronously before any await so a mounted surface cannot win the
  // same item after this drainer observes it.
  if (!claimQueuedSend(sessionId, nextItem.id)) return;
  watched.sendInFlight = true;
  useComposerStateStore.getState().removeQueuedDraft(sessionId, nextItem.id);

  try {
    await performQueuedDraftSend(context, sessionId, draft);
    dispatchQueuedDrain(sessionId, {
      type: "send_result",
      itemId: nextItem.id,
      outcome: "sent",
      at: Date.now(),
    });
    draft.attachments.forEach(revokeAttachmentPreview);
    useComposerStateStore.getState().appendHistory(sessionId, draft.text);
    useSessionActivityStore.getState().setRunStatus(
      context.workspaceId,
      sessionId,
      { type: "busy" },
    );
    markTaskRunStart(sessionId);
  } catch {
    dispatchQueuedDrain(sessionId, { type: "send_error", itemId: nextItem.id });
    useComposerStateStore.getState().prependQueuedDrafts(sessionId, [{ id: nextItem.id, draft }]);
  } finally {
    watched.sendInFlight = false;
    if (startRefs > 0) {
      reconcileWatchedSessions();
    }
    if (getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId).length === 0) {
      clearQueuedSendContext(sessionId);
    }
  }
}

function stopGlobalQueueDrainer() {
  unsubscribeComposerStore?.();
  unsubscribeContexts?.();
  unsubscribeComposerStore = null;
  unsubscribeContexts = null;
  for (const watched of [...watchedSessions.values()]) {
    releaseWatchedSession(watched, false);
  }
}

export function startGlobalQueueDrainer(): () => void {
  startRefs += 1;
  if (startRefs === 1) {
    unsubscribeComposerStore = useComposerStateStore.subscribe(reconcileWatchedSessions);
    unsubscribeContexts = subscribeQueuedSendContext(reconcileWatchedSessions);
    reconcileWatchedSessions();
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    startRefs = Math.max(0, startRefs - 1);
    if (startRefs === 0) stopGlobalQueueDrainer();
  };
}
