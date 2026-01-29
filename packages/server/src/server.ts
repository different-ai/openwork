import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ApprovalRequest, Capabilities, ServerConfig, WorkspaceInfo, Actor } from "./types.js";
import { ApprovalService } from "./approvals.js";
import { addPlugin, listPlugins, removePlugin } from "./plugins.js";
import { addMcp, listMcp, removeMcp } from "./mcp.js";
import { listSkills, upsertSkill } from "./skills.js";
import { deleteCommand, listCommands, upsertCommand } from "./commands.js";
import { ApiError, formatError } from "./errors.js";
import { readJsoncFile, updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import { recordAudit, readAuditEntries, readLastAudit } from "./audit.js";
import { parseFrontmatter } from "./frontmatter.js";
import { opencodeConfigPath, openworkConfigPath, projectCommandsDir, projectSkillsDir } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import { sanitizeCommandName } from "./validators.js";

type AuthMode = "none" | "client" | "host";

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  auth: AuthMode;
  handler: (ctx: RequestContext) => Promise<Response>;
}

interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  config: ServerConfig;
  approvals: ApprovalService;
  actor?: Actor;
}

export function startServer(config: ServerConfig) {
  const approvals = new ApprovalService(config.approval);
  const routes = createRoutes(config, approvals);

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }), request, config);
      }

      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) {
        return withCors(jsonResponse({ code: "not_found", message: "Not found" }, 404), request, config);
      }

      try {
        const actor = route.auth === "host" ? requireHost(request, config) : route.auth === "client" ? requireClient(request, config) : undefined;
        const response = await route.handler({ request, url, params: route.params, config, approvals, actor });
        return withCors(response, request, config);
      } catch (error) {
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", "Unexpected server error");
        return withCors(jsonResponse(formatError(apiError), apiError.status), request, config);
      }
    },
  });

  return server;
}

function matchRoute(routes: Route[], method: string, path: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.regex);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { ...route, params };
  }
  return null;
}

function addRoute(routes: Route[], method: string, path: string, auth: AuthMode, handler: Route["handler"]) {
  const keys: string[] = [];
  const regex = pathToRegex(path, keys);
  routes.push({ method, regex, keys, auth, handler });
}

