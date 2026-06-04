import { create } from "zustand";

const SESSION_SCROLL_STORAGE_KEY = "openwork:session-scroll:v1";

type StickyBottomSessionScrollState = {
  mode: "stickyBottom";
  topClippedMessageId: string | null;
};

type ManualSessionScrollState = {
  mode: "manual";
  scrollTop: number;
  topClippedMessageId: string | null;
};

export type SessionScrollState = StickyBottomSessionScrollState | ManualSessionScrollState;

type SessionScrollStateById = Record<string, SessionScrollState>;

const INITIAL_SESSION_SCROLL_STATE: StickyBottomSessionScrollState = {
  mode: "stickyBottom",
  topClippedMessageId: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTopClippedMessageId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeSessionScrollState(value: unknown): SessionScrollState | null {
  if (!isRecord(value)) return null;

  const topClippedMessageId = normalizeTopClippedMessageId(value.topClippedMessageId);
  if (value.mode === "stickyBottom") {
    return { mode: "stickyBottom", topClippedMessageId };
  }

  if (value.mode !== "manual" || typeof value.scrollTop !== "number" || !Number.isFinite(value.scrollTop)) {
    return null;
  }

  return {
    mode: "manual",
    scrollTop: Math.max(0, Math.round(value.scrollTop)),
    topClippedMessageId,
  };
}

function readPersistedSessionScrollState(): SessionScrollStateById {
  if (globalThis.window === undefined) return {};

  try {
    const raw = window.localStorage.getItem(SESSION_SCROLL_STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};

    const sessions: SessionScrollStateById = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      const state = normalizeSessionScrollState(value);
      if (state) sessions[sessionId] = state;
    }
    return sessions;
  } catch {
    return {};
  }
}

function persistSessionScrollState(sessions: SessionScrollStateById): void {
  if (globalThis.window === undefined) return;

  try {
    window.localStorage.setItem(SESSION_SCROLL_STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    return;
  }
}

export function getSessionScrollState(
  sessions: SessionScrollStateById,
  sessionId: string | null | undefined,
): SessionScrollState {
  if (!sessionId) return INITIAL_SESSION_SCROLL_STATE;
  return sessions[sessionId] ?? INITIAL_SESSION_SCROLL_STATE;
}

export function selectSessionIsStickyBottom(
  sessions: SessionScrollStateById,
  sessionId: string | null | undefined,
): boolean {
  return getSessionScrollState(sessions, sessionId).mode === "stickyBottom";
}

export function selectSessionTopClippedMessageId(
  sessions: SessionScrollStateById,
  sessionId: string | null | undefined,
): string | null {
  return getSessionScrollState(sessions, sessionId).topClippedMessageId;
}

function setSessionStickyBottom(
  sessions: SessionScrollStateById,
  sessionId: string | null | undefined,
  topClippedMessageId: string | null,
): SessionScrollStateById {
  if (!sessionId) return sessions;

  const current = getSessionScrollState(sessions, sessionId);
  if (current.mode === "stickyBottom" && current.topClippedMessageId === topClippedMessageId) {
    return sessions;
  }

  return {
    ...sessions,
    [sessionId]: { mode: "stickyBottom", topClippedMessageId },
  };
}

function setSessionManualScroll(
  sessions: SessionScrollStateById,
  sessionId: string | null | undefined,
  scrollTop: number,
  topClippedMessageId: string | null,
): SessionScrollStateById {
  if (!sessionId) return sessions;

  const nextScrollTop = Math.max(0, Math.round(scrollTop));
  const current = getSessionScrollState(sessions, sessionId);
  if (
    current.mode === "manual" &&
    current.scrollTop === nextScrollTop &&
    current.topClippedMessageId === topClippedMessageId
  ) {
    return sessions;
  }

  return {
    ...sessions,
    [sessionId]: { mode: "manual", scrollTop: nextScrollTop, topClippedMessageId },
  };
}

function setSessionTopClippedMessageId(
  sessions: SessionScrollStateById,
  sessionId: string | null | undefined,
  topClippedMessageId: string | null,
): SessionScrollStateById {
  if (!sessionId) return sessions;

  const current = getSessionScrollState(sessions, sessionId);
  if (current.topClippedMessageId === topClippedMessageId) return sessions;

  return {
    ...sessions,
    [sessionId]: { ...current, topClippedMessageId },
  };
}

type SessionScrollStore = {
  sessions: SessionScrollStateById;
  setStickyBottom: (sessionId: string | null | undefined, topClippedMessageId: string | null) => void;
  setManualScroll: (sessionId: string | null | undefined, scrollTop: number, topClippedMessageId: string | null) => void;
  setTopClippedMessageId: (sessionId: string | null | undefined, topClippedMessageId: string | null) => void;
};

export const useSessionScrollStore = create<SessionScrollStore>((set) => ({
  sessions: readPersistedSessionScrollState(),
  setStickyBottom: (sessionId, topClippedMessageId) => set((state) => {
    const sessions = setSessionStickyBottom(state.sessions, sessionId, topClippedMessageId);
    return sessions === state.sessions ? state : { sessions };
  }),
  setManualScroll: (sessionId, scrollTop, topClippedMessageId) => set((state) => {
    const sessions = setSessionManualScroll(state.sessions, sessionId, scrollTop, topClippedMessageId);
    return sessions === state.sessions ? state : { sessions };
  }),
  setTopClippedMessageId: (sessionId, topClippedMessageId) => set((state) => {
    const sessions = setSessionTopClippedMessageId(state.sessions, sessionId, topClippedMessageId);
    return sessions === state.sessions ? state : { sessions };
  }),
}));

useSessionScrollStore.subscribe((state) => persistSessionScrollState(state.sessions));
