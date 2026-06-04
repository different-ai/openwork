export type ResourceSnapshotConfigItem = {
  configItemId: string;
  lastUpdatedAt: string;
};

export type ResourceSnapshotPlugin = {
  pluginId: string;
  lastUpdatedAt: string;
  configItems: ResourceSnapshotConfigItem[];
};

export type ResourceSnapshotMarketplace = {
  lastUpdatedAt: string;
  plugins: ResourceSnapshotPlugin[];
};

export type ResourceSnapshot = {
  organizationId: string;
  orgMemberId: string;
  teamIds: string[];
  resources: {
    llmProviders: Record<string, string>;
    marketplaces: Record<string, ResourceSnapshotMarketplace>;
  };
};

export type DesktopCloudSyncChangeKind = "new" | "modified" | "removed";
export type DesktopCloudSyncResourceKind = "llmProvider" | "marketplace" | "plugin" | "configItem";

export type DesktopCloudSyncChange = {
  id: string;
  kind: DesktopCloudSyncChangeKind;
  resourceKind: DesktopCloudSyncResourceKind;
  marketplaceId?: string;
  pluginId?: string;
  previousLastUpdatedAt: string | null;
  nextLastUpdatedAt: string | null;
  queuedAt: number;
};

export type DesktopCloudSyncEntry = {
  contextKey: string;
  fetchedAt: number;
  organizationId: string;
  orgMemberId: string;
  pendingChanges: DesktopCloudSyncChange[];
  snapshot: ResourceSnapshot;
  teamIds: string[];
};

export type DesktopCloudSyncState = {
  entries: Record<string, DesktopCloudSyncEntry>;
  updatedAt: number;
  version: 1;
};

type CloudImportedProvider = {
  cloudProviderId: string;
  updatedAt: string | null;
};

type CloudImportedMarketplace = {
  marketplaceId: string;
  updatedAt: string | null;
};

type CloudImportedPluginFile = {
  configObjectId: string;
  updatedAt: string | null;
};

type CloudImportedPlugin = {
  pluginId: string;
  marketplaceId: string | null;
  updatedAt: string | null;
  files: CloudImportedPluginFile[];
};

type WorkspaceCloudImports = {
  providers: Record<string, CloudImportedProvider>;
  marketplaces: Record<string, CloudImportedMarketplace>;
  plugins: Record<string, CloudImportedPlugin>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function readTimestampRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const id = key.trim();
    const timestampValue = typeof entry === "string" ? entry.trim() : "";
    if (id && timestampValue) {
      record[id] = timestampValue;
    }
  }
  return record;
}

function readResourceSnapshotConfigItems(value: unknown): ResourceSnapshotConfigItem[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const configItemId = typeof entry.configItemId === "string" ? entry.configItemId.trim() : "";
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    return configItemId && lastUpdatedAt ? [{ configItemId, lastUpdatedAt }] : [];
  });
}

function readResourceSnapshotPlugins(value: unknown): ResourceSnapshotPlugin[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const pluginId = typeof entry.pluginId === "string" ? entry.pluginId.trim() : "";
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    if (!pluginId || !lastUpdatedAt) return [];

    return [{
      pluginId,
      lastUpdatedAt,
      configItems: readResourceSnapshotConfigItems(entry.configItems),
    }];
  });
}

function readResourceSnapshotMarketplaces(value: unknown): Record<string, ResourceSnapshotMarketplace> {
  if (!isRecord(value)) return {};

  const marketplaces: Record<string, ResourceSnapshotMarketplace> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const marketplaceId = key.trim();
    const lastUpdatedAt = typeof entry.lastUpdatedAt === "string" ? entry.lastUpdatedAt.trim() : "";
    if (!marketplaceId || !lastUpdatedAt) continue;
    marketplaces[marketplaceId] = {
      lastUpdatedAt,
      plugins: readResourceSnapshotPlugins(entry.plugins),
    };
  }
  return marketplaces;
}

