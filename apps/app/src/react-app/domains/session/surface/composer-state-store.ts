import { create } from "zustand";

import type { ComposerAttachment, ComposerDraft } from "../../../../app/types";
import type { ComposerMentionKind } from "./composer/mention-encoding";

export type QueuedComposerItem = {
  id: string;
  draft: ComposerDraft;
};

export type ComposerPastePart = {
  id: string;
  label: string;
  text: string;
  lines: number;
};

export type ComposerSessionState = {
  draft: string;
  attachments: ComposerAttachment[];
  mentions: Record<string, ComposerMentionKind>;
  pasteParts: ComposerPastePart[];
  revertMessageId: string | null;
};

export type ComposerStateStore = {
  sessions: Record<string, ComposerSessionState>;
  queuedDrafts: Record<string, QueuedComposerItem[]>;
  /**
   * Sent-prompt history per session, oldest first. Kept outside
   * `sessions` because `clearSession` resets the composer after every
   * send and must not wipe the recall history (#2012).
   */
  history: Record<string, string[]>;
  setDraft: (sessionId: string, draft: string) => void;
  replaceDraft: (sessionId: string, draft: string, revertMessageId?: string | null) => void;
  hydrateDraft: (sessionId: string, draft: string) => void;
  clearRevertTarget: (sessionId: string) => void;
  setAttachments: (sessionId: string, attachments: ComposerAttachment[]) => void;
  setMentions: (sessionId: string, mentions: Record<string, ComposerMentionKind>) => void;
  setPasteParts: (sessionId: string, pasteParts: ComposerPastePart[]) => void;
  appendHistory: (sessionId: string, text: string) => void;
  appendQueuedDraft: (sessionId: string, draft: ComposerDraft) => void;
  removeQueuedDraft: (sessionId: string, id: string) => void;
  updateQueuedDraft: (sessionId: string, id: string, draft: ComposerDraft) => void;
  reorderQueuedDrafts: (sessionId: string, ids: string[]) => void;
  clearQueuedDrafts: (sessionId: string) => void;
  prependQueuedDrafts: (sessionId: string, items: QueuedComposerItem[]) => void;
  clearSession: (sessionId: string) => void;
};

const EMPTY_ATTACHMENTS: ComposerAttachment[] = [];
const EMPTY_MENTIONS: Record<string, ComposerMentionKind> = {};
const EMPTY_PASTE_PARTS: ComposerPastePart[] = [];
const EMPTY_HISTORY: string[] = [];
const EMPTY_QUEUED_DRAFTS: QueuedComposerItem[] = [];
const HISTORY_LIMIT = 50;
const composerSessionDraftScopes = new Map<string, string>();

export function claimComposerSessionDraftScope(sessionId: string, scopeKey: string) {
  const session = sessionId.trim();
  if (!session) return;
  composerSessionDraftScopes.set(session, scopeKey);
}

export function getComposerSessionDraftScope(sessionId: string) {
  return composerSessionDraftScopes.get(sessionId.trim()) ?? null;
}

export function persistableComposerDraftText(text: string) {
  return text.replace(/\[attachment [^\]]+\]/g, "");
}

export function composerDraftNeedsHydration(input: {
  claimedScopeKey: string | null;
  nextScopeKey: string;
  currentText: string;
  storedText: string;
}) {
  return input.claimedScopeKey !== input.nextScopeKey
    || persistableComposerDraftText(input.currentText) !== input.storedText;
}

function createEmptyComposerSession(): ComposerSessionState {
  return {
    draft: "",
    attachments: [],
    mentions: {},
    pasteParts: [],
    revertMessageId: null,
  };
}

function getWritableSession(state: ComposerStateStore, sessionId: string): ComposerSessionState {
  return state.sessions[sessionId] ?? createEmptyComposerSession();
}

function createQueuedItem(draft: ComposerDraft, id?: string): QueuedComposerItem {
  return { id: id ?? crypto.randomUUID(), draft };
}

