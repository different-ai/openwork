import { beforeAll, expect, test } from "bun:test"

type DenApiApp = typeof import("../src/app.js").default

let app: DenApiApp | null = null
let explicitAuthGuards = new Set<unknown>()
let hasExplicitAuthGuardHandler: (handler: unknown) => boolean = () => false

const routeGuardExceptions = new Map<string, string>([
  ["GET /", "public marketing redirect"],
  ["GET /health", "public health check"],
  ["GET /openapi.json", "public API schema"],
  ["GET /docs", "public API documentation"],
  ["GET /v1/app-version", "public desktop update metadata"],
  ["GET /api/auth/.well-known/oauth-authorization-server", "public OAuth metadata"],
  ["GET /api/auth/.well-known/openid-configuration", "public OIDC metadata"],
  ["GET /.well-known/oauth-authorization-server/api/auth", "public OAuth metadata"],
  ["GET /.well-known/openid-configuration/api/auth", "public OIDC metadata"],
  ["GET /.well-known/oauth-authorization-server", "public OAuth metadata"],
  ["GET /.well-known/openid-configuration", "public OIDC metadata"],
  ["POST /register", "MCP OAuth dynamic client registration policy validates the request"],
  ["POST /api/auth/oauth2/register", "MCP OAuth dynamic client registration policy validates the request"],
  ["GET /api/auth/oauth2/authorize", "Better Auth OAuth authorization endpoint"],
  ["ALL /api/auth/sso/saml2/callback/*", "SAML response policy validates callback responses before Better Auth"],
  ["ALL /api/auth/sso/saml2/sp/acs/*", "SAML response policy validates ACS responses before Better Auth"],
  ["GET /api/auth/*", "Better Auth route mount"],
  ["POST /api/auth/*", "Better Auth route mount"],
  ["PUT /api/auth/*", "Better Auth route mount"],
  ["PATCH /api/auth/*", "Better Auth route mount"],
  ["DELETE /api/auth/*", "Better Auth route mount"],
  ["POST /v1/auth/desktop-handoff/exchange", "short-lived desktop handoff grant exchange"],
  ["POST /api/auth/scim/generate-token", "SCIM management route is explicitly disabled"],
  ["GET /api/auth/scim/list-provider-connections", "SCIM management route is explicitly disabled"],
  ["GET /api/auth/scim/get-provider-connection", "SCIM management route is explicitly disabled"],
  ["POST /api/auth/scim/delete-provider-connection", "SCIM management route is explicitly disabled"],
  ["ALL /api/auth/scim/v2/Groups", "SCIM group route is explicitly unsupported"],
  ["ALL /api/auth/scim/v2/Groups/:groupId", "SCIM group route is explicitly unsupported"],
  ["POST /api/auth/scim/v2/Users", "SCIM bearer token is validated by Better Auth"],
  ["PUT /api/auth/scim/v2/Users/:userId", "SCIM bearer token is validated by Better Auth"],
  ["PATCH /api/auth/scim/v2/Users/:userId", "SCIM bearer token is validated by Better Auth"],
  ["DELETE /api/auth/scim/v2/Users/:userId", "SCIM bearer token is validated before forwarding"],
  ["GET /v1/orgs/invitations/preview", "public invitation preview by invitation id"],
  ["GET /v1/orgs/sso/resolve", "public SSO domain discovery"],
  ["ALL /v1/orgs/:orgId/*", "legacy proxy forwards to guarded /v1 routes"],
  ["POST /v1/webhooks/connectors/github", "GitHub webhook signature is validated in-handler"],
  ["POST /v1/webhooks/stripe", "Stripe webhook signature is validated in-handler"],
  ["POST /v1/workers/:id/activity-heartbeat", "worker heartbeat token is validated in-handler"],
  ["GET /.well-known/oauth-protected-resource", "public OAuth protected-resource metadata"],
  ["GET /.well-known/oauth-protected-resource/mcp", "public OAuth protected-resource metadata"],
  ["GET /mcp/.well-known/oauth-protected-resource", "public OAuth protected-resource metadata"],
  ["ALL /mcp", "MCP request JWT is validated in-handler"],
  ["ALL /mcp/admin", "MCP request JWT plus admin allowlist are validated in-handler"],
])

function routeKey(input: { method: string; path: string }) {
  return `${input.method} ${input.path}`
}

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

beforeAll(async () => {
  seedRequiredEnv()

  const [appModule, middlewareModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/middleware/index.js"),
  ])

  app = appModule.default
  explicitAuthGuards = new Set<unknown>([
    middlewareModule.requireAdminMiddleware,
    middlewareModule.requireUserMiddleware,
    middlewareModule.resolveOrganizationContextMiddleware,
    middlewareModule.resolveUserOrganizationsMiddleware,
  ])
  hasExplicitAuthGuardHandler = middlewareModule.hasExplicitAuthGuardHandler
})

function routeChains() {
  if (!app) {
    throw new Error("den-api app was not loaded")
  }

  const chains = new Map<string, unknown[]>()

  for (const route of app.routes) {
    if (route.path === "/*") {
      continue
    }

    const key = routeKey(route)
    const handlers = chains.get(key) ?? []
    handlers.push(route.handler)
    chains.set(key, handlers)
  }

  return chains
}

test("registered den-api routes require an auth guard or explicit exception", () => {
  const chains = routeChains()
  const uncoveredRoutes = Array.from(chains.entries())
    .filter(([key, handlers]) => {
      if (routeGuardExceptions.has(key)) {
        return false
      }

      return !handlers.some((handler) => explicitAuthGuards.has(handler) || hasExplicitAuthGuardHandler(handler))
    })
    .map(([key]) => key)
    .sort()

  expect(uncoveredRoutes).toEqual([])
})

test("route guard exceptions stay tied to registered routes", () => {
  const chains = routeChains()
  const missingExceptions = Array.from(routeGuardExceptions.keys())
    .filter((key) => !chains.has(key))
    .sort()

  expect(missingExceptions).toEqual([])
})
