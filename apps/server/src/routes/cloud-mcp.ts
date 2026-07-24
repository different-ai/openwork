import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  OPENWORK_CLOUD_MCP_NAME,
  readOpenworkCloudMcpHealth,
  reconcileOpenworkCloudMcp,
  refreshOpenworkCloudMcpEngine,
  type CloudMcpServerMetadata,
  type CloudMcpProviderModelContext,
  type CloudMcpRuntimeRegistrar,
  type CloudMcpLiveStatusObserver,
} from "../cloud-mcp-health.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;

export type RegisterCloudMcpRoutesOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveOpencodeDirectory: (workspace: WorkspaceInfo) => string | null;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  registerRuntimeMcp: CloudMcpRuntimeRegistrar;
  refreshRegistrationFromLiveStatus?: CloudMcpLiveStatusObserver;
  serverMetadata?: CloudMcpServerMetadata;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerModelFromValues(provider: unknown, model: unknown): CloudMcpProviderModelContext | undefined {
  const providerValue = typeof provider === "string" ? provider.trim() : "";
  const modelValue = typeof model === "string" ? model.trim() : "";
  if (!providerValue && !modelValue) return undefined;
  if (!providerValue || !modelValue) {
    throw new ApiError(400, "invalid_payload", "provider and model must be supplied together");
  }
  return { provider: providerValue, model: modelValue };
}

function providerModelFromQuery(url: URL): CloudMcpProviderModelContext | undefined {
  return providerModelFromValues(url.searchParams.get("provider"), url.searchParams.get("model"));
}

function probeFromQuery(url: URL): boolean {
  const value = url.searchParams.get("probe")?.toLowerCase();
  return value === "1" || value === "true";
}

function providerModelFromBody(body: Record<string, unknown>): CloudMcpProviderModelContext | undefined {
  const direct = providerModelFromValues(body.provider, body.model);
  if (direct) return direct;
  if (!isRecord(body.context)) return undefined;
  return providerModelFromValues(body.context.provider, body.context.model);
}

function assertExactWorkspace(requestedId: string, workspace: WorkspaceInfo): void {
  if (requestedId.trim() !== workspace.id) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
}

function assertStrictBody(body: Record<string, unknown>, workspace: WorkspaceInfo): void {
  if (typeof body.workspaceId === "string" && body.workspaceId.trim() !== workspace.id) {
    throw new ApiError(400, "workspace_id_mismatch", "workspaceId must match the route workspace");
  }
  if (typeof body.name === "string" && body.name.trim() !== OPENWORK_CLOUD_MCP_NAME) {
    throw new ApiError(400, "invalid_mcp_name", "Only openwork-cloud can be reconciled by this endpoint");
  }
}

export function registerCloudMcpRoutes(options: RegisterCloudMcpRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveOpencodeDirectory,
    createWorkspaceOpencodeClient,
    registerRuntimeMcp,
    refreshRegistrationFromLiveStatus,
    serverMetadata,
  } = options;

  addRoute(routes, "GET", "/workspace/:id/mcp/openwork-cloud/health", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    assertExactWorkspace(ctx.params.id, workspace);
    const health = await readOpenworkCloudMcpHealth({
      config,
      workspace,
      directory: resolveOpencodeDirectory(workspace),
      providerModel: providerModelFromQuery(ctx.url),
      serverMetadata,
      probe: probeFromQuery(ctx.url),
      createWorkspaceOpencodeClient,
      refreshRegistrationFromLiveStatus,
    });
    return jsonResponse(health);
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/openwork-cloud/engine-refresh", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    assertExactWorkspace(ctx.params.id, workspace);
    // The refresh needs no payload; an optional body may scope provider/model
    // and name the trigger for the delivery ledger. An absent/empty body is
    // fine, but malformed JSON stays a hard 400 — never silently ignored.
    const raw = (await ctx.request.text()).trim();
    let body: Record<string, unknown> = {};
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ApiError(400, "invalid_json", "Invalid JSON body");
      }
      if (!isRecord(parsed)) {
        throw new ApiError(400, "invalid_payload", "JSON object body is required");
      }
      body = parsed;
    }
    assertStrictBody(body, workspace);
    const result = await refreshOpenworkCloudMcpEngine({
      config,
      workspace,
      directory: resolveOpencodeDirectory(workspace),
      providerModel: providerModelFromBody(body),
      serverMetadata,
      createWorkspaceOpencodeClient,
      registerRuntimeMcp,
      refreshRegistrationFromLiveStatus,
      trigger: typeof body.trigger === "string" ? body.trigger : undefined,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/openwork-cloud/reconcile", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    assertExactWorkspace(ctx.params.id, workspace);
    const body = await readJsonBody(ctx.request);
    if (!isRecord(body)) {
      throw new ApiError(400, "invalid_payload", "JSON object body is required");
    }
    assertStrictBody(body, workspace);
    const health = await reconcileOpenworkCloudMcp({
      config,
      workspace,
      directory: resolveOpencodeDirectory(workspace),
      body,
      providerModel: providerModelFromBody(body),
      serverMetadata,
      createWorkspaceOpencodeClient,
      registerRuntimeMcp,
      refreshRegistrationFromLiveStatus,
    });
    return jsonResponse(health);
  });
}
