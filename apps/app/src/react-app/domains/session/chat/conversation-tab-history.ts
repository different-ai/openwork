/**
 * Browser-like navigation history for the workbench. Each entry records the
 * primary session plus the split-pane session (if any) so back/forward can
 * restore the exact layout the user was looking at.
 */
export type ConversationHistoryEntry = {
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
  sessionId: string,
  splitSessionId: string | null,
) {
  return entry?.sessionId === sessionId && (entry.splitSessionId ?? null) === splitSessionId;
}

export function createConversationTabHistory(
  workspaceId: string,
  sessionId: string | null,
  splitSessionId: string | null = null,
): ConversationTabHistory {
  return {
    workspaceId,
    entries: sessionId ? [{ sessionId, splitSessionId }] : [],
    index: sessionId ? 0 : -1,
  };
}

export function syncConversationTabHistory(
  history: ConversationTabHistory,
  workspaceId: string,
  sessionId: string | null,
  splitSessionId: string | null = null,
): ConversationTabHistory {
  if (history.workspaceId !== workspaceId) {
    return createConversationTabHistory(workspaceId, sessionId, splitSessionId);
  }

  if (!sessionId) {
    if (history.entries.length === 0 && history.index === -1) return history;
    return createConversationTabHistory(workspaceId, null);
  }

  if (sameEntry(history.entries[history.index], sessionId, splitSessionId)) return history;

  const entriesBeforeForwardBranch = history.index >= 0
    ? history.entries.slice(0, history.index + 1)
    : [];
  const last = entriesBeforeForwardBranch[entriesBeforeForwardBranch.length - 1];
  const entries = sameEntry(last, sessionId, splitSessionId)
    ? entriesBeforeForwardBranch
    : [...entriesBeforeForwardBranch, { sessionId, splitSessionId }];

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
  if (history.workspaceId !== workspaceId) return history;
  const removedIndex = history.entries.findIndex((entry) => entry.sessionId === sessionId);
  const referencedAsSplit = history.entries.some((entry) => entry.splitSessionId === sessionId);
  if (removedIndex === -1 && !referencedAsSplit) return history;

  const kept = history.entries
    .filter((entry) => entry.sessionId !== sessionId)
    .map((entry) => entry.splitSessionId === sessionId ? { ...entry, splitSessionId: null } : entry);
  const entries: ConversationHistoryEntry[] = [];
  for (const entry of kept) {
    const last = entries[entries.length - 1];
    if (last && sameEntry(last, entry.sessionId, entry.splitSessionId)) continue;
    entries.push(entry);
  }
  if (entries.length === 0) return createConversationTabHistory(workspaceId, null);

  const index = removedIndex !== -1 && removedIndex <= history.index
    ? Math.max(0, history.index - 1)
    : history.index;

  return {
    workspaceId,
    entries,
    index: Math.min(index, entries.length - 1),
  };
}

export function navigateConversationTabHistory(
  history: ConversationTabHistory,
  direction: ConversationHistoryDirection,
): { history: ConversationTabHistory; entry: ConversationHistoryEntry | null } {
  if (!canNavigateConversationHistory(history, direction)) {
    return { history, entry: null };
  }

  const index = direction === "back" ? history.index - 1 : history.index + 1;
  return {
    history: { ...history, index },
    entry: history.entries[index] ?? null,
  };
}
