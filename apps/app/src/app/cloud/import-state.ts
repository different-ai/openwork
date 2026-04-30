export type CloudImportedSkillHub = {
  hubId: string;
  name: string;
  skillNames: string[];
  skillIds: string[];
  importedAt: number | null;
};

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
  skillHubs: Record<string, CloudImportedSkillHub>;
  skills: Record<string, CloudImportedSkill>;
  providers: Record<string, CloudImportedProvider>;
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
  const rawSkillHubs = isRecord(cloudImports.skillHubs) ? cloudImports.skillHubs : {};
  const rawSkills = isRecord(cloudImports.skills) ? cloudImports.skills : {};
  const rawProviders = isRecord(cloudImports.providers) ? cloudImports.providers : {};
  const rawPlugins = isRecord(cloudImports.plugins) ? cloudImports.plugins : {};

  const skillHubs = Object.fromEntries(
    Object.entries(rawSkillHubs)
      .map(([key, entry]) => {
        if (!isRecord(entry)) return null;
        const hubId = typeof entry.hubId === "string" ? entry.hubId.trim() : key.trim();
        const name = typeof entry.name === "string" ? entry.name.trim() : hubId;
        if (!hubId || !name) return null;
        const imported = {
          hubId,
          name,
          skillNames: readStringArray(entry.skillNames),
          skillIds: readStringArray(entry.skillIds),
          importedAt: typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
            ? entry.importedAt
            : null,
        } satisfies CloudImportedSkillHub;
        return [hubId, imported] as const;
      })
      .filter((entry): entry is readonly [string, CloudImportedSkillHub] => Boolean(entry)),
  );

  const providers = Object.fromEntries(
    Object.entries(rawProviders)
      .map(([key, entry]) => {
        if (!isRecord(entry)) return null;
        const cloudProviderId = typeof entry.cloudProviderId === "string"
          ? entry.cloudProviderId.trim()
          : key.trim();
        const providerId = typeof entry.providerId === "string" ? entry.providerId.trim() : "";
        const sourceProviderId = typeof entry.sourceProviderId === "string"
          ? entry.sourceProviderId.trim()
          : providerId;
        const name = typeof entry.name === "string" ? entry.name.trim() : providerId || cloudProviderId;
        if (!cloudProviderId || !providerId || !sourceProviderId || !name) return null;
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
        return [cloudProviderId, imported] as const;
      })
      .filter((entry): entry is readonly [string, CloudImportedProvider] => Boolean(entry)),
  );

  const skills = Object.fromEntries(
    Object.entries(rawSkills)
      .map(([key, entry]) => {
        if (!isRecord(entry)) return null;
        const cloudSkillId = typeof entry.cloudSkillId === "string"
          ? entry.cloudSkillId.trim()
          : key.trim();
        const installedName = typeof entry.installedName === "string" ? entry.installedName.trim() : "";
        const title = typeof entry.title === "string" ? entry.title.trim() : installedName || cloudSkillId;
        if (!cloudSkillId || !installedName || !title) return null;
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
        return [cloudSkillId, imported] as const;
      })
      .filter((entry): entry is readonly [string, CloudImportedSkill] => Boolean(entry)),
  );

  const plugins = Object.fromEntries(
    Object.entries(rawPlugins)
      .map(([key, entry]) => {
        if (!isRecord(entry)) return null;
        const pluginId = typeof entry.pluginId === "string" ? entry.pluginId.trim() : key.trim();
        const name = typeof entry.name === "string" ? entry.name.trim() : pluginId;
        if (!pluginId || !name) return null;
        const files = Array.isArray(entry.files)
          ? entry.files
              .map((file): CloudImportedPluginFile | null => {
                if (!isRecord(file)) return null;
                const configObjectId = typeof file.configObjectId === "string" ? file.configObjectId.trim() : "";
                const objectType = typeof file.objectType === "string" ? file.objectType.trim() : "";
                const title = typeof file.title === "string" ? file.title.trim() : configObjectId;
                const path = typeof file.path === "string" ? file.path.trim() : "";
                if (!configObjectId || !objectType || !title || !path) return null;
                return {
                  configObjectId,
                  versionId: typeof file.versionId === "string" ? file.versionId.trim() || null : null,
                  objectType,
                  title,
                  path,
                  updatedAt: typeof file.updatedAt === "string" ? file.updatedAt.trim() || null : null,
                };
              })
              .filter((file): file is CloudImportedPluginFile => file !== null)
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
        return [pluginId, imported] as const;
      })
      .filter((entry): entry is readonly [string, CloudImportedPlugin] => Boolean(entry)),
  );

  return { skillHubs, skills, providers, plugins };
}

export function withWorkspaceCloudImports(
  config: Record<string, unknown>,
  cloudImports: WorkspaceCloudImports,
) {
  return {
    ...config,
    cloudImports: {
      skillHubs: cloudImports.skillHubs,
      skills: cloudImports.skills,
      providers: cloudImports.providers,
      plugins: cloudImports.plugins,
    },
  };
}
