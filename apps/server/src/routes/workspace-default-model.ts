import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import {
  readWorkspaceDefaultModel,
  workspaceDefaultModelBodySchema,
  writeWorkspaceDefaultModel,
} from "../workspace-default-model.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

interface RegisterWorkspaceDefaultModelRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<unknown>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

/**
 * GET/PUT /workspace/:id/default-model: the model a new chat in this
 * workspace uses, so callers without the renderer's preferences can pick it.
 */
export function registerWorkspaceDefaultModelRoutes(options: RegisterWorkspaceDefaultModelRoutesOptions): void {
  const { routes, config, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspaceWithoutBootstrap } = options;

  addRoute(routes, "GET", "/workspace/:id/default-model", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    return jsonResponse(await readWorkspaceDefaultModel(config, workspace.id));
  });

  addRoute(routes, "PUT", "/workspace/:id/default-model", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const parsed = workspaceDefaultModelBodySchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) {
      throw new ApiError(400, "invalid_payload", "model must be null or { providerID, modelID, variant? } with non-empty strings", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    return jsonResponse(await writeWorkspaceDefaultModel(config, workspace.id, parsed.data.model));
  });
}
