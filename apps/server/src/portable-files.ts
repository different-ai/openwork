import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ApiError } from "./errors.js";
import { ensureDir, exists } from "./utils.js";

export type PortableFile = {
  path: string;
  content: string;
};

export type PlannedPortableFile = PortableFile & {
  absolutePath: string;
};

const ALLOWED_PORTABLE_PREFIXES = [".opencode/agents/", ".opencode/plugins/", ".opencode/tools/"];

const RESERVED_PORTABLE_SEGMENTS = new Set([".DS_Store", "Thumbs.db", "node_modules"]);

function normalizePortablePath(input: unknown): string {
  const normalized = String(input ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();

  if (!normalized) {
    throw new ApiError(400, "invalid_portable_file_path", "Portable file path is required");
  }

  if (normalized.includes("\0")) {
    throw new ApiError(400, "invalid_portable_file_path", `Portable file path contains an invalid byte: ${normalized}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ApiError(400, "invalid_portable_file_path", `Portable file path is invalid: ${normalized}`);
  }

  return normalized;
}

function isEnvFilePath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => /^\.env(?:\..+)?$/i.test(segment));
}

function hasReservedPortableSegment(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment) => RESERVED_PORTABLE_SEGMENTS.has(segment));
}

function isAllowedPortablePrefix(path: string): boolean {
  return ALLOWED_PORTABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function isAllowedPortableFilePath(input: unknown): boolean {
  const path = normalizePortablePath(input);
  if (!isAllowedPortablePrefix(path)) return false;
  if (isEnvFilePath(path)) return false;
  if (hasReservedPortableSegment(path)) return false;
  return true;
}

function normalizePortableFile(value: unknown): PortableFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_portable_file", "Portable files must be objects with path and content");
  }

  const record = value as Record<string, unknown>;
  const path = normalizePortablePath(record.path);
  if (!isAllowedPortableFilePath(path)) {
    throw new ApiError(400, "invalid_portable_file_path", `Portable file path is not allowed: ${path}`);
  }

  return {
    path,
    content: typeof record.content === "string" ? record.content : String(record.content ?? ""),
  };
}

export function planPortableFiles(workspaceRoot: string, value: unknown): PlannedPortableFile[] {
  if (!Array.isArray(value) || !value.length) return [];

  const root = resolve(workspaceRoot);
  return value.map((entry) => {
    const file = normalizePortableFile(entry);
    return {
      ...file,
      absolutePath: join(root, file.path),
    };
  });
}

async function walkPortableFiles(root: string, currentPath: string, output: PortableFile[]): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walkPortableFiles(root, absolutePath, output);
      continue;
    }
    if (!entry.isFile()) continue;

    const relativePath = normalizePortablePath(absolutePath.slice(root.length + 1));
    if (!isAllowedPortableFilePath(relativePath)) continue;
    output.push({
      path: relativePath,
      content: await readFile(absolutePath, "utf8"),
    });
  }
}

export async function listPortableFiles(workspaceRoot: string): Promise<PortableFile[]> {
  const root = resolve(workspaceRoot);
  const portableRoot = join(root, ".opencode");
  if (!(await exists(portableRoot))) return [];

  const output: PortableFile[] = [];
  await walkPortableFiles(root, portableRoot, output);
  output.sort((a, b) => a.path.localeCompare(b.path));
  return output;
}

export async function writePortableFiles(workspaceRoot: string, value: unknown, options?: { replace?: boolean }): Promise<PlannedPortableFile[]> {
  const files = planPortableFiles(workspaceRoot, value);
  if (!files.length) return [];

  if (options?.replace) {
    const existing = await listPortableFiles(workspaceRoot);
    for (const file of existing) {
      await rm(join(resolve(workspaceRoot), file.path), { force: true });
    }
  }

  for (const file of files) {
    await ensureDir(dirname(file.absolutePath));
    await writeFile(file.absolutePath, file.content, "utf8");
  }

  return files;
}
