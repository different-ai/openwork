import type { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import type { AppDependencies } from "../context/app-dependencies.js";
import { getRequestContext, type AppBindings } from "../context/request-context.js";
import { buildSuccessResponse } from "../http.js";
import { buildOperationId, jsonResponse, withCommonErrorResponses } from "../openapi.js";
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
        "OpenAPI contract for the standalone OpenWork Server V2 foundation.",
        "",
        "Phase 1 establishes the contract loop and the initial /system/* operational surface.",
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
      description: "Returns middleware ordering, route namespace conventions, and current foundation-level runtime metadata.",
      responses: withCommonErrorResponses({
        200: jsonResponse("Server metadata returned successfully.", metadataResponseSchema),
      }),
    }),
    (c) => {
      const requestContext = getRequestContext(c);
      return c.json(buildSuccessResponse(requestContext.requestId, requestContext.services.system.getMetadata()));
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
