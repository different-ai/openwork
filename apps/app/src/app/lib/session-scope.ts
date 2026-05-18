import { normalizeDirectoryPath } from "../utils";
import { normalizeDirectoryQueryPath } from "../utils";

/**
 * Branded string for directory values sent over the wire to the OpenCode server.
 *
 * The server compares `session.directory === query.directory` with strict
 * equality, so every call site that creates, lists, or deletes sessions must
 * use the same canonical format.  The brand makes it a *compile error* to pass
 * a raw `string` where a `TransportDirectory` is expected — you must go
 * through {@link toSessionTransportDirectory} first.
 *
 * On Windows this preserves native backslashes (`C:\Users\…`); on Unix it
 * normalises to forward-slashed paths without a trailing separator.
 */
export type TransportDirectory = string & {
  readonly __transportDirectory: unique symbol;
};

type WorkspaceType = "local" | "remote";

export function resolveScopedClientDirectory(input: {
  directory?: string | null;
  targetRoot?: string | null;
  workspaceType?: WorkspaceType | null;
}): TransportDirectory {
  const directory = toSessionTransportDirectory(input.directory);
  if (directory) return directory;

  if (input.workspaceType === "remote") return "" as TransportDirectory;

  return toSessionTransportDirectory(input.targetRoot);
}

/**
 * Canonical formatter for directory values sent to the OpenCode server.
 *
 * Returns a {@link TransportDirectory} — the only format the server accepts for
 * exact directory matching.  All session create / list / delete calls must use
 * this (or {@link resolveScopedClientDirectory}) instead of the local-only
 * {@link normalizeDirectoryQueryPath}.
 */
export function toSessionTransportDirectory(input?: string | null): TransportDirectory {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "" as TransportDirectory;

  if (/^\\\\\?\\UNC\\/i.test(trimmed)) {
    return `\\${trimmed.slice(7)}` as TransportDirectory;
  }

  if (/^\\\\\?\\[a-zA-Z]:[\\/]/.test(trimmed)) {
    return trimmed.slice(4) as TransportDirectory;
  }

  if (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(trimmed)) {
    return trimmed as TransportDirectory;
  }

  return normalizeDirectoryQueryPath(trimmed) as TransportDirectory;
}

export function describeDirectoryScope(input?: string | null) {
  const raw = input ?? "";
  const trimmed = raw.trim();
  const transport = toSessionTransportDirectory(trimmed);
  const normalized = normalizeDirectoryPath(trimmed);
  return {
    raw: trimmed || null,
    transport: (transport || null) as TransportDirectory | null,
    normalized: normalized || null,
  };
}

export function scopedRootsMatch(a?: string | null, b?: string | null) {
  const left = normalizeDirectoryPath(a ?? "");
  const right = normalizeDirectoryPath(b ?? "");
  if (!left || !right) return false;
  return left === right;
}

export function shouldApplyScopedSessionLoad(input: {
  loadedScopeRoot?: string | null;
  workspaceRoot?: string | null;
}) {
  const workspaceRoot = normalizeDirectoryPath(input.workspaceRoot ?? "");
  if (!workspaceRoot) return true;
  return scopedRootsMatch(input.loadedScopeRoot, workspaceRoot);
}

export function shouldRedirectMissingSessionAfterScopedLoad(input: {
  loadedScopeRoot?: string | null;
  workspaceRoot?: string | null;
  hasMatchingSession: boolean;
}) {
  if (input.hasMatchingSession) return false;

  const workspaceRoot = normalizeDirectoryPath(input.workspaceRoot ?? "");
  if (!workspaceRoot) return false;

  return scopedRootsMatch(input.loadedScopeRoot, workspaceRoot);
}

export type SessionLike = { directory?: string | null };

export type SessionScopeFilterMismatch = {
  workspaceRoot: string;
  sampleSessionDirectory: string;
  totalServerSessions: number;
};

/**
 * Filter a server-returned session list down to those whose `directory` matches
 * the active workspace root.
 *
 * **Fails open.** If the strict path comparison would drop every session even
 * though the server returned a non-empty list, the unfiltered list is returned
 * and `onMismatch` is invoked. The openwork server already routes the request
 * to the workspace's own OpenCode instance, so an empty filtered result almost
 * always means the two paths differ in form (resolved vs unresolved symlinks,
 * NFC vs NFD unicode, case, trailing separators) rather than the sessions
 * legitimately belonging to a different workspace. Hiding the user's sessions
 * in that situation is worse than rendering them.
 *
 * See: GitHub issue #1140.
 */
export function filterSessionsToWorkspace<S extends SessionLike>(
  sessions: ReadonlyArray<S>,
  workspaceRoot: string | null | undefined,
  options?: { onMismatch?: (info: SessionScopeFilterMismatch) => void },
): S[] {
  const root = normalizeDirectoryPath(workspaceRoot ?? "");
  if (!root) return sessions.slice();

  const filtered = sessions.filter(
    (session) => normalizeDirectoryPath(session?.directory ?? "") === root,
  );

  if (filtered.length === 0 && sessions.length > 0) {
    options?.onMismatch?.({
      workspaceRoot: root,
      sampleSessionDirectory: normalizeDirectoryPath(sessions[0]?.directory ?? ""),
      totalServerSessions: sessions.length,
    });
    return sessions.slice();
  }

  return filtered;
}
