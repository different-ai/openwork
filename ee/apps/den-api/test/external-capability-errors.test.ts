import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = process.env.DEN_ALLOW_PRIVATE_MCP_URLS ?? "1"
}

seedRequiredEnv()

let externalCapabilities: typeof import("../src/mcp/external-capabilities.js")

beforeAll(async () => {
  seedRequiredEnv()
  externalCapabilities = await import("../src/mcp/external-capabilities.js")
})

test("upstreamErrorMessage unwraps JSON-RPC errors from the SDK wrapper", () => {
  const message = externalCapabilities.upstreamErrorMessage(new Error('Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"App is not installed on this workspace"}}'))

  expect(message).toContain("App is not installed on this workspace")
  expect(message).toContain("-32600")
  expect(message).not.toContain("Streamable HTTP error")
})

test("upstreamErrorMessage caps non-JSON long messages at 300 characters plus ellipsis", () => {
  const raw = "x".repeat(350)
  const message = externalCapabilities.upstreamErrorMessage(new Error(raw))

  expect(message).toBe(`${"x".repeat(300)}...`)
  expect(message.length).toBe(303)
})

test("upstreamErrorMessage falls back without throwing when JSON-looking content is unparseable", () => {
  const raw = `Streamable HTTP error: {${"not-json".repeat(60)}`
  const message = externalCapabilities.upstreamErrorMessage(new Error(raw))

  expect(message).toBe(`${raw.slice(0, 300)}...`)
})

test("upstreamErrorMessage handles non-Error inputs", () => {
  expect(externalCapabilities.upstreamErrorMessage("plain failure")).toBe("plain failure")
})

test("externalConnectionErrorHint gives reconnect guidance for HTTP auth errors", () => {
  const hint = externalCapabilities.externalConnectionErrorHint("Acme MCP", new StreamableHTTPError(401, "Unauthorized"))

  expect(hint).toContain('The stored credential for "Acme MCP" is invalid or expired')
  expect(hint).toContain('Reconnect "Acme MCP"')
  expect(hint).toContain("OpenWork Cloud itself is still connected")
  expect(hint).toContain("This is a live probe, not a cached result")
})

test("JSON-RPC refresh failures are classified as downstream connector reauthorization", () => {
  const error = new Error('Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Invalid refresh token"}}')
  const message = externalCapabilities.upstreamErrorMessage(error)
  const hint = externalCapabilities.externalConnectionErrorHint("Knowledge Hub", error, message, "per_member")

  expect(externalCapabilities.externalMcpAuthErrorCode(error, message)).toBe("invalid_refresh_token")
  expect(externalCapabilities.isExternalMcpAuthError(error)).toBe(true)
  expect(hint).toContain('Reconnect "Knowledge Hub"')
  expect(hint).toContain("OpenWork Cloud -> Your Connections")
  expect(hint).toContain("OpenWork Cloud itself is still connected")
})

test("invalid_grant is classified without connector-specific special casing", () => {
  const error = new Error("OAuth token refresh failed: invalid_grant")

  expect(externalCapabilities.externalMcpAuthErrorCode(error)).toBe("invalid_grant")
})

test("generic connector recovery routes members and organization admins without provider names", () => {
  const memberStatus = externalCapabilities.buildExternalConnectionStatus({
    connection: { id: "connection-1", name: "Knowledge Hub", authType: "oauth", credentialMode: "per_member" },
    state: "reauth_required",
    errorCode: "invalid_refresh_token",
    message: "Invalid refresh token",
  })
  const networkStatus = externalCapabilities.buildExternalConnectionStatus({
    connection: { id: "connection-2", name: "Ticketing", authType: "none", credentialMode: "shared" },
    state: "provider_error",
    errorCode: "provider_error",
    message: "Connection refused",
  })
  const apiKeyStatus = externalCapabilities.buildExternalConnectionStatus({
    connection: { id: "connection-3", name: "CRM", authType: "apikey", credentialMode: "shared" },
    state: "reauth_required",
    errorCode: "unauthorized",
    message: "Unauthorized",
  })

  expect(memberStatus).toMatchObject({
    layer: "downstream_provider",
    connectionName: "Knowledge Hub",
    actor: "member",
    action: { type: "reconnect", surface: "openwork_your_connections" },
  })
  expect(networkStatus).toMatchObject({
    connectionName: "Ticketing",
    actor: "organization_admin",
    action: { type: "inspect_connection", surface: "openwork_organization_connections" },
  })
  expect(apiKeyStatus).toMatchObject({
    authType: "apikey",
    actor: "organization_admin",
    action: { type: "update_credentials", surface: "openwork_organization_connections" },
  })
})

