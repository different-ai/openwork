export type CloudImportedSkillHub = {
  hubId: string;
  name: string;
  skillNames: string[];
  skillIds: string[];
  importedAt: number | null;
};

export type CloudImportedProvider = {
  cloudProviderId: string;
  providerId: string;
  name: string;
  source: string | null;
  updatedAt: string | null;
  modelIds: string[];
  importedAt: number | null;
};

export type WorkspaceCloudImports = {
  skillHubs: Record<string, CloudImportedSkillHub>;
  providers: Record<string, CloudImportedProvider>;
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
  const rawProviders = isRecord(cloudImports.providers) ? cloudImports.providers : {};

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
        const name = typeof entry.name === "string" ? entry.name.trim() : providerId || cloudProviderId;
        if (!cloudProviderId || !providerId || !name) return null;
        const imported = {
          cloudProviderId,
          providerId,
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

  return { skillHubs, providers };
}

export function withWorkspaceCloudImports(
  config: Record<string, unknown>,
  cloudImports: WorkspaceCloudImports,
) {
  return {
    ...config,
    cloudImports: {
      skillHubs: cloudImports.skillHubs,
      providers: cloudImports.providers,
    },
  };
}
