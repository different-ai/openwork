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
