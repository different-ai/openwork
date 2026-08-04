import {
  createScheduledTaskDraftSchema,
  reviewScheduledTaskGrantSchema,
  scheduledTaskScheduleSchema,
  updateScheduledTaskDraftSchema,
} from "@openwork/types/scheduled-tasks";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ScheduledTaskScheduler } from "../scheduled-tasks/scheduled-task-scheduler.js";
import type { ScheduledTaskService } from "../scheduled-tasks/scheduled-task-service.js";
import type {
  ServerConfig,
  TokenScope,
  WorkspaceInfo,
} from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

export interface RegisterScheduledTaskRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  service: ScheduledTaskService;
  scheduler: ScheduledTaskScheduler;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspaceWithoutBootstrap: (
    config: ServerConfig,
    id: string,
  ) => Promise<WorkspaceInfo>;
  allowDeterministicTick: boolean | (() => boolean);
}

function actorId(ctx: RequestContext): string {
  return ctx.actor?.clientId?.trim()
    || ctx.actor?.type
    || "unknown";
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "invalid_scheduled_task", message, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

function parseOptionalLimit(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new ApiError(400, "invalid_limit", "limit must be an integer between 1 and 500");
  }
  return parsed;
}

async function requireLocalWorkspace(
  options: RegisterScheduledTaskRoutesOptions,
  ctx: RequestContext,
): Promise<WorkspaceInfo> {
  const workspace = await options.resolveWorkspaceWithoutBootstrap(
    options.config,
    ctx.params.id,
  );
  if (workspace.workspaceType !== "local") {
    throw new ApiError(
      409,
      "scheduled_tasks_local_only",
      "Scheduled tasks currently require a local workspace",
    );
  }
  return workspace;
}

function deterministicTickAllowed(
  value: RegisterScheduledTaskRoutesOptions["allowDeterministicTick"],
): boolean {
  return typeof value === "function" ? value() : value;
}

function resolveWorkspaceChild(root: string, candidate: string): string {
  const relativePath = relative(root, candidate);
  if (
    relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new ApiError(404, "scheduled_task_artifact_not_found", "Scheduled task artifact not found");
  }
  return candidate;
}

