import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { McpAuthResourceContext } from "../src/mcp/auth.js"

const GRANT_CLAIM = "https://openworklabs.com/grant_id"
const AGENT_RESOURCE = "http://127.0.0.1:8790/mcp/agent"
let jwtPayload: Record<string, unknown> = {}
let mcpAuth: typeof import("../src/mcp/auth.js")
let grantLiveness: typeof import("../src/mcp/grant-liveness.js")
let sessionLiveness: typeof import("../src/mcp/session-liveness.js")

const AuthSessionTable = { id: "session.id", expiresAt: "session.expiresAt" }
const AuthUserTable = { id: "user.id" }
const InvitationTable = { id: "invitation.id" }
const MemberTable = { id: "member.id", userId: "member.userId", organizationId: "member.organizationId", removedAt: "member.removedAt" }
const OAuthAccessTokenTable = { token: "access.token", sessionId: "access.sessionId" }
const OAuthConsentTable = { id: "consent.id" }
const OAuthRefreshTokenTable = { sessionId: "refresh.sessionId" }
const OrganizationTable = { id: "organization.id" }

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

function agentResourceContext(requestId: string): McpAuthResourceContext {
  return {
    route: "agent",
    resourceUrl: AGENT_RESOURCE,
    metadataUrl: "http://127.0.0.1:8790/.well-known/oauth-protected-resource/mcp/agent",
    oauthResources: [AGENT_RESOURCE],
    firstPartyResources: ["http://127.0.0.1:8790/mcp", AGENT_RESOURCE],
    requestId,
  }
}

function validMcpJwtPayload(includeGrant: boolean) {
  const payload: Record<string, unknown> = {
    sub: createDenTypeId("user"),
    aud: AGENT_RESOURCE,
    scope: "mcp:read mcp:write",
    sid: createDenTypeId("session"),
    "https://openworklabs.com/token_use": "mcp",
    "https://openworklabs.com/resource": AGENT_RESOURCE,
    "https://openworklabs.com/org_id": createDenTypeId("organization"),
  }
  if (includeGrant) {
    payload[GRANT_CLAIM] = createDenTypeId("oauthConsent")
  }
  return payload
}

async function verify(requestId: string) {
  return mcpAuth.verifyMcpRequest(new Headers({
    authorization: "Bearer header.payload.signature",
  }), agentResourceContext(requestId))
}

beforeAll(async () => {
  seedRequiredEnv()
  mock.module("@openwork-ee/den-db/schema", () => ({
    AuthSessionTable,
    AuthUserTable,
    InvitationTable,
    MemberTable,
    OAuthAccessTokenTable,
    OAuthConsentTable,
    OAuthRefreshTokenTable,
    OrganizationTable,
  }))
  mock.module("@openwork-ee/den-db/drizzle", () => ({
    and: (...conditions: unknown[]) => ({ conditions }),
    asc: (field: unknown) => field,
    eq: (field: unknown, value: unknown) => ({ field, value }),
    gt: (field: unknown, value: unknown) => ({ field, value }),
    isNull: (field: unknown) => ({ field }),
    lt: (field: unknown, value: unknown) => ({ field, value }),
    lte: (field: unknown, value: unknown) => ({ field, value }),
  }))
  mock.module("../src/auth.js", () => ({
    auth: {
      handler: () => Promise.resolve(Response.json({ keys: [] })),
    },
    DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
    DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
    DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp", AGENT_RESOURCE],
    DEN_MCP_GRANT_ID_CLAIM: GRANT_CLAIM,
    DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
    DEN_MCP_OAUTH_RESOURCE: AGENT_RESOURCE,
    DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
    DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
    DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
  }))
  mock.module("../src/db.js", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: createDenTypeId("member"), role: "member" }]),
          }),
        }),
      }),
    },
  }))
  mock.module("better-auth/oauth2", () => ({
    verifyJwsAccessToken: () => Promise.resolve(jwtPayload),
  }))

  const modules = await Promise.all([
    import("../src/mcp/auth.js"),
    import("../src/mcp/grant-liveness.js"),
    import("../src/mcp/session-liveness.js"),
  ])
  mcpAuth = modules[0]
  grantLiveness = modules[1]
  sessionLiveness = modules[2]
})

afterAll(() => {
  mock.restore()
})

test("grant-claim tokens stay valid without consulting their dead login session", async () => {
  jwtPayload = validMcpJwtPayload(true)
  let grantChecks = 0
  let sessionChecks = 0
  const restoreGrant = grantLiveness.setMcpGrantLivenessDependenciesForTest({
    select: ({ normalizedGrantId }) => {
      grantChecks += 1
      return Promise.resolve([{ id: normalizedGrantId }])
    },
  })
  const restoreSession = sessionLiveness.setMcpSessionLivenessDependenciesForTest({
    select: () => {
      sessionChecks += 1
      return Promise.resolve([])
    },
  })

  try {
    const principal = await verify("req_live_grant")
    expect(principal).not.toBeInstanceOf(Response)
    if (!(principal instanceof Response)) {
      expect(principal.organizationId).toBe(jwtPayload["https://openworklabs.com/org_id"])
    }
    expect(grantChecks).toBe(1)
    expect(sessionChecks).toBe(0)
  } finally {
    restoreGrant()
    restoreSession()
  }
})

test("missing grant claims return an invalid_token revocation response", async () => {
  jwtPayload = validMcpJwtPayload(true)
  const restoreGrant = grantLiveness.setMcpGrantLivenessDependenciesForTest({
    select: () => Promise.resolve([]),
  })

  try {
    const response = await verify("req_missing_grant")
    expect(response).toBeInstanceOf(Response)
    if (response instanceof Response) {
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"')
      await expect(response.json()).resolves.toMatchObject({
        error: "mcp_grant_revoked",
        oauthError: "invalid_token",
        referenceId: "req_missing_grant",
      })
    }
  } finally {
    restoreGrant()
  }
})

test("grant liveness outages return retryable 503 responses", async () => {
  jwtPayload = validMcpJwtPayload(true)
  const originalError = console.error
  console.error = () => undefined
  const restoreGrant = grantLiveness.setMcpGrantLivenessDependenciesForTest({
    select: () => Promise.reject(new Error("grant store unavailable")),
  })

  try {
    const response = await verify("req_grant_failure")
    expect(response).toBeInstanceOf(Response)
    if (response instanceof Response) {
      expect(response.status).toBe(503)
      expect(response.headers.get("retry-after")).toBe("10")
      expect(response.headers.get("www-authenticate")).toBeNull()
      await expect(response.json()).resolves.toMatchObject({
        error: "mcp_grant_check_unavailable",
        referenceId: "req_grant_failure",
      })
    }
  } finally {
    restoreGrant()
    console.error = originalError
  }
})

test("older sid-only tokens still die with their revoked session", async () => {
  jwtPayload = validMcpJwtPayload(false)
  let grantChecks = 0
  const restoreGrant = grantLiveness.setMcpGrantLivenessDependenciesForTest({
    select: () => {
      grantChecks += 1
      return Promise.resolve([])
    },
  })
  const restoreSession = sessionLiveness.setMcpSessionLivenessDependenciesForTest({
    select: () => Promise.resolve([]),
  })

  try {
    const response = await verify("req_dead_legacy_session")
    expect(response).toBeInstanceOf(Response)
    if (response instanceof Response) {
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toMatchObject({
        error: "mcp_session_revoked",
        oauthError: "invalid_token",
        referenceId: "req_dead_legacy_session",
      })
    }
    expect(grantChecks).toBe(0)
  } finally {
    restoreGrant()
    restoreSession()
  }
})
