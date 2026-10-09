import "./load-env.js"
import { registerSlackAssistantRoutes } from "./slack-assistant/routes.js"
import { registerWorkbotRoutes } from "./workbot/routes.js"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { swaggerUI } from "@hono/swagger-ui"
import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { cors } from "hono/cors"
import { Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { requestId } from "hono/request-id"
import { describeRoute, generateSpecs, resolver } from "hono-openapi"
import { z } from "zod"
import { db } from "./db.js"
import { env } from "./env.js"
import { getOrganizationFeatures } from "./features.js"
import { publicRoute } from "./middleware/index.js"
import { registerAdminMcpRoutes } from "./mcp/admin.js"
import { registerAgentMcpRoutes } from "./mcp/agent.js"
import { registerExternalConnectionProxyRoutes } from "./mcp/external-connection-proxy.js"
import { registerMcpRoutes } from "./mcp/index.js"
import type { MemberTeamsContext, OrganizationContextVariables, UserOrganizationsContext } from "./middleware/index.js"
import { buildOperationId, emptyResponse, htmlResponse, jsonResponse } from "./openapi.js"
import { appLogger } from "./observability/logger.js"
import { isWebOriginApprovedByAnyOrganization } from "./organization-web-origins.js"
import { createRequestAccessLogMiddleware, createTelemetryErrorSanitizerMiddleware, registerAppErrorHandler, registerObservabilityMiddleware } from "./observability/hono.js"
import { registerAdminRoutes } from "./routes/admin/index.js"
import { registerAuthRoutes } from "./routes/auth/index.js"
import { registerBootstrapRoutes } from "./routes/bootstrap/index.js"
import { registerEmailRoutes } from "./routes/email/index.js"
import { registerCloudRoutes } from "./routes/cloud/index.js"
import { registerDeprecatedMemoryRoutes } from "./routes/deprecated-memory.js"
import { registerDeprecatedSkillHubRoutes } from "./routes/deprecated-skill-hubs.js"
import { registerDevRoutes } from "./routes/dev/index.js"
import { registerInternalRoutes } from "./routes/internal/index.js"
import { registerMcpTokenRoutes } from "./routes/mcp/index.js"
import { registerAutomationRoutes } from "./routes/automations/index.js"
import { configureCloudAgentExecutor, configureCloudWorkflowExecutor, configureHeadlessAgentExecutor } from "./automations/service.js"
import { cloudAgentRuntimeAvailable, executeCloudAgent } from "./automations/cloud-agent-executor.js"
import { executeHeadlessAgent } from "./automations/headless-agent-executor.js"
import { getCatalog } from "./mcp/index.js"
import { buildCapabilityToolTree, createCapabilityRegistryContext } from "./mcp/capability-registry.js"
import { executeMarketplaceCapability } from "./mcp/marketplace-capabilities.js"
import { resolveMcpMemberIdentity } from "./mcp/external-capabilities.js"
import { DEN_MCP_REQUESTED_SCOPES } from "./mcp/scopes.js"
import { registerMeRoutes } from "./routes/me/index.js"
import { registerOrgRoutes } from "./routes/org/index.js"
import { registerTelemetryRoutes } from "./routes/telemetry/index.js"
import { registerVersionRoutes } from "./routes/version/index.js"
import { registerFeatureRoutes } from "./routes/features/index.js"
import { registerWebhookRoutes } from "./routes/webhooks/index.js"
import { registerWorkerRoutes } from "./routes/workers/index.js"
import type { AuthContextVariables } from "./session.js"
import { sessionMiddleware } from "./session.js"
import { preclaimScopeMiddleware } from "./middleware/preclaim-scope.js"
import { auditRequestMiddleware } from "./audit/request-capture.js"
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

// Deny-by-default, mirroring the route guards: every operation requires a
// session token or an organization API key unless its describeRoute declares
// its own `security` (an empty array marks a public route). Declared at
// document level and copied onto every operation that declares none, so tools
// that ignore document-level security still see it.
const defaultOperationSecurity: Array<Record<string, string[]>> = [{ denApiKey: [] }, { bearerAuth: [] }]
const openApiOperationMethods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const

type OpenApiDocument = Awaited<ReturnType<typeof generateSpecs>>

function withExplicitOperationSecurity(document: OpenApiDocument): OpenApiDocument {
  for (const pathItem of Object.values(document.paths ?? {})) {
    if (!pathItem) continue
    for (const method of openApiOperationMethods) {
      const operation = pathItem[method]
      if (operation && operation.security === undefined) {
        operation.security = defaultOperationSecurity
      }
    }
  }
  return document
}

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
if (!env.corsHandledByEdge) {
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
}

const corsLogger = appLogger.child({ component: "cors" })
const WEB_ORIGIN_LOOKUP_FAILURE_LOG_INTERVAL_MS = 60_000
let lastWebOriginLookupFailureLoggedAt = 0

// Operator CORS_ORIGINS plus the exact origins organizations approved in
// Org settings. The database list is cached per process for 30 seconds and a
// lookup failure fails closed rather than failing the request.
async function resolveStrictCorsOrigin(origin: string) {
  if (!origin) return null
  if (env.corsOrigins.includes(origin)) return origin
  try {
    return await isWebOriginApprovedByAnyOrganization(origin) ? origin : null
  } catch (error) {
    const now = Date.now()
    if (now - lastWebOriginLookupFailureLoggedAt >= WEB_ORIGIN_LOOKUP_FAILURE_LOG_INTERVAL_MS) {
      lastWebOriginLookupFailureLoggedAt = now
      corsLogger.warn("approved web origin lookup failed; denying CORS", {
        error_name: error instanceof Error ? error.name : typeof error,
      })
    }
    return null
  }
}

if (!env.corsHandledByEdge) {
  app.use(
    "*",
    cors({
      origin: resolveStrictCorsOrigin,
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "X-Api-Key", "X-Request-Id", "X-OpenWork-Legacy-Org-Id", "X-OpenWork-Org-Id", "X-OpenWork-Audit-Correlation"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["Content-Length", "Content-Disposition", "X-Audit-Next-Cursor", "X-Audit-Snapshot-Sequence", "X-Audit-Resource-Scope"],
      maxAge: 600,
    }),
  )
}

app.use("*", sessionMiddleware)
// Generic operation audit capture (src/audit/request-capture.ts); every route is
// declared in src/audit/routes and checked by scripts/check-audit-route-coverage.ts.
// Registered before preclaimScopeMiddleware so its 403 denials are recorded
// (platform store) against the endpoint they refused.
app.use("*", auditRequestMiddleware)
app.use("/v1/*", preclaimScopeMiddleware)

app.get(
  "/",
  describeRoute({
    tags: ["System"],
    security: [],
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
    security: [],
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
    security: [],
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
registerEmailRoutes(app)
registerCloudRoutes(app)
registerDeprecatedMemoryRoutes(app)
registerDeprecatedSkillHubRoutes(app)
registerDevRoutes(app)
registerMeRoutes(app)
registerAutomationRoutes(app, { enabled: env.automations.runtimeEnabled })
registerOrgRoutes(app)
registerSlackAssistantRoutes(app)
registerWorkbotRoutes(app)
registerVersionRoutes(app)
registerFeatureRoutes(app)
registerWebhookRoutes(app)
registerInternalRoutes(app)
registerWorkerRoutes(app)
registerMcpTokenRoutes(app)
registerMcpRoutes(app)
registerAgentMcpRoutes(app)
registerExternalConnectionProxyRoutes(app)
registerAdminMcpRoutes(app)
registerTelemetryRoutes(app)

configureCloudAgentExecutor({ execute: executeCloudAgent, runtimeAvailable: cloudAgentRuntimeAvailable })
configureHeadlessAgentExecutor((input) => executeHeadlessAgent(input))

configureCloudWorkflowExecutor(async ({ organizationId, ownerMemberId, automationRunId, action }) => {
  const normalizedOrganizationId = normalizeDenTypeId("organization", organizationId)
  const normalizedOwnerMemberId = normalizeDenTypeId("member", ownerMemberId)
  const members = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizedOwnerMemberId),
    eq(MemberTable.organizationId, normalizedOrganizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  const userId = members[0]?.userId
  if (!userId) return { ok: false, message: "The Automation owner is no longer active.", retryable: false }
  const organizationFeatures = await getOrganizationFeatures(normalizedOrganizationId)
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
    generatedArtifactViewsEnabled: env.generatedArtifactViewsEnabled,
    organizationFeatures,
  })
  const result = await executeMarketplaceCapability({
    organizationId,
    member,
    pluginId: action.script.pluginId,
    configObjectId: action.script.configObjectId,
    configObjectVersionId: action.script.configObjectVersionId,
    automationRunId: normalizeDenTypeId("automationRun", automationRunId),
    body: action.input,
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
    return { ok: false, message: result.result.hint ?? "The Workflow could not execute.", retryable: false }
  }
  if (!result.result.receiptId) {
    return { ok: false, message: "The Workflow ran, but its durable artifact receipt could not be recorded.", retryable: true }
  }
  return {
    ok: true,
    value: result.result.value,
    canonicalResult: result.result.canonicalResult ?? JSON.stringify(result.result.value),
    receiptId: result.result.receiptId,
  }
})

let openApiDocument: OpenApiDocument | undefined
const openApiOptions: Parameters<typeof generateSpecs>[1] = {
  documentation: {
    openapi: "3.1.0",
    info: {
      title: "Den API",
      version: env.serviceVersion,
      contact: {
        name: "OpenWork",
        url: "https://openworklabs.com",
        email: "team@openworklabs.com",
      },
      license: {
        name: "OpenWork Enterprise Edition License",
        url: "https://github.com/different-ai/openwork/blob/dev/ee/LICENSE",
      },
      description: [
        "OpenAPI spec for the Den control plane API.",
        "",
        "Authentication:",
        "- API keys (they start with `den_`) go in the `x-api-key` header as the raw value. Do not send them as `Authorization: Bearer`; that header only accepts Den session tokens, so an API key there returns 401.",
        "  Example: `curl https://api.openworklabs.com/v1/me -H \"x-api-key: den_...\"`.",
        "  API keys resolve to the issuing user and the organization member they were scoped to when created, so they can call ordinary user and organization routes without a separate signed-in session.",
        "- Use `Authorization: Bearer <session-token>` for user-authenticated routes that require a Den session.",
        "- Session-only flows still require a signed-in user session, including organization creation, invitation acceptance, active-organization switching, and MCP token minting.",
        "- Public routes like health and documentation do not require authentication.",
        "",
        "Swagger tip: use the security schemes in the Authorize dialog to set `denApiKey` (your API key) or `bearerAuth` (a session token) before trying protected endpoints.",
      ].join("\n"),
    },
    servers: env.apiPublicUrl ? [{ url: env.apiPublicUrl }] : [],
    security: defaultOperationSecurity,
    // Every tag used by a describeRoute must be registered here; the Spectral
    // gate (operation-tag-defined) fails otherwise. Protocol adapters (SCIM,
    // OAuth) are tagged by protocol. Internal is excluded from the published
    // snapshot (see scripts/generate-openapi-snapshot.ts).
    tags: [
      { name: "System", description: "Service health, readiness, API documentation, and desktop version metadata." },
      { name: "Authentication", description: "Sign-in discovery, administrator bootstrap, OAuth provider connections, and MCP token minting." },
      { name: "OAuth", description: "OAuth 2.0 / OpenID Connect authorization-server and protected-resource metadata and dynamic client registration (RFC 8414, RFC 9728, RFC 7591), used by MCP clients." },
      { name: "SCIM", description: "SCIM 2.0 provisioning endpoints for identity providers (RFC 7644) and the organization SCIM connector management routes." },
      { name: "SSO", description: "Organization single sign-on connector management routes." },
      { name: "Bootstrap", description: "Agent-first provisional workspace setup routes." },
      { name: "Users", description: "Current user and membership routes." },
      { name: "Organizations", description: "Organization creation, context, brand assets, and install links." },
      { name: "Invitations", description: "Invitation preview, acceptance, creation, and cancellation routes." },
      { name: "Members", description: "Organization member management routes." },
      { name: "Roles", description: "Organization custom role management routes." },
      { name: "Teams", description: "Organization team management routes." },
      { name: "API Keys", description: "Organization API key management routes." },
      { name: "Desktop Policies", description: "Desktop app policies applied to the organization, members, or teams." },
      { name: "LLM Providers", description: "Organization LLM provider catalog, configuration, and access routes." },
      { name: "Inference", description: "Organization inference settings." },
      { name: "Inference Providers", description: "Organization inference Gateway providers, model groups, credential sets, access grants, member connections, and usage." },
      { name: "Gateway Usage Limits", description: "Estimated-cost policies, independent member calendar buckets, assignments, and audited usage-extension requests." },
      { name: "Cloud", description: "Organization Cloud instance lifecycle and browser gateway resolution." },
      { name: "Workers", description: "List and delete the organization's workers, including OpenWork Web instances." },
      { name: "Worker Activity", description: "Worker heartbeat and activity reporting routes." },
      { name: "Managed deployments", description: "OpenWork installations in an organization's own cloud account: launch approval, installer milestones and health reports." },
      { name: "Automations", description: "Scheduled Automations, their runs, and desktop runner presence." },
      { name: "Workbot", description: "The signed-in member's single Workbot conversation." },
      { name: "Workflows", description: "Saved Workflows (Code Mode scripts), their versions, snapshots, and views." },
      { name: "Workflow Runs", description: "Durable Workflow run history." },
      { name: "Codemode Runs", description: "Generated Artifact views produced by Code Mode runs." },
      { name: "Apps", description: "Saved reusable apps built from Workflows and Artifact views, and their sharing." },
      { name: "Config Objects", description: "Versioned configuration objects (skills, workflows, and other plugin content)." },
      { name: "Plugins", description: "Plugin packages, access grants, and imports." },
      { name: "Marketplaces", description: "Marketplaces that distribute plugins to members and teams." },
      { name: "Resources", description: "Aggregated snapshot of the resources and marketplace capabilities available to the caller." },
      { name: "Dashboards", description: "Shared dashboards and their access grants." },
      { name: "Capability Sources", description: "Native provider capabilities (Google Workspace, Microsoft 365) and external MCP connections executed as the calling member." },
      { name: "Direct uploads", description: "Multipart uploads that stream workspace files straight to a provider." },
      { name: "Connectors", description: "Connector accounts and instances (GitHub and other sources) and their sync state." },
      { name: "GitHub", description: "GitHub App installation, repository discovery, and plugin import from GitHub." },
      { name: "Diagnostics", description: "Controlled egress diagnostics for self-hosted deployments." },
      { name: "Telemetry", description: "Telemetry event ingestion and adoption analytics." },
      { name: "Webhooks", description: "Signed inbound webhooks from third-party providers." },
      { name: "Admin", description: "Platform administration routes for allowlisted OpenWork administrators." },
      { name: "Deprecated", description: "Removed features that answer with 410 or an empty result for old clients." },
      { name: "Internal", description: "Runner, scheduled-maintenance and development-only routes; excluded from the published document." },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "session-token",
          description: "Den session token passed as `Authorization: Bearer <session-token>` for user-authenticated Den routes. Not for API keys: send `den_` keys in the `x-api-key` header instead.",
        },
        denApiKey: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "Organization API key passed as the `x-api-key` header. The raw key is the header value; do not prefix it with `Bearer`.",
        },
        mcpAccessToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "MCP access token issued by the Den OAuth authorization server, passed as `Authorization: Bearer <token>`. Used by MCP transports and the direct-upload routes they call.",
        },
        scimBearerToken: {
          type: "http",
          scheme: "bearer",
          description: "SCIM provisioning token issued from `POST /v1/scim/token`, passed by the identity provider as `Authorization: Bearer <token>`.",
        },
        automationRunnerToken: {
          type: "http",
          scheme: "bearer",
          description: "Short-lived Automation runner token issued when a desktop runner registers, passed as `Authorization: Bearer <token>`.",
        },
        maintenanceToken: {
          type: "http",
          scheme: "bearer",
          description: "Deployment maintenance token (DEN_MAINTENANCE_TOKEN) used by scheduled jobs, passed as `Authorization: Bearer <token>`.",
        },
        workerHeartbeatToken: {
          type: "http",
          scheme: "bearer",
          description: "Per-worker heartbeat token passed as `Authorization: Bearer <token>` (or the `x-den-worker-heartbeat-token` header).",
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
}

app.get(
  "/openapi.json",
  describeRoute({
    tags: ["System"],
    security: [],
    summary: "Get OpenAPI document",
    description: "Returns the machine-readable OpenAPI 3.1 document for the Den API so humans and tools can inspect the API surface.",
    responses: {
      200: jsonResponse("OpenAPI document returned successfully.", openApiDocumentSchema),
    },
  }),
  publicRoute,
  async (c) => {
    openApiDocument ??= withExplicitOperationSecurity(await generateSpecs(app, openApiOptions, c))
    return c.json(openApiDocument)
  },
)

app.get(
  "/docs",
  describeRoute({
    tags: ["System"],
    security: [],
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
