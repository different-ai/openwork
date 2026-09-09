import type { OpenworkServerClient } from "@/app/lib/openwork-server";

import { isOpenableFileTarget, type OpenTarget } from "./open-target";

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
  const base = root?.trim();
  if (!base || !isAbsolute(base) || !isLocal(base) || path.startsWith("~")) return null;
  return `${base.replace(/[/\\]+$/, "")}/${path.replace(/^\.[/\\]/, "")}`;
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
