import type { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import { HTTPException } from "hono/http-exception";
import type { AppDependencies } from "../context/app-dependencies.js";
import { getRequestContext, type AppBindings } from "../context/request-context.js";
import { buildSuccessResponse } from "../http.js";
import { buildOperationId, jsonResponse, withCommonErrorResponses } from "../openapi.js";
import {
  capabilitiesResponseSchema,
  serverInventoryListResponseSchema,
  systemStatusResponseSchema,
} from "../schemas/registry.js";
import { healthResponseSchema, metadataResponseSchema, openApiDocumentSchema, rootInfoResponseSchema } from "../schemas/system.js";
import { routePaths } from "./route-paths.js";

type ServerV2App = Hono<AppBindings>;

function createOpenApiDocumentation(version: string) {
  return {
    openapi: "3.1.0",
    info: {
        title: "OpenWork Server V2",
        version,
        description: [
          "OpenAPI contract for the standalone OpenWork Server V2 runtime and durable registry state.",
          "",
          "Phase 7 adds workspace-scoped config projection, file mutation routes, reload events, file watching, and reconciliation behind Server V2.",
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
