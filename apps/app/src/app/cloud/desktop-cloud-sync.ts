import {
  createDenClient,
  readDenSettings,
} from "../lib/den";
import type {
  OpenworkDesktopCloudSyncChange,
  OpenworkDesktopCloudSyncResult,
  OpenworkDesktopCloudSyncState,
  OpenworkServerClient,
} from "../lib/openwork-server";

export type PendingCloudPluginChange = "modified" | "removed";

type InstalledCloudPluginLike = {
  updatedAt: string | null;
  files: Array<{ configObjectId: string; updatedAt: string | null }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readSyncChange(value: unknown): OpenworkDesktopCloudSyncChange | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const kind = value.kind === "new" || value.kind === "modified" || value.kind === "removed" ? value.kind : null;
  const resourceKind = value.resourceKind === "llmProvider" ||
    value.resourceKind === "marketplace" ||
    value.resourceKind === "plugin" ||
    value.resourceKind === "configItem"
    ? value.resourceKind
    : null;
  if (!id || !kind || !resourceKind) return null;
  return {
    id,
    kind,
    resourceKind,
    marketplaceId: typeof value.marketplaceId === "string" ? value.marketplaceId : undefined,
    pluginId: typeof value.pluginId === "string" ? value.pluginId : undefined,
    previousLastUpdatedAt: typeof value.previousLastUpdatedAt === "string" ? value.previousLastUpdatedAt : null,
    nextLastUpdatedAt: typeof value.nextLastUpdatedAt === "string" ? value.nextLastUpdatedAt : null,
    queuedAt: typeof value.queuedAt === "number" && Number.isFinite(value.queuedAt) ? value.queuedAt : 0,
  };
}

/** Read all pending changes from a persisted desktop-cloud-sync state (GET response). */
export function readPendingCloudSyncChanges(state: OpenworkDesktopCloudSyncState): OpenworkDesktopCloudSyncChange[] {
  return Object.values(state.entries).flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.pendingChanges)) return [];
    return entry.pendingChanges.flatMap((change) => {
      const parsed = readSyncChange(change);
      return parsed ? [parsed] : [];
    });
  });
}

/**
 * Derive a map of installed cloud plugin id -> pending change.
 * "modified" means an update is available; "removed" means the plugin was
 * removed upstream. Stale changes (already applied locally or for plugins
 * no longer installed) are filtered out.
 */
export function derivePendingCloudPluginChanges(input: {
  changes: OpenworkDesktopCloudSyncChange[];
  installedPlugins: Record<string, InstalledCloudPluginLike>;
}): Record<string, PendingCloudPluginChange> {
  const pending: Record<string, PendingCloudPluginChange> = {};
  const markModified = (pluginId: string) => {
    if (pending[pluginId] !== "removed") pending[pluginId] = "modified";
  };

  for (const change of input.changes) {
    if (change.resourceKind === "plugin") {
      const installed = input.installedPlugins[change.id];
      if (!installed) continue;
      if (change.kind === "removed") {
        pending[change.id] = "removed";
      } else if (installed.updatedAt !== change.nextLastUpdatedAt) {
        markModified(change.id);
      }
      continue;
    }

    if (change.resourceKind !== "configItem") continue;
    const pluginId = change.pluginId?.trim() ?? "";
    const installed = pluginId ? input.installedPlugins[pluginId] : undefined;
    if (!installed) continue;
    const file = installed.files.find((entry) => entry.configObjectId === change.id) ?? null;
    if (change.kind === "removed") {
      if (file) markModified(pluginId);
    } else if (change.kind === "new") {
      if (!file) markModified(pluginId);
    } else if (file && file.updatedAt !== change.nextLastUpdatedAt) {
      markModified(pluginId);
    }
  }

  return pending;
}

let desktopCloudSyncQueue: Promise<void> = Promise.resolve();

async function runDesktopCloudSync(input: {
  openworkClient: OpenworkServerClient;
  workspaceId: string;
}): Promise<OpenworkDesktopCloudSyncResult | null> {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const activeOrgId = settings.activeOrgId?.trim() ?? "";
  if (!token || !activeOrgId) return null;

  const snapshot = await createDenClient({
    baseUrl: settings.baseUrl,
    apiBaseUrl: settings.apiBaseUrl,
    token,
  }).getResourceSnapshot(activeOrgId);

  return input.openworkClient.syncDesktopCloud(input.workspaceId, snapshot);
}

export function refreshDesktopCloudSync(input: {
  openworkClient: OpenworkServerClient | null | undefined;
  workspaceId: string | null | undefined;
}): Promise<OpenworkDesktopCloudSyncResult | null> {
  const openworkClient = input.openworkClient ?? null;
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (!openworkClient || !workspaceId) return Promise.resolve(null);

  const run = desktopCloudSyncQueue.then(() => runDesktopCloudSync({ openworkClient, workspaceId }));
  desktopCloudSyncQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
