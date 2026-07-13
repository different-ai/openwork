export type ConversationTabHistory = {
  workspaceId: string;
  entries: string[];
  index: number;
};

export type ConversationHistoryDirection = "back" | "forward";

export function createConversationTabHistory(workspaceId: string, sessionId: string | null): ConversationTabHistory {
  return {
    workspaceId,
    entries: sessionId ? [sessionId] : [],
    index: sessionId ? 0 : -1,
  };
}

export function syncConversationTabHistory(
  history: ConversationTabHistory,
  workspaceId: string,
  sessionId: string | null,
): ConversationTabHistory {
  if (history.workspaceId !== workspaceId) {
    return createConversationTabHistory(workspaceId, sessionId);
  }

  if (!sessionId) {
    if (history.entries.length === 0 && history.index === -1) return history;
    return createConversationTabHistory(workspaceId, null);
  }

  if (history.entries[history.index] === sessionId) return history;

  const entriesBeforeForwardBranch = history.index >= 0
    ? history.entries.slice(0, history.index + 1)
    : [];
  const last = entriesBeforeForwardBranch[entriesBeforeForwardBranch.length - 1];
  const entries = last === sessionId
    ? entriesBeforeForwardBranch
    : [...entriesBeforeForwardBranch, sessionId];

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
  return history.workspaceId === workspaceId && history.entries[history.index] === sessionId;
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
  const removedIndex = history.entries.indexOf(sessionId);
  if (removedIndex === -1) return history;

  const entries = history.entries.filter((entry) => entry !== sessionId);
  if (entries.length === 0) return createConversationTabHistory(workspaceId, null);

  const index = removedIndex <= history.index
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
): { history: ConversationTabHistory; sessionId: string | null } {
  if (!canNavigateConversationHistory(history, direction)) {
    return { history, sessionId: null };
  }

  const index = direction === "back" ? history.index - 1 : history.index + 1;
  return {
    history: { ...history, index },
    sessionId: history.entries[index] ?? null,
  };
}
