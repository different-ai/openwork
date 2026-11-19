import fuzzysort from "fuzzysort";

/** A session the search dialog can match by title. */
export type SearchableSession = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  /** Last activity (in practice, the newest message) in milliseconds. */
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

const newestFirst = (a: SearchableSession, b: SearchableSession) => b.updatedAt - a.updatedAt;

/**
 * Sessions to show for a query, newest message first. Sessions whose title or
 * workspace contains every typed word come first; looser fuzzy matches follow
 * by match quality so a typo still finds something without outranking them.
 */
export function rankSearchableSessions(
  sessions: SearchableSession[],
  query: string,
  limit: number,
): SearchableSession[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...sessions].sort(newestFirst).slice(0, limit);

  const contains = sessions.filter((session) => {
    const text = `${session.title} ${session.workspaceTitle}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  contains.sort(newestFirst);
  if (contains.length >= limit) return contains.slice(0, limit);

  const included = new Set(contains);
  const fuzzy = fuzzysort
    .go(query.trim(), sessions, { keys: ["title", "workspaceTitle"] })
    .map((hit) => hit.obj)
    .filter((session) => !included.has(session));
  return [...contains, ...fuzzy].slice(0, limit);
}
