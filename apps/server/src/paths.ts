import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";

export function assertAbsolute(path: string): void {
  if (!isAbsolute(path)) {
    throw new ApiError(400, "invalid_path", "Path must be absolute");
  }
}

export async function resolveWithinRoot(root: string, ...segments: string[]): Promise<string> {
  const resolvedRoot = await realpath(root);
  const candidate = resolve(resolvedRoot, ...segments);
  const resolvedCandidate = await realpath(candidate).catch(() => candidate);
  if (resolvedCandidate === resolvedRoot) return candidate;
  if (!resolvedCandidate.startsWith(resolvedRoot + sep)) {
    throw new ApiError(400, "path_escape", "Path escapes workspace root");
  }
  return candidate;
}
