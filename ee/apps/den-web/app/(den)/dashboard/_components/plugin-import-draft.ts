export type PluginImportAuthType = "oauth" | "none";
export type PluginImportCredentialMode = "per_member" | "shared";

export type PluginImportServer = {
  name: string;
  serverKey: string;
  url: string | null;
  supported: boolean;
  skippedReason: "headers_unsupported" | "invalid_config" | "invalid_url" | "local_unsupported" | "missing_url" | "unsupported_auth" | null;
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
const CREDENTIAL_QUERY_KEYS = new Set([
  "accesstoken",
  "apikey",
  "credential",
  "credentials",
  "password",
  "passwd",
  "secret",
  "token",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function skippedServerReason(value: unknown): PluginImportServer["skippedReason"] {
  if (value === "headers_unsupported" || value === "invalid_config" || value === "invalid_url" || value === "local_unsupported" || value === "missing_url" || value === "unsupported_auth") {
    return value;
  }
  return null;
}

function storedImportOptions(value: Record<string, unknown>): Pick<PluginImportDraft, "authType" | "credentialMode"> | null {
  const authType = value.serverMode === undefined
    ? (value.authType === undefined ? "oauth" : value.authType)
    : value.serverMode === "oauth"
      ? "oauth"
      : value.serverMode === "none"
        ? "none"
        : null;
  const credentialMode = value.accountScope === undefined
    ? (value.credentialMode === undefined ? "per_member" : value.credentialMode)
    : value.accountScope === "shared"
      ? "shared"
      : value.accountScope === "member"
        ? "per_member"
        : null;
  if ((authType !== "oauth" && authType !== "none") || (credentialMode !== "per_member" && credentialMode !== "shared")) {
    return null;
  }
  return { authType, credentialMode };
}

function hasCredentialQuery(url: URL): boolean {
  return Array.from(url.searchParams.keys()).some((key) =>
    CREDENTIAL_QUERY_KEYS.has(key.toLowerCase().replaceAll("-", "").replaceAll("_", "")),
  );
}

export function normalizePublicGitHubPluginUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid public GitHub plugin URL.");
  }
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com")) {
    throw new Error("Plugin imports must use an HTTPS github.com URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("GitHub plugin URLs cannot include credentials, query parameters, or fragments.");
  }
  return url.toString();
}

function validateSelectedServerUrl(server: PluginImportServer): void {
  if (!server.url) throw new Error(`The selected MCP server "${server.name}" does not have a remote URL.`);
  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error(`The selected MCP server "${server.name}" has an invalid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`The selected MCP server "${server.name}" must use HTTPS.`);
  }
  if (url.username || url.password || url.hash || hasCredentialQuery(url)) {
    throw new Error(`The selected MCP server "${server.name}" URL cannot contain credentials or a fragment.`);
  }
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
  // Current drafts store only allowlisted, non-sensitive option labels. Older
  // version-one drafts used the internal field names or omitted the options.
  const options = storedImportOptions(value);
  if (!options) return null;
  if (!Array.isArray(value.selectedServerKeys) || !value.selectedServerKeys.every((entry) => typeof entry === "string")) return null;
  if (!Array.isArray(value.selectedSkillKeys) || !value.selectedSkillKeys.every((entry) => typeof entry === "string")) return null;

  try {
    const preview = parsePluginImportPreview({ item: value.preview });
    const githubUrl = normalizePublicGitHubPluginUrl(value.githubUrl);
    if (preview.servers.some((server) => server.url !== null)) return null;
    return {
      version: 1,
      authType: options.authType,
      credentialMode: options.credentialMode,
      githubUrl,
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
    const draft = parseStoredDraft(JSON.parse(value));
    if (!draft) window.sessionStorage.removeItem(STORAGE_KEY);
    return draft;
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function minimizePluginImportDraft(draft: PluginImportDraft): PluginImportDraft {
  const githubUrl = normalizePublicGitHubPluginUrl(draft.githubUrl);
  const selectedServerKeys = [...new Set(draft.selectedServerKeys)];
  const selectedSkillKeys = [...new Set(draft.selectedSkillKeys)];
  const selectedServers = draft.preview.servers.filter((server) => selectedServerKeys.includes(server.serverKey));
  const selectedSkills = draft.preview.skills.filter((skill) => selectedSkillKeys.includes(skill.skillKey));

  if (selectedServers.length !== selectedServerKeys.length || selectedServers.some((server) => !server.supported)) {
    throw new Error("The selected MCP servers no longer match this plugin preview.");
  }
  if (selectedSkills.length !== selectedSkillKeys.length || selectedSkills.some((skill) => !skill.supported)) {
    throw new Error("The selected skills no longer match this plugin preview.");
  }
  selectedServers.forEach(validateSelectedServerUrl);

  return {
    version: 1,
    authType: draft.authType,
    credentialMode: draft.credentialMode,
    githubUrl,
    preview: {
      repositoryFullName: draft.preview.repositoryFullName,
      rootPath: draft.preview.rootPath,
      servers: selectedServers.map((server) => ({ ...server, url: null })),
      skills: selectedSkills.map((skill) => ({
        ...skill,
        description: null,
        sourcePath: "SKILL.md",
      })),
      warnings: [],
    },
    selectedServerKeys,
    selectedSkillKeys,
  };
}

export function savePluginImportDraft(draft: PluginImportDraft): void {
  const minimized = minimizePluginImportDraft(draft);
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: minimized.version,
    serverMode: minimized.authType === "none" ? "none" : "oauth",
    accountScope: minimized.credentialMode === "shared" ? "shared" : "member",
    githubUrl: minimized.githubUrl,
    preview: minimized.preview,
    selectedServerKeys: minimized.selectedServerKeys,
    selectedSkillKeys: minimized.selectedSkillKeys,
  }));
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
