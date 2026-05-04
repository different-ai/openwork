import type { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import { HTTPException } from "hono/http-exception";
import type { AppDependencies } from "../context/app-dependencies.js";
import { getRequestContext, type AppBindings } from "../context/request-context.js";
import { buildErrorResponse, buildSuccessResponse, RouteError } from "../http.js";
import { buildOperationId, jsonResponse, withCommonErrorResponses } from "../openapi.js";
import {
  capabilitiesResponseSchema,
  remoteServerConnectRequestSchema,
  remoteServerConnectResponseSchema,
  remoteServerSyncRequestSchema,
  serverInventoryListResponseSchema,
  systemStatusResponseSchema,
} from "../schemas/registry.js";
import { healthResponseSchema, metadataResponseSchema, openApiDocumentSchema, rootInfoResponseSchema } from "../schemas/system.js";
import { routePaths } from "./route-paths.js";

type ServerV2App = Hono<AppBindings>;

function toWorkspaceSummary(workspace: ReturnType<AppDependencies["services"]["workspaceRegistry"]["serializeWorkspace"]>) {
  const { notes: _notes, ...summary } = workspace;
  return summary;
}

async function parseJsonBody<T>(schema: { parse(input: unknown): T }, request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return schema.parse({});
  }
  return schema.parse(await request.json());
}

function buildRouteErrorJson(requestId: string, error: unknown) {
  if (error instanceof HTTPException) {
    const status = error.status;
    const code = status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : "invalid_request";
    return {
      body: buildErrorResponse({
        code,
        message: error.message || (code === "not_found" ? "Route not found." : "Request failed."),
        requestId,
      }),
      status,
    };
  }
  if (error instanceof RouteError) {
    return {
      body: buildErrorResponse({
        code: error.code,
        details: error.details,
        message: error.message,
        requestId,
      }),
      status: error.status,
    };
  }
  const routeLike = error && typeof error === "object"
    ? error as { code?: unknown; details?: unknown; message?: unknown; status?: unknown }
    : null;
  if (routeLike && typeof routeLike.status === "number" && typeof routeLike.code === "string" && typeof routeLike.message === "string") {
    return {
      body: buildErrorResponse({
        code: routeLike.code as any,
        details: Array.isArray(routeLike.details) ? routeLike.details as any : undefined,
        message: routeLike.message,
        requestId,
      }),
      status: routeLike.status,
    };
  }
  return null;
}

function createOpenApiDocumentation(version: string) {
  return {
    openapi: "3.1.0",
    info: {
        title: "OpenWork Server V2",
        version,
        description: [
          "OpenAPI contract for the standalone OpenWork Server V2 runtime and durable registry state.",
          "",
          "Phase 10 makes Server V2 the default runtime, keeps release/runtime assets in a managed extracted directory, and closes the remaining cutover tooling around the standalone contract.",
        ].join("\n"),
    },
    servers: [{ url: "/" }],
    tags: [
      {
        name: "System",
        description: "Server-level operational routes and contract metadata.",
      },
      {
        name: "Workspaces",
        description: "Workspace-first resources will live under /workspaces/:workspaceId.",
      },
      {
        name: "Runtime",
        description: "Server-owned runtime supervision, versions, and child process health.",
      },
      {
        name: "Sessions",
        description: "Workspace-first session and streaming primitives backed by OpenCode or remote OpenWork servers.",
      },
      {
        name: "Messages",
        description: "Workspace-first message history and mutation primitives nested under sessions.",
      },
      {
        name: "Config",
        description: "Workspace-scoped config projection, raw config editing, and materialization owned by Server V2.",
      },
      {
        name: "Files",
        description: "Workspace-scoped file sessions, simple content routes, inbox, and artifact surfaces owned by Server V2.",
      },
      {
        name: "Reload",
        description: "Workspace-scoped reload events, reconciliation, and explicit runtime reload controls.",
      },
    ],
  };
}

