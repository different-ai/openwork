export const OPEN_RENAME_SESSION_EVENT = "openwork:session:rename";

export function requestRenameSession(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_RENAME_SESSION_EVENT, { detail: { sessionId } }));
}

export function renameSessionIdFromEvent(event: Event): string | null {
  if (!(event instanceof CustomEvent)) return null;
  return typeof event.detail?.sessionId === "string" ? event.detail.sessionId : null;
}
