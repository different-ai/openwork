export type LabWorkspaceSummary = {
  id: string;
  name: string;
  displayName?: string | null;
  baseUrl?: string | null;
  path?: string | null;
  directory?: string | null;
  workspaceType?: string | null;
  remoteType?: string | null;
  opencode?: {
    baseUrl?: string | null;
    directory?: string | null;
    username?: string | null;
    password?: string | null;
  } | null;
};

export type LabStoredConnection = {
  baseUrl: string;
  token?: string;
  hostToken?: string;
  workspaceId: string;
  connectedAt: number;
};

export type LabStatusSnapshot = {
  ok: boolean;
  version?: string;
  readOnly?: boolean;
  approval?: { mode?: "manual" | "auto" | string; timeoutMs?: number };
  workspace?: LabWorkspaceSummary | null;
  selectedWorkspaceId?: string | null;
  activeWorkspaceId?: string | null;
  authorizedRoots?: string[];
  server?: { host?: string; port?: number; configPath?: string | null };
};

export type LabCapabilities = {
  config?: { read?: boolean; write?: boolean };
  proxy?: { opencode?: boolean; opencodeRouter?: boolean };
  skills?: { read?: boolean; write?: boolean };
  plugins?: { read?: boolean; write?: boolean };
  mcp?: { read?: boolean; write?: boolean };
  commands?: { read?: boolean; write?: boolean };
  toolProviders?: {
    files?: {
      injection?: boolean;
      outbox?: boolean;
      inboxPath?: string;
      outboxPath?: string;
      maxBytes?: number;
    };
  };
};

export type LabConfigSnapshot = {
  opencode: Record<string, unknown>;
  openwork: Record<string, unknown>;
  updatedAt?: number | null;
};

export type LabConnectionStateResponse = {
  connected: boolean;
  saved: boolean;
  connection?: {
    baseUrl: string;
    workspaceId: string;
    token?: string;
    hostToken?: string;
    hasToken: boolean;
    hasHostToken: boolean;
  };
  status?: LabStatusSnapshot | null;
  capabilities?: LabCapabilities | null;
  workspaces?: LabWorkspaceSummary[];
  selectedWorkspace?: LabWorkspaceSummary | null;
  error?: string | null;
};

export const LAB_CONNECTION_COOKIE = "openwork-lab-connection";

export function normalizeOpenworkServerUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

export function parseOpenworkWorkspaceIdFromUrl(input: string) {
  const normalized = normalizeOpenworkServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    if (prev !== "w" || !last) return null;
    return decodeURIComponent(last);
  } catch {
    const match = normalized.match(/\/w\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
}

export function stripWorkspaceMount(input: string) {
  const normalized = normalizeOpenworkServerUrl(input) ?? "";
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    const prev = segments[segments.length - 2] ?? "";
    if (prev === "w" && last) {
      url.pathname = segments.slice(0, -2).length
        ? `/${segments.slice(0, -2).join("/")}`
        : "";
    }
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return normalized.replace(/\/w\/[^/?#]+$/, "").replace(/\/+$/, "");
  }
}

export function buildWorkspaceScopedBaseUrl(baseUrl: string, workspaceId?: string | null) {
  const normalized = normalizeOpenworkServerUrl(baseUrl) ?? "";
  if (!normalized) return null;
  const existing = parseOpenworkWorkspaceIdFromUrl(normalized);
  if (existing) return normalized;
  const id = (workspaceId ?? "").trim();
  if (!id) return normalized;

  try {
    const url = new URL(normalized);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/w/${encodeURIComponent(id)}`;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return `${normalized}/w/${encodeURIComponent(id)}`;
  }
}

export function workspaceLabel(workspace: LabWorkspaceSummary | null | undefined) {
  const primary = workspace?.displayName?.trim() || workspace?.name?.trim();
  if (primary) return primary;
  const path = workspace?.path?.trim() || workspace?.directory?.trim();
  if (!path) return "Workspace";
  const pieces = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return pieces[pieces.length - 1] || path;
}

export function ensureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function normalizeAuthorizedFolderPath(input: string | null | undefined) {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/[\\/]\*+$/, "").replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

export function externalDirectoryKeyToAuthorizedFolder(key: string, value: unknown) {
  if (value !== "allow") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed === "/*") return "/";
  if (!trimmed.endsWith("/*")) return null;
  return normalizeAuthorizedFolderPath(trimmed.slice(0, -2));
}

export function authorizedFolderToExternalDirectoryKey(folder: string) {
  const normalized = normalizeAuthorizedFolderPath(folder);
  if (!normalized) return "";
  return normalized === "/" ? "/*" : `${normalized}/*`;
}

export function readAuthorizedFoldersFromConfig(opencodeConfig: Record<string, unknown>) {
  const permission = ensureRecord(opencodeConfig.permission);
  const externalDirectory = ensureRecord(permission.external_directory);
  const folders: string[] = [];
  const hiddenEntries: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(externalDirectory)) {
    const folder = externalDirectoryKeyToAuthorizedFolder(key, value);
    if (!folder) {
      hiddenEntries[key] = value;
      continue;
    }
    if (seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }

  return { folders, hiddenEntries };
}

export function mergeAuthorizedFoldersIntoExternalDirectory(
  folders: string[],
  hiddenEntries: Record<string, unknown>,
) {
  const next: Record<string, unknown> = { ...hiddenEntries };
  for (const folder of folders) {
    const key = authorizedFolderToExternalDirectoryKey(folder);
    if (!key) continue;
    next[key] = "allow";
  }
  return next;
}
