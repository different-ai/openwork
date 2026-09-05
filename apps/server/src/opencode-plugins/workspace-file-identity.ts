import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

/**
 * Open-then-verify access to files under the workspace, shared by the plugins
 * that read attachments or read and write workbooks.
 *
 * Node exposes neither openat nor O_RESOLVE_BENEATH, so any pathname is
 * resolved again by every syscall and a directory under the workspace could
 * be swapped for a link between two of them. These helpers therefore never
 * decide anything from a pathname check that precedes a syscall. They obtain
 * the file handle FIRST, then prove — from the handle's own inode — that it
 * is the regular file sitting at exactly the requested path inside the real
 * workspace root, with no symbolic link in any component and a real directory
 * as its parent. Only a handle that passes is ever read from or written to.
 *
 * The one pathname-dependent effect that can survive a concurrent swap is the
 * exclusive creation of an EMPTY file: O_EXCL can never replace an existing
 * file, no content is written before the proof passes, callers restrict the
 * name to an inert extension, and a misplaced empty inode is removed by
 * identity. Overwrites open without O_CREAT and without O_TRUNC, so nothing
 * changes until the handle is proven to be the very inode the caller decided
 * to overwrite.
 */

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type OpenedWorkspaceFile = {
  handle: FileHandle;
  info: Stats;
  created: boolean;
};

export class WorkspaceFileError extends Error {
  readonly code: "missing" | "link" | "not-file" | "exists" | "changed" | "folder-missing";

  constructor(code: WorkspaceFileError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Prove that an already-open handle refers to the regular file at exactly
 * `path`: the directory entry at `path` is the handle's inode, `path` resolves
 * to itself (no link in any component), its parent is a real directory that
 * also resolves to itself, and everything sits under `realRoot`. Evaluated
 * after the open, so a swap before the open fails the proof and a swap after
 * it cannot redirect the handle.
 */
export async function proveHandleInPlace(actual: Stats, path: string, realRoot: string): Promise<boolean> {
  if (!actual.isFile() || !isWithin(realRoot, path)) return false;
  const folder = dirname(path);
  const [placed, placedReal, folderNow, folderReal] = await Promise.all([
    lstat(path).catch(() => null),
    realpath(path).catch(() => null),
    lstat(folder).catch(() => null),
    realpath(folder).catch(() => null),
  ]);
  return placed !== null && sameFile(placed, actual) && placedReal === path
    && folderNow !== null && folderNow.isDirectory() && folderReal === folder;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "";
}

/**
 * Fast path before the open: refuse a folder that is missing or that already
 * resolves through a link. This is not the safety boundary (a swap after it
 * is caught by the post-open proof); it keeps the ordinary case from creating
 * even a transient empty inode through a link.
 */
async function refuseLinkedFolder(path: string, label: string, missingCode: WorkspaceFileError["code"]): Promise<void> {
  const folder = dirname(path);
  const folderReal = await realpath(folder).catch(() => null);
  if (folderReal === null) {
    throw new WorkspaceFileError(missingCode, missingCode === "missing" ? `${label} was not found in the workspace.` : `${label}: its folder does not exist.`);
  }
  if (folderReal !== folder) throw new WorkspaceFileError("link", `${label} passes through a symbolic link, which is not allowed.`);
}

/**
 * Open a regular file for reading without following a link at any level and
 * prove it is in place before returning the handle. The caller must close it.
 */
export async function openWorkspaceFileForReading(realRoot: string, path: string, label: string): Promise<OpenedWorkspaceFile> {
  await refuseLinkedFolder(path, label, "missing");
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new WorkspaceFileError("missing", `${label} was not found in the workspace.`);
    if (code === "ELOOP" || code === "EMLINK") throw new WorkspaceFileError("link", `${label} passes through a symbolic link, which is not allowed.`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new WorkspaceFileError("not-file", `${label} is not a regular file.`);
    if (!(await proveHandleInPlace(info, path, realRoot))) {
      const real = await realpath(path).catch(() => null);
      if (real !== null && real !== path) throw new WorkspaceFileError("link", `${label} passes through a symbolic link, which is not allowed.`);
      throw new WorkspaceFileError("changed", `${label} changed on disk while it was being opened; nothing was read. Try again.`);
    }
    return { handle, info, created: false };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Open a regular file for writing and prove it is in place before returning
 * the handle. An existing file is opened without O_CREAT and without O_TRUNC
 * and must be the inode the caller observed (`expected`); a new file is
 * created with O_EXCL, which can never replace anything, and is removed by
 * identity if it proves to have landed anywhere but at `path`. The caller
 * truncates and writes through the returned handle, then closes it.
 */
export async function openWorkspaceFileForWriting(realRoot: string, path: string, expected: Stats | null, label: string): Promise<OpenedWorkspaceFile> {
  await refuseLinkedFolder(path, label, "folder-missing");
  let handle: FileHandle;
  try {
    handle = expected
      ? await open(path, constants.O_WRONLY | NO_FOLLOW)
      : await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o644);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new WorkspaceFileError("folder-missing", `${label}: its folder does not exist.`);
    if (code === "EEXIST") throw new WorkspaceFileError("exists", `${label} appeared on disk while it was being created; nothing was written. Try again.`);
    if (code === "ELOOP" || code === "EMLINK") throw new WorkspaceFileError("link", `${label} passes through a symbolic link, which is not allowed.`);
    throw error;
  }
  try {
    const info = await handle.stat();
    const inPlace = await proveHandleInPlace(info, path, realRoot) && (expected === null || sameFile(info, expected));
    if (!inPlace) {
      const real = await realpath(path).catch(() => null);
      if (expected === null) {
        // Our own empty inode may have been created through a swapped folder:
        // remove it wherever the path currently leads, but only if it is ours.
        const placed = await lstat(path).catch(() => null);
        if (placed && sameFile(placed, info)) await rm(path, { force: true }).catch(() => undefined);
      }
      if (real !== null && real !== path) throw new WorkspaceFileError("link", `${label} passes through a symbolic link, which is not allowed.`);
      throw new WorkspaceFileError("changed", `${label} changed on disk while it was being opened; nothing was written. Try again.`);
    }
    return { handle, info, created: expected === null };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
