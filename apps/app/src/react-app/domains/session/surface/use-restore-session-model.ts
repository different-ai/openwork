import { useLayoutEffect } from "react";
import { controlSessionModel, type ControlSessionLike } from "../control/list-control-sessions";
import { useSessionModelStore } from "./session-model-store";

export function restoreSessionModel(sessionId: string, session: ControlSessionLike | null | undefined) {
  const model = session?.id === sessionId ? controlSessionModel(session) : null;
  if (!model) return;
  useSessionModelStore.getState().restoreModel(sessionId,
    { providerID: model.providerId, modelID: model.modelId }, model.variant);
}

export function useRestoreSessionModel(sessionId: string, session: ControlSessionLike | null | undefined) {
  useLayoutEffect(() => restoreSessionModel(sessionId, session), [sessionId, session]);
}
