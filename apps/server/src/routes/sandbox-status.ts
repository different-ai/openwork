import { ApiError } from "../errors.js";
import { localSandboxRuntime } from "../local-sandbox-runtime.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerSandboxStatusRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  runtime?: ReturnType<typeof localSandboxRuntime>;
}): void {
  const { routes, config, requireClientScope, resolveWorkspaceWithoutBootstrap, runtime = localSandboxRuntime(config) } = options;
  addRoute(routes, "GET", "/workspace/:id/sandbox-status", "client", async ctx => {
    const started = performance.now();
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const workspaceMs = performance.now() - started;
    const status = runtime.snapshot(workspace.path);
    return Response.json(status, { headers: { "Cache-Control": "no-store", "Server-Timing": `workspace;dur=${workspaceMs.toFixed(2)}, snapshot;dur=${(performance.now() - started - workspaceMs).toFixed(2)}` } });
  });
  addRoute(routes, "POST", "/workspace/:id/sandbox-status/prepare", "client", async ctx => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    if (await runtime.refreshMode(workspace.path) === "off") throw new ApiError(409, "sandbox_disabled", "Turn on Use OpenWork Sandbox before preparing it.");
    void runtime.prepare(workspace.path, "retry");
    return Response.json(runtime.snapshot(workspace.path), { headers: { "Cache-Control": "no-store" } });
  });
}