test("reauth-required overrides generic provider ownership from a refresh diagnostic", () => {
  const status = externalCapabilities.buildExternalConnectionStatus({
    connection: { id: "connection-refresh", name: "Research Vault", authType: "oauth", credentialMode: "per_member" },
    state: "reauth_required",
    errorCode: "unauthorized",
    message: "The authorization server rejected the token refresh exchange.",
    diagnostic: {
      referenceId: "req_refresh",
      phase: "CONTINUITY_REFRESH",
      category: "http_failure",
      code: "MCP_HTTP_400",
      highestPassed: "reachable",
      retryable: false,
      actionOwner: "provider_admin",
      operatorAction: "Inspect provider and proxy logs.",
      message: "The authorization server rejected the token refresh exchange.",
      httpStatus: 400,
    },
  })

  expect(status).toMatchObject({
    state: "reauth_required",
    actor: "member",
    action: {
      type: "reconnect",
      label: "Reconnect Research Vault",
      surface: "openwork_your_connections",
    },
  })
  expect("diagnostic" in status).toBe(false)
})

test("provider installation failures route to the provider admin console", () => {
  const status = externalCapabilities.buildExternalConnectionStatus({
    connection: { id: "connection-4", name: "Documents", authType: "oauth", credentialMode: "shared" },
    state: "provider_error",
    errorCode: "provider_error",
    message: "App is not installed on this workspace",
  })

  expect(status).toMatchObject({
    actor: "provider_admin",
    action: { type: "fix_provider", surface: "provider_admin_console" },
  })
})

test("structured diagnostics remain the single source of truth for fix ownership", async () => {
  const { ExternalMcpDiagnosticTracker } = await import("../src/capability-sources/external-mcp-diagnostics.js")
  const cause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" })
  const diagnostic = new ExternalMcpDiagnosticTracker("req_network_owner").error(
    new Error("fetch failed", { cause }),
    "MCP_INITIALIZE",
  ).diagnostic
  const status = externalCapabilities.buildExternalConnectionStatus({
    connection: { id: "connection-network", name: "Ticketing", authType: "none", credentialMode: "shared" },
    state: "provider_error",
    errorCode: "provider_error",
    message: diagnostic.message,
    diagnostic,
  })

  expect(diagnostic.actionOwner).toBe("network_admin")
  expect(status).toMatchObject({
    actor: diagnostic.actionOwner,
    action: {
      type: "fix_network",
      label: diagnostic.operatorAction,
      surface: "network_infrastructure",
    },
  })
  expect("diagnostic" in status).toBe(false)
})

test("generic provider failures route to connector inspection instead of cloud reauthorization", () => {
  const hint = externalCapabilities.externalConnectionErrorHint("Ticketing", new Error("Connection refused"))

  expect(hint).toContain('inspect "Ticketing"')
  expect(hint).toContain("dashboard -> Connections")
  expect(hint).toContain("OpenWork Cloud itself is still connected")
  expect(hint).not.toContain("Reconnect OpenWork Cloud")
})

test("externalConnectionErrorHint gives provider-admin guidance for JSON-RPC rejections", () => {
  const error = new Error('Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"App is not installed on this workspace"}}')
  const hint = externalCapabilities.externalConnectionErrorHint("Acme MCP", error)

  expect(hint).toContain("The provider's server rejected the request")
  expect(hint).toContain("App is not installed on this workspace")
  expect(hint).toContain("-32600")
  expect(hint).toContain("provider's own admin console")
  expect(hint).toContain("This is a live probe, not a cached result")
  expect(hint).not.toContain("expired")
  expect(externalCapabilities.isExternalMcpAuthError(error)).toBe(false)
})
