import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

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

async function refuseLinkedFolder(path: string, label: string, missingCode: WorkspaceFileError["code"]): Promise<void> {
  const folder = dirname(path);
  const folderReal = await realpath(folder).catch(() => null);
  if (folderReal === null) {
    throw new WorkspaceFileError(missingCode, missingCode === "missing" ? `${label} was not found in the workspace.` : `${label}: its folder does not exist.`);
  }
  if (folderReal !== folder) throw new WorkspaceFileError("link", `${label} passes through a symbolic link, which is not allowed.`);
}

export async function openWorkspaceFileForReading(realRoot: string, path: string, label: string): Promise<OpenedWorkspaceFile> {
  await refuseLinkedFolder(path, label, "missing");
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
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
