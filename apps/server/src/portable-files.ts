import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  WorkspacePortabilityError,
  isAllowedPortableFilePath as isAllowedPortableFilePathContract,
  normalizePortableFile as normalizePortableFileContract,
  normalizePortablePath as normalizePortablePathContract,
  type PortableFile,
} from "@openwork/workspace-portability";

import { ApiError } from "./errors.js";
import { ensureDir, exists } from "./utils.js";

export type { PortableFile } from "@openwork/workspace-portability";

export type PlannedPortableFile = PortableFile & {
  absolutePath: string;
};

function normalizePortablePath(input: unknown): string {
  try {
    return normalizePortablePathContract(input);
  } catch (error) {
    throwPortabilityApiError(error);
  }
}

export function isAllowedPortableFilePath(input: unknown): boolean {
  try {
    return isAllowedPortableFilePathContract(input);
  } catch (error) {
    throwPortabilityApiError(error);
  }
}

function normalizePortableFile(value: unknown): PortableFile {
  try {
    return normalizePortableFileContract(value);
  } catch (error) {
    throwPortabilityApiError(error);
  }
}

function throwPortabilityApiError(error: unknown): never {
  if (error instanceof WorkspacePortabilityError) {
    throw new ApiError(400, error.code, error.message);
  }
  throw error;
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

async function walkPortableFilePaths(root: string, currentPath: string, output: string[]): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walkPortableFilePaths(root, absolutePath, output);
      continue;
    }
    if (!entry.isFile()) continue;

    const relativePath = normalizePortablePath(absolutePath.slice(root.length + 1));
    if (!isAllowedPortableFilePath(relativePath)) continue;
    output.push(relativePath);
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

export async function listPortableFilePaths(workspaceRoot: string): Promise<string[]> {
  const root = resolve(workspaceRoot);
  const portableRoot = join(root, ".opencode");
  if (!(await exists(portableRoot))) return [];

  const output: string[] = [];
  await walkPortableFilePaths(root, portableRoot, output);
  output.sort((a, b) => a.localeCompare(b));
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
