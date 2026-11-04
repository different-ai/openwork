import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {{ ok: true; path: string }} WorkspaceFileLaunchAllowed
 * @typedef {{ ok: false; reason: "invalid" | "missing" | "not-file" | "outside"; error: string }} WorkspaceFileLaunchRefused
 * @typedef {WorkspaceFileLaunchAllowed | WorkspaceFileLaunchRefused} WorkspaceFileLaunchDecision
 */

/**
 * Probe a chat file candidate without opening or revealing anything. Launch permissions
 * are deliberately checked separately by resolveWorkspaceFileLaunch at the final boundary.
 * @param {string} target
 * @returns {Promise<string | null>}
 */
export async function resolveChatFilePath(target) {
  // Reject UNC/network and device namespace paths before touching the filesystem.
  /** @param {string} value */
  const isLocalAbsolute = (value) => typeof value === "string"
    && path.isAbsolute(value)
    && !/^[\\/]{2}/.test(value)
    && !value.includes("\u0000");
  if (!isLocalAbsolute(target)) return null;
  try {
    const canonical = await realpath(target);
    if (!isLocalAbsolute(canonical)) return null;
    const info = await stat(canonical);
    return info.isFile() || info.isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

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

/**
 * A missing chat reference is normal (another computer, deleted output), not
 * an OS error. Check the exact item before opening OR revealing; never open a
 * parent directory as a substitute for a missing file. Symlink launch guards
 * still run at the final native boundary.
 * @param {string} workspaceRoot
 * @param {string} target
 * @param {{ reveal?: boolean; openPath: (path: string) => Promise<string>; revealPath: (path: string) => void }} actions
 * @returns {Promise<import("@openwork/types/desktop-ipc").DesktopWorkspaceFileOpenResult>}
 */
export async function openChatWorkspaceFile(workspaceRoot, target, actions) {
  const decision = await resolveWorkspaceFileLaunch(workspaceRoot, target);
  if (decision.ok === false) {
    if (decision.reason === "outside") {
      try {
        await stat(target);
        actions.revealPath(target);
        return { ok: true, action: "revealed" };
      } catch {
        // The reference is stale, or this account cannot access it.
      }
    }
    return { ok: true, action: "unavailable" };
  }
  if (actions.reveal) {
    actions.revealPath(decision.path);
    return { ok: true, action: "revealed" };
  }
  const error = await actions.openPath(decision.path);
  return error?.trim() ? { ok: false, error } : { ok: true, action: "opened" };
}

/**
 * A chat's output folder: where its computer use puts what it makes for the person,
 * one folder per chat under Downloads/OpenWork.
 * @param {string} downloads
 * @param {string} sessionId
 * @returns {string | null}
 */
export function chatOutputFolder(downloads, sessionId) {
  const name = String(sessionId).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return /^\.*$/.test(name) ? null : path.join(downloads, "OpenWork", name);
}

/**
 * The files in a chat's output folder, newest first, however they got there: an app's
 * save, a script's export or a shell command. Regular files only, no links or hidden
 * names, at most three folders deep and `limit` files.
 * @param {string} folder
 * @returns {Promise<Array<{ path: string; bytes: number; modifiedAt: number }>>}
 */
export async function listChatOutputFiles(folder, { limit = 200 } = {}) {
  /** @type {Array<{ path: string; bytes: number; modifiedAt: number }>} */
  const files = [];
  let budget = 2000;
  /** @param {string} dir @param {number} depth */
  const walk = async (dir, depth) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (--budget < 0) return;
      if (entry.name.startsWith(".")) continue;
      const item = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(item, depth + 1);
      else if (entry.isFile()) {
        const info = await lstat(item).catch(() => null);
        if (info?.isFile()) files.push({ path: item, bytes: info.size, modifiedAt: info.mtimeMs });
      }
    }
  };
  const root = await lstat(folder).catch(() => null);
  if (root?.isDirectory()) await walk(folder, 1);
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limit);
}

/**
 * Whether Open may launch `target` as this chat's own output: a regular file that is not
 * a link and not executable, resolving inside the chat's output folder.
 * @param {string | null} folder
 * @param {string} target
 */
export async function opensFromChatOutput(folder, target) {
  if (!folder) return false;
  const decision = await resolveWorkspaceFileLaunch(folder, target);
  if (decision.ok === false) return false;
  const info = await lstat(target).catch(() => null);
  return Boolean(info?.isFile()) && (info.mode & 0o111) === 0;
}
