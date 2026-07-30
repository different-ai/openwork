import { join } from "node:path";
import {
  uiArtifactBuildRequestSchema,
  uiArtifactIntentRequestSchema,
  uiArtifactProjectFileUpdateSchema,
  uiArtifactProjectUpdateSchema,
  uiArtifactPublishRequestSchema,
  uiArtifactSettingsUpdateSchema,
  uiArtifactStateUpdateSchema,
} from "@openwork/types/ui-artifact-project";
import { recordAudit } from "../audit.js";
import { ApiError } from "../errors.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { createArtifactProjectService, type ArtifactProjectService } from "../ui-artifacts/index.js";
import { shortId } from "../utils.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;

interface RegisterUiArtifactRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  requireApproval: (
    ctx: RequestContext,
    input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
  ) => Promise<void>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

async function readBoundedJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError(413, "ui_artifact_request_too_large", "Artifact request exceeds its size limit");
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("Artifact request exceeds its size limit").catch(() => undefined);
        throw new ApiError(413, "ui_artifact_request_too_large", "Artifact request exceeds its size limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function parseBody<T>(
  result: { success: true; data: T } | { success: false; error: { issues: unknown } },
  code: string,
  message: string,
): T {
  if (!result.success) {
    throw new ApiError(400, code, message, { issues: result.error.issues });
  }
  return result.data;
}

