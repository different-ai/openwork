/** A session the search dialog can match by title. */
export type SearchableSession = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  updatedAt: number;
};

export function searchableSessionKey(session: SearchableSession): string {
  return `${session.workspaceId}\u0000${session.sessionId}`;
}

export function dedupeSearchableSessions(sessions: SearchableSession[]): SearchableSession[] {
  const unique = new Map<string, SearchableSession>();
  for (const session of sessions) {
    const key = searchableSessionKey(session);
    const existing = unique.get(key);
    if (!existing || session.updatedAt > existing.updatedAt) unique.set(key, session);
  }
  return [...unique.values()];
}
