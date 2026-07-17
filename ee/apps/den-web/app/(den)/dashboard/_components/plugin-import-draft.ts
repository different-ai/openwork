export type PluginImportAuthType = "oauth" | "none";
export type PluginImportCredentialMode = "per_member" | "shared";

export type PluginImportServer = {
  name: string;
  serverKey: string;
  url: string | null;
  supported: boolean;
  skippedReason: "missing_url" | "local_unsupported" | "invalid_url" | "unsupported_auth" | null;
};

export type PluginImportSkill = {
  description: string | null;
  name: string;
  skillKey: string;
  sourcePath: string;
  supported: boolean;
  skippedReason: "invalid_skill" | null;
};

export type PluginImportPreview = {
  repositoryFullName: string;
  rootPath: string;
  servers: PluginImportServer[];
  skills: PluginImportSkill[];
  warnings: string[];
};

export type PluginImportDraft = {
  version: 1;
  authType: PluginImportAuthType;
  credentialMode: PluginImportCredentialMode;
  githubUrl: string;
  preview: PluginImportPreview;
  selectedServerKeys: string[];
  selectedSkillKeys: string[];
};

const STORAGE_KEY = "openwork.plugin-import-draft.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function skippedServerReason(value: unknown): PluginImportServer["skippedReason"] {
  if (value === "missing_url" || value === "local_unsupported" || value === "invalid_url" || value === "unsupported_auth") {
    return value;
  }
  return null;
}

export function parsePluginImportPreview(payload: unknown): PluginImportPreview {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  if (!item) throw new Error("GitHub plugin import preview response was incomplete.");

  return {
    repositoryFullName: typeof item.repositoryFullName === "string" ? item.repositoryFullName : "",
    rootPath: typeof item.rootPath === "string" ? item.rootPath : "",
    servers: Array.isArray(item.servers)
      ? item.servers.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.name !== "string") return [];
          return [{
            name: entry.name,
            serverKey: typeof entry.serverKey === "string" ? entry.serverKey : `${entry.name}:${typeof entry.url === "string" ? entry.url : ""}`,
            url: typeof entry.url === "string" ? entry.url : null,
            supported: entry.supported === true,
            skippedReason: skippedServerReason(entry.skippedReason),
          }];
        })
      : [],
    skills: Array.isArray(item.skills)
      ? item.skills.flatMap((entry) => {
          if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.skillKey !== "string") return [];
          return [{
            description: typeof entry.description === "string" ? entry.description : null,
            name: entry.name,
            skillKey: entry.skillKey,
            sourcePath: typeof entry.sourcePath === "string" ? entry.sourcePath : "SKILL.md",
            supported: entry.supported === true,
            skippedReason: entry.skippedReason === "invalid_skill" ? "invalid_skill" : null,
          }];
        })
      : [],
    warnings: Array.isArray(item.warnings)
      ? item.warnings.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
  };
}

function parseStoredDraft(value: unknown): PluginImportDraft | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.githubUrl !== "string" || !isRecord(value.preview)) {
    return null;
  }
  if (value.authType !== "oauth" && value.authType !== "none") return null;
  if (value.credentialMode !== "per_member" && value.credentialMode !== "shared") return null;
  if (!Array.isArray(value.selectedServerKeys) || !value.selectedServerKeys.every((entry) => typeof entry === "string")) return null;
  if (!Array.isArray(value.selectedSkillKeys) || !value.selectedSkillKeys.every((entry) => typeof entry === "string")) return null;

  try {
    const preview = parsePluginImportPreview({ item: value.preview });
    return {
      version: 1,
      authType: value.authType,
      credentialMode: value.credentialMode,
      githubUrl: value.githubUrl,
      preview,
      selectedServerKeys: value.selectedServerKeys,
      selectedSkillKeys: value.selectedSkillKeys,
    };
  } catch {
    return null;
  }
}

export function loadPluginImportDraft(): PluginImportDraft | null {
  if (typeof window === "undefined") return null;
  const value = window.sessionStorage.getItem(STORAGE_KEY);
  if (!value) return null;
  try {
    return parseStoredDraft(JSON.parse(value));
  } catch {
    return null;
  }
}

export function savePluginImportDraft(draft: PluginImportDraft): void {
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

export function clearPluginImportDraft(): void {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(STORAGE_KEY);
}

export function pluginImportSourceLabel(preview: PluginImportPreview): string {
  return `${preview.repositoryFullName}${preview.rootPath ? `/${preview.rootPath}` : ""}`;
}

export function pluginImportSuggestedName(preview: PluginImportPreview): string {
  const source = preview.rootPath.split("/").filter(Boolean).at(-1)
    ?? preview.repositoryFullName.split("/").filter(Boolean).at(-1)
    ?? "Imported plugin";
  return source
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
