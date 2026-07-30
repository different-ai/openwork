import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { ApiError } from "../errors.js";

function nodeErrorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return error.code;
}

export function isMissingFileError(error: unknown): boolean {
  return nodeErrorCode(error) === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

export async function assertSafeArtifactPath(workspaceRoot: string, candidate: string): Promise<void> {
  // This rejects traversal and symlinks that exist when a path is inspected.
  // Node's path-based filesystem APIs do not provide descriptor-relative
  // openat/renameat operations across every supported desktop platform, so
  // authoring assumes the local workspace is not being concurrently mutated by
  // a hostile same-user process. The generated component never receives
  // filesystem access; its hard security boundary is the opaque iframe bridge.
  const workspacePath = resolve(workspaceRoot);
  const candidatePath = resolve(candidate);
  if (!isWithin(workspacePath, candidatePath)) {
    throw new ApiError(400, "ui_artifact_unsafe_path", "Artifact path escapes the workspace");
  }

  const workspaceRealPath = await realpath(workspacePath);
  const pathFromWorkspace = relative(workspacePath, candidatePath);
  const segments = pathFromWorkspace ? pathFromWorkspace.split(sep) : [];
  let currentPath = workspacePath;

  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);
    try {
      const info = await lstat(currentPath);
      if (info.isSymbolicLink()) {
        throw new ApiError(400, "ui_artifact_symlink_rejected", "Artifact paths cannot contain symbolic links");
      }
      const currentRealPath = await realpath(currentPath);
      if (!isWithin(workspaceRealPath, currentRealPath)) {
        throw new ApiError(400, "ui_artifact_unsafe_path", "Artifact path resolves outside the workspace");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isMissingFileError(error)) return;
      throw error;
    }
  }
}

export async function ensureSafeDirectory(workspaceRoot: string, directory: string): Promise<void> {
  await assertSafeArtifactPath(workspaceRoot, directory);
  await mkdir(directory, { recursive: true });
  await assertSafeArtifactPath(workspaceRoot, directory);
  const info = await lstat(directory);
  if (!info.isDirectory()) {
    throw new ApiError(400, "ui_artifact_unsafe_path", "Artifact path is not a directory");
  }
}

export async function atomicWriteText(workspaceRoot: string, path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await ensureSafeDirectory(workspaceRoot, parent);
  await assertSafeArtifactPath(workspaceRoot, path);
  const temporaryPath = resolve(parent, `.openwork-artifact-${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  try {
    await assertSafeArtifactPath(workspaceRoot, temporaryPath);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await assertSafeArtifactPath(workspaceRoot, path);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
