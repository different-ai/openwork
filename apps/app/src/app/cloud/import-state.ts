export type CloudImportedSkill = {
  cloudSkillId: string;
  installedName: string;
  title: string;
  description: string | null;
  shared: "org" | "public" | null;
  updatedAt: string | null;
  importedAt: number | null;
};

export type CloudImportedProvider = {
  cloudProviderId: string;
  providerId: string;
  sourceProviderId: string;
  name: string;
  source: string | null;
  updatedAt: string | null;
  modelIds: string[];
  importedAt: number | null;
};

export type CloudImportedMarketplace = {
  marketplaceId: string;
  name: string;
  updatedAt: string | null;
  pluginIds: string[];
  importedAt: number | null;
};

export type CloudImportedPluginFile = {
  configObjectId: string;
  versionId: string | null;
  objectType: string;
  title: string;
  path: string;
  updatedAt: string | null;
};

export type CloudImportedPlugin = {
  pluginId: string;
  marketplaceId: string | null;
  name: string;
  description: string | null;
  updatedAt: string | null;
  files: CloudImportedPluginFile[];
  importedAt: number | null;
};

export type WorkspaceCloudImports = {
  skills: Record<string, CloudImportedSkill>;
  providers: Record<string, CloudImportedProvider>;
  marketplaces: Record<string, CloudImportedMarketplace>;
  plugins: Record<string, CloudImportedPlugin>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

export function readWorkspaceCloudImports(value: unknown): WorkspaceCloudImports {
  const root = isRecord(value) ? value : {};
  const cloudImports = isRecord(root.cloudImports) ? root.cloudImports : {};
  const rawSkills = isRecord(cloudImports.skills) ? cloudImports.skills : {};
  const rawProviders = isRecord(cloudImports.providers) ? cloudImports.providers : {};
  const rawMarketplaces = isRecord(cloudImports.marketplaces) ? cloudImports.marketplaces : {};
  const rawPlugins = isRecord(cloudImports.plugins) ? cloudImports.plugins : {};

  const providers = Object.fromEntries(
    Object.entries(rawProviders).flatMap(([key, entry]) => {
      if (!isRecord(entry)) return [];
      const cloudProviderId = typeof entry.cloudProviderId === "string"
        ? entry.cloudProviderId.trim()
        : key.trim();
      const providerId = typeof entry.providerId === "string" ? entry.providerId.trim() : "";
      const sourceProviderId = typeof entry.sourceProviderId === "string"
        ? entry.sourceProviderId.trim()
        : providerId;
      const name = typeof entry.name === "string" ? entry.name.trim() : providerId || cloudProviderId;
      if (!cloudProviderId || !providerId || !sourceProviderId || !name) return [];
      const imported = {
        cloudProviderId,
        providerId,
        sourceProviderId,
        name,
        source: typeof entry.source === "string" ? entry.source.trim() || null : null,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt.trim() || null : null,
        modelIds: readStringArray(entry.modelIds),
        importedAt: typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : null,
      } satisfies CloudImportedProvider;
      return [[cloudProviderId, imported] as const];
    }),
  );

  const skills = Object.fromEntries(
    Object.entries(rawSkills).flatMap(([key, entry]) => {
      if (!isRecord(entry)) return [];
      const cloudSkillId = typeof entry.cloudSkillId === "string"
        ? entry.cloudSkillId.trim()
        : key.trim();
      const installedName = typeof entry.installedName === "string" ? entry.installedName.trim() : "";
      const title = typeof entry.title === "string" ? entry.title.trim() : installedName || cloudSkillId;
      if (!cloudSkillId || !installedName || !title) return [];
      const imported = {
        cloudSkillId,
        installedName,
        title,
        description: typeof entry.description === "string" ? entry.description.trim() || null : null,
        shared: entry.shared === "org" || entry.shared === "public" ? entry.shared : null,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt.trim() || null : null,
        importedAt: typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : null,
      } satisfies CloudImportedSkill;
      return [[cloudSkillId, imported] as const];
    }),
  );

  const marketplaces = Object.fromEntries(
    Object.entries(rawMarketplaces).flatMap(([key, entry]) => {
      if (!isRecord(entry)) return [];
      const marketplaceId = typeof entry.marketplaceId === "string"
        ? entry.marketplaceId.trim()
        : key.trim();
      const name = typeof entry.name === "string" ? entry.name.trim() : marketplaceId;
      if (!marketplaceId || !name) return [];
      const imported = {
        marketplaceId,
        name,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt.trim() || null : null,
        pluginIds: readStringArray(entry.pluginIds),
        importedAt: typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : null,
      } satisfies CloudImportedMarketplace;
      return [[marketplaceId, imported] as const];
    }),
  );

  const plugins = Object.fromEntries(
    Object.entries(rawPlugins).flatMap(([key, entry]) => {
      if (!isRecord(entry)) return [];
      const pluginId = typeof entry.pluginId === "string" ? entry.pluginId.trim() : key.trim();
      const name = typeof entry.name === "string" ? entry.name.trim() : pluginId;
      if (!pluginId || !name) return [];
      const files = Array.isArray(entry.files)
        ? entry.files.flatMap((file) => {
            if (!isRecord(file)) return [];
            const configObjectId = typeof file.configObjectId === "string" ? file.configObjectId.trim() : "";
            const objectType = typeof file.objectType === "string" ? file.objectType.trim() : "";
            const title = typeof file.title === "string" ? file.title.trim() : configObjectId;
            const path = typeof file.path === "string" ? file.path.trim() : "";
            if (!configObjectId || !objectType || !title || !path) return [];
            return [
              {
                configObjectId,
                versionId: typeof file.versionId === "string" ? file.versionId.trim() || null : null,
                objectType,
                title,
                path,
                updatedAt: typeof file.updatedAt === "string" ? file.updatedAt.trim() || null : null,
              } satisfies CloudImportedPluginFile,
            ];
          })
        : [];
      const imported = {
        pluginId,
        marketplaceId: typeof entry.marketplaceId === "string" ? entry.marketplaceId.trim() || null : null,
        name,
        description: typeof entry.description === "string" ? entry.description.trim() || null : null,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt.trim() || null : null,
        files,
        importedAt: typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : null,
      } satisfies CloudImportedPlugin;
      return [[pluginId, imported] as const];
    }),
  );

  return { skills, providers, marketplaces, plugins };
}

export function withWorkspaceCloudImports(
  config: Record<string, unknown>,
  cloudImports: WorkspaceCloudImports,
) {
  return {
    ...config,
    cloudImports: {
      skills: cloudImports.skills,
      providers: cloudImports.providers,
      marketplaces: cloudImports.marketplaces,
      plugins: cloudImports.plugins,
    },
  };
}
