import type { PortableFile } from "./types.js"

export const ALLOWED_PORTABLE_FILE_PREFIXES = [
  ".opencode/agents/",
  ".opencode/plugins/",
  ".opencode/tools/",
] as const

export const RESERVED_PORTABLE_FILE_SEGMENTS = [
  ".DS_Store",
  "Thumbs.db",
  "node_modules",
] as const

export type WorkspacePortabilityErrorCode =
  | "invalid_portable_file"
  | "invalid_portable_file_path"

export class WorkspacePortabilityError extends Error {
  readonly code: WorkspacePortabilityErrorCode

  constructor(code: WorkspacePortabilityErrorCode, message: string) {
    super(message)
    this.name = "WorkspacePortabilityError"
    this.code = code
  }
}

const reservedSegments = new Set<string>(RESERVED_PORTABLE_FILE_SEGMENTS)

export function normalizePortablePath(input: unknown): string {
  const normalized = String(input ?? "")
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim()

  if (!normalized) {
    throw new WorkspacePortabilityError(
      "invalid_portable_file_path",
      "Portable file path is required",
    )
  }

  if (normalized.includes("\0")) {
    throw new WorkspacePortabilityError(
      "invalid_portable_file_path",
      `Portable file path contains an invalid byte: ${normalized}`,
    )
  }

  const segments = normalized.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new WorkspacePortabilityError(
      "invalid_portable_file_path",
      `Portable file path is invalid: ${normalized}`,
    )
  }

  return normalized
}

function isEnvFilePath(path: string): boolean {
  return path.split("/").some((segment) => /^\.env(?:\..+)?$/i.test(segment))
}

function hasReservedPortableSegment(path: string): boolean {
  return path.split("/").some((segment) => reservedSegments.has(segment))
}

function isAllowedPortablePrefix(path: string): boolean {
  return ALLOWED_PORTABLE_FILE_PREFIXES.some((prefix) => path.startsWith(prefix))
}

export function isAllowedPortableFilePath(input: unknown): boolean {
  const path = normalizePortablePath(input)
  if (!isAllowedPortablePrefix(path)) return false
  if (isEnvFilePath(path)) return false
  if (hasReservedPortableSegment(path)) return false
  return true
}

export function normalizePortableFile(value: unknown): PortableFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspacePortabilityError(
      "invalid_portable_file",
      "Portable files must be objects with path and content",
    )
  }

  const record = value as Record<string, unknown>
  const path = normalizePortablePath(record.path)
  if (!isAllowedPortableFilePath(path)) {
    throw new WorkspacePortabilityError(
      "invalid_portable_file_path",
      `Portable file path is not allowed: ${path}`,
    )
  }

  return {
    path,
    content: typeof record.content === "string" ? record.content : String(record.content ?? ""),
  }
}
