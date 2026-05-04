import { createHash } from "node:crypto";
import path from "node:path";

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createStableId(prefix: string, key: string) {
  return `${prefix}_${stableHash(key).slice(0, 12)}`;
}

export function createServerId(kind: "local" | "remote", key: string) {
  if (kind === "local") {
    return "srv_local";
  }

  return createStableId("srv", `remote::${key}`);
}

export function createLocalWorkspaceId(dataDir: string) {
  return createStableId("ws", dataDir);
}

export function createRemoteWorkspaceId(input: {
  baseUrl: string;
  directory?: string | null;
  remoteWorkspaceId?: string | null;
  remoteType: "openwork" | "opencode";
}) {
  if (input.remoteType === "openwork") {
    const key = ["openwork", input.baseUrl, input.remoteWorkspaceId?.trim() ?? ""]
      .filter(Boolean)
      .join("::");
    return createStableId("ws", key);
  }

  const key = ["remote", input.baseUrl, input.directory?.trim() ?? ""]
    .filter(Boolean)
    .join("::");
  return createStableId("ws", key);
}

export function createInternalWorkspaceId(kind: "control" | "help") {
  return createStableId("ws", `internal::${kind}`);
}

export function slugifyWorkspaceValue(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || fallback;
}

export function deriveWorkspaceSlugSource(input: {
  dataDir?: string | null;
  displayName: string;
  fallback: string;
}) {
  const baseName = input.dataDir ? path.basename(input.dataDir) : "";
  return slugifyWorkspaceValue(input.displayName || baseName, input.fallback);
}