export function normalizeResourceSnapshot(value: unknown): ResourceSnapshot | null {
  if (!isRecord(value)) return null;
  const organizationId = typeof value.organizationId === "string" ? value.organizationId.trim() : "";
  const orgMemberId = typeof value.orgMemberId === "string" ? value.orgMemberId.trim() : "";
  const resources = isRecord(value.resources) ? value.resources : null;
  if (!organizationId || !orgMemberId || !resources) return null;

  return {
    organizationId,
    orgMemberId,
    teamIds: readStringArray(value.teamIds),
    resources: {
      llmProviders: readTimestampRecord(resources.llmProviders),
      marketplaces: readResourceSnapshotMarketplaces(resources.marketplaces),
    },
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function readImportedProviders(value: unknown): Record<string, CloudImportedProvider> {
  if (!isRecord(value)) return {};

  const providers: Record<string, CloudImportedProvider> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const cloudProviderId = readString(entry.cloudProviderId) ?? key.trim();
    if (!cloudProviderId) continue;
    providers[cloudProviderId] = {
      cloudProviderId,
      updatedAt: readString(entry.updatedAt),
    };
  }
  return providers;
}

function readImportedMarketplaces(value: unknown): Record<string, CloudImportedMarketplace> {
  if (!isRecord(value)) return {};

  const marketplaces: Record<string, CloudImportedMarketplace> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const marketplaceId = readString(entry.marketplaceId) ?? key.trim();
    if (!marketplaceId) continue;
    marketplaces[marketplaceId] = {
      marketplaceId,
      updatedAt: readString(entry.updatedAt),
    };
  }
  return marketplaces;
}

function readImportedPluginFiles(value: unknown): CloudImportedPluginFile[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const configObjectId = readString(entry.configObjectId);
    if (!configObjectId) return [];
    return [{
      configObjectId,
      updatedAt: readString(entry.updatedAt),
    }];
  });
}

function readImportedPlugins(value: unknown): Record<string, CloudImportedPlugin> {
  if (!isRecord(value)) return {};

  const plugins: Record<string, CloudImportedPlugin> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const pluginId = readString(entry.pluginId) ?? key.trim();
    if (!pluginId) continue;
    plugins[pluginId] = {
      pluginId,
      marketplaceId: readString(entry.marketplaceId),
      updatedAt: readString(entry.updatedAt),
      files: readImportedPluginFiles(entry.files),
    };
  }
  return plugins;
}

function readWorkspaceCloudImports(openwork: Record<string, unknown>): WorkspaceCloudImports {
  const cloudImports = isRecord(openwork.cloudImports) ? openwork.cloudImports : {};
  return {
    providers: readImportedProviders(cloudImports.providers),
    marketplaces: readImportedMarketplaces(cloudImports.marketplaces),
    plugins: readImportedPlugins(cloudImports.plugins),
  };
}

function readChange(value: unknown): DesktopCloudSyncChange | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const kind = value.kind === "new" || value.kind === "modified" || value.kind === "removed"
    ? value.kind
    : null;
  const resourceKind = value.resourceKind === "llmProvider" ||
    value.resourceKind === "marketplace" ||
    value.resourceKind === "plugin" ||
    value.resourceKind === "configItem"
    ? value.resourceKind
    : null;
  const queuedAt = typeof value.queuedAt === "number" && Number.isFinite(value.queuedAt)
    ? value.queuedAt
    : Date.now();
  if (!id || !kind || !resourceKind) return null;

  return {
    id,
    kind,
    resourceKind,
    marketplaceId: readString(value.marketplaceId) ?? undefined,
    pluginId: readString(value.pluginId) ?? undefined,
    previousLastUpdatedAt: readString(value.previousLastUpdatedAt),
    nextLastUpdatedAt: readString(value.nextLastUpdatedAt),
    queuedAt,
  };
}

