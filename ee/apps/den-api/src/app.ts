import "./load-env.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { swaggerUI } from "@hono/swagger-ui"
import { cors } from "hono/cors"
import { Hono } from "hono"
import { logger } from "hono/logger"
import type { RequestIdVariables } from "hono/request-id"
import { requestId } from "hono/request-id"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"
import { z } from "zod"
import { env } from "./env.js"
import type { MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "./middleware/index.js"
import { buildOperationId, emptyResponse, htmlResponse, jsonResponse } from "./openapi.js"
import { registerAdminRoutes } from "./routes/admin/index.js"
import { registerAuthRoutes } from "./routes/auth/index.js"
import { registerMeRoutes } from "./routes/me/index.js"
import { registerOrgRoutes } from "./routes/org/index.js"
import { registerWorkerRoutes } from "./routes/workers/index.js"
import type { AuthContextVariables } from "./session.js"
import { sessionMiddleware } from "./session.js"

type AppVariables = RequestIdVariables & AuthContextVariables & Partial<UserOrganizationsContext> & Partial<OrganizationContextVariables> & Partial<MemberTeamsContext>

const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("den-api"),
}).meta({ ref: "DenApiHealthResponse" })

const openApiDocumentSchema = z.object({
  openapi: z.string(),
  info: z.object({
    title: z.string(),
    version: z.string(),
  }).passthrough(),
  paths: z.record(z.string(), z.unknown()),
  components: z.object({}).passthrough().optional(),
}).passthrough().meta({ ref: "OpenApiDocument" })

const app = new Hono<{ Variables: AppVariables }>()

app.use("*", logger())
app.use("*", requestId({
  headerName: "",
  generator: () => createDenTypeId("request"),
}))
app.use("*", async (c, next) => {
  await next()
  c.header("X-Request-Id", c.get("requestId"))
})

if (env.corsOrigins.length > 0) {
  app.use(
    "*",
      cors({
        origin: env.corsOrigins,
        credentials: true,
        allowHeaders: ["Content-Type", "Authorization", "X-Api-Key", "X-Request-Id"],
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        exposeHeaders: ["Content-Length", "X-Request-Id"],
        maxAge: 600,
    }),
  )
}

app.use("*", sessionMiddleware)

app.get(
  "/",
  describeRoute({
    tags: ["System"],
    hide: true,
    summary: "Redirect API root",
    description: "Redirects the API root to the OpenWork marketing site instead of serving API content.",
    responses: {
      302: emptyResponse("Redirect to the OpenWork marketing site."),
    },
  }),
  (c) => {
    return c.redirect("https://openworklabs.com", 302)
  },
)

app.get(
  "/health",
  describeRoute({
    tags: ["System"],
    summary: "Check den-api health",
    description: "Returns a lightweight health payload for den-api.",
    responses: {
      200: {
        description: "den-api is reachable",
        content: {
          "application/json": {
            schema: resolver(healthResponseSchema),
          },
        },
      },
    },
  }),
  (c) => {
    return c.json({ ok: true, service: "den-api" })
  },
)

registerAdminRoutes(app)
registerAuthRoutes(app)
registerMeRoutes(app)
registerOrgRoutes(app)
registerWorkerRoutes(app)

app.get(
  "/openapi.json",
  describeRoute({
    tags: ["System"],
    summary: "Get OpenAPI document",
    description: "Returns the machine-readable OpenAPI 3.1 document for the Den API so humans and tools can inspect the API surface.",
    responses: {
      200: jsonResponse("OpenAPI document returned successfully.", openApiDocumentSchema),
    },
  }),
  openAPIRouteHandler(app, {
    documentation: {
      openapi: "3.1.0",
      info: {
        title: "Den API",
        version: "dev",
        description: [
          "OpenAPI spec for the Den control plane API.",
          "",
          "Authentication:",
          "- Use `Authorization: Bearer <session-token>` for user-authenticated routes that require a Den session.",
          "- Use `x-api-key: <den-api-key>` for API-key-authenticated routes that accept organization API keys.",
          "- Public routes like health and documentation do not require authentication.",
          "",
          "Swagger tip: use the security schemes in the Authorize dialog to set either `bearerAuth` or `denApiKey` before trying protected endpoints.",
        ].join("\n"),
      },
      servers: [
        { url: "https://api.openworklabs.com" },
      ],
      tags: [
        { name: "System", description: "Service health and operational routes." },
        { name: "Organizations", description: "Top-level organization creation and context routes." },
        { name: "Invitations", description: "Invitation preview, acceptance, creation, and cancellation routes." },
        { name: "API Keys", description: "Organization API key management routes." },
        { name: "Members", description: "Organization member management routes." },
        { name: "Roles", description: "Organization custom role management routes." },
        { name: "Teams", description: "Organization team management routes." },
        { name: "Templates", description: "Organization shared template routes." },
        { name: "LLM Providers", description: "Organization LLM provider catalog, configuration, and access routes." },
        { name: "Skills", description: "Organization skill authoring and sharing routes." },
        { name: "Skill Hubs", description: "Organization skill hub management and access routes." },
        { name: "Workers", description: "Worker lifecycle, billing, and runtime routes." },
        { name: "Worker Runtime", description: "Worker runtime inspection and upgrade routes." },
        { name: "Worker Activity", description: "Worker heartbeat and activity reporting routes." },
        { name: "Admin", description: "Administrative reporting routes." },
        { name: "Users", description: "Current user and membership routes." },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "session-token",
            description: "Session token passed as `Authorization: Bearer <session-token>` for user-authenticated Den routes.",
          },
          denApiKey: {
            type: "apiKey",
            in: "header",
            name: "x-api-key",
            description: "Organization API key passed as the `x-api-key` header for API-key-authenticated Den routes.",
          },
        },
      },
    },
    includeEmptyPaths: true,
    exclude: ["/docs", "/openapi.json"],
    excludeMethods: ["OPTIONS"],
    defaultOptions: {
      ALL: {
        operationId: (route) => buildOperationId(route.method, route.path),
      },
    },
  }),
)

app.get(
  "/docs",
  describeRoute({
    tags: ["System"],
    summary: "Serve Swagger UI",
    description: "Serves Swagger UI so developers can browse and try the Den API from a browser.",
    responses: {
      200: htmlResponse("Swagger UI page returned successfully."),
    },
  }),
  swaggerUI({
    url: "/openapi.json",
    persistAuthorization: true,
    displayOperationId: true,
    defaultModelsExpandDepth: 1,
  }),
)

app.notFound((c) => {
  return c.json({ error: "not_found" }, 404)
})

export default app
