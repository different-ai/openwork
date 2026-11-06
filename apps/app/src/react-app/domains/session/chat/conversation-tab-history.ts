/**
 * Browser-like navigation history for the workbench. Each entry records the
 * primary session plus the split-pane session (if any) so back/forward can
 * restore the exact layout the user was looking at.
 */
export type ConversationHistoryEntry = {
  workspaceId: string;
  sessionId: string;
  splitSessionId: string | null;
};

export type ConversationTabHistory = {
  workspaceId: string;
  entries: ConversationHistoryEntry[];
  index: number;
};

export type ConversationHistoryDirection = "back" | "forward";

function sameEntry(
  entry: ConversationHistoryEntry | undefined,
  workspaceId: string,
  sessionId: string,
  splitSessionId: string | null,
) {
  return entry?.workspaceId === workspaceId && entry.sessionId === sessionId && entry.splitSessionId === splitSessionId;
}

export function createConversationTabHistory(
  workspaceId: string,
  sessionId: string | null,
  splitSessionId: string | null = null,
): ConversationTabHistory {
  return {
    workspaceId,
    entries: sessionId ? [{ workspaceId, sessionId, splitSessionId }] : [],
    index: sessionId ? 0 : -1,
  };
}

export function syncConversationTabHistory(
  history: ConversationTabHistory,
  workspaceId: string,
  sessionId: string | null,
  splitSessionId: string | null = null,
): ConversationTabHistory {
  if (!sessionId) {
    if (history.entries.length === 0 && history.index === -1) return history;
    return createConversationTabHistory(workspaceId, null);
  }

  if (sameEntry(history.entries[history.index], workspaceId, sessionId, splitSessionId)) return history;

  const entriesBeforeForwardBranch = history.index >= 0
    ? history.entries.slice(0, history.index + 1)
    : [];
  const last = entriesBeforeForwardBranch[entriesBeforeForwardBranch.length - 1];
  const entries = sameEntry(last, workspaceId, sessionId, splitSessionId)
    ? entriesBeforeForwardBranch
    : [...entriesBeforeForwardBranch, { workspaceId, sessionId, splitSessionId }];

  return {
    workspaceId,
    entries,
    index: entries.length - 1,
  };
}

export function canNavigateConversationHistory(history: ConversationTabHistory, direction: ConversationHistoryDirection) {
  if (direction === "back") return history.index > 0;
  return history.index >= 0 && history.index < history.entries.length - 1;
}

export function isConversationTabHistoryCurrent(
  history: ConversationTabHistory,
  workspaceId: string,
  sessionId: string | null,
) {
  return history.workspaceId === workspaceId && history.entries[history.index]?.sessionId === sessionId;
}

export function canNavigateSelectedConversationHistory(
  history: ConversationTabHistory,
  workspaceId: string,
  sessionId: string | null,
  direction: ConversationHistoryDirection,
) {
  return isConversationTabHistoryCurrent(history, workspaceId, sessionId) && canNavigateConversationHistory(history, direction);
}

export function removeConversationHistoryEntry(
  history: ConversationTabHistory,
  workspaceId: string,
  sessionId: string,
): ConversationTabHistory {
  const removedIndex = history.entries.findIndex((entry) => entry.workspaceId === workspaceId && entry.sessionId === sessionId);
  const referencedAsSplit = history.entries.some((entry) => entry.workspaceId === workspaceId && entry.splitSessionId === sessionId);
  if (removedIndex === -1 && !referencedAsSplit) return history;

  const entries: ConversationHistoryEntry[] = [];
  let index = -1;
  for (const [oldIndex, entry] of history.entries.entries()) {
    if (entry.workspaceId === workspaceId && entry.sessionId === sessionId) continue;
    const next = entry.workspaceId === workspaceId && entry.splitSessionId === sessionId
      ? { ...entry, splitSessionId: null } : entry;
    if (!sameEntry(entries.at(-1), next.workspaceId, next.sessionId, next.splitSessionId)) entries.push(next);
    if (oldIndex <= history.index) index = entries.length - 1;
  }
  const currentIndex = Math.max(0, index);
  const current = entries[currentIndex];
  if (!current) return createConversationTabHistory(history.workspaceId, null);
  return { workspaceId: current.workspaceId, entries, index: currentIndex };
}

export function navigateConversationTabHistory(
  history: ConversationTabHistory,
  direction: ConversationHistoryDirection,
): { history: ConversationTabHistory; entry: ConversationHistoryEntry | null } {
  if (!canNavigateConversationHistory(history, direction)) {
    return { history, entry: null };
  }

  const index = direction === "back" ? history.index - 1 : history.index + 1;
  const entry = history.entries[index];
  if (!entry) return { history, entry: null };
  return {
    history: { ...history, workspaceId: entry.workspaceId, index },
    entry,
  };
}
