import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import { inheritWorkspaceOpencodeConnection, resolveWorkspaceOpencodeConnection } from "../opencode-connection.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { ensureDir, exists, shortId } from "../utils.js";
import { defaultWorkspaceOpenworkConfig, ensureWorkspaceFiles } from "../workspace-init.js";
import { seedOpenworkWorkspaceConfigIfEmpty } from "../openwork-workspace-config-store.js";
import { workspaceIdForPath } from "../workspaces.js";
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
  /**
   * Dispose-free re-attach of the workspace's runtime MCPs via the engine's
   * dynamic push. The injected engine config file is workspace-independent,
   * so activation never reloads or disposes an engine instance.
   */
  syncWorkspaceRuntimeMcp: (config: ServerConfig, workspace: WorkspaceInfo) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return {
    id: workspace.id,
    path: workspace.path,
    name: workspace.name,
    preset: workspace.preset,
    workspaceType: workspace.workspaceType,
    ...(workspace.displayName ? { displayName: workspace.displayName } : {}),
    ...(workspace.sandboxBackend ? { sandboxBackend: workspace.sandboxBackend } : {}),
    ...(workspace.sandboxRunId ? { sandboxRunId: workspace.sandboxRunId } : {}),
    ...(workspace.sandboxContainerName ? { sandboxContainerName: workspace.sandboxContainerName } : {}),
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
    syncWorkspaceRuntimeMcp,
  } = options;

  const resolveWorkspaceForRegistry = (id: string): Promise<WorkspaceInfo> => resolveWorkspace(config, id);

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

    const workspaceId = workspaceIdForPath(workspacePath);
    // Seed the per-workspace openwork config in the runtime DB (replaces the
    // legacy `.opencode/openwork.json` file). No-op if a row already exists.
    await seedOpenworkWorkspaceConfigIfEmpty(
      config,
      workspaceId,
      defaultWorkspaceOpenworkConfig(workspacePath, preset),
    );

    const workspace: WorkspaceInfo = {
      id: workspaceId,
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
      target: workspace.path || "workspace",
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
    const wasActive = config.workspaces[0]?.id === workspace.id;
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
    // The injected engine config file is workspace-independent, so activation
    // never disposes or reloads an engine instance. Fire-and-forget re-attach
    // of the activated workspace's runtime MCPs via the dynamic push.
    if (!wasActive && workspace.workspaceType === "local" && resolveWorkspaceOpencodeConnection(config, workspace).baseUrl?.trim()) {
      void syncWorkspaceRuntimeMcp(config, workspace).catch(() => undefined);
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
