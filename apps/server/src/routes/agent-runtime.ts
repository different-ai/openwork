import { recordAudit } from "../audit.js";
import type { AgentRuntime } from "../agent-runtime-store.js";
import type { CodexRuntimeService } from "../codex-opencode-adapter.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

type RegisterAgentRuntimeRoutesOptions = {
  routes: Route[];
  config: ServerConfig;
  codexRuntime: CodexRuntimeService;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
};

function requireWorkerWorkspace(workspace: WorkspaceInfo): void {
  if (workspace.workspaceType !== "local" || !workspace.path.trim()) {
    throw new ApiError(
      400,
      "codex_runtime_workspace_unsupported",
      "Codex Server must be configured on the OpenWork worker that owns this workspace",
    );
  }
}

function runtimeFromBody(body: Record<string, unknown>): AgentRuntime {
  if (body.runtime === "opencode" || body.runtime === "codex") return body.runtime;
  throw new ApiError(400, "invalid_payload", "runtime must be opencode or codex");
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "invalid_payload", `${field} is required`);
  }
  return value.trim();
}

function runtimeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(
    503,
    "codex_runtime_unavailable",
    error instanceof Error ? error.message : "Codex runtime is unavailable",
  );
}

export function registerAgentRuntimeRoutes(options: RegisterAgentRuntimeRoutesOptions): void {
  const {
    routes,
    config,
    codexRuntime,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
  } = options;

  addRoute(routes, "GET", "/workspace/:id/agent-runtime", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireWorkerWorkspace(workspace);
    return jsonResponse(await codexRuntime.status(workspace));
  });

  addRoute(routes, "PUT", "/workspace/:id/agent-runtime", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireWorkerWorkspace(workspace);
    const runtime = runtimeFromBody(await readJsonBody(ctx.request));
    try {
      const status = await codexRuntime.select(workspace, runtime);
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: "agent-runtime.select",
        target: runtime,
        summary: `Selected ${runtime === "codex" ? "Codex Server" : "OpenCode"} runtime`,
        timestamp: Date.now(),
      });
      return jsonResponse(status);
    } catch (error) {
      throw runtimeError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/agent-runtime/codex/login", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireWorkerWorkspace(workspace);
    if (!(await codexRuntime.isSelected(workspace.id))) {
      throw new ApiError(409, "codex_runtime_not_selected", "Select Codex Server before connecting ChatGPT");
    }
    try {
      return jsonResponse(await codexRuntime.startDeviceLogin(workspace), 201);
    } catch (error) {
      throw runtimeError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/agent-runtime/codex/login/cancel", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireWorkerWorkspace(workspace);
    const loginId = requiredString(await readJsonBody(ctx.request), "loginId");
    try {
      await codexRuntime.cancelLogin(workspace, loginId);
      return jsonResponse({ ok: true });
    } catch (error) {
      throw runtimeError(error);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/agent-runtime/codex/logout", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireWorkerWorkspace(workspace);
    try {
      await codexRuntime.logout(workspace);
      return jsonResponse(await codexRuntime.status(workspace));
    } catch (error) {
      throw runtimeError(error);
    }
  });
}
