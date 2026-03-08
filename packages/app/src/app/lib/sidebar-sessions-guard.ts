/**
 * Determines whether the sidebar sessions should be updated based on the current
 * and new session lists.
 *
 * This guard prevents the sidebar from being cleared when the server temporarily
 * returns an empty list (e.g., during worker restart/reconnect before the session
 * database is fully loaded).
 *
 * @param currentSessions - The sessions currently displayed in the sidebar
 * @param newSessions - The new sessions from the server
 * @returns true if the sidebar should be updated, false to preserve existing sessions
 */
export function shouldUpdateSidebarSessions(
  currentSessions: Array<{ id: string }>,
  newSessions: Array<{ id: string }>,
): boolean {
  // Don't clear existing sidebar sessions if the session store is empty.
  // This can happen during worker restart/reconnect when the server hasn't fully loaded
  // its session database yet. Preserving existing sessions prevents the sidebar from
  // flickering empty during the reconnection window.
  if (currentSessions.length > 0 && newSessions.length === 0) {
    return false;
  }

  return true;
}

/**
 * Filters sessions to only those belonging to a specific workspace root directory.
 *
 * @param sessions - All sessions
 * @param workspaceRoot - The normalized workspace root directory
 * @param normalizeDir - Function to normalize directory paths for comparison
 * @returns Sessions scoped to the workspace
 */
export function scopeSessionsToWorkspace<T extends { directory: string }>(
  sessions: T[],
  workspaceRoot: string | null,
  normalizeDir: (dir: string) => string,
): T[] {
  if (!workspaceRoot) {
    return sessions;
  }
  return sessions.filter(
    (session) => normalizeDir(session.directory) === workspaceRoot,
  );
}
