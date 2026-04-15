import type { Context, Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { HTTPException } from "hono/http-exception";
import { getRequestContext, type AppBindings } from "../context/request-context.js";
import { buildSuccessResponse } from "../http.js";
import { jsonResponse, withCommonErrorResponses } from "../openapi.js";
import {
  rawOpencodeConfigQuerySchema,
  rawOpencodeConfigResponseSchema,
  rawOpencodeConfigWriteRequestSchema,
  workspaceConfigPatchRequestSchema,
  workspaceConfigResponseSchema,
} from "../schemas/config.js";
import {
  binaryListResponseSchema,
  binaryUploadResponseSchema,
  engineReloadResponseSchema,
  fileBatchReadRequestSchema,
  fileBatchReadResponseSchema,
  fileBatchWriteRequestSchema,
  fileCatalogSnapshotResponseSchema,
  fileMutationResultSchema,
  fileOperationsRequestSchema,
  fileSessionCreateRequestSchema,
  fileSessionIdParamsSchema,
  fileSessionResponseSchema,
  reloadEventsResponseSchema,
  simpleContentQuerySchema,
  simpleContentResponseSchema,
  simpleContentWriteRequestSchema,
  workspaceActivationResponseSchema,
  workspaceCreateLocalRequestSchema,
  workspaceDisposeResponseSchema,
  workspaceDeleteResponseSchema,
} from "../schemas/files.js";
import { workspaceDetailResponseSchema } from "../schemas/registry.js";
import { routePaths } from "./route-paths.js";

function parseQuery<T>(schema: { parse(input: unknown): T }, url: string) {
  const searchParams = new URL(url).searchParams;
  const query: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    query[key] = value;
  }
  return schema.parse(query);
}

async function parseJsonBody<T>(schema: { parse(input: unknown): T }, request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return schema.parse({});
  }
  return schema.parse(await request.json());
}

function readActorKey(c: Context<AppBindings>) {
  const requestContext = getRequestContext(c);
  requestContext.services.auth.requireVisibleRead(requestContext.actor);
  const authorization = c.req.raw.headers.get("authorization")?.trim() ?? "";
  const hostToken = c.req.raw.headers.get("x-openwork-host-token")?.trim() ?? "";
  return {
    actorKey: requestContext.actor.kind === "host" ? hostToken || authorization : authorization,
    actorKind: requestContext.actor.kind === "host" ? "host" as const : "client" as const,
    requestContext,
  };
}

function requireWorkspaceAccess(c: Context<AppBindings>) {
  const { requestContext, actorKey, actorKind } = readActorKey(c);
  const workspaceId = c.req.param("workspaceId") ?? "";
  const workspace = requestContext.services.workspaceRegistry.getById(workspaceId, {
    includeHidden: requestContext.actor.kind === "host",
  });
  if (!workspace) {
    throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
  }
  return { actorKey, actorKind, requestContext, workspaceId };
}

function createBinaryResponse(inputValue: { buffer?: Uint8Array; filePath?: string; filename: string; size: number }) {
  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${inputValue.filename}"`);
  headers.set("Content-Length", String(inputValue.size));
  return new Response(inputValue.buffer ?? (Bun as any).file(inputValue.filePath!), { headers, status: 200 });
}

