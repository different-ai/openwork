import type { SessionActionTarget } from "@/react-app/domains/session/sidebar/session-menu-actions";

export const OPEN_SESSION_ACTION_EVENT = "openwork:session:action";
export type SessionDialogRequest =
  | { action: "rename" | "delete"; target: SessionActionTarget }
  | { action: "create-group"; workspaceId: string };

export function requestSessionDialog(request: SessionDialogRequest): void {
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_ACTION_EVENT, { detail: request }));
}

export function sessionDialogRequestFromEvent(event: Event): SessionDialogRequest | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (!detail || typeof detail !== "object" || !("action" in detail)) return null;
  if (detail.action === "create-group" && "workspaceId" in detail && typeof detail.workspaceId === "string" && detail.workspaceId) {
    return { action: "create-group", workspaceId: detail.workspaceId };
  }
  if ((detail.action !== "rename" && detail.action !== "delete") || !("target" in detail)) return null;
  const target = detail.target;
  if (!target || typeof target !== "object" || !("workspaceId" in target) || !("sessionId" in target) || !("title" in target)
    || typeof target.workspaceId !== "string" || !target.workspaceId || typeof target.sessionId !== "string" || !target.sessionId
    || typeof target.title !== "string") return null;
  return { action: detail.action, target: { workspaceId: target.workspaceId, sessionId: target.sessionId, title: target.title } };
}
