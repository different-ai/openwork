import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{ ok: true; path: string }} WorkspaceFileLaunchAllowed
 * @typedef {{ ok: false; reason: "invalid" | "missing" | "not-file" | "outside"; error: string }} WorkspaceFileLaunchRefused
 * @typedef {WorkspaceFileLaunchAllowed | WorkspaceFileLaunchRefused} WorkspaceFileLaunchDecision
 */

function describeError(error) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error ?? "unknown error");
}

function isInside(root, candidate, platform) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".") return false;
  const comparable = platform === "win32" ? relative.toLowerCase() : relative;
  if (comparable === ".." || comparable.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(relative);
}

/**
 * Decide whether the desktop may hand a referenced file to its default application.
 *
 * The renderer can only compare strings. This resolves both the workspace root and the
 * requested file on disk, so a symlink that lexically lives in the workspace but points
 * somewhere else is treated as outside it. Only an existing regular file whose resolved
 * location stays inside the resolved workspace root is allowed to launch; everything else
 * is refused with a reason the caller can turn into reveal-only behavior.
 *
 * @param {string} workspaceRoot
 * @param {string} target
 * @param {{ realpath?: typeof realpath; stat?: typeof stat; platform?: NodeJS.Platform }} [deps]
 * @returns {Promise<WorkspaceFileLaunchDecision>}
 */
export async function resolveWorkspaceFileLaunch(workspaceRoot, target, deps = {}) {
  const resolvePath = deps.realpath ?? realpath;
  const statPath = deps.stat ?? stat;
  const platform = deps.platform ?? process.platform;
  const root = String(workspaceRoot ?? "").trim();
  const requested = String(target ?? "").trim();
  if (!root || !requested) {
    return { ok: false, reason: "invalid", error: "Workspace root and file path are required." };
  }
  if (!path.isAbsolute(root) || !path.isAbsolute(requested)) {
    return { ok: false, reason: "invalid", error: "Workspace root and file path must be absolute." };
  }

  let resolvedRoot;
  try {
    resolvedRoot = await resolvePath(root);
  } catch (error) {
    return { ok: false, reason: "invalid", error: `Could not resolve the workspace folder: ${describeError(error)}` };
  }

  let resolvedTarget;
  try {
    resolvedTarget = await resolvePath(requested);
  } catch {
    return { ok: false, reason: "missing", error: `Could not find "${requested}" on disk.` };
  }

  if (!isInside(resolvedRoot, resolvedTarget, platform)) {
    return { ok: false, reason: "outside", error: "This file resolves outside the workspace, so it can only be shown in its folder." };
  }

  try {
    const info = await statPath(resolvedTarget);
    if (!info.isFile()) {
      return { ok: false, reason: "not-file", error: "Only files inside the workspace can be opened with an application." };
    }
  } catch (error) {
    return { ok: false, reason: "missing", error: `Could not read "${requested}": ${describeError(error)}` };
  }

  return { ok: true, path: resolvedTarget };
}
