import "./load-env.js"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { swaggerUI } from "@hono/swagger-ui"
import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { cors } from "hono/cors"
import { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { requestId } from "hono/request-id"
import { describeRoute, openAPIRouteHandler, resolver } from "hono-openapi"
import { z } from "zod"
import { db } from "./db.js"
import { env } from "./env.js"
import { publicRoute } from "./middleware/index.js"
import { registerAdminMcpRoutes } from "./mcp/admin.js"
import { registerAgentMcpRoutes } from "./mcp/agent.js"
import { registerMcpRoutes } from "./mcp/index.js"
import type { MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "./middleware/index.js"
import { buildOperationId, emptyResponse, htmlResponse, jsonResponse } from "./openapi.js"
import { appLogger } from "./observability/logger.js"
import { createRequestAccessLogMiddleware, createTelemetryErrorSanitizerMiddleware, registerAppErrorHandler, registerObservabilityMiddleware } from "./observability/hono.js"
import { registerAdminRoutes } from "./routes/admin/index.js"
import { registerAuthRoutes } from "./routes/auth/index.js"
import { registerBootstrapRoutes } from "./routes/bootstrap/index.js"
import { registerCloudRoutes } from "./routes/cloud/index.js"
import { registerDeprecatedSkillHubRoutes } from "./routes/deprecated-skill-hubs.js"
import { registerDevRoutes } from "./routes/dev/index.js"
import { registerMcpTokenRoutes } from "./routes/mcp/index.js"
import { registerMemoryRoutes } from "./routes/memory/index.js"
import { registerAutomationRoutes } from "./routes/automations/index.js"
import { configureCloudAgentExecutor, configureCloudSavedScriptExecutor } from "./automations/service.js"
import { cloudAgentRuntimeAvailable, executeCloudAgent } from "./automations/cloud-agent-executor.js"
import { getCatalog } from "./mcp/index.js"
import { buildCapabilityToolTree, createCapabilityRegistryContext } from "./mcp/capability-registry.js"
import { executeMarketplaceCapability } from "./mcp/marketplace-capabilities.js"
import { resolveMcpMemberIdentity } from "./mcp/external-capabilities.js"
import { DEN_MCP_REQUESTED_SCOPES } from "./mcp/scopes.js"
import { codemodeScriptsEnabled } from "./capability-sources/codemode-rollout.js"
import { registerMeRoutes } from "./routes/me/index.js"
import { registerOrgRoutes } from "./routes/org/index.js"
import { registerTelemetryRoutes } from "./routes/telemetry/index.js"
import { registerVersionRoutes } from "./routes/version/index.js"
import { registerWebhookRoutes } from "./routes/webhooks/index.js"
import { registerWorkerRoutes } from "./routes/workers/index.js"
import type { AuthContextVariables } from "./session.js"
import { sessionMiddleware } from "./session.js"
import { isOperationalErrorPath, normalizeOperationalErrorResponse, operationalErrorResponse } from "./operational-errors.js"
import { sanitizePublicResponseHeaders } from "./public-response-headers.js"

type AppVariables = RequestIdVariables & AuthContextVariables & Partial<UserOrganizationsContext> & Partial<OrganizationContextVariables> & Partial<MemberTeamsContext>

const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal("den-api"),
  version: z.string(),
}).meta({ ref: "DenApiHealthResponse" })

const readinessResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal("den-api"),
  checks: z.object({
    database: z.enum(["ok", "error"]),
  }),
}).meta({ ref: "DenApiReadinessResponse" })

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
const strictTransportSecurityHeader = "max-age=31536000; includeSubDomains"