export function registerScheduledTaskRoutes(
  options: RegisterScheduledTaskRoutesOptions,
): void {
  const {
    routes,
    config,
    service,
    scheduler,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
  } = options;
  const base = "/workspace/:id/scheduled-tasks";

  // Static paths must be registered before :taskId because the registry is
  // intentionally first-match-wins.
  addRoute(routes, "POST", `${base}/preview`, "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    await requireLocalWorkspace(options, ctx);
    const body = await readJsonBody(ctx.request);
    const schedule = parse(
      scheduledTaskScheduleSchema,
      body.schedule,
      "A valid manual, daily, or weekly schedule is required",
    );
    const after = body.after === undefined ? undefined : Number(body.after);
    if (after !== undefined && (!Number.isInteger(after) || after < 0)) {
      throw new ApiError(400, "invalid_schedule_preview", "after must be a non-negative timestamp");
    }
    return jsonResponse({ preview: service.preview(schedule, after) });
  });

  addRoute(routes, "POST", `${base}/scheduler/tick`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    if (!deterministicTickAllowed(options.allowDeterministicTick)) {
      throw new ApiError(404, "not_found", "Route not found");
    }
    const body = await readJsonBody(ctx.request);
    const timestamp = body.now === undefined ? undefined : Number(body.now);
    if (timestamp !== undefined && (!Number.isInteger(timestamp) || timestamp < 0)) {
      throw new ApiError(400, "invalid_scheduler_tick", "now must be a non-negative timestamp");
    }
    return jsonResponse(await scheduler.tick({
      now: timestamp ?? Date.now(),
      source: "manual",
      workspaceId: ctx.params.id,
    }));
  });

  addRoute(routes, "GET", base, "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    await requireLocalWorkspace(options, ctx);
    return jsonResponse({ items: service.list(ctx.params.id) });
  });

  addRoute(routes, "POST", base, "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    const definition = parse(
      createScheduledTaskDraftSchema,
      await readJsonBody(ctx.request),
      "A valid scheduled-task definition is required",
    );
    if (definition.workspaceId !== ctx.params.id) {
      throw new ApiError(
        400,
        "scheduled_task_workspace_mismatch",
        "The definition workspace must match the route workspace",
      );
    }
    const created = service.createDraft(definition, actorId(ctx));
    return jsonResponse(created, 201);
  });

  addRoute(routes, "GET", `${base}/:taskId`, "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    await requireLocalWorkspace(options, ctx);
    return jsonResponse(service.get(ctx.params.id, ctx.params.taskId));
  });

  addRoute(routes, "PATCH", `${base}/:taskId`, "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    const input = parse(
      updateScheduledTaskDraftSchema,
      await readJsonBody(ctx.request),
      "A valid expectedRevisionId and definition are required",
    );
    return jsonResponse(
      service.updateDraft(ctx.params.id, ctx.params.taskId, input, actorId(ctx)),
    );
  });

  addRoute(routes, "POST", `${base}/:taskId/duplicate`, "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    const body = await readJsonBody(ctx.request);
    if (body.name !== undefined && typeof body.name !== "string") {
      throw new ApiError(400, "invalid_scheduled_task", "name must be a string");
    }
    const created = service.duplicate(
      ctx.params.id,
      ctx.params.taskId,
      actorId(ctx),
      typeof body.name === "string" ? body.name : undefined,
    );
    return jsonResponse(created, 201);
  });

  addRoute(routes, "POST", `${base}/:taskId/review`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    const body = await readJsonBody(ctx.request);
    const input = parse(
      reviewScheduledTaskGrantSchema,
      { ...body, grantor: actorId(ctx) },
      "A valid reviewed grant is required",
    );
    return jsonResponse(
      await service.review(ctx.params.id, ctx.params.taskId, input, actorId(ctx)),
    );
  });

  addRoute(routes, "POST", `${base}/:taskId/enable`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    return jsonResponse({ task: await service.enable(ctx.params.id, ctx.params.taskId) });
  });

  addRoute(routes, "POST", `${base}/:taskId/pause`, "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    return jsonResponse({ task: service.pause(ctx.params.id, ctx.params.taskId) });
  });

  addRoute(routes, "POST", `${base}/:taskId/resume`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    return jsonResponse({ task: await service.resume(ctx.params.id, ctx.params.taskId) });
  });

  addRoute(routes, "POST", `${base}/:taskId/revoke`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    const body = await readJsonBody(ctx.request);
    if (body.reason !== undefined && typeof body.reason !== "string") {
      throw new ApiError(400, "invalid_scheduled_task_revocation", "reason must be a string");
    }
    return jsonResponse(await service.revokeGrant(
      ctx.params.id,
      ctx.params.taskId,
      typeof body.reason === "string" ? body.reason : "Revoked by owner",
      actorId(ctx),
    ));
  });

  addRoute(routes, "POST", `${base}/:taskId/run`, "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    return jsonResponse(
      { run: await service.runOnce(ctx.params.id, ctx.params.taskId) },
      202,
    );
  });

  addRoute(routes, "DELETE", `${base}/:taskId`, "host", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    return jsonResponse({ task: await service.delete(ctx.params.id, ctx.params.taskId) });
  });

  addRoute(routes, "GET", `${base}/:taskId/runs`, "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    await requireLocalWorkspace(options, ctx);
    return jsonResponse({
      items: service.listRuns(
        ctx.params.id,
        ctx.params.taskId,
        parseOptionalLimit(ctx.url.searchParams.get("limit")),
      ),
    });
  });

  addRoute(routes, "GET", `${base}/:taskId/runs/:runId`, "client", async (ctx) => {
    requireClientScope(ctx, "viewer");
    await requireLocalWorkspace(options, ctx);
    return jsonResponse(
      service.getRunReceipt(ctx.params.id, ctx.params.taskId, ctx.params.runId),
    );
  });

  addRoute(
    routes,
    "GET",
    `${base}/:taskId/runs/:runId/artifacts/:artifactId`,
    "client",
    async (ctx) => {
      requireClientScope(ctx, "viewer");
      const workspace = await requireLocalWorkspace(options, ctx);
      const receipt = service.getRunReceipt(
        ctx.params.id,
        ctx.params.taskId,
        ctx.params.runId,
      );
      const artifact = receipt.artifacts.find(
        (candidate) =>
          candidate.id === ctx.params.artifactId && candidate.kind === "file",
      );
      if (!artifact) {
        throw new ApiError(
          404,
          "scheduled_task_artifact_not_found",
          "Scheduled task artifact not found",
        );
      }

      let canonicalRoot: string;
      let canonicalArtifact: string;
      try {
        canonicalRoot = await realpath(workspace.path);
        canonicalArtifact = await realpath(resolve(canonicalRoot, artifact.value));
        resolveWorkspaceChild(canonicalRoot, canonicalArtifact);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          404,
          "scheduled_task_artifact_not_found",
          "Scheduled task artifact not found",
        );
      }
      const info = await stat(canonicalArtifact).catch(() => null);
      if (!info) {
        throw new ApiError(
          404,
          "scheduled_task_artifact_not_found",
          "Scheduled task artifact not found",
        );
      }
      if (!info.isFile()) {
        throw new ApiError(
          404,
          "scheduled_task_artifact_not_found",
          "Scheduled task artifact not found",
        );
      }

      const filename = (artifact.name ?? basename(canonicalArtifact))
        .replace(/["\r\n]/gu, "_");
      const headers = new Headers({
        "Content-Type": "application/octet-stream",
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="${filename}"`,
      });
      const stream = Readable.toWeb(
        createReadStream(canonicalArtifact),
      ) as unknown as ReadableStream;
      return new Response(stream, { status: 200, headers });
    },
  );

  addRoute(routes, "POST", `${base}/:taskId/runs/:runId/cancel`, "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    ensureWritable(config);
    await requireLocalWorkspace(options, ctx);
    return jsonResponse({
      run: await service.cancelRun(ctx.params.id, ctx.params.taskId, ctx.params.runId),
    });
  });
}
