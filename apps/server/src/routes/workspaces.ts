import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { inheritWorkspaceOpencodeConnection, resolveWorkspaceOpencodeConnection } from "../opencode-connection.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ensureDir, exists, shortId } from "../utils.js";
import { ensureWorkspaceFiles } from "../workspace-init.js";
import { workspaceIdForPath, workspaceIdForRemote } from "../workspaces.js";
import { addRoute, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type ParseOptionalBoolean = (value: string | null, name: string) => boolean | undefined;

interface RegisterWorkspaceRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  onWorkspacesChanged: () => void;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  readOptionalJsonBody: ReadJsonBody;
  parseOptionalBoolean: ParseOptionalBoolean;
  ensureWritable: (config: ServerConfig) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  serializeWorkspace: (workspace: ServerConfig["workspaces"][number]) => unknown;
  reloadOpencodeEngine: (config: ServerConfig, workspace: WorkspaceInfo) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function normalizeRemoteDirectory(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function parseOpenworkWorkspaceIdFromUrl(input: string | null | undefined): string | null {
  const raw = input?.trim() ?? "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    return mountIndex >= 0 && segments[mountIndex + 1]
      ? decodeURIComponent(segments[mountIndex + 1])
      : null;
  } catch {
    const match = raw.match(/\/(?:workspace|w)\/([^/?#]+)/);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
}

function stripOpenworkWorkspaceMount(input: string | null | undefined): string | null {
  const raw = input?.trim() ?? "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = prefix ? `/${prefix}` : "/";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/(?:workspace|w)\/[^/?#]+.*$/, "").replace(/\/+$/, "") || raw;
  }
}

function openworkRemoteWorkspaceId(hostUrl: string, workspaceId: string | null | undefined): string {
  const remoteWorkspaceId = workspaceId?.trim() || parseOpenworkWorkspaceIdFromUrl(hostUrl);
  return remoteWorkspaceId ? `rem_${remoteWorkspaceId}` : workspaceIdForRemote(hostUrl, null);
}

function workspaceDirectoryCandidates(workspace: Record<string, unknown>): string[] {
  const opencode = isRecord(workspace.opencode) ? workspace.opencode : {};
  return [workspace.directory, workspace.path, opencode.directory]
    .map(normalizeRemoteDirectory)
    .filter(Boolean);
}

function selectOpenworkWorkspaceForConnection(list: unknown, directory: string | null): Record<string, unknown> | null {
  if (!isRecord(list)) return null;
  const rawItems = Array.isArray(list.items)
    ? list.items
    : Array.isArray(list.workspaces)
      ? list.workspaces
      : [];
  const items = rawItems.filter(isRecord);
  if (!items.length) return null;

  const expectedDirectory = normalizeRemoteDirectory(directory);
  if (expectedDirectory) {
    return items.find((item) => workspaceDirectoryCandidates(item).includes(expectedDirectory)) ?? null;
  }

  const activeId = readStringField(list, "activeId");
  return (activeId ? items.find((item) => readStringField(item, "id") === activeId) : null) ?? items[0] ?? null;
}

function openworkWorkspaceDisplayName(workspace: Record<string, unknown>): string | null {
  return readStringField(workspace, "displayName")
    || readStringField(workspace, "openworkWorkspaceName")
    || readStringField(workspace, "name")
    || readStringField(workspace, "id")
    || null;
}

async function fetchOpenworkWorkspaceList(hostUrl: string, token: string, hostToken: string): Promise<unknown> {
  const url = `${hostUrl.replace(/\/+$/, "")}/workspaces`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (hostToken) headers.set("X-OpenWork-Host-Token", hostToken);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new ApiError(
        502,
        "openwork_workspace_discovery_failed",
        `OpenWork workspace discovery failed (${response.status} ${response.statusText || "HTTP error"})`,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "openwork_workspace_discovery_failed", "OpenWork workspace discovery failed", {
      error: String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverOpenworkWorkspace(input: {
  hostUrl: string;
  token: string;
  hostToken: string;
  directory: string | null;
}): Promise<Record<string, unknown> | null> {
  const list = await fetchOpenworkWorkspaceList(input.hostUrl, input.token, input.hostToken);
  return selectOpenworkWorkspaceForConnection(list, input.directory);
}

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return value;
}

async function readServerConfigFile(configPath: string): Promise<Record<string, unknown>> {
  if (!(await exists(configPath))) {
    return {};
  }

  try {
    const raw = await readFile(configPath, "utf8");
    return ensurePlainObject(JSON.parse(raw));
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse server config", {
      path: configPath,
      error: String(error),
    });
  }
}

function serializeWorkspaceConfigEntry(workspace: WorkspaceInfo): Record<string, unknown> {
  const isLocalWorkspace = workspace.workspaceType !== "remote";
  return {
    id: workspace.id,
    path: workspace.path,
    name: workspace.name,
    preset: workspace.preset,
    workspaceType: workspace.workspaceType,
    ...(workspace.remoteType ? { remoteType: workspace.remoteType } : {}),
    ...(!isLocalWorkspace && workspace.baseUrl ? { baseUrl: workspace.baseUrl } : {}),
    ...(!isLocalWorkspace && workspace.directory ? { directory: workspace.directory } : {}),
    ...(workspace.displayName ? { displayName: workspace.displayName } : {}),
    ...(workspace.openworkHostUrl ? { openworkHostUrl: workspace.openworkHostUrl } : {}),
    ...(workspace.openworkToken ? { openworkToken: workspace.openworkToken } : {}),
    ...(workspace.openworkWorkspaceId ? { openworkWorkspaceId: workspace.openworkWorkspaceId } : {}),
    ...(workspace.openworkWorkspaceName ? { openworkWorkspaceName: workspace.openworkWorkspaceName } : {}),
    ...(workspace.sandboxBackend ? { sandboxBackend: workspace.sandboxBackend } : {}),
    ...(workspace.sandboxRunId ? { sandboxRunId: workspace.sandboxRunId } : {}),
    ...(workspace.sandboxContainerName ? { sandboxContainerName: workspace.sandboxContainerName } : {}),
    ...(!isLocalWorkspace && workspace.opencodeUsername ? { opencodeUsername: workspace.opencodeUsername } : {}),
    ...(!isLocalWorkspace && workspace.opencodePassword ? { opencodePassword: workspace.opencodePassword } : {}),
  };
}

async function persistServerWorkspaceState(config: ServerConfig): Promise<boolean> {
  const configPath = config.configPath?.trim() ?? "";
  if (!configPath) return false;

  const parsed = await readServerConfigFile(configPath);
  const next = {
    ...parsed,
    workspaces: config.workspaces.map(serializeWorkspaceConfigEntry),
    authorizedRoots: Array.from(new Set(config.authorizedRoots.map((root) => resolve(root)))),
  };

  await ensureDir(dirname(configPath));
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
    return true;
  } finally {
    try {
      await rm(tmpPath);
    } catch {
      // ignore
    }
  }
}

export function registerWorkspaceRoutes(options: RegisterWorkspaceRoutesOptions): void {
  const {
    routes,
    config,
    onWorkspacesChanged,
    jsonResponse,
    readJsonBody,
    readOptionalJsonBody,
    parseOptionalBoolean,
    ensureWritable,
    resolveWorkspace,
    serializeWorkspace,
    reloadOpencodeEngine,
  } = options;

  const resolveWorkspaceForRegistry = async (id: string): Promise<WorkspaceInfo> => {
    const workspaceId = id.trim();
    const aliasWorkspaceId = workspaceId.startsWith("rem_") ? workspaceId.slice("rem_".length) : "";
    const workspace =
      config.workspaces.find((entry) => entry.id === workspaceId) ??
      (aliasWorkspaceId ? config.workspaces.find((entry) => entry.id === aliasWorkspaceId) : undefined);
    if (!workspace) {
      throw new ApiError(404, "workspace_not_found", "Workspace not found");
    }
    if (workspace.workspaceType === "remote") {
      return { ...workspace, path: workspace.path?.trim() ?? "" };
    }
    return resolveWorkspace(config, id);
  };

  addRoute(routes, "POST", "/workspaces/local", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const folderPath = typeof body.folderPath === "string" ? body.folderPath.trim() : "";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : basename(folderPath || "Workspace");
    const preset = typeof body.preset === "string" && body.preset.trim() ? body.preset.trim() : "starter";

    if (!folderPath) {
      throw new ApiError(400, "invalid_payload", "folderPath is required");
    }

    const workspacePath = resolve(folderPath);
    await ensureDir(workspacePath);
    await ensureWorkspaceFiles(workspacePath, preset);

    const workspace: WorkspaceInfo = {
      id: workspaceIdForPath(workspacePath),
      name,
      path: workspacePath,
      preset,
      workspaceType: "local",
      ...inheritWorkspaceOpencodeConnection(config),
    };

    config.workspaces = [workspace, ...config.workspaces.filter((entry) => entry.id !== workspace.id)];
    if (!config.authorizedRoots.some((root) => resolve(root) === workspacePath)) {
      config.authorizedRoots = [...config.authorizedRoots, workspacePath];
    }
    const persisted = await persistServerWorkspaceState(config);
    onWorkspacesChanged();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.create",
      target: workspace.path,
      summary: `Created workspace ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      activeId: workspace.id,
      workspaces: config.workspaces.map(serializeWorkspace),
      persisted,
    }, 201);
  });

  addRoute(routes, "POST", "/workspaces/remote", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const baseUrl = readStringField(body, "baseUrl");
    if (!baseUrl) {
      throw new ApiError(400, "invalid_payload", "baseUrl is required");
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new ApiError(400, "invalid_payload", "baseUrl must start with http:// or https://");
    }

    const remoteType = readStringField(body, "remoteType") === "opencode" ? "opencode" : "openwork";
    const directory = readStringField(body, "directory") || null;
    const displayName = readStringField(body, "displayName") || null;
    const rawOpenworkHostUrl = readStringField(body, "openworkHostUrl") || null;
    const openworkHostUrl = remoteType === "openwork"
      ? stripOpenworkWorkspaceMount(rawOpenworkHostUrl ?? baseUrl)
      : rawOpenworkHostUrl;
    const openworkToken = readStringField(body, "openworkToken");
    const openworkHostToken = readStringField(body, "openworkHostToken");
    const sandboxBackend = readStringField(body, "sandboxBackend");
    const sandboxRunId = readStringField(body, "sandboxRunId");
    const sandboxContainerName = readStringField(body, "sandboxContainerName");
    let openworkWorkspaceId = remoteType === "openwork"
      ? readStringField(body, "openworkWorkspaceId")
        || parseOpenworkWorkspaceIdFromUrl(rawOpenworkHostUrl)
        || parseOpenworkWorkspaceIdFromUrl(baseUrl)
      : "";
    let openworkWorkspaceName = readStringField(body, "openworkWorkspaceName") || null;

    if (remoteType === "openwork" && !openworkWorkspaceId) {
      const discovered = await discoverOpenworkWorkspace({
        hostUrl: openworkHostUrl ?? baseUrl,
        token: openworkToken,
        hostToken: openworkHostToken,
        directory,
      });
      openworkWorkspaceId = discovered ? readStringField(discovered, "id") : "";
      openworkWorkspaceName = discovered ? openworkWorkspaceDisplayName(discovered) : openworkWorkspaceName;
      if (!openworkWorkspaceId) {
        throw new ApiError(
          400,
          "openwork_workspace_not_found",
          directory
            ? `OpenWork server has no workspace matching ${directory}.`
            : "OpenWork server returned no workspaces.",
        );
      }
    }

    const workspace: WorkspaceInfo = {
      id: remoteType === "openwork"
        ? openworkRemoteWorkspaceId(openworkHostUrl ?? baseUrl, openworkWorkspaceId)
        : workspaceIdForRemote(baseUrl, directory),
      name: displayName ?? openworkWorkspaceName ?? "Remote workspace",
      path: directory ?? "",
      preset: "remote",
      workspaceType: "remote",
      remoteType,
      baseUrl: remoteType === "openwork" ? (openworkHostUrl ?? baseUrl) : baseUrl,
      ...(directory ? { directory } : {}),
      ...(displayName ? { displayName } : {}),
      ...(remoteType === "openwork" && openworkHostUrl ? { openworkHostUrl } : {}),
      ...(openworkToken ? { openworkToken } : {}),
      ...(remoteType === "openwork" && openworkWorkspaceId ? { openworkWorkspaceId } : {}),
      ...(remoteType === "openwork" && openworkWorkspaceName ? { openworkWorkspaceName } : {}),
      ...(sandboxBackend ? { sandboxBackend } : {}),
      ...(sandboxRunId ? { sandboxRunId } : {}),
      ...(sandboxContainerName ? { sandboxContainerName } : {}),
    };

    config.workspaces = [workspace, ...config.workspaces.filter((entry) => entry.id !== workspace.id)];
    const persisted = await persistServerWorkspaceState(config);
    onWorkspacesChanged();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.create",
      target: workspace.path || workspace.baseUrl || "workspace",
      summary: `Created remote workspace ${workspace.name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      activeId: workspace.id,
      workspaces: config.workspaces.map(serializeWorkspace),
      persisted,
    }, 201);
  });

  addRoute(routes, "PATCH", "/workspaces/:id/display-name", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspaceForRegistry(ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const nextDisplayName = typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim()
      : undefined;

    config.workspaces = config.workspaces.map((entry) =>
      entry.id === workspace.id
        ? {
            ...entry,
            displayName: nextDisplayName,
            name: nextDisplayName ?? entry.name,
          }
        : entry,
    );

    const persisted = await persistServerWorkspaceState(config);
    onWorkspacesChanged();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.rename",
      target: workspace.path || workspace.baseUrl || "workspace",
      summary: `Updated workspace display name${nextDisplayName ? ` to ${nextDisplayName}` : ""}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      activeId: config.workspaces[0]?.id ?? null,
      workspaces: config.workspaces.map(serializeWorkspace),
      persisted,
    });
  });

  addRoute(routes, "POST", "/workspaces/:id/activate", "host", async (ctx) => {
    const workspace = await resolveWorkspaceForRegistry(ctx.params.id);
    const queryPersist = parseOptionalBoolean(ctx.url.searchParams.get("persist"), "persist");
    const body = queryPersist === undefined ? await readOptionalJsonBody(ctx.request) : {};
    const persist = queryPersist ?? (body.persist === true);
    if (persist) ensureWritable(config);
    config.workspaces = [
      workspace,
      ...config.workspaces.filter((entry) => entry.id !== workspace.id),
    ];
    const persisted = persist ? await persistServerWorkspaceState(config) : false;
    if (persist) onWorkspacesChanged();
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.activate",
      target: "workspace",
      summary: "Switched active workspace",
      timestamp: Date.now(),
    });
    if (workspace.workspaceType === "local" && resolveWorkspaceOpencodeConnection(config, workspace).baseUrl?.trim()) {
      await reloadOpencodeEngine(config, workspace);
    }
    return jsonResponse({ activeId: workspace.id, workspace: serializeWorkspace(workspace), persisted });
  });

  addRoute(routes, "DELETE", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(config);

    const workspace = await resolveWorkspaceForRegistry(ctx.params.id);

    const before = config.workspaces.length;
    config.workspaces = config.workspaces.filter((entry) => entry.id !== workspace.id);
    const deleted = before !== config.workspaces.length;

    if (deleted && workspace.workspaceType === "local") {
      // Only remove exact matches; authorizedRoots can contain broader entries.
      config.authorizedRoots = config.authorizedRoots.filter((root) => resolve(root) !== resolve(workspace.path));
    }
    const persisted = await persistServerWorkspaceState(config);
    onWorkspacesChanged();

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.delete",
      target: "workspace",
      summary: "Deleted workspace from OpenWork server",
      timestamp: Date.now(),
    });

    const active = config.workspaces[0] ?? null;
    return jsonResponse({
      ok: true,
      deleted,
      persisted,
      activeId: active?.id ?? null,
      items: config.workspaces.map(serializeWorkspace),
      workspaces: config.workspaces.map(serializeWorkspace),
    });
  });
}