function readDesktopCloudSyncEntry(contextKey: string, value: unknown): DesktopCloudSyncEntry | null {
  if (!isRecord(value)) return null;
  const snapshot = normalizeResourceSnapshot(value.snapshot);
  if (!snapshot) return null;

  return {
    contextKey,
    fetchedAt: typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt) ? value.fetchedAt : 0,
    organizationId: readString(value.organizationId) ?? snapshot.organizationId,
    orgMemberId: readString(value.orgMemberId) ?? snapshot.orgMemberId,
    pendingChanges: Array.isArray(value.pendingChanges)
      ? value.pendingChanges.flatMap((entry) => {
          const change = readChange(entry);
          return change ? [change] : [];
        })
      : [],
    snapshot,
    teamIds: readStringArray(value.teamIds),
  };
}

export function readDesktopCloudSyncState(openwork: Record<string, unknown>): DesktopCloudSyncState {
  const raw = isRecord(openwork.desktopCloudSync) ? openwork.desktopCloudSync : {};
  const rawEntries = isRecord(raw.entries) ? raw.entries : {};
  const entries: Record<string, DesktopCloudSyncEntry> = {};
  for (const [key, entry] of Object.entries(rawEntries)) {
    const contextKey = key.trim();
    const parsed = contextKey ? readDesktopCloudSyncEntry(contextKey, entry) : null;
    if (parsed) entries[contextKey] = parsed;
  }

  return {
    entries,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    version: 1,
  };
}

function contextKey(snapshot: ResourceSnapshot): string {
  return [snapshot.organizationId, snapshot.orgMemberId].join("::");
}

function changeKey(change: Pick<DesktopCloudSyncChange, "id" | "marketplaceId" | "pluginId" | "resourceKind">) {
  return [change.resourceKind, change.marketplaceId ?? "", change.pluginId ?? "", change.id].join("::");
}

function mergePendingChanges(previous: DesktopCloudSyncChange[], next: DesktopCloudSyncChange[]) {
  if (next.length === 0) return previous;
  const nextKeys = new Set(next.map(changeKey));
  return [
    ...previous.filter((change) => !nextKeys.has(changeKey(change))),
    ...next,
  ];
}

function findRemotePlugin(snapshot: ResourceSnapshot, input: { marketplaceId?: string | null; pluginId: string }) {
  const preferredMarketplaceId = input.marketplaceId?.trim() ?? "";
  if (preferredMarketplaceId) {
    const marketplace = snapshot.resources.marketplaces[preferredMarketplaceId];
    const plugin = marketplace?.plugins.find((entry) => entry.pluginId === input.pluginId) ?? null;
    if (plugin) return { marketplaceId: preferredMarketplaceId, plugin };
  }

  for (const [marketplaceId, marketplace] of Object.entries(snapshot.resources.marketplaces)) {
    const plugin = marketplace.plugins.find((entry) => entry.pluginId === input.pluginId) ?? null;
    if (plugin) return { marketplaceId, plugin };
  }
  return null;
}

function queueInstalledChange(input: {
  changes: DesktopCloudSyncChange[];
  id: string;
  installedLastUpdatedAt: string | null;
  marketplaceId?: string;
  pluginId?: string;
  queuedAt: number;
  remoteLastUpdatedAt: string | null;
  resourceKind: DesktopCloudSyncResourceKind;
}) {
  if (!input.remoteLastUpdatedAt) {
    input.changes.push({
      id: input.id,
      kind: "removed",
      resourceKind: input.resourceKind,
      marketplaceId: input.marketplaceId,
      pluginId: input.pluginId,
      previousLastUpdatedAt: input.installedLastUpdatedAt,
      nextLastUpdatedAt: null,
      queuedAt: input.queuedAt,
    });
    return;
  }

  if (!input.installedLastUpdatedAt) {
    input.changes.push({
      id: input.id,
      kind: "new",
      resourceKind: input.resourceKind,
      marketplaceId: input.marketplaceId,
      pluginId: input.pluginId,
      previousLastUpdatedAt: null,
      nextLastUpdatedAt: input.remoteLastUpdatedAt,
      queuedAt: input.queuedAt,
    });
    return;
  }

  if (input.installedLastUpdatedAt !== input.remoteLastUpdatedAt) {
    input.changes.push({
      id: input.id,
      kind: "modified",
      resourceKind: input.resourceKind,
      marketplaceId: input.marketplaceId,
      pluginId: input.pluginId,
      previousLastUpdatedAt: input.installedLastUpdatedAt,
      nextLastUpdatedAt: input.remoteLastUpdatedAt,
      queuedAt: input.queuedAt,
    });
  }
}

