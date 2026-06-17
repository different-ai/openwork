/**
 * path-security.ts
 *
 * Shared workspace path-security primitives.
 *
 * These functions are the single source of truth for sandbox boundary checks.
 * Both `routes/files.ts` and `extensions/openai-image-generation.ts` import
 * from here so the logic can never drift between the two copies.
 *
 * Design decisions
 * ────────────────
 * 1. Case-insensitive comparison on win32 *and* darwin.
 *    APFS / HFS+ are case-insensitive by default on macOS, so the same
 *    lower-casing guard that fixes Windows also prevents false-rejections on
 *    macOS without ever relaxing the actual containment check.
 *
 * 2. Trailing separator in the root prefix (`rootResolved + sep`).
 *    This is the classic "sibling-prefix" guard: it makes sure that a
 *    workspace at /projects/ws cannot be escaped by /projects/ws-secret.
 *    `startsWith("/projects/ws/")` is false for "/projects/ws-secret/…".
 *
 * 3. `posix.normalize` before the per-part `..` check in
 *    `normalizeWorkspaceRelativePath`.
 *    `posix.normalize` collapses `a/b/../c` → `a/c`, which means benign
 *    dot-dot segments inside an otherwise valid path are accepted rather than
 *    rejected as traversal.  Any traversal that *leaves* the root produces a
 *    leading `../` or exactly `..`, which is then caught and rejected.
 *
 * 4. Symlinks are deliberately NOT followed (no `realpath`).
 *    Resolving symlinks is an async FS operation and would change the
 *    signature of `resolveSafeChildPath` from sync to async everywhere it is
 *    called.  Symlink-based escapes require the attacker to control a symlink
 *    *inside* the workspace, which is a much narrower threat model; that
 *    mitigation is noted as out-of-scope and can be layered on separately.
 */

import { posix, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";

/**
 * Returns true when the current OS uses a case-insensitive filesystem by
 * default (Windows and macOS).  Used to decide whether path-prefix checks
 * should fold case.
 */
function isCaseInsensitiveFs(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

/**
 * Normalise a *workspace-relative* path supplied by the client.
 *
 * - Converts back-slashes to forward-slashes (Windows payloads).
 * - Strips common "workspace/…" or "/workspace/…" prefix variants that
 *   the OpenWork UI and agent tooling tend to emit.
 * - Collapses benign in-bounds dot-dot segments (`a/b/../c` → `a/c`).
 * - Rejects null bytes, absolute paths, and traversal that escapes the root.
 *
 * @throws {ApiError} 400 on any invalid or traversal path.
 */
export function normalizeWorkspaceRelativePath(
  input: string,
  options: { allowSubdirs: boolean },
): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (raw.includes("\u0000")) {
    throw new ApiError(400, "invalid_path", "Path contains null byte");
  }

  // Normalise separators first so every subsequent regex works on forward-
  // slash paths regardless of the client OS.
  let normalized = raw.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^workspaces\/[^/]+\//i, "");
  normalized = normalized.replace(/^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i, "");
  normalized = normalized.replace(/^workspace\//, "");
  normalized = normalized.replace(/^\/+/, "");

  // Collapse benign in-bounds dot-dot segments (e.g. a/b/../c → a/c).
  // Any traversal that still escapes the root after collapsing produces a
  // leading "../" or exactly "..", which we catch below.
  normalized = posix.normalize(normalized);
  if (normalized.startsWith("../") || normalized === "..") {
    throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
  }

  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (!options.allowSubdirs && parts.length > 1) {
    throw new ApiError(400, "invalid_path", "Subdirectories are not allowed");
  }
  // Belt-and-suspenders: posix.normalize only leaves a leading ".." (already
  // caught above); this loop catches any surviving bare ".." or "." parts.
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
    }
  }
  return parts.join("/");
}

/**
 * Resolve `child` relative to `root` and assert it stays inside `root`.
 *
 * Uses a case-insensitive prefix check on win32 and darwin to avoid
 * false-rejections caused by OS-level path normalisation that changes
 * letter-case (e.g. `C:\Users\Me\ws` vs `c:\users\me\ws`).
 *
 * The trailing separator in the prefix (`rootResolved + sep`) prevents the
 * sibling-workspace-prefix attack: `/projects/ws` cannot be escaped via
 * `/projects/ws-evil`.
 *
 * @throws {ApiError} 400 when `child` resolves to `root` itself (not a file)
 *   or to any path outside `root`.
 */
export function resolveSafeChildPath(root: string, child: string): string {
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, child);

  if (candidate === rootResolved) {
    throw new ApiError(400, "invalid_path", "Path must point to a file");
  }

  const rootPrefix = rootResolved + sep;
  const safe = isCaseInsensitiveFs()
    ? candidate.toLowerCase().startsWith(rootPrefix.toLowerCase())
    : candidate.startsWith(rootPrefix);

  if (!safe) {
    throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
  }

  return candidate;
}
