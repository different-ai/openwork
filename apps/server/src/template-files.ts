import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ApiError } from "./errors.js";
import { ensureDir, exists } from "./utils.js";

export type TemplateFile = {
  path: string;
  content: string;
};

export type PlannedTemplateFile = TemplateFile & {
  absolutePath: string;
};

const RESERVED_TEMPLATE_EXACT_PATHS = new Set([
  ".opencode/openwork.json",
  ".opencode/openwork.jsonc",
  ".opencode/opencode.db",
]);

const RESERVED_TEMPLATE_PREFIXES = [
  ".opencode/commands/",
  ".opencode/skills/",
];

const RESERVED_TEMPLATE_SEGMENTS = new Set([".DS_Store", "Thumbs.db"]);

function normalizeTemplatePath(input: unknown): string {
  const normalized = String(input ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();

  if (!normalized) {
    throw new ApiError(400, "invalid_template_file_path", "Template file path is required");
  }

  if (normalized.includes("\0")) {
    throw new ApiError(400, "invalid_template_file_path", `Template file path contains an invalid byte: ${normalized}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ApiError(400, "invalid_template_file_path", `Template file path is invalid: ${normalized}`);
  }

  return normalized;
}

function isEnvFilePath(path: string): boolean {
  return path
    .split("/")
    .some((segment) => /^\.env(?:\..+)?$/i.test(segment));
}

function isReservedTemplatePath(path: string): boolean {
  if (RESERVED_TEMPLATE_EXACT_PATHS.has(path)) return true;
  if (RESERVED_TEMPLATE_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;

  const segments = path.split("/");
  if (segments.some((segment) => RESERVED_TEMPLATE_SEGMENTS.has(segment))) return true;

  const name = segments[segments.length - 1] ?? "";
  return /(?:\.db(?:-shm|-wal)?|\.sqlite(?:-shm|-wal)?)$/i.test(name);
}

export function isAllowedTemplateFilePath(input: unknown): boolean {
  const path = normalizeTemplatePath(input);
  if (!path.startsWith(".opencode/")) return false;
  if (isEnvFilePath(path)) return false;
  if (isReservedTemplatePath(path)) return false;
  return true;
}

function normalizeTemplateFile(value: unknown): TemplateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_template_file", "Template files must be objects with path and content");
  }

  const record = value as Record<string, unknown>;
  const path = normalizeTemplatePath(record.path);
  if (!isAllowedTemplateFilePath(path)) {
    throw new ApiError(400, "invalid_template_file_path", `Template file path is not allowed: ${path}`);
  }

  return {
    path,
    content: typeof record.content === "string" ? record.content : String(record.content ?? ""),
  };
}

export function planTemplateFiles(workspaceRoot: string, value: unknown): PlannedTemplateFile[] {
  if (!Array.isArray(value) || !value.length) return [];

  const root = resolve(workspaceRoot);
  return value.map((entry) => {
    const file = normalizeTemplateFile(entry);
    return {
      ...file,
      absolutePath: join(root, file.path),
    };
  });
}

async function walkTemplateFiles(root: string, currentPath: string, output: TemplateFile[]): Promise<void> {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walkTemplateFiles(root, absolutePath, output);
      continue;
    }
    if (!entry.isFile()) continue;

    const relativePath = normalizeTemplatePath(absolutePath.slice(root.length + 1));
    if (!isAllowedTemplateFilePath(relativePath)) continue;
    output.push({
      path: relativePath,
      content: await readFile(absolutePath, "utf8"),
    });
  }
}

export async function listTemplateFiles(workspaceRoot: string): Promise<TemplateFile[]> {
  const root = resolve(workspaceRoot);
  const templateRoot = join(root, ".opencode");
  if (!(await exists(templateRoot))) return [];

  const output: TemplateFile[] = [];
  await walkTemplateFiles(root, templateRoot, output);
  output.sort((a, b) => a.path.localeCompare(b.path));
  return output;
}

export async function writeTemplateFiles(workspaceRoot: string, value: unknown, options?: { replace?: boolean }): Promise<PlannedTemplateFile[]> {
  const files = planTemplateFiles(workspaceRoot, value);
  if (!files.length) return [];

  if (options?.replace) {
    const existing = await listTemplateFiles(workspaceRoot);
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