export function registerFileRoutes(app: Hono<AppBindings>) {
  app.post(
    routePaths.workspaces.createLocal,
    describeRoute({
      tags: ["Workspaces"],
      summary: "Create a local workspace",
      description: "Creates a local workspace, initializes starter files, creates the Server V2 config directory, and reconciles the new workspace into managed config state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Local workspace created successfully.", workspaceDetailResponseSchema),
      }, { includeForbidden: true, includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireHost(requestContext.actor);
      const body = await parseJsonBody(workspaceCreateLocalRequestSchema, c.req.raw);
      const workspace = await requestContext.services.files.createLocalWorkspace({
        folderPath: body.folderPath,
        name: body.name,
        preset: body.preset ?? "starter",
      });
      const detail = requestContext.services.workspaceRegistry.getById(workspace.id, { includeHidden: true });
      return c.json(buildSuccessResponse(requestContext.requestId, detail));
    },
  );

  app.post(
    routePaths.workspaces.activate(),
    describeRoute({
      tags: ["Workspaces"],
      summary: "Activate a workspace",
      description: "Marks a workspace as the active local workspace for migration-era host flows that still expect an active workspace concept.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace activated successfully.", workspaceActivationResponseSchema),
      }, { includeForbidden: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      const workspaceId = c.req.param("workspaceId") ?? "";
      const activeWorkspaceId = requestContext.services.files.activateWorkspace(workspaceId);
      return c.json(buildSuccessResponse(requestContext.requestId, { activeWorkspaceId }));
    },
  );

  app.patch(
    routePaths.workspaces.displayName(),
    describeRoute({
      tags: ["Workspaces"],
      summary: "Update workspace display name",
      description: "Updates the persisted display name for a workspace record during migration.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace detail returned successfully.", workspaceDetailResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext } = readActorKey(c);
      const workspaceId = c.req.param("workspaceId") ?? "";
      const body = await c.req.json();
      const displayName = typeof body?.displayName === "string" ? body.displayName : null;
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      requestContext.services.files.updateWorkspaceDisplayName(workspaceId, displayName);
      const detail = requestContext.services.workspaceRegistry.getById(workspaceId, { includeHidden: requestContext.actor.kind === "host" });
      return c.json(buildSuccessResponse(requestContext.requestId, detail));
    },
  );

  app.delete(
    routePaths.workspaces.byId(),
    describeRoute({
      tags: ["Workspaces"],
      summary: "Delete workspace",
      description: "Deletes a workspace record from the local Server V2 registry during migration-era host flows.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace deleted successfully.", workspaceDeleteResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext } = readActorKey(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      const workspaceId = c.req.param("workspaceId") ?? "";
      const result = requestContext.services.files.deleteWorkspace(workspaceId);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.dispose(),
    describeRoute({
      tags: ["Workspaces"],
      summary: "Dispose workspace runtime instance",
      description: "Disposes the runtime instance associated with the workspace through Server V2 and refreshes managed runtime supervision where required.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace runtime instance disposed successfully.", workspaceDisposeResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext } = readActorKey(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      const workspaceId = c.req.param("workspaceId") ?? "";
      const result = await requestContext.services.files.disposeWorkspaceInstance(workspaceId);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.get(
    routePaths.workspaces.config(),
    describeRoute({
      tags: ["Config"],
      summary: "Read workspace config",
      description: "Returns stored and effective workspace config along with the materialized config paths managed by Server V2.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace config returned successfully.", workspaceConfigResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const snapshot = await requestContext.services.config.getWorkspaceConfigSnapshot(workspaceId);
      return c.json(buildSuccessResponse(requestContext.requestId, snapshot));
    },
  );

  app.patch(
    routePaths.workspaces.config(),
    describeRoute({
      tags: ["Config"],
      summary: "Patch workspace config",
      description: "Updates stored workspace OpenWork/OpenCode config, absorbs recognized managed sections into the database, and rematerializes the effective config files.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace config updated successfully.", workspaceConfigResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const body = await parseJsonBody(workspaceConfigPatchRequestSchema, c.req.raw);
      const snapshot = await requestContext.services.config.patchWorkspaceConfig(workspaceId, body);
      if (body.opencode) {
        requestContext.services.files.emitReloadEvent(workspaceId, "config", {
          action: "updated",
          name: "opencode.jsonc",
          path: snapshot.materialized.configOpencodePath ?? undefined,
          type: "config",
        });
      }
      if (body.openwork) {
        requestContext.services.files.emitReloadEvent(workspaceId, "config", {
          action: "updated",
          name: "openwork.json",
          path: snapshot.materialized.configOpenworkPath ?? undefined,
          type: "config",
        });
      }
      await requestContext.services.files.recordWorkspaceAudit(
        workspaceId,
        "config.patch",
        snapshot.materialized.configOpencodePath ?? snapshot.materialized.configOpenworkPath ?? workspaceId,
        "Patched workspace config through Server V2.",
      );
      return c.json(buildSuccessResponse(requestContext.requestId, snapshot));
    },
  );

  app.get(
    routePaths.workspaces.rawOpencodeConfig(),
    describeRoute({
      tags: ["Config"],
      summary: "Read raw OpenCode config text",
      description: "Returns the editable raw OpenCode config text for project or global scope, generated from the server-owned config state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Raw OpenCode config returned successfully.", rawOpencodeConfigResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const query = parseQuery(rawOpencodeConfigQuerySchema, c.req.url);
      const result = await requestContext.services.config.readRawOpencodeConfig(workspaceId, query.scope ?? "project");
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.rawOpencodeConfig(),
    describeRoute({
      tags: ["Config"],
      summary: "Write raw OpenCode config text",
      description: "Parses raw OpenCode config text, absorbs recognized managed sections into the database, and rematerializes the effective config files.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Raw OpenCode config written successfully.", rawOpencodeConfigResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const body = await parseJsonBody(rawOpencodeConfigWriteRequestSchema, c.req.raw);
      const result = body.scope === "global"
        ? requestContext.services.config.writeGlobalOpencodeConfig(body.content)
        : await requestContext.services.config.writeWorkspaceRawOpencodeConfig(workspaceId, body.content);
      if (body.scope !== "global") {
        requestContext.services.files.emitReloadEvent(workspaceId, "config", {
          action: "updated",
          name: "opencode.jsonc",
          path: result.path ?? undefined,
          type: "config",
        });
        await requestContext.services.files.recordWorkspaceAudit(
          workspaceId,
          "config.raw.write",
          result.path ?? workspaceId,
          "Updated raw OpenCode config through Server V2.",
        );
      }
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.get(
    routePaths.workspaces.reloadEvents(),
    describeRoute({
      tags: ["Reload"],
      summary: "List reload events",
      description: "Returns workspace-scoped reload events emitted by Server V2 after config/file mutations, watched changes, or reconciliation work.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Reload events returned successfully.", reloadEventsResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const since = Number(new URL(c.req.url).searchParams.get("since") ?? "0");
      const result = await requestContext.services.files.getReloadEvents(workspaceId, Number.isFinite(since) ? since : 0);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.engineReload(),
    describeRoute({
      tags: ["Reload"],
      summary: "Reload the local engine",
      description: "Restarts the local OpenCode runtime through the Server V2 runtime supervisor for the selected local workspace.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace engine reloaded successfully.", engineReloadResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const result = await requestContext.services.files.reloadWorkspaceEngine(workspaceId);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.fileSessions.base(),
    describeRoute({
      tags: ["Files"],
      summary: "Create a workspace file session",
      description: "Creates a server-owned file session for a local workspace and returns the session metadata used for file catalog and mutation routes.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace file session created successfully.", fileSessionResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { actorKey, actorKind, requestContext, workspaceId } = requireWorkspaceAccess(c);
      const body = await parseJsonBody(fileSessionCreateRequestSchema, c.req.raw);
      const session = await requestContext.services.files.createWorkspaceFileSession(workspaceId, { actorKey, actorKind, ...body });
      return c.json(buildSuccessResponse(requestContext.requestId, session));
    },
  );

  app.post(
    routePaths.workspaces.fileSessions.renew(),
    describeRoute({
      tags: ["Files"],
      summary: "Renew a workspace file session",
      description: "Extends the lifetime of an existing workspace file session.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace file session renewed successfully.", fileSessionResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { actorKey, actorKind, requestContext, workspaceId } = requireWorkspaceAccess(c);
      const params = fileSessionIdParamsSchema.parse(c.req.param());
      const body = await parseJsonBody(fileSessionCreateRequestSchema, c.req.raw);
      const session = await requestContext.services.files.renewWorkspaceFileSession(workspaceId, params.fileSessionId, actorKey, actorKind, body.ttlSeconds);
      return c.json(buildSuccessResponse(requestContext.requestId, session));
    },
  );

  app.delete(
    routePaths.workspaces.fileSessions.byId(),
    describeRoute({
      tags: ["Files"],
      summary: "Close a workspace file session",
      description: "Closes a workspace file session and releases its temporary server-side catalog state.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace file session closed successfully.", workspaceActivationResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { actorKey, actorKind, requestContext, workspaceId } = requireWorkspaceAccess(c);
      const params = fileSessionIdParamsSchema.parse(c.req.param());
      await requestContext.services.files.closeWorkspaceFileSession(workspaceId, params.fileSessionId, actorKey, actorKind);
      return c.json(buildSuccessResponse(requestContext.requestId, { activeWorkspaceId: workspaceId }));
    },
  );

  app.get(
    routePaths.workspaces.fileSessions.catalogSnapshot(),
    describeRoute({
      tags: ["Files"],
      summary: "Get a file catalog snapshot",
      description: "Returns the file catalog snapshot for a workspace file session.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace file catalog returned successfully.", fileCatalogSnapshotResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { actorKey, actorKind, requestContext, workspaceId } = requireWorkspaceAccess(c);
      const params = fileSessionIdParamsSchema.parse(c.req.param());
      const query = new URL(c.req.url).searchParams;
      const result = await requestContext.services.files.listFileSessionCatalogSnapshot(workspaceId, params.fileSessionId, actorKey, actorKind, {
        after: query.get("after"),
        includeDirs: query.get("includeDirs") !== "false",
        limit: query.get("limit"),
        prefix: query.get("prefix"),
      });
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.get(
    routePaths.workspaces.fileSessions.catalogEvents(),
    describeRoute({
      tags: ["Files"],
      summary: "List file session catalog events",
      description: "Returns file mutation events recorded for a workspace file session since the requested cursor.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace file session events returned successfully.", fileMutationResultSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const { actorKey, actorKind, requestContext, workspaceId } = requireWorkspaceAccess(c);
      const params = fileSessionIdParamsSchema.parse(c.req.param());
      const result = requestContext.services.files.listFileSessionEvents(workspaceId, params.fileSessionId, actorKey, actorKind, new URL(c.req.url).searchParams.get("since"));
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.fileSessions.readBatch(),
    describeRoute({
      tags: ["Files"],
      summary: "Read a batch of files",
      description: "Reads a batch of files through the server-owned file session model.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace files read successfully.", fileBatchReadResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { actorKey, actorKind, requestContext, workspaceId } = requireWorkspaceAccess(c);
      const params = fileSessionIdParamsSchema.parse(c.req.param());
      const body = await parseJsonBody(fileBatchReadRequestSchema, c.req.raw);
      const result = await requestContext.services.files.readWorkspaceFiles(workspaceId, params.fileSessionId, actorKey, actorKind, body.paths);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.fileSessions.writeBatch(),
    describeRoute({
      tags: ["Files"],
      summary: "Write a batch of files",
      description: "Writes a batch of files with revision-aware conflict handling through the server-owned file session model.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace files written successfully.", fileMutationResultSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { actorKey, actorKind, requestContext, workspaceId } = requireWorkspaceAccess(c);
      const params = fileSessionIdParamsSchema.parse(c.req.param());
      const body = await parseJsonBody(fileBatchWriteRequestSchema, c.req.raw);
      const result = await requestContext.services.files.writeWorkspaceFiles(workspaceId, params.fileSessionId, actorKey, actorKind, body.writes);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.fileSessions.operations(),
    describeRoute({
      tags: ["Files"],
      summary: "Run file operations",
      description: "Runs mkdir, rename, and delete operations through the server-owned file session model.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace file operations applied successfully.", fileMutationResultSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { actorKey, actorKind, requestContext, workspaceId } = requireWorkspaceAccess(c);
      const params = fileSessionIdParamsSchema.parse(c.req.param());
      const body = await parseJsonBody(fileOperationsRequestSchema, c.req.raw);
      const result = await requestContext.services.files.workspaceFileOperations(workspaceId, params.fileSessionId, actorKey, actorKind, body.operations);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.get(
    routePaths.workspaces.simpleContent(),
    describeRoute({
      tags: ["Files"],
      summary: "Read simple content",
      description: "Reads markdown-oriented content for lighter file flows without using the full file session model.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace content returned successfully.", simpleContentResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const query = parseQuery(simpleContentQuerySchema, c.req.url);
      const result = await requestContext.services.files.readSimpleContent(workspaceId, query.path);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.post(
    routePaths.workspaces.simpleContent(),
    describeRoute({
      tags: ["Files"],
      summary: "Write simple content",
      description: "Writes markdown-oriented content with basic conflict handling for lighter file flows.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace content written successfully.", simpleContentResponseSchema),
      }, { includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const body = await parseJsonBody(simpleContentWriteRequestSchema, c.req.raw);
      const result = await requestContext.services.files.writeSimpleContent(workspaceId, body);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.get(
    routePaths.workspaces.inbox.base(),
    describeRoute({
      tags: ["Files"],
      summary: "List inbox items",
      description: "Returns uploadable inbox items for the selected workspace.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace inbox returned successfully.", binaryListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const result = await requestContext.services.files.listInbox(workspaceId);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.get(
    routePaths.workspaces.inbox.byId(),
    describeRoute({
      tags: ["Files"],
      summary: "Download inbox item",
      description: "Downloads one inbox file for the selected workspace.",
      responses: withCommonErrorResponses({
        200: {
          description: "Inbox item downloaded successfully.",
          content: {
            "application/octet-stream": {
              schema: resolver(simpleContentResponseSchema),
            },
          },
        },
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const result = await requestContext.services.files.downloadInboxItem(workspaceId, c.req.param("inboxId") ?? "");
      return createBinaryResponse({
        buffer: (result as { buffer?: Uint8Array }).buffer,
        filePath: (result as { absolutePath?: string }).absolutePath,
        filename: result.filename,
        size: result.size,
      });
    },
  );

  app.post(
    routePaths.workspaces.inbox.base(),
    describeRoute({
      tags: ["Files"],
      summary: "Upload inbox item",
      description: "Uploads one file into the managed inbox area for the selected workspace.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace inbox item uploaded successfully.", binaryUploadResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const form = await c.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new HTTPException(400, { message: "Form field 'file' is required." });
      }
      const requestedPath = (new URL(c.req.url).searchParams.get("path") ?? String(form.get("path") ?? "")).trim();
      const result = await requestContext.services.files.uploadInboxItem(workspaceId, requestedPath, file);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.get(
    routePaths.workspaces.artifacts.base(),
    describeRoute({
      tags: ["Files"],
      summary: "List artifacts",
      description: "Returns downloadable artifact items for the selected workspace.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Workspace artifacts returned successfully.", binaryListResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const result = await requestContext.services.files.listArtifacts(workspaceId);
      return c.json(buildSuccessResponse(requestContext.requestId, result));
    },
  );

  app.get(
    routePaths.workspaces.artifacts.byId(),
    describeRoute({
      tags: ["Files"],
      summary: "Download artifact",
      description: "Downloads one artifact file for the selected workspace.",
      responses: withCommonErrorResponses({
        200: {
          description: "Artifact downloaded successfully.",
          content: {
            "application/octet-stream": {
              schema: resolver(simpleContentResponseSchema),
            },
          },
        },
      }, { includeUnauthorized: true }),
    }),
    async (c) => {
      const { requestContext, workspaceId } = requireWorkspaceAccess(c);
      const result = await requestContext.services.files.downloadArtifact(workspaceId, c.req.param("artifactId") ?? "");
      return createBinaryResponse({
        buffer: (result as { buffer?: Uint8Array }).buffer,
        filePath: (result as { absolutePath?: string }).absolutePath,
        filename: result.filename,
        size: result.size,
      });
    },
  );
}
