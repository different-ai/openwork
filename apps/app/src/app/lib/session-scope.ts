import { normalizeDirectoryPath } from "../utils";
import { normalizeDirectoryQueryPath } from "../utils";

export type TransportDirectory = string & {
  readonly __transportDirectory: unique symbol;
};

export function resolveScopedClientDirectory(input: {
  directory?: string | null;
  targetRoot?: string | null;
}): TransportDirectory {
  const directory = toSessionTransportDirectory(input.directory);
  if (directory) return directory;
  return toSessionTransportDirectory(input.targetRoot);
}

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