export const useComposerStateStore = create<ComposerStateStore>((set) => ({
  sessions: {},
  queuedDrafts: {},
  history: {},
  setDraft: (sessionId, draft) => set((state) => {
    const current = getWritableSession(state, sessionId);
    const revertMessageId = draft ? current.revertMessageId : null;
    if (current.draft === draft && current.revertMessageId === revertMessageId) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, draft, revertMessageId } } };
  }),
  replaceDraft: (sessionId, draft, revertMessageId = null) => set((state) => {
    const current = getWritableSession(state, sessionId);
    const target = revertMessageId?.trim() || null;
    if (current.draft === draft && current.revertMessageId === target) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, draft, revertMessageId: target } } };
  }),
  hydrateDraft: (sessionId, draft) => set((state) => {
    const current = state.sessions[sessionId];
    if (!draft) {
      if (!current) return state;
      const sessions = { ...state.sessions };
      delete sessions[sessionId];
      return { sessions };
    }
    if (
      current?.draft === draft
      && current.attachments.length === 0
      && Object.keys(current.mentions).length === 0
      && current.pasteParts.length === 0
      && current.revertMessageId === null
    ) return state;
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: { ...createEmptyComposerSession(), draft },
      },
    };
  }),
  clearRevertTarget: (sessionId) => set((state) => {
    const current = state.sessions[sessionId];
    if (!current?.revertMessageId) return state;
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: { ...current, revertMessageId: null },
      },
    };
  }),
  setAttachments: (sessionId, attachments) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.attachments === attachments) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, attachments } } };
  }),
  setMentions: (sessionId, mentions) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.mentions === mentions) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, mentions } } };
  }),
  setPasteParts: (sessionId, pasteParts) => set((state) => {
    const current = getWritableSession(state, sessionId);
    if (current.pasteParts === pasteParts) return state;
    return { sessions: { ...state.sessions, [sessionId]: { ...current, pasteParts } } };
  }),
  appendHistory: (sessionId, text) => set((state) => {
    const trimmed = text.trim();
    if (!trimmed) return state;
    const current = state.history[sessionId] ?? EMPTY_HISTORY;
    // Skip consecutive duplicates so spamming the same prompt does not
    // fill the recall buffer.
    if (current[current.length - 1] === trimmed) return state;
    const next = [...current, trimmed].slice(-HISTORY_LIMIT);
    return { history: { ...state.history, [sessionId]: next } };
  }),
  appendQueuedDraft: (sessionId, draft) => set((state) => {
    const current = state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: [...current, createQueuedItem(draft)] } };
  }),
  removeQueuedDraft: (sessionId, id) => set((state) => {
    const current = state.queuedDrafts[sessionId];
    if (!current) return state;
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) return state;
    if (next.length > 0) return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: next } };
    const queuedDrafts = { ...state.queuedDrafts };
    delete queuedDrafts[sessionId];
    return { queuedDrafts };
  }),
  updateQueuedDraft: (sessionId, id, draft) => set((state) => {
    const current = state.queuedDrafts[sessionId];
    if (!current) return state;
    let changed = false;
    const next = current.map((item) => {
      if (item.id !== id) return item;
      changed = true;
      return { ...item, draft };
    });
    if (!changed) return state;
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: next } };
  }),
  reorderQueuedDrafts: (sessionId, ids) => set((state) => {
    const current = state.queuedDrafts[sessionId];
    if (!current || current.length === 0) return state;
    if (ids.length !== current.length) return state;
    const byId = new Map(current.map((item) => [item.id, item]));
    const next: QueuedComposerItem[] = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) return state;
      next.push(item);
    }
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: next } };
  }),
  clearQueuedDrafts: (sessionId) => set((state) => {
    if (!state.queuedDrafts[sessionId]) return state;
    const queuedDrafts = { ...state.queuedDrafts };
    delete queuedDrafts[sessionId];
    return { queuedDrafts };
  }),
  prependQueuedDrafts: (sessionId, items) => set((state) => {
    if (items.length === 0) return state;
    const current = state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
    return { queuedDrafts: { ...state.queuedDrafts, [sessionId]: [...items, ...current] } };
  }),
  clearSession: (sessionId) => set((state) => {
    if (!state.sessions[sessionId]) return state;
    const sessions = { ...state.sessions };
    delete sessions[sessionId];
    return { sessions };
  }),
}));

export function getComposerDraft(state: ComposerStateStore, sessionId: string): string {
  return state.sessions[sessionId]?.draft ?? "";
}

export function getComposerAttachments(state: ComposerStateStore, sessionId: string): ComposerAttachment[] {
  return state.sessions[sessionId]?.attachments ?? EMPTY_ATTACHMENTS;
}

export function getComposerMentions(state: ComposerStateStore, sessionId: string): Record<string, ComposerMentionKind> {
  return state.sessions[sessionId]?.mentions ?? EMPTY_MENTIONS;
}

export function getComposerPasteParts(state: ComposerStateStore, sessionId: string): ComposerPastePart[] {
  return state.sessions[sessionId]?.pasteParts ?? EMPTY_PASTE_PARTS;
}

export function getComposerHistory(state: ComposerStateStore, sessionId: string): string[] {
  return state.history[sessionId] ?? EMPTY_HISTORY;
}

export function getComposerQueuedDrafts(state: ComposerStateStore, sessionId: string): QueuedComposerItem[] {
  return state.queuedDrafts[sessionId] ?? EMPTY_QUEUED_DRAFTS;
}

export function getComposerRevertMessageId(state: ComposerStateStore, sessionId: string): string | null {
  return state.sessions[sessionId]?.revertMessageId ?? null;
}
