import { statfsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { ApiError } from "./errors.js";

export const LOW_DISK_SPACE_BYTES = 2 * 1024 ** 3;
export const CRITICAL_DISK_SPACE_BYTES = 200 * 1024 ** 2;

export type DiskSpaceLevel = "ok" | "low" | "critical";

export type DiskSpaceStatus = {
  freeBytes: number | null;
  totalBytes: number | null;
  level: DiskSpaceLevel;
};

const DISK_FULL_CODES = new Set(["ENOSPC", "EDQUOT", "SQLITE_FULL"]);
const DISK_FULL_MESSAGE = /\b(?:ENOSPC|EDQUOT)\b|database or disk is full/;

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

export function diskSpaceLevel(freeBytes: number | null): DiskSpaceLevel {
  if (freeBytes === null) return "ok";
  if (freeBytes < CRITICAL_DISK_SPACE_BYTES) return "critical";
  if (freeBytes < LOW_DISK_SPACE_BYTES) return "low";
  return "ok";
}

function statusFromStats(stats: { bavail: number; blocks: number; bsize: number }): DiskSpaceStatus {
  const freeBytes = stats.bavail * stats.bsize;
  const totalBytes = stats.blocks * stats.bsize;
  if (!Number.isFinite(freeBytes) || freeBytes < 0 || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return UNKNOWN_DISK_SPACE;
  }
  return { freeBytes, totalBytes, level: diskSpaceLevel(freeBytes) };
}

const UNKNOWN_DISK_SPACE: DiskSpaceStatus = { freeBytes: null, totalBytes: null, level: "ok" };

export async function readDiskSpace(directory: string): Promise<DiskSpaceStatus> {
  try {
    return statusFromStats(await statfs(directory));
  } catch {
    return UNKNOWN_DISK_SPACE;
  }
}

let watchedDirectory: string | null = null;

export function watchDiskSpace(directory: string): void {
  watchedDirectory = directory;
}

export function watchedDiskFreeMegabytes(): number | null {
  if (!watchedDirectory) return null;
  try {
    const { freeBytes } = statusFromStats(statfsSync(watchedDirectory));
    return freeBytes === null ? null : Math.floor(freeBytes / 1024 ** 2);
  } catch {
    return null;
  }
}
