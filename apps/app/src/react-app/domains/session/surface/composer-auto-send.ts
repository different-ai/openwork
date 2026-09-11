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

export function markComposerAutoSend(sessionId: string, payload?: ComposerAutoSendPayload) {
  const id = sessionId.trim();
  if (!id) return;
  if (!payload) {
    pendingLegacyAutoSendSessionIds.add(id);
    return;
  }
  const scoped = pendingScopedAutoSends.get(id) ?? new Map<string, ComposerAutoSendPayload>();
  scoped.set(payload.scopeKey, {
    scopeKey: payload.scopeKey,
    composer: snapshotComposerSessionState(payload.composer),
  });
  pendingScopedAutoSends.set(id, scoped);
}

export function consumeComposerAutoSend(sessionId: string, scopeKey?: string): boolean {
  const id = sessionId.trim();
  if (scopeKey === undefined) return pendingLegacyAutoSendSessionIds.delete(id);
  const scoped = pendingScopedAutoSends.get(id);
  if (!scoped) return false;
  if (!scoped.delete(scopeKey)) return false;
  if (scoped.size === 0) pendingScopedAutoSends.delete(id);
  return true;
}

export function getComposerAutoSendPayload(sessionId: string, scopeKey: string): ComposerAutoSendPayload | null {
  return pendingScopedAutoSends.get(sessionId.trim())?.get(scopeKey) ?? null;
}

export function consumeComposerAutoSendPayload(sessionId: string, scopeKey: string): ComposerAutoSendPayload | null {
  const payload = getComposerAutoSendPayload(sessionId, scopeKey);
  if (!payload) return null;
  const id = sessionId.trim();
  const scoped = pendingScopedAutoSends.get(id);
  scoped?.delete(scopeKey);
  if (scoped?.size === 0) pendingScopedAutoSends.delete(id);
  return payload;
}

export function hasComposerAutoSend(sessionId: string, scopeKey?: string): boolean {
  const id = sessionId.trim();
  if (scopeKey === undefined) return pendingLegacyAutoSendSessionIds.has(id);
  const scoped = pendingScopedAutoSends.get(id);
  return scoped?.has(scopeKey) === true;
}
