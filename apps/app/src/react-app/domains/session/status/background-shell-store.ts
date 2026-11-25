import { create } from "zustand";

import type { EngineShell } from "../../../../app/lib/background-shell-tasks";

export type BackgroundShell = {
  id: string;
  sessionId: string;
  command: string;
  startedAt: number;
  observedAt: number;
};

export type BackgroundShellBook = {
  running: Readonly<Record<string, BackgroundShell>>;
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
  let running = book.running;
  if (wasRunning) {
    const copy = { ...book.running };
    delete copy[shellId];
    running = copy;
  }
  return { running, settled: known ? book.settled : [...book.settled, shellId].slice(-SETTLED_LIMIT) };
}

export type BackgroundShellResync = {
  listed: readonly EngineShell[];
  startedAt: number;
  sessionIds: ReadonlySet<string> | "all";
  admit: (shell: EngineShell & { sessionID: string }) => boolean;
};

export function resyncBackgroundShells(book: BackgroundShellBook, input: BackgroundShellResync): BackgroundShellBook {
  const inScope = (sessionId: string) => input.sessionIds === "all" || input.sessionIds.has(sessionId);
  const listed = new Map<string, EngineShell & { sessionID: string }>();
  for (const shell of input.listed) {
    if (shell.status !== "running" || !shell.sessionID || !inScope(shell.sessionID)) continue;
    listed.set(shell.id, { ...shell, sessionID: shell.sessionID });
  }
  let next = book;
  for (const shell of Object.values(book.running)) {
    if (!inScope(shell.sessionId) || listed.has(shell.id) || shell.observedAt >= input.startedAt) continue;
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
  return next;
}

export function clearBackgroundShellSession(book: BackgroundShellBook, sessionId: string): BackgroundShellBook {
  let next = book;
  for (const shell of Object.values(book.running)) {
    if (shell.sessionId === sessionId) next = settleBackgroundShell(next, shell.id);
  }
  return next;
}

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
  booksByWorkspaceId: Record<string, BackgroundShellBook>;
  update: (workspaceId: string, change: (book: BackgroundShellBook) => BackgroundShellBook) => void;
};

export const useBackgroundShellStore = create<BackgroundShellStore>((set) => ({
  booksByWorkspaceId: {},
  update: (workspaceId, change) => set((state) => {
    const current = state.booksByWorkspaceId[workspaceId] ?? emptyBackgroundShellBook;
    const next = change(current);
    return next === current ? state : { booksByWorkspaceId: { ...state.booksByWorkspaceId, [workspaceId]: next } };
  }),
}));
