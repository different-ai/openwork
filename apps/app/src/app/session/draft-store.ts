import type { PromptMode } from "../types";

export type SessionDraftSnapshot = {
  text: string;
  mode: PromptMode;
};

const STORAGE_KEY = "openwork.session-drafts.v1";
const MAX_DRAFT_COUNT = 100;

let draftCache: Map<string, SessionDraftSnapshot> | null = null;

export const sessionDraftScopeKey = (
  workspaceId: string,
  sessionId: string | null | undefined,
) => {
  const workspace = workspaceId.trim();
  const session = (sessionId ?? "").trim();
  if (!workspace || !session) return "";
  return `${workspace}:${session}`;
};

const isPromptMode = (value: unknown): value is PromptMode =>
  value === "prompt" || value === "shell";

const loadDraftCache = () => {
  if (draftCache) return draftCache;
  draftCache = new Map<string, SessionDraftSnapshot>();
  if (typeof window === "undefined") return draftCache;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return draftCache;
    const parsed = JSON.parse(raw) as Record<string, { text?: unknown; mode?: unknown }>;
    if (!parsed || typeof parsed !== "object") return draftCache;
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !value || typeof value !== "object") continue;
      const text = typeof value.text === "string" ? value.text : "";
      const mode = isPromptMode(value.mode) ? value.mode : "prompt";
      if (!text && mode === "prompt") continue;
      draftCache.set(key, { text, mode });
    }
  } catch {
    // ignore malformed localStorage data
  }
  return draftCache;
};

const persistDraftCache = () => {
  if (typeof window === "undefined") return;
  const cache = loadDraftCache();
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // ignore storage write failures
  }
};

export const getSessionDraft = (
  workspaceId: string,
  sessionId: string | null | undefined,
) => {
  const key = sessionDraftScopeKey(workspaceId, sessionId);
  if (!key) return null;
  return loadDraftCache().get(key) ?? null;
};

export const saveSessionDraft = (
  workspaceId: string,
  sessionId: string | null | undefined,
  snapshot: SessionDraftSnapshot,
) => {
  const key = sessionDraftScopeKey(workspaceId, sessionId);
  if (!key) return;

  const normalized: SessionDraftSnapshot = {
    text: snapshot.text,
    mode: snapshot.mode,
  };

  if (!normalized.text && normalized.mode === "prompt") {
    clearSessionDraft(workspaceId, sessionId);
    return;
  }

  const cache = loadDraftCache();
  cache.delete(key);
  cache.set(key, normalized);
  while (cache.size > MAX_DRAFT_COUNT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  persistDraftCache();
};

export const clearSessionDraft = (
  workspaceId: string,
  sessionId: string | null | undefined,
) => {
  const key = sessionDraftScopeKey(workspaceId, sessionId);
  if (!key) return;
  const cache = loadDraftCache();
  if (!cache.delete(key)) return;
  persistDraftCache();
};