function diffInstalledCloudResources(
  cloudImports: WorkspaceCloudImports,
  snapshot: ResourceSnapshot,
  queuedAt: number,
): DesktopCloudSyncChange[] {
  const changes: DesktopCloudSyncChange[] = [];

  for (const provider of Object.values(cloudImports.providers)) {
    queueInstalledChange({
      changes,
      id: provider.cloudProviderId,
      installedLastUpdatedAt: provider.updatedAt,
      queuedAt,
      remoteLastUpdatedAt: snapshot.resources.llmProviders[provider.cloudProviderId] ?? null,
      resourceKind: "llmProvider",
    });
  }

  for (const marketplace of Object.values(cloudImports.marketplaces)) {
    queueInstalledChange({
      changes,
      id: marketplace.marketplaceId,
      installedLastUpdatedAt: marketplace.updatedAt,
      queuedAt,
      remoteLastUpdatedAt: snapshot.resources.marketplaces[marketplace.marketplaceId]?.lastUpdatedAt ?? null,
      resourceKind: "marketplace",
    });
  }

  for (const plugin of Object.values(cloudImports.plugins)) {
    const remote = findRemotePlugin(snapshot, { marketplaceId: plugin.marketplaceId, pluginId: plugin.pluginId });
    queueInstalledChange({
      changes,
      id: plugin.pluginId,
      installedLastUpdatedAt: plugin.updatedAt,
      marketplaceId: remote?.marketplaceId ?? plugin.marketplaceId ?? undefined,
      queuedAt,
      remoteLastUpdatedAt: remote?.plugin.lastUpdatedAt ?? null,
      resourceKind: "plugin",
    });

    for (const file of plugin.files) {
      const remoteConfigItem = remote?.plugin.configItems.find((entry) => entry.configItemId === file.configObjectId) ?? null;
      queueInstalledChange({
        changes,
        id: file.configObjectId,
        installedLastUpdatedAt: file.updatedAt,
        marketplaceId: remote?.marketplaceId ?? plugin.marketplaceId ?? undefined,
        pluginId: plugin.pluginId,
        queuedAt,
        remoteLastUpdatedAt: remoteConfigItem?.lastUpdatedAt ?? null,
        resourceKind: "configItem",
      });
    }
  }

  return changes;
}

export function syncDesktopCloudResources(input: {
  now?: number;
  openwork: Record<string, unknown>;
  snapshot: ResourceSnapshot;
}) {
  const now = input.now ?? Date.now();
  const state = readDesktopCloudSyncState(input.openwork);
  const key = contextKey(input.snapshot);
  const previousEntry = state.entries[key] ?? null;
  const changes = diffInstalledCloudResources(readWorkspaceCloudImports(input.openwork), input.snapshot, now);
  const entry: DesktopCloudSyncEntry = {
    contextKey: key,
    fetchedAt: now,
    organizationId: input.snapshot.organizationId,
    orgMemberId: input.snapshot.orgMemberId,
    pendingChanges: mergePendingChanges(previousEntry?.pendingChanges ?? [], changes),
    snapshot: input.snapshot,
    teamIds: input.snapshot.teamIds,
  };
  const nextState: DesktopCloudSyncState = {
    entries: {
      ...state.entries,
      [key]: entry,
    },
    updatedAt: now,
    version: 1,
  };

  return {
    changes,
    openwork: {
      ...input.openwork,
      desktopCloudSync: nextState,
    },
    state: nextState,
  };
}
