import { DRAFT_OWNER_KEY } from "@openwork/browser-tabs";

export const NO_SESSION_SIDE_PANEL_KEY = DRAFT_OWNER_KEY;

export function getSidePanelSessionKey(sessionId: string | null) {
  if (!sessionId?.trim()) {
    return NO_SESSION_SIDE_PANEL_KEY;
  }

  return sessionId;
}
