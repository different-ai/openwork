import { normalizeDirectoryPath } from "../utils";

type WorkspaceType = "local" | "remote";

export function resolveScopedClientDirectory(input: {
  directory?: string | null;
  targetRoot?: string | null;
  workspaceType?: WorkspaceType | null;
}) {
  const directory = input.directory?.trim() ?? "";
  if (directory) return directory;

  if (input.workspaceType === "remote") return "";

  return input.targetRoot?.trim() ?? "";
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