registerObservabilityMiddleware(app)
app.use("*", requestId({
  headerName: "",
  generator: () => createDenTypeId("request"),
}))
app.use("*", async (c, next) => {
  await next()
  sanitizePublicResponseHeaders(c.res.headers)
})
app.use("*", async (c, next) => {
  await next()
  c.header("X-Content-Type-Options", "nosniff")
  c.header("Strict-Transport-Security", strictTransportSecurityHeader)
})
app.use("*", createTelemetryErrorSanitizerMiddleware())
app.use("*", async (c, next) => {
  await next()
  c.res = await normalizeOperationalErrorResponse(c.req.path, c.res, c.get("requestId"))
})
app.use("*", createRequestAccessLogMiddleware())
registerAppErrorHandler(app, (error, c, requestId) => {
  if (!isOperationalErrorPath(c.req.path)) {
    return undefined
  }
  return operationalErrorResponse(error, c, requestId)
})

// The handoff exchange is called from Cloud instance pages, whose Daytona
// preview origins rotate on every re-sign and can never be statically
// allowlisted. Reflecting the origin here is safe because this route is
// authenticated solely by the one-time, 5-minute grant in the request body
// and never consults cookies or sessions - a hostile page gains nothing
// without a valid grant. Registered before the global CORS middleware so it
// answers the preflight for exactly this path; every other route keeps the
// strict allowlist below.
app.use(
  "/v1/auth/desktop-handoff/exchange",
  cors({
    origin: (origin) => origin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    allowMethods: ["POST", "OPTIONS"],
    maxAge: 600,
  }),
)

