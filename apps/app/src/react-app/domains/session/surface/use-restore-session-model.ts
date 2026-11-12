import { useLayoutEffect } from "react";
import { controlSessionModel, type ControlSessionLike } from "../control/list-control-sessions";
import { useSessionModelStore } from "./session-model-store";

/** Use only an owned engine session, never the concrete answered-by model of
 * a reply: Auto/Smart may have routed it without changing the chosen router. */
export function restoreSessionModel(sessionId: string, session: ControlSessionLike | null | undefined) {
  const model = session?.id === sessionId ? controlSessionModel(session) : null;
  if (!model) return;
  useSessionModelStore.getState().restoreModel(sessionId,
    { providerID: model.providerId, modelID: model.modelId }, model.variant);
}

/** Remote/API-created sessions already have an engine-bound model, but have
 * never visited this browser's picker. Restore it when owned history arrives,
 * before painting the ready composer. */
export function useRestoreSessionModel(sessionId: string, session: ControlSessionLike | null | undefined) {
  useLayoutEffect(() => restoreSessionModel(sessionId, session), [sessionId, session]);
}
