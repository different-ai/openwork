import { create } from "zustand";

import { setBackgroundShellTasksFlag, type EngineShell } from "../../../../app/lib/background-shell-tasks";

/** A command the agent left running in the background for one conversation. */
export type BackgroundShell = {
  id: string;
  sessionId: string;
  command: string;
  startedAt: number;
  /** When this app learned of it. A resync whose read started earlier cannot drop it. */
  observedAt: number;
  /** Last successful running-command listing (or the start event). */
  checkedAt?: number;
  /** Latest applied listing attempt; a slower older read cannot undo its result. */
  checkStartedAt?: number;
  /** A listing failed: the command is last known running, not verified running. */
  stale?: boolean;
};

/** Background commands for one workspace. */
export type BackgroundShellBook = {
  running: Readonly<Record<string, BackgroundShell>>;
  /** Commands known to have ended. A late or replayed start must not bring one back. */
  settled: readonly string[];
};

export const emptyBackgroundShellBook: BackgroundShellBook = { running: {}, settled: [] };

const SETTLED_LIMIT = 500;

export function addBackgroundShell(book: BackgroundShellBook, shell: BackgroundShell): BackgroundShellBook {
  if (book.settled.includes(shell.id)) return book;
  const existing = book.running[shell.id];
  const next: BackgroundShell = existing ? {
    ...existing,
    command: existing.command || shell.command,
    startedAt: Math.min(existing.startedAt || shell.startedAt, shell.startedAt || existing.startedAt),
  } : shell;
  if (existing && existing.command === next.command && existing.startedAt === next.startedAt) return book;
  return { ...book, running: { ...book.running, [shell.id]: next } };
}

export function settleBackgroundShell(book: BackgroundShellBook, shellId: string): BackgroundShellBook {
  const known = book.settled.includes(shellId);
  const wasRunning = shellId in book.running;
  if (known && !wasRunning) return book;
  // Keep the running record's identity when nothing in it changed, so the
  // chat does not re-render for every foreground command's exit.
  let running = book.running;
  if (wasRunning) {
    const copy = { ...book.running };
    delete copy[shellId];
    running = copy;
  }
  return { running, settled: known ? book.settled : [...book.settled, shellId].slice(-SETTLED_LIMIT) };
}

export type BackgroundShellResync = {
  /** Commands the engine listed as running. */
  listed: readonly EngineShell[];
  /** When that read started. Commands learned after it are kept. */
  startedAt: number;
  /** Only these conversations are resynced; the others are left as they are. */
  sessionIds: ReadonlySet<string> | "all";
  /**
   * Whether a listed command this app did not know about is a background
   * one. The listing also includes a foreground command while it runs, so it
   * only counts when its conversation is idle (a foreground command keeps its
   * conversation running) or the conversation's tool call says background.
   */
  admit: (shell: EngineShell & { sessionID: string }) => boolean;
};

/**
 * Converge on the engine's list of running commands: drop what it no longer
 * runs (an exit the volatile event stream may have lost), keep what it still
 * runs, and add background commands this app missed while disconnected.
 */
export function resyncBackgroundShells(book: BackgroundShellBook, input: BackgroundShellResync): BackgroundShellBook {
  const inScope = (sessionId: string) => input.sessionIds === "all" || input.sessionIds.has(sessionId);
  const listed = new Map<string, EngineShell & { sessionID: string }>();
  for (const shell of input.listed) {
    if (shell.status !== "running" || !shell.sessionID || !inScope(shell.sessionID)) continue;
    listed.set(shell.id, { ...shell, sessionID: shell.sessionID });
  }
  let next = book;
  for (const shell of Object.values(book.running)) {
    if (!inScope(shell.sessionId) || listed.has(shell.id) || Math.max(shell.observedAt, shell.checkStartedAt ?? 0) >= input.startedAt) continue;
    next = settleBackgroundShell(next, shell.id);
  }
  for (const shell of listed.values()) {
    if (next.running[shell.id] || next.settled.includes(shell.id) || !input.admit(shell)) continue;
    next = addBackgroundShell(next, {
      id: shell.id,
      sessionId: shell.sessionID,
      command: shell.command,
      startedAt: shell.startedAt,
      observedAt: input.startedAt,
    });
  }
  return markBackgroundShellFreshness(next, input.sessionIds, input.startedAt);
}

/** Failed reads preserve both the count and when it was last confirmed. */
export function markBackgroundShellFreshness(book: BackgroundShellBook, sessionIds: ReadonlySet<string> | "all", checkedAt?: number, failedBefore = Date.now()): BackgroundShellBook {
  const running = { ...book.running };
  let changed = false;
  for (const shell of Object.values(book.running)) {
    if (sessionIds !== "all" && !sessionIds.has(shell.sessionId)) continue;
    // Older completions cannot undo a later check, including a later failure.
    const attemptAt = checkedAt ?? failedBefore;
    if (Math.max(shell.observedAt, shell.checkStartedAt ?? 0) > attemptAt) continue;
    running[shell.id] = { ...shell, stale: checkedAt === undefined, checkStartedAt: attemptAt, checkedAt: checkedAt === undefined ? shell.checkedAt ?? shell.observedAt : Math.max(checkedAt, shell.checkedAt ?? 0, shell.observedAt) };
    changed = true;
  }
  return changed ? { ...book, running } : book;
}

/** Settle every command of a conversation that no longer exists. */
export function clearBackgroundShellSession(book: BackgroundShellBook, sessionId: string): BackgroundShellBook {
  let next = book;
  for (const shell of Object.values(book.running)) {
    if (shell.sessionId === sessionId) next = settleBackgroundShell(next, shell.id);
  }
  return next;
}

/** One conversation's running background commands, oldest first. */
export function sessionBackgroundShells(
  running: Readonly<Record<string, BackgroundShell>> | undefined,
  sessionId: string,
): BackgroundShell[] {
  if (!running) return [];
  return Object.values(running)
    .filter((shell) => shell.sessionId === sessionId)
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
}

type BackgroundShellStore = {
  /** Mirrors the `backgroundShellTasks` feature. Off keeps the old chat and records nothing. */
  enabled: boolean;
  booksByWorkspaceId: Record<string, BackgroundShellBook>;
  setEnabled: (enabled: boolean) => void;
  update: (workspaceId: string, change: (book: BackgroundShellBook) => BackgroundShellBook) => void;
};

export const useBackgroundShellStore = create<BackgroundShellStore>((set) => ({
  enabled: false,
  booksByWorkspaceId: {},
  setEnabled: (enabled) => {
    setBackgroundShellTasksFlag(enabled);
    // Turning the feature off forgets everything, so turning it back on
    // starts from the engine's own list instead of stale counts.
    set((state) => state.enabled === enabled ? state : { enabled, booksByWorkspaceId: enabled ? state.booksByWorkspaceId : {} });
  },
  update: (workspaceId, change) => set((state) => {
    if (!state.enabled) return state;
    const current = state.booksByWorkspaceId[workspaceId] ?? emptyBackgroundShellBook;
    const next = change(current);
    return next === current ? state : { booksByWorkspaceId: { ...state.booksByWorkspaceId, [workspaceId]: next } };
  }),
}));
