import { create } from "zustand";

const SESSION_SCROLL_STORAGE_KEY = "openwork:session-scroll:v1";
const PERSIST_DELAY_MS = 250;

export type SessionScrollAnchor = { messageId: string; offset: number };

// Geometry and nearby IDs only: never persist transcript text or tool results.
export type SessionScrollGeometry = {
  owner: string;
  scrollHeight: number;
  viewportWidth: number;
  before: number;
  after: number;
  messageIds: string[];
};

type StickyBottomSessionScrollState = {
  mode: "stickyBottom";
  topClippedMessageId: string | null;
  geometry?: SessionScrollGeometry;
};

type ManualSessionScrollState = {
  mode: "manual";
  scrollTop: number;
  anchor?: SessionScrollAnchor;
  topClippedMessageId: string | null;
  geometry?: SessionScrollGeometry;
};

export type SessionScrollState = (StickyBottomSessionScrollState | ManualSessionScrollState) & {
  // Also retain ownership on legacy entries until claimed, even if their
  // optional geometry is evicted before the conversation is reopened.
  owner?: string;
};

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
  const geometry = normalizeGeometry(value.geometry);
  const owner = typeof value.owner === "string" && value.owner.length > 0 && value.owner.length <= 1024
    ? value.owner : geometry?.owner;
  const metadata = { ...(owner ? { owner } : {}), ...(geometry && geometry.owner === owner ? { geometry } : {}) };
  if (value.mode === "stickyBottom") {
    return { mode: "stickyBottom", topClippedMessageId, ...metadata };
  }

  if (value.mode !== "manual" || typeof value.scrollTop !== "number" || !Number.isFinite(value.scrollTop)) {
    return null;
  }

  return {
    mode: "manual",
    scrollTop: Math.max(0, Math.round(value.scrollTop)),
    ...(isRecord(value.anchor) && typeof value.anchor.messageId === "string" && value.anchor.messageId.trim()
      && typeof value.anchor.offset === "number" && Number.isFinite(value.anchor.offset)
      ? { anchor: { messageId: value.anchor.messageId, offset: value.anchor.offset } }
      : {}),
    topClippedMessageId,
    ...metadata,
  };
}

function normalizeGeometry(value: unknown): SessionScrollGeometry | undefined {
  if (!isRecord(value) || typeof value.owner !== "string" || !value.owner || value.owner.length > 1024) return;
  const { scrollHeight, viewportWidth, before, after, messageIds } = value;
  if (typeof scrollHeight !== "number" || !Number.isFinite(scrollHeight) || scrollHeight <= 0 || scrollHeight > 30_000_000
    || typeof viewportWidth !== "number" || !Number.isFinite(viewportWidth) || viewportWidth <= 0 || viewportWidth > 30_000
    || typeof before !== "number" || !Number.isFinite(before) || before < 0 || before > scrollHeight
    || typeof after !== "number" || !Number.isFinite(after) || after < 0 || after > scrollHeight
    || !Array.isArray(messageIds)) return;
  const ids = messageIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 256).slice(0, 24);
  return { owner: value.owner, scrollHeight, viewportWidth, before, after, messageIds: [...new Set(ids)] };
}

export function readPersistedSessionScrollState(): SessionScrollStateById {
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
    // Clipped-message controls are presentation state, not a reading position.
    const positions = Object.fromEntries(Object.entries(sessions).map(([id, state]) => [id,
      state.mode === "manual"
        ? { mode: state.mode, scrollTop: state.scrollTop, anchor: state.anchor, owner: state.owner, geometry: state.geometry }
        : { mode: state.mode, owner: state.owner, geometry: state.geometry },
    ]));
    window.localStorage.setItem(SESSION_SCROLL_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    return;
  }
}

export function getSessionScrollState(
  sessions: SessionScrollStateById,
  sessionId: string | null | undefined,
  owner?: string,
): SessionScrollState {
  if (!sessionId) return INITIAL_SESSION_SCROLL_STATE;
  if (owner) {
    const owned = sessions[sessionScrollKey(sessionId, owner)];
    if (owned) return owned;
    const legacy = sessions[sessionId];
    const legacyOwner = legacy?.owner ?? legacy?.geometry?.owner;
    return legacy && (!legacyOwner || legacyOwner === owner) ? legacy : INITIAL_SESSION_SCROLL_STATE;
  }
  return sessions[sessionId] ?? INITIAL_SESSION_SCROLL_STATE;
}

export function sessionScrollKey(sessionId: string, owner?: string): string {
  return owner ? JSON.stringify(["session-scroll", owner, sessionId]) : sessionId;
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
    [sessionId]: { mode: "stickyBottom", topClippedMessageId, owner: current.owner, ...(current.geometry ? { geometry: current.geometry } : {}) },
  };
}

