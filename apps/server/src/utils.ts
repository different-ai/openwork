import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function shortId(): string {
  return randomUUID();
}

export function parseList(input: string | undefined): string[] {
  if (!input) return [];
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)).filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[,;]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

const RENAME_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Rename, retrying while Windows still holds the file. Antivirus scanning or
 * the search indexer opens freshly written files (uploads, downloaded engine
 * binaries) for a few seconds, and a plain rename then fails with EPERM/EBUSY.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: {
    platform?: NodeJS.Platform;
    renameImpl?: (from: string, to: string) => Promise<void>;
    delaysMs?: readonly number[];
  } = {},
): Promise<void> {
  const renameImpl = options.renameImpl ?? rename;
  const delays = (options.platform ?? process.platform) === "win32"
    ? options.delaysMs ?? [100, 250, 500, 1_000, 2_000, 4_000, 8_000]
    : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      const delay = delays[attempt];
      if (delay === undefined || !code || !RENAME_RETRY_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
