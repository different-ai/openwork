import type { OpenworkServerClient } from "@/app/lib/openwork-server";

import { classifyOpenTarget, isOpenableFileTarget, openTargetFromUrl, type OpenTarget } from "./open-target";

export function openTargetForHref(href: string, targets: OpenTarget[], root?: string): OpenTarget | null {
  const url = openTargetFromUrl(href);
  if (url) return url;
  if (!href.trim() || href.trim().startsWith("#")) return null;
  const value = href.trim().replace(/^\.\//, "");
  const path = localArtifactPath(root, value);
  if (!path && !localArtifactPath("/", value)) return null;
  const exact = targets.find((target) => target.kind === "file"
    && (target.value === value || (path !== null && localArtifactPath(root, target.value) === path)));
  if (exact) return exact;
  return {
    id: `file:${value}`,
    kind: "file",
    value,
    name: (path ?? value).split(/[/\\]/).pop() || value,
    preview: classifyOpenTarget(path ?? value, "file"),
    confidence: 100,
    reason: "explicit link",
  };
}

type ArtifactTargetResolver = Pick<OpenworkServerClient, "resolveArtifacts">;

export function isWorkspaceContainedArtifactTarget(target: OpenTarget) {
  if (!isOpenableFileTarget(target)) return false;

  const normalized = target.value.trim().replace(/[\\]+/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;

  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Explicit native opens accept local paths, never URLs or network shares. */
export function localArtifactPath(root: string | null | undefined, value: string): string | null {
  let path = value.trim();
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname || url.search || url.hash) return null;
      path = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  }
  const isAbsolute = (path: string) => path.startsWith("/") || /^[A-Za-z]:[/\\]/.test(path);
  const isLocal = (path: string) => !/[\x00-\x1f]/.test(path)
    && !/^[/\\]{2}/.test(path)
    && (!/^[A-Za-z][A-Za-z\d+.-]*:/.test(path) || /^[A-Za-z]:[/\\]/.test(path));
  if (!path || !isLocal(path)) return null;
  if (isAbsolute(path)) return path;
  // Validate decoded components without changing the literal filesystem name.
  try {
    const decoded = decodeURIComponent(path);
    if (!isLocal(decoded) || isAbsolute(decoded)
      || decoded.split(/[/\\]/).some((segment) => !segment || /^\.{1,2}\s*$/.test(segment))) return null;
  } catch {
    return null;
  }
  const base = root?.trim();
  if (!base || !isAbsolute(base) || !isLocal(base) || path.startsWith("~")) return null;
  return `${base.replace(/[/\\]+$/, "")}/${path}`;
}

/** Compare locations only; the literal path handed to the desktop is never rewritten. */
function isWorkspaceContainedPath(root: string | null | undefined, path: string): boolean {
  const base = root?.trim();
  if (!base) return false;
  const normalize = (value: string) => value
    .replace(/[\\]+/g, "/")
    .replace(/\/+$/, "")
    .replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
  const container = normalize(base);
  const candidate = normalize(path);
  // A dot segment can leave the workspace after the prefix matches; never treat it as inside.
  if (candidate.split("/").some((segment) => /^\.{1,2}\s*$/.test(segment))) return false;
  if (!container) return candidate.startsWith("/");
  return candidate === container || candidate.startsWith(`${container}/`);
}

export type NativeFileAction = { path: string; action: "open" | "reveal" };

/**
 * Decide what an explicit native action may do with a referenced path. Only files inside
 * the workspace are handed to their default application. Anything else is shown in the
 * file manager and never launched, so a referenced path cannot start a program.
 *
 * This is a string-level pre-check for menu affordances. The desktop process makes the
 * final decision on disk (`__openWorkspaceFile` / `__openWithApp`): it resolves symlinks
 * for both the workspace root and the file and launches only a real file that stays inside
 * the real workspace, revealing anything else instead.
 */
export function nativeFileAction(
  root: string | null | undefined,
  value: string,
  options?: { reveal?: boolean },
): NativeFileAction | null {
  const path = localArtifactPath(root, value);
  if (!path) return null;
  if (options?.reveal || !isWorkspaceContainedPath(root, path)) return { path, action: "reveal" };
  return { path, action: "open" };
}

export async function resolveCollectibleOpenTarget(
  client: ArtifactTargetResolver,
  workspaceId: string,
  target: OpenTarget,
): Promise<OpenTarget | null> {
  if (target.kind !== "file") return null;

  const response = await client.resolveArtifacts(workspaceId, [target]);
  return response.items.find(isWorkspaceContainedArtifactTarget) ?? null;
}