function setSessionManualScroll(
  sessions: SessionScrollStateById,
  sessionId: string | null | undefined,
  scrollTop: number,
  topClippedMessageId: string | null,
  anchor?: SessionScrollAnchor,
): SessionScrollStateById {
  if (!sessionId) return sessions;

  const nextScrollTop = Math.max(0, Math.round(scrollTop));
  const current = getSessionScrollState(sessions, sessionId);
  if (
    current.mode === "manual" &&
    current.scrollTop === nextScrollTop &&
    current.anchor?.messageId === anchor?.messageId &&
    current.anchor?.offset === anchor?.offset &&
    current.topClippedMessageId === topClippedMessageId
  ) {
    return sessions;
  }

  return {
    ...sessions,
    [sessionId]: { mode: "manual", scrollTop: nextScrollTop, topClippedMessageId, anchor, owner: current.owner, ...(current.geometry ? { geometry: current.geometry } : {}) },
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
  claimOwner: (sessionId: string, owner: string) => void;
  setStickyBottom: (sessionId: string | null | undefined, topClippedMessageId: string | null) => void;
  setManualScroll: (sessionId: string | null | undefined, scrollTop: number, topClippedMessageId: string | null, anchor?: SessionScrollAnchor) => void;
  setTopClippedMessageId: (sessionId: string | null | undefined, topClippedMessageId: string | null) => void;
  setGeometry: (sessionId: string, geometry: SessionScrollGeometry) => void;
};

export const useSessionScrollStore = create<SessionScrollStore>((set) => ({
  sessions: readPersistedSessionScrollState(),
  claimOwner: (sessionId, owner) => set((state) => {
    const legacy = state.sessions[sessionId];
    const legacyOwner = legacy?.owner ?? legacy?.geometry?.owner;
    if (!legacy || (legacyOwner && legacyOwner !== owner)) return state;
    const key = sessionScrollKey(sessionId, owner);
    const sessions = { ...state.sessions };
    // Geometry-free v1 positions have no recoverable owner. Claim them once,
    // never copy them into every workspace exposing the same session ID.
    sessions[key] ??= { ...legacy, owner };
    delete sessions[sessionId];
    schedulePersistence(legacy, sessions[key], true);
    return { sessions };
  }),
  setGeometry: (sessionId, geometry) => set((state) => {
    const next = normalizeGeometry(geometry);
    const current = getSessionScrollState(state.sessions, sessionId);
    if (!next || (current.owner && current.owner !== next.owner) || JSON.stringify(current.geometry) === JSON.stringify(next)) return state;
    const updated = { ...current, owner: next.owner, geometry: next };
    schedulePersistence(current, updated);
    const sessions = { ...state.sessions, [sessionId]: updated };
    // Keep positions indefinitely, but bound the heavier geometry hints.
    const older = Object.keys(sessions).filter((id) => id !== sessionId && sessions[id].geometry);
    for (const id of older.slice(0, Math.max(0, older.length - 63))) {
      const { geometry: _geometry, ...position } = sessions[id];
      sessions[id] = position;
    }
    return { sessions };
  }),
  setStickyBottom: (sessionId, topClippedMessageId) => set((state) => {
    const sessions = setSessionStickyBottom(state.sessions, sessionId, topClippedMessageId);
    schedulePersistence(getSessionScrollState(state.sessions, sessionId), getSessionScrollState(sessions, sessionId));
    return sessions === state.sessions ? state : { sessions };
  }),
  setManualScroll: (sessionId, scrollTop, topClippedMessageId, anchor) => set((state) => {
    const sessions = setSessionManualScroll(state.sessions, sessionId, scrollTop, topClippedMessageId, anchor);
    schedulePersistence(getSessionScrollState(state.sessions, sessionId), getSessionScrollState(sessions, sessionId));
    return sessions === state.sessions ? state : { sessions };
  }),
  setTopClippedMessageId: (sessionId, topClippedMessageId) => set((state) => {
    const sessions = setSessionTopClippedMessageId(state.sessions, sessionId, topClippedMessageId);
    return sessions === state.sessions ? state : { sessions };
  }),
}));

let persistTimer: ReturnType<typeof setTimeout> | undefined;

export function flushSessionScrollState() {
  if (persistTimer === undefined) return;
  clearTimeout(persistTimer);
  persistTimer = undefined;
  persistSessionScrollState(useSessionScrollStore.getState().sessions);
}

function schedulePersistence(before: SessionScrollState, next: SessionScrollState, force = false) {
  const changed = before.geometry !== next.geometry || before.mode !== next.mode || (next.mode === "manual" && before.mode === "manual" && (
    next.scrollTop !== before.scrollTop || next.anchor?.messageId !== before.anchor?.messageId
    || next.anchor?.offset !== before.anchor?.offset
  ));
  if (!changed && !force) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flushSessionScrollState, PERSIST_DELAY_MS);
}
