import { join } from "node:path";
import { openworkServerDataDir } from "@openwork/paths";

// Where installed apps live on disk.
//
// Layout, under the existing server data directory:
//
//   apps/
//     <appId>/
//       <version>/          extracted, verified package contents
//     .candidates/
//       <digest>.owapp      archives downloaded during preview
//     installed.json        the persisted registry
//     audit.jsonl           append-only lifecycle record
//     data/<appId>/         app-owned storage, deletable on uninstall
//
// App ids are validated as reverse-DNS before they ever reach a path, and every
// segment is re-checked here, so a crafted id cannot climb out of this tree.

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function appsRoot(dataDir = openworkServerDataDir()): string {
  return join(dataDir, "apps");
}

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value.includes("..")) {
    throw new Error(`unsafe ${label} path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

export function appInstallDir(appId: string, version: string, dataDir?: string): string {
  return join(appsRoot(dataDir), safeSegment(appId, "app id"), safeSegment(version, "version"));
}

export function appVersionsDir(appId: string, dataDir?: string): string {
  return join(appsRoot(dataDir), safeSegment(appId, "app id"));
}

export function appDataDir(appId: string, dataDir?: string): string {
  return join(appsRoot(dataDir), "data", safeSegment(appId, "app id"));
}

export function candidateCacheDir(dataDir?: string): string {
  return join(appsRoot(dataDir), ".candidates");
}

export function installedRegistryPath(dataDir?: string): string {
  return join(appsRoot(dataDir), "installed.json");
}

export function auditLogPath(dataDir?: string): string {
  return join(appsRoot(dataDir), "audit.jsonl");
}
