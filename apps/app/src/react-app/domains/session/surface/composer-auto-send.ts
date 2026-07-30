/**
 * One-step "Run task" from the empty-state hero: the route seeds the created
 * session's draft and marks it here; the session surface consumes the mark
 * and fires its normal send path once the composer is ready. If the send
 * conditions are never met (e.g. no usable model), the mark simply expires
 * with the surface and the seeded draft stays for manual sending.
 */
const pendingAutoSendSessionIds = new Set<string>();

export function markComposerAutoSend(sessionId: string) {
  const id = sessionId.trim();
  if (id) pendingAutoSendSessionIds.add(id);
}

export function consumeComposerAutoSend(sessionId: string): boolean {
  return pendingAutoSendSessionIds.delete(sessionId.trim());
}
