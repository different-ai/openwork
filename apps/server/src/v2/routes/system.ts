import type { Hono } from "hono";
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi";
import { z } from "zod";
import { jsonResponse, buildOperationId, emptyResponse } from "../openapi.js";
import { getV2Health } from "../services/system-service.js";
import { openApiDocumentSchema, v2HealthResponseSchema } from "../schemas/system.js";

const rootRedirectSchema = z.object({}).passthrough().meta({ ref: "OpenWorkServerV2RootRedirect" });

export function registerSystemRoutes(app: Hono) {
  app.get(
    "/",
    describeRoute({
      tags: ["System"],
      hide: true,
      summary: "Redirect API root",
      description: "Redirects the V2 API root to the machine-readable OpenAPI document.",
      responses: {
        302: emptyResponse("Redirect to the V2 OpenAPI document."),
      },
    }),
    (c) => c.redirect("/openapi.json", 302),
  );

  app.get(
    "/health",
    describeRoute({
      tags: ["System"],
      summary: "Check OpenWork Server V2 health",
      description: "Returns a lightweight health payload for the V2 server scaffold.",
      responses: {
        200: jsonResponse("OpenWork Server V2 is reachable.", v2HealthResponseSchema),
      },
    }),
    (c) => c.json(getV2Health()),
  );

  app.get(
    "/openapi.json",
    describeRoute({
      tags: ["System"],
      summary: "Get OpenWork Server V2 OpenAPI document",
      description: "Returns the machine-readable OpenAPI 3.1 document for the Server V2 scaffold.",
      responses: {
        200: jsonResponse("OpenAPI document returned successfully.", openApiDocumentSchema),
      },
    }),
    openAPIRouteHandler(app, {
      documentation: {
        openapi: "3.1.0",
        info: {
          title: "OpenWork Server V2",
          version: "dev",
          description: [
            "OpenAPI spec for the OpenWork Server V2 scaffold.",
            "",
            "This is the contract-first replacement surface for the current Bun server.",
          ].join("\n"),
        },
        servers: [{ url: "/v2" }],
        tags: [{ name: "System", description: "Service health and contract routes." }],
      },
      includeEmptyPaths: true,
      exclude: ["/openapi.json"],
      excludeMethods: ["OPTIONS"],
      defaultOptions: {
        ALL: {
          operationId: (route) => buildOperationId(route.method, route.path),
        },
      },
    }),
  );

  app.get(
    "/openapi/meta",
    describeRoute({
      tags: ["System"],
      hide: true,
      summary: "Get OpenAPI route metadata",
      description: "Returns a minimal metadata payload that confirms the V2 scaffold is mounted.",
      responses: {
        200: {
          description: "Route metadata returned successfully.",
          content: {
            "application/json": {
              schema: resolver(rootRedirectSchema),
            },
          },
        },
      },
    }),
    (c) => c.json({ ok: true }),
  );
}
