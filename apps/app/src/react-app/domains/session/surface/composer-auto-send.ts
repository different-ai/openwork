/**
 * One-step "Run task" from the empty-state hero: the route seeds the created
 * session's continuation draft and marks the submitted draft here; the
 * session surface consumes the mark and fires its normal send path once the
 * composer is ready.
 */
import { snapshotComposerSessionState, type ComposerSessionState } from "./composer-state-store";

export type ComposerAutoSendPayload = {
  scopeKey: string;
  composer: ComposerSessionState;
};

export function composerAutoSendScopeKey(input: {
  draftScope: string | null;
  opencodeBaseUrl: string;
  workspaceId: string;
  sessionId: string;
}) {
  return JSON.stringify([input.draftScope, input.opencodeBaseUrl, input.workspaceId, input.sessionId]);
}

const pendingLegacyAutoSendSessionIds = new Set<string>();
const pendingScopedAutoSends = new Map<string, Map<string, ComposerAutoSendPayload>>();
const autoSendListenersBySession = new Map<string, Set<() => void>>();

function notifyComposerAutoSend(sessionId: string) {
  for (const listener of autoSendListenersBySession.get(sessionId) ?? []) listener();
}

export function hasPendingComposerAutoSend(sessionId: string): boolean {
  const id = sessionId.trim();
  return pendingLegacyAutoSendSessionIds.has(id) || pendingScopedAutoSends.has(id);
}

export function subscribeComposerAutoSend(sessionId: string, listener: () => void): () => void {
  const id = sessionId.trim();
  const listeners = autoSendListenersBySession.get(id) ?? new Set<() => void>();
  autoSendListenersBySession.set(id, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) autoSendListenersBySession.delete(id);
  };
}

export function markComposerAutoSend(sessionId: string, payload?: ComposerAutoSendPayload) {
  const id = sessionId.trim();
  if (!id) return;
  if (!payload) {
    pendingLegacyAutoSendSessionIds.add(id);
    notifyComposerAutoSend(id);
    return;
  }
  const scoped = pendingScopedAutoSends.get(id) ?? new Map<string, ComposerAutoSendPayload>();
  scoped.set(payload.scopeKey, {
    scopeKey: payload.scopeKey,
    composer: snapshotComposerSessionState(payload.composer),
  });
  pendingScopedAutoSends.set(id, scoped);
  notifyComposerAutoSend(id);
}

export function consumeComposerAutoSend(sessionId: string, scopeKey?: string): boolean {
  const id = sessionId.trim();
  if (scopeKey === undefined) {
    if (!pendingLegacyAutoSendSessionIds.delete(id)) return false;
  } else {
    const scoped = pendingScopedAutoSends.get(id);
    if (!scoped?.delete(scopeKey)) return false;
    if (scoped.size === 0) pendingScopedAutoSends.delete(id);
  }
  notifyComposerAutoSend(id);
  return true;
}

export function getComposerAutoSendPayload(sessionId: string, scopeKey: string): ComposerAutoSendPayload | null {
  return pendingScopedAutoSends.get(sessionId.trim())?.get(scopeKey) ?? null;
}

export function consumeComposerAutoSendPayload(sessionId: string, scopeKey: string): ComposerAutoSendPayload | null {
  const payload = getComposerAutoSendPayload(sessionId, scopeKey);
  if (!payload) return null;
  consumeComposerAutoSend(sessionId, scopeKey);
  return payload;
}

export function hasComposerAutoSend(sessionId: string, scopeKey?: string): boolean {
  const id = sessionId.trim();
  if (scopeKey === undefined) return pendingLegacyAutoSendSessionIds.has(id);
  const scoped = pendingScopedAutoSends.get(id);
  return scoped?.has(scopeKey) === true;
}
