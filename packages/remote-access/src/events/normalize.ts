import { record } from "../contract/index.js";
import type { Hint } from "./replay-buffer.js";
export function normalizeEvent(
  value: unknown,
  workspaceId: string,
): { hint: Hint; reset: boolean } {
  if (!record(value) || typeof value.type !== "string" || !record(value.data))
    return { hint: { kind: "hostChanged", workspaceId }, reset: true };
  const d = value.data,
    sid =
      typeof d.sessionID === "string"
        ? d.sessionID
        : value.type === "session.created" && typeof d.id === "string"
          ? d.id
          : undefined;
  if (!sid || !/^[A-Za-z0-9_-]{1,200}$/.test(sid))
    return { hint: { kind: "hostChanged", workspaceId }, reset: true };
  let kind: Hint["kind"];
  if (/\.permission\.|^permission\.|^form\./.test(value.type))
    kind = "approvalsChanged";
  else if (/^session\.(text|reasoning|tool|step|next|usage)\./.test(value.type))
    kind = "messageChanged";
  else if (/^session\.(execution|inbox)\./.test(value.type))
    kind = "statusChanged";
  else if (/^session\.(created|updated|deleted)$/.test(value.type))
    kind = "sessionChanged";
  else return { hint: { kind: "hostChanged", workspaceId }, reset: true };
  return { hint: { kind, workspaceId, sessionId: sid }, reset: false };
}
