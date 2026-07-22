import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
import { ApiError } from "./errors.js";
import { ensureDir, exists } from "./utils.js";

interface ParseResult<T> {
  data: T;
  raw: string;
  invalid?: boolean;
  missing?: boolean;
}

export type ReadJsoncFileOptions = {
  allowInvalid?: boolean;
  maxBytes?: number;
  regularFileOnly?: boolean;
  signal?: AbortSignal;
};

const BOUNDED_READ_CHUNK_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function fileReadError(code: string, message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "code", { value: code, enumerable: true });
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw fileReadError("ABORT_ERR", "File read aborted");
}

/**
 * Read a small diagnostics input without following symlinks or opening a FIFO
 * in blocking mode. The size is checked both before and while reading so a
 * file that grows after inspection cannot exceed the caller's memory budget.
 */
export async function readBoundedRegularTextFile(
  path: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<string> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  throwIfAborted(options.signal);
  const pathMetadata = await lstat(path);
  throwIfAborted(options.signal);
  if (!pathMetadata.isFile()) {
    throw fileReadError("NOT_REGULAR_FILE", "Expected a regular file");
  }
  if (pathMetadata.size > options.maxBytes) {
    throw fileReadError("FILE_TOO_LARGE", "File exceeds the configured read limit");
  }

  const nonBlockingFlags = process.platform === "win32"
    ? 0
    : constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | nonBlockingFlags);
  try {
    const openedMetadata = await handle.stat();
    throwIfAborted(options.signal);
    if (!openedMetadata.isFile()) {
      throw fileReadError("NOT_REGULAR_FILE", "Expected a regular file");
    }
    if (openedMetadata.size > options.maxBytes) {
      throw fileReadError("FILE_TOO_LARGE", "File exceeds the configured read limit");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= options.maxBytes) {
      throwIfAborted(options.signal);
      const remainingWithOverflowByte = options.maxBytes - totalBytes + 1;
      const chunk = Buffer.allocUnsafe(Math.min(BOUNDED_READ_CHUNK_BYTES, remainingWithOverflowByte));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      throwIfAborted(options.signal);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > options.maxBytes) {
        throw fileReadError("FILE_TOO_LARGE", "File exceeds the configured read limit");
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readJsoncFile<T>(
  path: string,
  fallback: T,
  options?: ReadJsoncFileOptions,
): Promise<ParseResult<T>> {
  let raw: string;
  if (options?.regularFileOnly === true) {
    try {
      raw = await readBoundedRegularTextFile(path, {
        maxBytes: options.maxBytes ?? 1024 * 1024,
        signal: options.signal,
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (hasErrorCode(error, "ENOENT")) return { data: fallback, raw: "", missing: true };
      throw error;
    }
  } else {
    if (!(await exists(path))) {
      return { data: fallback, raw: "", missing: true };
    }
    raw = await readFile(path, { encoding: "utf8", signal: options?.signal });
  }
  const errors: { error: number; offset: number; length: number }[] = [];
  const data = parse(raw, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    if (options?.allowInvalid === true) return { data: fallback, raw, invalid: true };
    const details = errors.map((error) => ({
      code: printParseErrorCode(error.error),
      offset: error.offset,
      length: error.length,
    }));
    throw new ApiError(422, "invalid_jsonc", "Failed to parse JSONC", details);
  }
  return { data, raw };
}

export async function updateJsoncTopLevel(path: string, updates: Record<string, unknown>): Promise<void> {
  const hasFile = await exists(path);
  if (!hasFile) {
    await ensureDir(dirname(path));
    const content = JSON.stringify(updates, null, 2) + "\n";
    await writeFile(path, content, "utf8");
    return;
  }

  let content = await readFile(path, "utf8");
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  for (const [key, value] of Object.entries(updates)) {
    const edits = modify(content, [key], value, { formattingOptions });
    content = applyEdits(content, edits);
  }
  await writeFile(path, content.endsWith("\n") ? content : content + "\n", "utf8");
}

export async function updateJsoncPath(path: string, jsonPath: (string | number)[], value: unknown): Promise<void> {
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  const hasFile = await exists(path);
  if (!hasFile) {
    await ensureDir(dirname(path));
    let content = "{}\n";
    const edits = modify(content, jsonPath, value, { formattingOptions });
    content = applyEdits(content, edits);
    await writeFile(path, content.endsWith("\n") ? content : content + "\n", "utf8");
    return;
  }

  let content = await readFile(path, "utf8");
  const edits = modify(content, jsonPath, value, { formattingOptions });
  content = applyEdits(content, edits);
  await writeFile(path, content.endsWith("\n") ? content : content + "\n", "utf8");
}

export async function writeJsoncFile(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const content = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, content, "utf8");
}
