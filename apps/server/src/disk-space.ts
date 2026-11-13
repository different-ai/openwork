import { statfsSync } from "node:fs";
import { ApiError } from "./errors.js";

// Node reports a full disk or quota as an error code. SQLite and errors that
// wrap either one only carry it in the message. The bare phrase "no space
// left on device" is not matched: a remote command's output can contain it.
const DISK_FULL_CODES = new Set(["ENOSPC", "EDQUOT", "SQLITE_FULL"]);
const DISK_FULL_MESSAGE = /\b(?:ENOSPC|EDQUOT)\b|database or disk is full/;

/** True when a local write failed because the disk, or the account's quota on it, is full. */
export function isDiskFullError(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth += 1) {
    if (visited.has(current)) return false;
    visited.add(current);
    const code: unknown = Reflect.get(current, "code");
    if (typeof code === "string" && DISK_FULL_CODES.has(code)) return true;
    const message: unknown = Reflect.get(current, "message");
    if (typeof message === "string" && DISK_FULL_MESSAGE.test(message)) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

/** The answer for a request that failed for a reason no route handled. */
export function unexpectedApiError(error: unknown): ApiError {
  if (isDiskFullError(error)) {
    return new ApiError(
      507,
      "insufficient_storage",
      "Not enough disk space. Free up space on the computer running OpenWork, then try again.",
    );
  }
  return new ApiError(500, "internal_error", "Unexpected server error");
}

let watchedDirectory: string | null = null;

/** Names the folder whose disk is reported with disk-full errors. */
export function watchDiskSpace(directory: string): void {
  watchedDirectory = directory;
}

/** Whole megabytes free on the watched disk, for error reports; null when unknown. */
export function watchedDiskFreeMegabytes(): number | null {
  if (!watchedDirectory) return null;
  try {
    const stats = statfsSync(watchedDirectory);
    const freeBytes = stats.bavail * stats.bsize;
    return Number.isFinite(freeBytes) && freeBytes >= 0 ? Math.floor(freeBytes / 1024 ** 2) : null;
  } catch {
    return null;
  }
}
