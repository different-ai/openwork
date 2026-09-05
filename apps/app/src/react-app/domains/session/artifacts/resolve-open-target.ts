import type { OpenworkServerClient } from "@/app/lib/openwork-server";

import { isCollectibleArtifactTarget, type OpenTarget } from "./open-target";

type ArtifactTargetResolver = Pick<OpenworkServerClient, "resolveArtifacts">;

export function isWorkspaceContainedArtifactTarget(target: OpenTarget) {
  if (!isCollectibleArtifactTarget(target)) return false;

  const normalized = target.value.trim().replace(/[\\]+/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;

  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
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