export function registerUiArtifactRoutes(options: RegisterUiArtifactRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    ensureWritable,
    requireClientScope,
    requireApproval,
    resolveWorkspace,
  } = options;
  const services = new Map<string, { workspacePath: string; service: ArtifactProjectService }>();

  const resolveService = async (workspaceId: string) => {
    const workspace = await resolveWorkspace(config, workspaceId);
    if (workspace.workspaceType === "remote") {
      throw new ApiError(
        400,
        "ui_artifact_workspace_unsupported",
        "Dynamic artifacts must be managed by the OpenWork server that owns the local workspace",
      );
    }
    const cached = services.get(workspace.id);
    if (cached?.workspacePath === workspace.path) return { workspace, service: cached.service };
    const service = createArtifactProjectService({
      workspaceRoot: workspace.path,
      workspaceId: workspace.id,
    });
    services.set(workspace.id, { workspacePath: workspace.path, service });
    return { workspace, service };
  };

  addRoute(routes, "GET", "/workspace/:id/ui-artifacts", "client", async (ctx) => {
    const { service } = await resolveService(ctx.params.id);
    return jsonResponse({ items: await service.list() });
  });

  addRoute(routes, "GET", "/workspace/:id/ui-artifacts/settings", "client", async (ctx) => {
    const { service } = await resolveService(ctx.params.id);
    return jsonResponse(await service.getSettings());
  });

  addRoute(routes, "PUT", "/workspace/:id/ui-artifacts/settings", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { workspace, service } = await resolveService(ctx.params.id);
    const update = parseBody(
      uiArtifactSettingsUpdateSchema.safeParse(await readBoundedJsonBody(ctx.request, 8_192)),
      "ui_artifact_settings_update_invalid",
      "Artifact settings update is invalid",
    );
    const target = join(workspace.path, ".opencode", "openwork", "artifact-settings.json");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "ui-artifact.settings.write",
      summary: "Update dynamic artifact settings",
      paths: [target],
    });
    const settings = await service.updateSettings(update);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "ui-artifact.settings.write",
      target,
      summary: update.project
        ? `${update.project.enabled ? "Enabled" : "Disabled"} artifact project ${update.project.slug}`
        : `${settings.builderSkillEnabled ? "Enabled" : "Disabled"} the managed artifact builder skill`,
      timestamp: Date.now(),
    });
    return jsonResponse(settings);
  });

  addRoute(routes, "GET", "/workspace/:id/ui-artifacts/agent-skill", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const { service } = await resolveService(ctx.params.id);
    return jsonResponse(await service.getAgentSkill());
  });

  addRoute(routes, "GET", "/workspace/:id/ui-artifacts/:slug", "client", async (ctx) => {
    const { service } = await resolveService(ctx.params.id);
    return jsonResponse(await service.get(ctx.params.slug));
  });

  addRoute(routes, "PUT", "/workspace/:id/ui-artifacts/:slug", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { workspace, service } = await resolveService(ctx.params.id);
    const update = parseBody(
      uiArtifactProjectUpdateSchema.safeParse(await readBoundedJsonBody(ctx.request, 1_300_000)),
      "ui_artifact_project_update_invalid",
      "Artifact project update is invalid",
    );
    const projectRoot = join(
      workspace.path,
      ".opencode",
      "openwork",
      "artifacts",
      ctx.params.slug,
    );
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "ui-artifact.project.write",
      summary: `Update all files in ${ctx.params.slug}`,
      paths: Object.keys(update.files).map((file) => join(projectRoot, file)),
    });
    const snapshot = await service.putProject(ctx.params.slug, update);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "ui-artifact.project.write",
      target: projectRoot,
      summary: `Atomically updated all files in ${ctx.params.slug}`,
      timestamp: Date.now(),
    });
    return jsonResponse(snapshot);
  });

  addRoute(routes, "PUT", "/workspace/:id/ui-artifacts/:slug/files", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { workspace, service } = await resolveService(ctx.params.id);
    const body = await readBoundedJsonBody(ctx.request, 300_000);
    const update = parseBody(
      uiArtifactProjectFileUpdateSchema.safeParse(body),
      "ui_artifact_file_update_invalid",
      "Artifact file update is invalid",
    );
    const target = join(
      workspace.path,
      ".opencode",
      "openwork",
      "artifacts",
      ctx.params.slug,
      update.file,
    );
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "ui-artifact.file.write",
      summary: `Update ${ctx.params.slug}/${update.file}`,
      paths: [target],
    });
    const snapshot = await service.putFile(ctx.params.slug, update);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "ui-artifact.file.write",
      target,
      summary: `Updated ${ctx.params.slug}/${update.file}`,
      timestamp: Date.now(),
    });
    return jsonResponse(snapshot);
  });

  addRoute(routes, "POST", "/workspace/:id/ui-artifacts/:slug/build", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { workspace, service } = await resolveService(ctx.params.id);
    const request = parseBody(
      uiArtifactBuildRequestSchema.safeParse(await readBoundedJsonBody(ctx.request, 4_096)),
      "ui_artifact_build_request_invalid",
      "Artifact build request is invalid",
    );
    const pinned = await service.build(ctx.params.slug, request);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "ui-artifact.build",
      target: ctx.params.slug,
      summary: `Built ${ctx.params.slug} at ${pinned.build.projectRevision}`,
      timestamp: Date.now(),
    });
    return jsonResponse(pinned.build);
  });

  addRoute(routes, "POST", "/workspace/:id/ui-artifacts/:slug/publish", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { workspace, service } = await resolveService(ctx.params.id);
    const request = parseBody(
      uiArtifactPublishRequestSchema.safeParse(await readBoundedJsonBody(ctx.request, 80_000)),
      "ui_artifact_publish_request_invalid",
      "Artifact publish request is invalid",
    );
    const receipt = await service.publish(ctx.params.slug, request);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "ui-artifact.publish",
      target: `${ctx.params.slug}:${receipt.attachment.instanceId}`,
      summary: `Published ${ctx.params.slug} from ${request.provenance?.createdBy ?? "user"}`,
      timestamp: Date.now(),
    });
    return jsonResponse(receipt);
  });

  addRoute(
    routes,
    "GET",
    "/workspace/:id/ui-artifacts/:slug/builds/:revision",
    "client",
    async (ctx) => {
      const { service } = await resolveService(ctx.params.id);
      return jsonResponse(await service.getBuild(ctx.params.slug, ctx.params.revision));
    },
  );

  addRoute(
    routes,
    "GET",
    "/workspace/:id/ui-artifacts/:slug/instances/:instanceId/state",
    "client",
    async (ctx) => {
      const { service } = await resolveService(ctx.params.id);
      return jsonResponse(await service.getState(ctx.params.slug, ctx.params.instanceId));
    },
  );

  addRoute(
    routes,
    "PUT",
    "/workspace/:id/ui-artifacts/:slug/instances/:instanceId/state",
    "client",
    async (ctx) => {
      ensureWritable(config);
      requireClientScope(ctx, "collaborator");
      const { workspace, service } = await resolveService(ctx.params.id);
      const update = parseBody(
        uiArtifactStateUpdateSchema.safeParse(await readBoundedJsonBody(ctx.request, 70_000)),
        "ui_artifact_state_update_invalid",
        "Artifact state update is invalid",
      );
      const state = await service.updateState(ctx.params.slug, ctx.params.instanceId, update);
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: "ui-artifact.state.write",
        target: `${ctx.params.slug}:${ctx.params.instanceId}`,
        summary: `Updated ${ctx.params.slug} instance state`,
        timestamp: Date.now(),
      });
      return jsonResponse(state);
    },
  );

  addRoute(
    routes,
    "POST",
    "/workspace/:id/ui-artifacts/:slug/instances/:instanceId/intents",
    "client",
    async (ctx) => {
      ensureWritable(config);
      requireClientScope(ctx, "collaborator");
      const { workspace, service } = await resolveService(ctx.params.id);
      const request = parseBody(
        uiArtifactIntentRequestSchema.safeParse(await readBoundedJsonBody(ctx.request, 40_000)),
        "ui_artifact_intent_invalid",
        "Artifact intent request is invalid",
      );
      const result = await service.stageIntent(ctx.params.slug, ctx.params.instanceId, request);
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "remote" },
        action: "ui-artifact.intent.stage",
        target: `${ctx.params.slug}:${ctx.params.instanceId}:${request.intentId}`,
        summary: result.ok
          ? `Staged ${ctx.params.slug} intent ${request.intentId}`
          : `Rejected ${ctx.params.slug} intent ${request.intentId}`,
        timestamp: Date.now(),
      });
      return jsonResponse(result);
    },
  );
}