export function registerSystemRoutes(app: ServerV2App, dependencies: AppDependencies) {
  app.get(
    routePaths.root,
    describeRoute({
      tags: ["System"],
      summary: "Get server root information",
      description: "Returns the root metadata for the standalone Server V2 process and its route conventions.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Server root information returned successfully.", rootInfoResponseSchema),
      }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.system.getRootInfo()));
    },
  );

  app.get(
    routePaths.system.health,
    describeRoute({
      tags: ["System"],
      summary: "Check Server V2 health",
      description: "Returns a lightweight health response for the standalone Server V2 process.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Server health returned successfully.", healthResponseSchema),
      }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.system.getHealth()));
    },
  );

  app.get(
    routePaths.system.meta,
    describeRoute({
      tags: ["System"],
      summary: "Get foundation metadata",
      description: "Returns middleware ordering, route namespace conventions, sqlite bootstrap status, and startup import diagnostics.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Server metadata returned successfully.", metadataResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.system.getMetadata(requestContext.actor)));
    },
  );

  app.get(
    routePaths.system.capabilities,
    describeRoute({
      tags: ["System"],
      summary: "Get server capabilities",
      description: "Returns the typed Server V2 capability model, including auth requirements and migrated registry/runtime read slices.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Server capabilities returned successfully.", capabilitiesResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.system.getCapabilities(requestContext.actor)));
    },
  );

  app.get(
    routePaths.system.status,
    describeRoute({
      tags: ["System"],
      summary: "Get normalized system status",
      description: "Returns normalized status, registry summary, auth requirements, runtime summary, and capabilities for app startup and settings surfaces.",
      responses: withCommonErrorResponses({
        200: jsonResponse("System status returned successfully.", systemStatusResponseSchema),
      }, { includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireVisibleRead(requestContext.actor);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.system.getStatus(requestContext.actor)));
    },
  );

  app.get(
    routePaths.system.servers,
    describeRoute({
      tags: ["System"],
      summary: "List known server targets",
      description: "Returns the local server registry inventory. This is host-scoped because it can reveal internal server connection metadata.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Server inventory returned successfully.", serverInventoryListResponseSchema),
      }, { includeForbidden: true, includeUnauthorized: true }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireHost(requestContext.actor);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.system.listServers()));
    },
  );

  app.post(
    routePaths.system.serverConnect,
    describeRoute({
      tags: ["System"],
      summary: "Connect a remote OpenWork server",
      description: "Validates a remote OpenWork server through the local Server V2 process, stores the remote connection metadata, and syncs the discovered remote workspaces into the local canonical registry.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Remote OpenWork server connected successfully.", remoteServerConnectResponseSchema),
      }, { includeForbidden: true, includeInvalidRequest: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireHost(requestContext.actor);
      const body = await parseJsonBody(remoteServerConnectRequestSchema, c.req.raw);
      let result;
      try {
        result = await requestContext.services.remoteServers.connect(body);
      } catch (error) {
        const resolved = buildRouteErrorJson(requestContext.requestId, error);
        if (resolved) {
          return c.json(resolved.body, resolved.status as any);
        }
        throw error;
      }
      return c.json(buildSuccessResponse(requestContext.requestId, {
        selectedWorkspaceId: result.selectedWorkspaceId,
        server: requestContext.services.serverRegistry.serialize(result.server, { includeBaseUrl: true }),
        workspaces: result.workspaces.map((workspace) => toWorkspaceSummary(requestContext.services.workspaceRegistry.serializeWorkspace(workspace))),
      }));
    },
  );

  app.post(
    routePaths.system.serverSync(),
    describeRoute({
      tags: ["System"],
      summary: "Sync a remote OpenWork server",
      description: "Refreshes the remote workspace inventory for a stored remote OpenWork server and updates the local canonical registry mapping.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Remote OpenWork server synced successfully.", remoteServerConnectResponseSchema),
      }, { includeForbidden: true, includeInvalidRequest: true, includeNotFound: true, includeUnauthorized: true }),
    }),
    async (c) => {
      const requestContext = getRequestContext(c);
      requestContext.services.auth.requireHost(requestContext.actor);
      const body = await parseJsonBody(remoteServerSyncRequestSchema, c.req.raw);
      const serverId = c.req.param("serverId") ?? "";
      let result;
      try {
        result = await requestContext.services.remoteServers.sync(serverId, body);
      } catch (error) {
        const resolved = buildRouteErrorJson(requestContext.requestId, error);
        if (resolved) {
          return c.json(resolved.body, resolved.status as any);
        }
        throw error;
      }
      return c.json(buildSuccessResponse(requestContext.requestId, {
        selectedWorkspaceId: result.selectedWorkspaceId,
        server: requestContext.services.serverRegistry.serialize(result.server, { includeBaseUrl: true }),
        workspaces: result.workspaces.map((workspace) => toWorkspaceSummary(requestContext.services.workspaceRegistry.serializeWorkspace(workspace))),
      }));
    },
  );

  app.get(
    routePaths.openapiDocument,
    describeRoute({
      tags: ["System"],
      summary: "Get the OpenAPI document",
      description: "Returns the machine-readable OpenAPI 3.1 document generated from the Hono route definitions.",
      responses: withCommonErrorResponses({
        200: jsonResponse("OpenAPI document returned successfully.", openApiDocumentSchema),
      }),
    }),
    openAPIRouteHandler(app, {
      documentation: createOpenApiDocumentation(dependencies.version),
      includeEmptyPaths: true,
      exclude: [routePaths.openapiDocument],
      excludeMethods: ["OPTIONS"],
      defaultOptions: {
        ALL: {
          operationId: (route) => buildOperationId(route.method, route.path),
        },
      },
    }),
  );
}
