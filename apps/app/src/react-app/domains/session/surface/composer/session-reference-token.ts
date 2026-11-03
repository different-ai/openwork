import { parseSessionReference, sessionReferenceHref } from "@/components/chat/session-reference";

/**
 * A `[session <workspaceId> <sessionId> <title>]` composer draft token is a
 * reference to another task, picked from the composer `#` menu. The ids keep
 * it stable when the task is renamed; the title is only the label shown when
 * the task can no longer be found.
 *
 * Sent, it becomes the task's route (`/workspace/<id>/session/<id>`), which
 * the transcript already renders as a link with the task's current title, plus
 * a synthetic instruction that tells the agent how to read it.
 */
export type SessionReferenceTokenValue = {
  workspaceId: string;
  sessionId: string;
  title: string;
};

const SESSION_TOKEN_RE = /^\[session (\S+) (\S+)(?: ([^\]\n]*))?\]$/;

export function sanitizeSessionReferenceTitle(title: string) {
  return title.replace(/[[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Both ids must survive as route segments; anything else is not a reference. */
function validIdentity(workspaceId: string, sessionId: string) {
  const parsed = parseSessionReference(sessionReferenceHref({ workspaceId, sessionId }));
  return parsed?.workspaceId === workspaceId && parsed.sessionId === sessionId;
}

export function encodeSessionReferenceToken(value: SessionReferenceTokenValue): string | null {
  if (!validIdentity(value.workspaceId, value.sessionId)) return null;
  const title = sanitizeSessionReferenceTitle(value.title);
  return title
    ? `[session ${value.workspaceId} ${value.sessionId} ${title}]`
    : `[session ${value.workspaceId} ${value.sessionId}]`;
}

/** The reference carried by one `[session …]` segment, or null. */
export function parseSessionReferenceToken(segment: string): SessionReferenceTokenValue | null {
  const match = segment.match(SESSION_TOKEN_RE);
  const workspaceId = match?.[1];
  const sessionId = match?.[2];
  if (!workspaceId || !sessionId || !validIdentity(workspaceId, sessionId)) return null;
  return { workspaceId, sessionId, title: sanitizeSessionReferenceTitle(match[3] ?? "") };
}

/** What the user message holds: the task route, rendered as a link in the transcript. */
export function sessionReferenceText(value: SessionReferenceTokenValue) {
  return sessionReferenceHref(value);
}

/** Model-facing steering text. Only ever sent as a synthetic part. */
export function sessionReferencePrompt(value: SessionReferenceTokenValue) {
  const title = value.title ? ` "${value.title}"` : "";
  return `The user referenced another OpenWork task${title} (sessionId: ${value.sessionId}, workspaceId: ${value.workspaceId}), shown in their message as ${sessionReferenceText(value)}. When it helps with the request, read it as context with the OpenWork session.read query (openwork_query id "session.read", args { "sessionId": "${value.sessionId}" }; add "summary": true for a quick overview). A summary holds only the first request and the last reply, and a plain read only the last 30 messages: for details from earlier in the task, read again with "count" (up to 100) and "from": "start", or find the passage first with session.search, and do not say something is missing from the task until you have read that far back. If it cannot be read because it was deleted or is not accessible, say so briefly and continue without it. Do not change or send messages to that task unless the user asks.`;
}