function pathToRegex(path: string, keys: string[]): RegExp {
  const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return new RegExp(`^${pattern}$`);
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response: Response, request: Request, config: ServerConfig) {
  const origin = request.headers.get("origin");
  const allowedOrigins = config.corsOrigins;
  let allowOrigin: string | null = null;
  if (allowedOrigins.includes("*")) {
    allowOrigin = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    allowOrigin = origin;
  }

  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-OpenWork-Host-Token, X-OpenWork-Client-Id");
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

function requireClient(request: Request, config: ServerConfig): Actor {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token || token !== config.token) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const clientId = request.headers.get("x-openwork-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(token) };
}

function requireHost(request: Request, config: ServerConfig): Actor {
  const token = request.headers.get("x-openwork-host-token");
  if (!token || token !== config.hostToken) {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  return { type: "host", tokenHash: hashToken(token) };
}

function buildCapabilities(config: ServerConfig): Capabilities {
  const writeEnabled = !config.readOnly;
  return {
    skills: { read: true, write: writeEnabled, source: "openwork" },
    plugins: { read: true, write: writeEnabled },
    mcp: { read: true, write: writeEnabled },
    commands: { read: true, write: writeEnabled },
    config: { read: true, write: writeEnabled },
  };
}

function serializeWorkspace(workspace: ServerConfig["workspaces"][number]) {
  const opencode =
    workspace.baseUrl || workspace.directory
      ? {
          baseUrl: workspace.baseUrl,
          directory: workspace.directory,
        }
      : undefined;
  return {
    ...workspace,
    opencode,
  };
}

function createRoutes(config: ServerConfig, approvals: ApprovalService): Route[] {
  const routes: Route[] = [];

  addRoute(routes, "GET", "/health", "none", async () => {
    return jsonResponse({ ok: true, version: "0.1.0", uptimeMs: Date.now() - config.startedAt });
  });

  addRoute(routes, "GET", "/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/workspaces", "client", async () => {
    const active = config.workspaces[0];
    const items = active ? [serializeWorkspace(active)] : [];
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const opencode = await readOpencodeConfig(workspace.path);
    const openwork = await readOpenworkConfig(workspace.path);
    const lastAudit = await readLastAudit(workspace.path);
    return jsonResponse({ opencode, openwork, updatedAt: lastAudit?.timestamp ?? null });
  });

  addRoute(routes, "GET", "/workspace/:id/audit", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsed = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await readAuditEntries(workspace.path, limit);
    return jsonResponse({ items });
  });

  addRoute(routes, "PATCH", "/workspace/:id/config", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const opencode = body.opencode as Record<string, unknown> | undefined;
    const openwork = body.openwork as Record<string, unknown> | undefined;

    if (!opencode && !openwork) {
      throw new ApiError(400, "invalid_payload", "opencode or openwork updates required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.patch",
      summary: "Patch workspace config",
      paths: [opencode ? opencodeConfigPath(workspace.path) : null, openwork ? openworkConfigPath(workspace.path) : null].filter(Boolean) as string[],
    });

    if (opencode) {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
    if (openwork) {
      await writeOpenworkConfig(workspace.path, openwork, true);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.patch",
      target: "opencode.json",
      summary: "Patched workspace config",
      timestamp: Date.now(),
    });

    return jsonResponse({ updatedAt: Date.now() });
  });

  addRoute(routes, "GET", "/workspace/:id/plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const result = await listPlugins(workspace.path, includeGlobal);
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const spec = String(body.spec ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.add",
      summary: `Add plugin ${spec}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    await addPlugin(workspace.path, spec);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.add",
      target: "opencode.json",
      summary: `Added ${spec}`,
      timestamp: Date.now(),
    });
    const result = await listPlugins(workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/workspace/:id/plugins/:name", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.remove",
      summary: `Remove plugin ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    await removePlugin(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.remove",
      target: "opencode.json",
      summary: `Removed ${name}`,
      timestamp: Date.now(),
    });
    const result = await listPlugins(workspace.path, false);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const items = await listSkills(workspace.path, includeGlobal);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name, "SKILL.md")],
    });
    const path = await upsertSkill(workspace.path, { name, content, description });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.upsert",
      target: path,
      summary: `Upserted skill ${name}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ name, path, description: description ?? "", scope: "project" });
  });

  addRoute(routes, "GET", "/workspace/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const configPayload = body.config as Record<string, unknown> | undefined;
    if (!configPayload) {
      throw new ApiError(400, "invalid_payload", "MCP config is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary: `Add MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    await addMcp(workspace.path, name, configPayload);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: "opencode.json",
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.remove",
      summary: `Remove MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    await removeMcp(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.remove",
      target: "opencode.json",
      summary: `Removed MCP ${name}`,
      timestamp: Date.now(),
    });
    const items = await listMcp(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/commands", "client", async (ctx) => {
    const scope = ctx.url.searchParams.get("scope") === "global" ? "global" : "workspace";
    if (scope === "global") {
      requireHost(ctx.request, config);
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listCommands(workspace.path, scope);
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/commands", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const template = String(body.template ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.upsert",
      summary: `Upsert command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    const path = await upsertCommand(workspace.path, {
      name,
      description: body.description ? String(body.description) : undefined,
      template,
      agent: body.agent ? String(body.agent) : undefined,
      model: body.model ? String(body.model) : undefined,
      subtask: typeof body.subtask === "boolean" ? body.subtask : undefined,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.upsert",
      target: path,
      summary: `Upserted command ${name}`,
      timestamp: Date.now(),
    });
    const items = await listCommands(workspace.path, "workspace");
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/commands/:name", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.delete",
      summary: `Delete command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    await deleteCommand(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.delete",
      target: join(workspace.path, ".opencode", "commands"),
      summary: `Deleted command ${name}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const exportPayload = await exportWorkspace(workspace);
    return jsonResponse(exportPayload);
  });

  addRoute(routes, "POST", "/workspace/:id/import", "client", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.import",
      summary: "Import workspace config",
      paths: [opencodeConfigPath(workspace.path), openworkConfigPath(workspace.path)],
    });
    await importWorkspace(workspace, body);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.import",
      target: "workspace",
      summary: "Imported workspace config",
      timestamp: Date.now(),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/approvals", "host", async (ctx) => {
    return jsonResponse({ items: ctx.approvals.list() });
  });

  addRoute(routes, "POST", "/approvals/:id", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const reply = body.reply === "allow" ? "allow" : "deny";
    const result = ctx.approvals.respond(ctx.params.id, reply);
    if (!result) {
      throw new ApiError(404, "approval_not_found", "Approval request not found");
    }
    return jsonResponse({ ok: true, allowed: result.allowed });
  });

  return routes;
}