if (env.corsOrigins.length > 0) {
  app.use(
    "*",
      cors({
        origin: env.corsOrigins,
        credentials: true,
        allowHeaders: ["Content-Type", "Authorization", "X-Api-Key", "X-Request-Id", "X-OpenWork-Legacy-Org-Id"],
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        exposeHeaders: ["Content-Length"],
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
    description: "Redirects the API root when DEN_MARKETING_URL is configured; otherwise returns a lightweight service payload.",
    responses: {
      200: jsonResponse("API root service payload.", healthResponseSchema),
      302: emptyResponse("Redirect to the configured marketing site."),
    },
  }),
  publicRoute,
  (c) => {
    if (env.marketingUrl) {
      return c.redirect(env.marketingUrl, 302)
    }
    return c.json({ ok: true, service: "den-api" })
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
  publicRoute,
  (c) => {
    return c.json({ ok: true, service: "den-api", version: env.serviceVersion })
  },
)

app.get(
  "/ready",
  describeRoute({
    tags: ["System"],
    summary: "Check den-api readiness",
    description: "Verifies den-api can reach its database dependency.",
    responses: {
      200: jsonResponse("den-api is ready to serve traffic.", readinessResponseSchema),
      503: jsonResponse("den-api is not ready to serve traffic.", readinessResponseSchema),
    },
  }),
  publicRoute,
  async (c) => {
    try {
      await db.execute(sql`select 1`)
      return c.json({ ok: true, service: "den-api", checks: { database: "ok" } })
    } catch (error) {
      appLogger.error("readiness database check failed", { component: "readiness", error })
      return c.json({ ok: false, service: "den-api", checks: { database: "error" } }, 503)
    }
  },
)

registerAdminRoutes(app)
registerAuthRoutes(app)
registerBootstrapRoutes(app)
registerCloudRoutes(app)
registerDeprecatedSkillHubRoutes(app)
registerDevRoutes(app)
registerMeRoutes(app)
registerMemoryRoutes(app)
registerAutomationRoutes(app)
registerOrgRoutes(app)
registerVersionRoutes(app)
registerWebhookRoutes(app)
registerWorkerRoutes(app)
registerMcpTokenRoutes(app)
registerMcpRoutes(app)
registerAgentMcpRoutes(app)
registerAdminMcpRoutes(app)
registerTelemetryRoutes(app)

configureCloudAgentExecutor({ execute: executeCloudAgent, runtimeAvailable: cloudAgentRuntimeAvailable })

configureCloudSavedScriptExecutor(async ({ organizationId, ownerMemberId, automationRunId, action }) => {
  const normalizedOrganizationId = normalizeDenTypeId("organization", organizationId)
  const normalizedOwnerMemberId = normalizeDenTypeId("member", ownerMemberId)
  const members = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizedOwnerMemberId),
    eq(MemberTable.organizationId, normalizedOrganizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  const userId = members[0]?.userId
  if (!userId) return { ok: false, message: "The Automation owner is no longer active.", retryable: false }
  const organizations = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(
    eq(OrganizationTable.id, normalizedOrganizationId),
  ).limit(1)
  const organizationMetadata = organizations[0]?.metadata
  const codemodeEnabled = codemodeScriptsEnabled(organizationMetadata)
  if (!codemodeEnabled) {
    return { ok: false, message: "Code Mode scripts are disabled for this organization.", retryable: false }
  }
  const member = await resolveMcpMemberIdentity({ userId, organizationId })
  if (!member) return { ok: false, message: "The Automation owner is no longer active.", retryable: false }
  const catalog = await getCatalog(app as unknown as Hono, undefined)
  const principal = { userId, organizationId, scopes: new Set(DEN_MCP_REQUESTED_SCOPES), payload: {} }
  const capabilityContext = createCapabilityRegistryContext({
    app: app as unknown as Hono,
    env: undefined,
    catalog,
    principal,
    organizationId: normalizedOrganizationId,
    member,
    redirectUriBase: env.apiPublicUrl ?? "http://127.0.0.1",
    codemodeEnabled,
    organizationMetadata,
    mcpConnectionsGatingEnabled: env.mcpConnectionsGatingEnabled,
  })
  const result = await executeMarketplaceCapability({
    organizationId,
    member,
    pluginId: action.script.pluginId,
    configObjectId: action.script.configObjectId,
    configObjectVersionId: action.script.configObjectVersionId,
    automationRunId: normalizeDenTypeId("automationRun", automationRunId),
    body: action.input,
    codemodeEnabled: true,
    validateScriptOutput: true,
    buildTools: () => buildCapabilityToolTree(capabilityContext),
  })
  if (!result.ok) return {
    ok: false,
    message: result.message,
    retryable: false,
    ...("receiptId" in result ? { receiptId: result.receiptId ?? null } : {}),
  }
  if (result.result.status !== "executed") {
    return { ok: false, message: result.result.hint ?? "The saved Script could not execute.", retryable: false }
  }
  if (!result.result.receiptId) {
    return { ok: false, message: "The Script ran, but its durable artifact receipt could not be recorded.", retryable: true }
  }
  return {
    ok: true,
    value: result.result.value,
    canonicalResult: result.result.canonicalResult ?? JSON.stringify(result.result.value),
    receiptId: result.result.receiptId,
  }
})

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
  publicRoute,
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
      servers: env.apiPublicUrl ? [{ url: env.apiPublicUrl }] : [],
      tags: [
        { name: "System", description: "Service health and operational routes." },
        { name: "Organizations", description: "Top-level organization creation and context routes." },
        { name: "Invitations", description: "Invitation preview, acceptance, creation, and cancellation routes." },
        { name: "API Keys", description: "Organization API key management routes." },
        { name: "SCIM", description: "Organization SCIM connector management routes." },
        { name: "SSO", description: "Organization single sign-on connector management routes." },
        { name: "Members", description: "Organization member management routes." },
        { name: "Roles", description: "Organization custom role management routes." },
        { name: "Teams", description: "Organization team management routes." },
        { name: "Templates", description: "Organization shared template routes." },
        { name: "LLM Providers", description: "Organization LLM provider catalog, configuration, and access routes." },
        { name: "Workers", description: "Worker lifecycle, billing, and runtime routes." },
        { name: "Worker Runtime", description: "Worker runtime inspection and upgrade routes." },
        { name: "Worker Activity", description: "Worker heartbeat and activity reporting routes." },
        { name: "Telemetry", description: "Telemetry event ingestion and adoption analytics." },
        { name: "Admin", description: "Administrative reporting routes." },
        { name: "Users", description: "Current user and membership routes." },
        { name: "Bootstrap", description: "Agent-first provisional workspace setup routes." },
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
  publicRoute,
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