async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspace = config.workspaces.find((entry) => entry.id === id);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(workspace.path);
  const authorized = await isAuthorizedRoot(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  return { ...workspace, path: resolvedWorkspace };
}

async function isAuthorizedRoot(workspacePath: string, roots: string[]): Promise<boolean> {
  const resolvedWorkspace = resolve(workspacePath);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

function ensureWritable(config: ServerConfig): void {
  if (config.readOnly) {
    throw new ApiError(403, "read_only", "Server is read-only");
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const json = await request.json();
    return json as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  return data;
}

async function readOpenworkConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const path = openworkConfigPath(workspaceRoot);
  if (!(await exists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse openwork.json");
  }
}

async function writeOpenworkConfig(workspaceRoot: string, payload: Record<string, unknown>, merge: boolean): Promise<void> {
  const path = openworkConfigPath(workspaceRoot);
  const next = merge ? { ...(await readOpenworkConfig(workspaceRoot)), ...payload } : payload;
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

async function requireApproval(
  ctx: RequestContext,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
): Promise<void> {
  const actor = ctx.actor ?? { type: "remote" };
  const result = await ctx.approvals.requestApproval({ ...input, actor });
  if (!result.allowed) {
    throw new ApiError(403, "write_denied", "Write request denied", {
      requestId: result.id,
      reason: result.reason,
    });
  }
}

async function exportWorkspace(workspace: WorkspaceInfo) {
  const opencode = await readOpencodeConfig(workspace.path);
  const openwork = await readOpenworkConfig(workspace.path);
  const skills = await listSkills(workspace.path, false);
  const commands = await listCommands(workspace.path, "workspace");
  const skillContents = await Promise.all(
    skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.path, "utf8"),
    })),
  );
  const commandContents = await Promise.all(
    commands.map(async (command) => ({
      name: command.name,
      description: command.description,
      template: command.template,
    })),
  );

  return {
    workspaceId: workspace.id,
    exportedAt: Date.now(),
    opencode,
    openwork,
    skills: skillContents,
    commands: commandContents,
  };
}

async function importWorkspace(workspace: WorkspaceInfo, payload: Record<string, unknown>): Promise<void> {
  const modes = (payload.mode as Record<string, string> | undefined) ?? {};
  const opencode = payload.opencode as Record<string, unknown> | undefined;
  const openwork = payload.openwork as Record<string, unknown> | undefined;
  const skills = (payload.skills as { name: string; content: string; description?: string }[] | undefined) ?? [];
  const commands = (payload.commands as { name: string; content?: string; description?: string; template?: string; agent?: string; model?: string | null; subtask?: boolean }[] | undefined) ?? [];

  if (opencode) {
    if (modes.opencode === "replace") {
      await writeJsoncFile(opencodeConfigPath(workspace.path), opencode);
    } else {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
  }

  if (openwork) {
    if (modes.openwork === "replace") {
      await writeOpenworkConfig(workspace.path, openwork, false);
    } else {
      await writeOpenworkConfig(workspace.path, openwork, true);
    }
  }

  if (skills.length > 0) {
    if (modes.skills === "replace") {
      await rm(projectSkillsDir(workspace.path), { recursive: true, force: true });
    }
    for (const skill of skills) {
      await upsertSkill(workspace.path, skill);
    }
  }

  if (commands.length > 0) {
    if (modes.commands === "replace") {
      await rm(projectCommandsDir(workspace.path), { recursive: true, force: true });
    }
    for (const command of commands) {
      if (command.content) {
        const parsed = parseFrontmatter(command.content);
        const name = command.name || (typeof parsed.data.name === "string" ? parsed.data.name : "");
        const description = command.description || (typeof parsed.data.description === "string" ? parsed.data.description : undefined);
        if (!name) {
          throw new ApiError(400, "invalid_command", "Command name is required");
        }
        const template = parsed.body.trim();
        await upsertCommand(workspace.path, {
          name,
          description,
          template,
          agent: typeof parsed.data.agent === "string" ? parsed.data.agent : undefined,
          model: typeof parsed.data.model === "string" ? parsed.data.model : undefined,
          subtask: typeof parsed.data.subtask === "boolean" ? parsed.data.subtask : undefined,
        });
      } else {
        const name = command.name ?? "";
        const template = command.template ?? "";
        await upsertCommand(workspace.path, {
          name,
          description: command.description,
          template,
          agent: command.agent,
          model: command.model,
          subtask: command.subtask,
        });
      }
    }
  }
}
