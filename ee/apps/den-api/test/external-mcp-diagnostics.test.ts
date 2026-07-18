import { describe, expect, test } from "bun:test"
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { EnterpriseMcpOAuthContractError } from "@openwork/enterprise-mcp-client"
import {
  ExternalMcpDiagnosticTracker,
  catalogDiagnosticError,
  createExternalMcpDiagnosticFetch,
  externalMcpDiagnosticForLog,
  safeExternalMcpEndpointForLog,
  safeExternalMcpCauseChain,
} from "../src/capability-sources/external-mcp-diagnostics.js"
import { PrivateUrlError } from "../src/capability-sources/url-guard.js"
import { connectCallbackPage } from "../src/capability-sources/oauth-callback-page.js"

process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DEN_DB_ENCRYPTION_KEY ??= "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET ??= "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"
process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"

function networkError(code: string, secret = "Bearer super-secret-token") {
  const cause = new Error(secret)
  Object.defineProperties(cause, {
    code: { value: code, enumerable: true },
    errno: { value: -61, enumerable: true },
    syscall: { value: "connect", enumerable: true },
  })
  return new Error("fetch failed", { cause })
}

function captureConsoleError<T>(run: () => T): { result: T; errors: unknown[][] } {
  const errors: unknown[][] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    return { result: run(), errors }
  } finally {
    console.error = originalError
  }
}

function serializedConsoleErrors(errors: unknown[][]): string {
  return errors
    .flat()
    .map((entry) => {
      const serialized = typeof entry === "string" ? entry : JSON.stringify(entry)
      return serialized ?? ""
    })
    .join(" ")
}

class RecordingOAuthProvider implements OAuthClientProvider {
  client: OAuthClientInformationMixed | undefined
  tokensValue: OAuthTokens | undefined
  savedClients = 0
  savedTokens = 0
  savedVerifiers = 0
  redirects = 0

  constructor(input: {
    client?: OAuthClientInformationMixed
    tokens?: OAuthTokens
  } = {}) {
    this.client = input.client
    this.tokensValue = input.tokens
  }

  get redirectUrl(): string {
    return "https://den.example.test/v1/mcp/callback"
  }

  get clientMetadata() {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "OpenWork deadline test",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.client
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.client = clientInformation
    this.savedClients += 1
  }

  tokens(): OAuthTokens | undefined {
    return this.tokensValue
  }

  saveTokens(tokens: OAuthTokens): void {
    this.tokensValue = tokens
    this.savedTokens += 1
  }

  redirectToAuthorization(): void {
    this.redirects += 1
  }

  saveCodeVerifier(): void {
    this.savedVerifiers += 1
  }

  codeVerifier(): string {
    return "test-pkce-verifier"
  }
}

describe("external MCP diagnostics", () => {
  test("maps enterprise OAuth contract expirations to specific owners and actions", () => {
    const cases = [
      {
        code: "MCP_OAUTH_AUTHORIZATION_EXPIRED" as const,
        phase: "AUTH_TOKEN_ACQUISITION",
        owner: "member",
      },
      {
        code: "MCP_OAUTH_CLIENT_EXPIRED" as const,
        phase: "AUTH_CLIENT_REGISTRATION",
        owner: "organization_admin",
      },
      {
        code: "MCP_OAUTH_CREDENTIAL_EXPIRED" as const,
        phase: "CONTINUITY_REFRESH",
        owner: "member",
      },
    ]
    for (const entry of cases) {
      const diagnostic = new ExternalMcpDiagnosticTracker(`req_${entry.code}`).error(
        new EnterpriseMcpOAuthContractError(entry.code, "safe contract failure"),
        "AUTH_TOKEN_ACQUISITION",
      ).diagnostic
      expect(diagnostic.code).toBe(entry.code)
      expect(diagnostic.phase).toBe(entry.phase)
      expect(diagnostic.actionOwner).toBe(entry.owner)
      expect(diagnostic.operatorAction.length).toBeGreaterThan(0)
    }
  })
  test("Turbo propagates the configured public Den API URL into local runtime tasks", async () => {
    const turboConfig: unknown = await Bun.file(new URL("../../../../turbo.json", import.meta.url)).json()
    expect(turboConfig).toHaveProperty("globalEnv")
    if (typeof turboConfig !== "object" || turboConfig === null || !("globalEnv" in turboConfig) || !Array.isArray(turboConfig.globalEnv)) {
      throw new Error("turbo.json globalEnv is not an array")
    }
    expect(turboConfig.globalEnv).toContain("DEN_API_PUBLIC_URL")
  })

  test.each([
    ["ENOTFOUND", "NETWORK_DNS", "dns_failure", "MCP_ENOTFOUND"],
    ["ECONNREFUSED", "NETWORK_TCP", "network_failure", "MCP_ECONNREFUSED"],
    ["ETIMEDOUT", "NETWORK_TCP", "network_failure", "MCP_ETIMEDOUT"],
    ["CERT_HAS_EXPIRED", "NETWORK_TLS", "tls_failure", "MCP_CERT_HAS_EXPIRED"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "NETWORK_TLS", "tls_failure", "MCP_UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
  ])("classifies %s without exposing the wrapped message", (code, phase, category, diagnosticCode) => {
    const tracker = new ExternalMcpDiagnosticTracker("req_test")
    tracker.passed("HTTP_ROUTING", "reachable")
    const error = tracker.error(networkError(code))

    expect(error.diagnostic).toMatchObject({
      referenceId: "req_test",
      phase,
      category,
      code: diagnosticCode,
      highestPassed: "reachable",
    })
    expect(JSON.stringify(externalMcpDiagnosticForLog(error, "ignored", "MCP_INITIALIZE"))).not.toContain("super-secret-token")
  })

  test("fails closed for blocked private URLs", () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_private")
    const error = tracker.error(new PrivateUrlError("http://169.254.169.254", "metadata address"))
    expect(error.diagnostic).toMatchObject({
      phase: "CONFIGURATION",
      category: "security_blocked",
      code: "MCP_URL_BLOCKED",
      retryable: false,
    })
    expect(error.diagnostic.message).not.toContain("169.254.169.254")
  })

  test("classifies Node fetch forbidden ports as configuration, not protocol failure", () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_bad_port")
    tracker.begin("MCP_INITIALIZE")
    const error = tracker.error(new TypeError("fetch failed", { cause: new Error("bad port") }))
    expect(error.diagnostic).toMatchObject({
      phase: "CONFIGURATION",
      operationPhase: "MCP_INITIALIZE",
      category: "unsupported_endpoint_port",
      code: "MCP_FETCH_FORBIDDEN_PORT",
      actionOwner: "organization_admin",
    })
  })

  test("does not infer a forbidden port from arbitrary provider error text", () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_provider_bad_port_words")
    tracker.begin("MCP_TOOL_EXECUTION")
    const error = tracker.error(new Error("Provider ticket says bad port in requested ticket"))
    expect(error.diagnostic).toMatchObject({
      phase: "MCP_TOOL_EXECUTION",
      category: "mcp_protocol_failure",
      code: "MCP_MCP_TOOL_EXECUTION",
    })
  })

  test("safe cause chains retain only allowlisted native fields", () => {
    const causes = safeExternalMcpCauseChain(networkError("ECONNRESET", "client_secret=do-not-log"))
    expect(causes).toEqual([
      { name: "Error" },
      { name: "Error", code: "ECONNRESET", errno: -61, syscall: "connect" },
    ])
    expect(JSON.stringify(causes)).not.toContain("do-not-log")
  })

  test("safe cause chains bound attacker-controlled native fields", () => {
    const error = Object.assign(new Error("secret"), {
      name: `Evil access_token=${"x".repeat(100)}`,
      code: "superSecretOpaqueToken123",
      errno: "opaqueSecret123",
      syscall: "send-secret",
    })
    expect(safeExternalMcpCauseChain(error)).toEqual([{ name: "Error" }])
  })

  test("safe endpoint logs omit credentials, query parameters, and fragments", () => {
    const endpoint = safeExternalMcpEndpointForLog("https://user:password@mcp.example.invalid/tenant/server?token=secret#fragment")
    expect(endpoint).toEqual({ origin: "https://mcp.example.invalid", pathHash: "sha256:8ab7ab56bba09945" })
    expect(JSON.stringify(endpoint)).not.toContain("password")
    expect(JSON.stringify(endpoint)).not.toContain("secret")
    expect(JSON.stringify(endpoint)).not.toContain("tenant/server")
  })

  test("tracks discovery fetch phases without retaining request bodies", async () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_discovery")
    const requests: string[] = []
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async (url) => {
        requests.push(String(url))
        return new Response(JSON.stringify({ resource: "https://mcp.example.invalid/mcp" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })

    const response = await diagnosticFetch("https://mcp.example.invalid/.well-known/oauth-protected-resource/mcp")
    expect(response.ok).toBe(true)
    expect(requests).toEqual(["https://mcp.example.invalid/.well-known/oauth-protected-resource/mcp"])

    const error = tracker.error(new Error("later failure"))
    expect(error.diagnostic).toMatchObject({
      phase: "AUTH_RESOURCE_DISCOVERY",
      highestPassed: "reachable",
    })
  })

  test("an HTTP 200 alone never proves MCP protocol readiness", async () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_html")
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
    })
    await diagnosticFetch("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })

    const error = tracker.error(new SyntaxError("Unexpected token '<'"))
    expect(error.diagnostic).toMatchObject({
      phase: "HTTP_ROUTING",
      operationPhase: "MCP_INITIALIZE",
      category: "unexpected_html",
      code: "MCP_HTTP_HTML_RESPONSE",
      highestPassed: "reachable",
    })
  })

  test("an authenticated HTTP response does not prove authorization before MCP parsing", async () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_authorized")
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })
    await diagnosticFetch("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: { authorization: "Bearer must-not-be-retained", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })

    const error = tracker.error(new Error("initialize failed"))
    expect(error.diagnostic.highestPassed).toBe("reachable")
    expect(error.diagnostic).not.toHaveProperty("jsonRpcCode")
    expect(JSON.stringify(error)).not.toContain("must-not-be-retained")
  })

  test.each([
    [404, "HTTP_ROUTING", "MCP_HTTP_404"],
    [406, "MCP_TRANSPORT", "MCP_HTTP_406"],
    [415, "MCP_TRANSPORT", "MCP_HTTP_415"],
    [503, "MCP_INITIALIZE", "MCP_HTTP_503"],
  ])("classifies initialize HTTP %s at the actionable layer", async (status, phase, code) => {
    const tracker = new ExternalMcpDiagnosticTracker(`req_http_${status}`)
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async () => new Response(JSON.stringify({ error: "safe" }), {
        status,
        headers: { "content-type": "application/json", "x-ms-request-id": "provider-request-123" },
      }),
    })
    await diagnosticFetch("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    const error = tracker.error(new Error("SDK parse failure"))
    expect(error.diagnostic).toMatchObject({
      phase,
      ...(phase === "MCP_INITIALIZE" ? {} : { operationPhase: "MCP_INITIALIZE" }),
      code,
      httpStatus: status,
      providerRequestId: "provider-request-123",
    })
  })

  test("distinguishes ServiceNow-style ACL 403 from an OAuth challenge", async () => {
    const makeDiagnostic = async (headers: HeadersInit) => {
      const tracker = new ExternalMcpDiagnosticTracker("req_403")
      const diagnosticFetch = createExternalMcpDiagnosticFetch({
        endpoint: "https://instance.service-now.com/mcp",
        tracker,
        fetch: async () => new Response(JSON.stringify({ error: "denied" }), {
          status: 403,
          headers: { "content-type": "application/json", ...headers },
        }),
      })
      await diagnosticFetch("https://instance.service-now.com/mcp", {
        method: "POST",
        headers: { authorization: "Bearer hidden", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
      })
      return tracker.error(new Error("denied")).diagnostic
    }

    expect(await makeDiagnostic({})).toMatchObject({ phase: "PROVIDER_AUTHORIZATION", code: "MCP_PROVIDER_HTTP_403" })
    expect(await makeDiagnostic({ "www-authenticate": "Bearer error=\"insufficient_scope\"" })).toMatchObject({
      phase: "AUTH_RESOURCE_VALIDATION",
      code: "MCP_OAUTH_INSUFFICIENT_SCOPE",
    })
  })

  test("classifies allowlisted provider tool results without exposing provider content", () => {
    const makeToolError = (referenceId: string, structuredContent: Record<string, unknown>) => {
      const tracker = new ExternalMcpDiagnosticTracker(referenceId)
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return tracker.providerToolError({
        isError: true,
        content: [{ type: "text", text: "provider-secret-message" }],
        structuredContent,
      })
    }

    const { result: toolErrors } = captureConsoleError(() => ({
      denied: makeToolError("req_provider_denied", {
        category: "provider_policy",
        providerStatus: 403,
        providerCode: "sensitive-provider-code",
        requestId: "provider-request-403",
      }),
      throttled: makeToolError("req_provider_throttled", {
        category: "provider_api",
        providerStatus: 429,
        requestId: "provider-request-429",
        retryAfterSeconds: "provider-secret-retry-value",
      }),
      unknown: makeToolError("req_provider_unknown", {
        category: "provider_api",
        providerStatus: 403,
        providerCode: "sensitive-unknown-code",
        requestId: "invalid request id with spaces",
      }),
    }))
    const { denied, throttled, unknown } = toolErrors
    expect(denied.diagnostic).toMatchObject({
      phase: "PROVIDER_AUTHORIZATION",
      category: "provider_policy_denied",
      code: "MCP_PROVIDER_HTTP_403",
      highestPassed: "protocol_ready",
      retryable: false,
      actionOwner: "provider_admin",
      providerRequestId: "provider-request-403",
    })

    expect(throttled.diagnostic).toMatchObject({
      phase: "PROVIDER_EXECUTION",
      category: "provider_throttled",
      code: "MCP_PROVIDER_HTTP_429",
      highestPassed: "protocol_ready",
      retryable: true,
      actionOwner: "provider_admin",
      providerRequestId: "provider-request-429",
    })

    expect(unknown.diagnostic).toMatchObject({
      phase: "PROVIDER_EXECUTION",
      category: "provider_tool_error",
      code: "MCP_PROVIDER_TOOL_ERROR",
      highestPassed: "protocol_ready",
      retryable: false,
      actionOwner: "provider_admin",
    })
    expect(unknown.diagnostic.providerRequestId).toBeUndefined()

    const serialized = JSON.stringify([denied, throttled, unknown])
    expect(serialized).not.toContain("provider-secret-message")
    expect(serialized).not.toContain("sensitive-provider-code")
    expect(serialized).not.toContain("provider-secret-retry-value")
    expect(serialized).not.toContain("sensitive-unknown-code")
    expect(serialized).not.toContain("invalid request id with spaces")
  })

  test("classifies remote invalid params as correctable tool input", () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_invalid_params")
    tracker.begin("MCP_TOOL_EXECUTION")
    const invalidParams = new Error("Provider rejected private argument detail")
    Object.defineProperty(invalidParams, "code", { value: -32602 })

    const error = tracker.error(invalidParams)
    expect(error.diagnostic).toMatchObject({
      phase: "MCP_TOOL_EXECUTION",
      category: "mcp_tool_input_invalid",
      code: "MCP_INVALID_PARAMS",
      actionOwner: "openwork",
      retryable: false,
      jsonRpcCode: -32602,
    })
    expect(error.diagnostic.operatorAction).toContain("do not retry the same arguments")
    expect(JSON.stringify(error.diagnostic)).not.toContain("private argument detail")
  })

  test("classifies structured provider validation errors as correctable tool input", () => {
    const { result: error } = captureConsoleError(() => {
      const tracker = new ExternalMcpDiagnosticTracker("req_provider_invalid_params")
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return tracker.providerToolError({
        isError: true,
        content: [{ type: "text", text: "private provider validation detail" }],
        structuredContent: { category: "invalid_arguments" },
      })
    })

    expect(error.diagnostic).toMatchObject({
      phase: "MCP_TOOL_EXECUTION",
      category: "mcp_tool_input_invalid",
      code: "MCP_PROVIDER_INVALID_PARAMS",
      actionOwner: "openwork",
      retryable: false,
    })
    expect(JSON.stringify(error.diagnostic)).not.toContain("private provider validation detail")
  })

  test("classifies standardized MCP SDK input-validation tool errors without exposing their text", () => {
    const { result: error } = captureConsoleError(() => {
      const tracker = new ExternalMcpDiagnosticTracker("req_sdk_invalid_params")
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return tracker.providerToolError({
        isError: true,
        content: [{
          type: "text",
          text: "Input validation error: Invalid arguments for tool lookup_incident: private provider detail",
        }],
      })
    })

    expect(error.diagnostic).toMatchObject({
      phase: "MCP_TOOL_EXECUTION",
      category: "mcp_tool_input_invalid",
      code: "MCP_PROVIDER_INVALID_PARAMS",
      actionOwner: "openwork",
      retryable: false,
    })
    expect(JSON.stringify(error.diagnostic)).not.toContain("private provider detail")
  })

  test("derives allowlisted provider evidence from ServiceNow-style text JSON", () => {
    const providerText = '{"status":403,"error":"insufficient_acl","requestId":"TXN-abc-123"}'
    const { result: error } = captureConsoleError(() => {
      const tracker = new ExternalMcpDiagnosticTracker("req_servicenow_text")
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return tracker.providerToolError({
        isError: true,
        content: [{ type: "text", text: providerText }],
      })
    })

    expect(error.diagnostic).toMatchObject({
      phase: "PROVIDER_AUTHORIZATION",
      category: "provider_policy_denied",
      code: "MCP_PROVIDER_HTTP_403",
      providerStatus: 403,
      providerCode: "insufficient_acl",
      providerRequestId: "TXN-abc-123",
      highestPassed: "protocol_ready",
    })
    expect(error.diagnostic.payloadBytes ?? 0).toBeGreaterThan(0)
    expect(error.diagnostic.message).toContain("provider status 403")
    expect(error.diagnostic.message).toContain("code insufficient_acl")
    expect(error.diagnostic.message).not.toContain(providerText)
  })

  test("logs Redis-style provider text evidence without surfacing it in the diagnostic", () => {
    const providerText = "All slots are not covered by nodes. 0 of 16384 covered."
    const { result: error, errors } = captureConsoleError(() => {
      const tracker = new ExternalMcpDiagnosticTracker("req_redis_text")
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return tracker.providerToolError({
        isError: true,
        content: [{ type: "text", text: providerText }],
      })
    })

    expect(error.diagnostic).toMatchObject({
      phase: "PROVIDER_EXECUTION",
      category: "provider_tool_error",
      code: "MCP_PROVIDER_TOOL_ERROR",
    })
    expect(error.diagnostic.payloadBytes ?? 0).toBeGreaterThan(0)
    expect(error.diagnostic.message).not.toContain(providerText)

    const loggedText = serializedConsoleErrors(errors)
    expect(loggedText).toContain("external_mcp_provider_tool_evidence")
    expect(loggedText).toContain("req_redis_text")
    expect(loggedText).toContain(providerText)
  })

  test("does not classify mid-sentence provider status-like numbers", () => {
    const { result: error } = captureConsoleError(() => {
      const tracker = new ExternalMcpDiagnosticTracker("req_mid_sentence_status")
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return tracker.providerToolError({
        isError: true,
        content: [{ type: "text", text: "we found 403 records" }],
      })
    })

    expect(error.diagnostic).toMatchObject({
      phase: "PROVIDER_EXECUTION",
      category: "provider_tool_error",
      code: "MCP_PROVIDER_TOOL_ERROR",
    })
    expect(error.diagnostic.providerStatus).toBeUndefined()
  })

  test("keeps empty provider tool content generic with zero payload bytes", () => {
    const { result: error } = captureConsoleError(() => {
      const tracker = new ExternalMcpDiagnosticTracker("req_empty_tool_content")
      tracker.passed("MCP_INITIALIZED", "protocol_ready")
      return tracker.providerToolError({
        isError: true,
        content: [],
      })
    })

    expect(error.diagnostic).toMatchObject({
      phase: "PROVIDER_EXECUTION",
      category: "provider_tool_error",
      code: "MCP_PROVIDER_TOOL_ERROR",
      payloadBytes: 0,
    })
  })

  test("typed OAuth token errors override generic HTTP 400 classification", async () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_invalid_grant")
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async () => new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    })
    await diagnosticFetch("https://login.example.invalid/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "must-not-log" }),
    })
    const oauthError = new Error("Provider body must not be returned")
    oauthError.name = "InvalidGrantError"
    const error = tracker.error(oauthError)
    expect(error.diagnostic).toMatchObject({
      phase: "AUTH_TOKEN_ACQUISITION",
      category: "oauth_token_failure",
      code: "MCP_OAUTH_INVALID_GRANT",
      actionOwner: "member",
      httpStatus: 400,
    })
    expect(JSON.stringify(error)).not.toContain("must-not-log")
  })

  test.each([
    ["InvalidTargetError", "AUTH_RESOURCE_VALIDATION", "oauth_invalid_target", "MCP_OAUTH_INVALID_TARGET"],
    ["InsufficientScopeError", "AUTH_RESOURCE_VALIDATION", "oauth_insufficient_scope", "MCP_OAUTH_INSUFFICIENT_SCOPE"],
    ["UnsupportedTokenTypeError", "AUTH_TOKEN_ACQUISITION", "oauth_unsupported_token_type", "MCP_OAUTH_UNSUPPORTED_TOKEN_TYPE"],
  ])("typed %s overrides generic token HTTP 400 classification", async (name, phase, category, code) => {
    const tracker = new ExternalMcpDiagnosticTracker(`req_${name}`)
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async () => new Response(JSON.stringify({ error: "must-not-return" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    })
    await diagnosticFetch("https://login.example.invalid/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "must-not-log" }),
    })
    const oauthError = new Error("Provider body must not be returned")
    oauthError.name = name
    const error = tracker.error(oauthError)
    expect(error.diagnostic).toMatchObject({
      phase,
      category,
      code,
      httpStatus: 400,
    })
    expect(JSON.stringify(error)).not.toContain("must-not-log")
  })

  test.each([
    ["MethodNotAllowedError", "oauth_method_not_allowed", "MCP_OAUTH_METHOD_NOT_ALLOWED", false],
    ["TooManyRequestsError", "oauth_provider_throttled", "MCP_OAUTH_TOO_MANY_REQUESTS", true],
  ])("classifies typed %s without exposing provider text", (name, category, code, retryable) => {
    const tracker = new ExternalMcpDiagnosticTracker(`req_${name}`)
    tracker.begin("AUTH_TOKEN_ACQUISITION")
    const oauthError = new Error("client_secret=must-not-return")
    oauthError.name = name
    const error = tracker.error(oauthError)
    expect(error.diagnostic).toMatchObject({
      phase: "AUTH_TOKEN_ACQUISITION",
      category,
      code,
      retryable,
    })
    expect(JSON.stringify(error.diagnostic)).not.toContain("must-not-return")
  })

  test("does not treat a bare unauthenticated 401 as OAuth discovery", async () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_bare_401")
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async () => new Response(null, { status: 401 }),
    })
    await diagnosticFetch("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    expect(tracker.error(new Error("SDK rejected the response")).diagnostic).toMatchObject({
      phase: "MCP_INITIALIZE",
      category: "http_failure",
      code: "MCP_HTTP_401",
      httpStatus: 401,
    })
  })

  test("maps bounded SDK protocol incompatibility errors to MCP_VERSION", () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_version")
    tracker.passed("MCP_TRANSPORT", "reachable")
    const error = tracker.error(new Error("Server protocol version 2024-01-01 is not supported"), "MCP_INITIALIZE")
    expect(error.diagnostic).toMatchObject({
      phase: "MCP_VERSION",
      operationPhase: "MCP_INITIALIZE",
      category: "mcp_version_mismatch",
      code: "MCP_UNSUPPORTED_VERSION",
      highestPassed: "reachable",
    })
  })

  test("produces bounded catalog errors with no cursor value", () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_catalog")
    tracker.passed("MCP_INITIALIZE", "protocol_ready")
    const error = catalogDiagnosticError({
      tracker,
      code: "MCP_CATALOG_CURSOR_LOOP",
      operatorAction: "Fix the provider's repeated tools/list cursor.",
    })
    expect(error.diagnostic).toMatchObject({
      phase: "MCP_TOOL_DISCOVERY",
      category: "mcp_catalog",
      code: "MCP_CATALOG_CURSOR_LOOP",
      highestPassed: "protocol_ready",
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toContain("cursor-secret")
  })

  test("callback failures render only the safe diagnostic message and reference", () => {
    const tracker = new ExternalMcpDiagnosticTracker("req_callback")
    tracker.begin("AUTH_TOKEN_ACQUISITION")
    const error = tracker.error(new Error("client_secret=hidden access_token=hidden Bearer hidden"))
    const html = connectCallbackPage({
      ok: false,
      name: "Enterprise MCP <test>",
      message: error.diagnostic.message,
      referenceId: error.diagnostic.referenceId,
    })

    expect(html).toContain("Diagnostic reference: <code>req_callback</code>")
    expect(html).toContain("Enterprise MCP &lt;test&gt;")
    expect(html).not.toContain("client_secret")
    expect(html).not.toContain("access_token")
    expect(html).not.toContain("Bearer hidden")
  })

  test("successful callbacks stay in the browser without opening the desktop app", () => {
    const html = connectCallbackPage({ ok: true, name: "Enterprise MCP <test>" })

    expect(html).toContain("You're connected")
    expect(html).toContain("Enterprise MCP &lt;test&gt; is connected to OpenWork.")
    expect(html).toContain("window.close()")
    expect(html).toContain("Close window")
    expect(html).not.toContain("openwork://")
    expect(html).not.toContain("Open OpenWork")
  })

  test("exhausts paginated tool catalogs exactly once", async () => {
    const { collectExternalMcpToolPages } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_pages")
    diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
    const cursors: (string | undefined)[] = []
    const tools = await collectExternalMcpToolPages({
      diagnostic,
      listPage: async (cursor) => {
        cursors.push(cursor)
        return cursor
          ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
          : { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" }
      },
    })

    expect(cursors).toEqual([undefined, "page-2"])
    expect(tools.map((tool) => tool.name)).toEqual(["first", "second"])
  })

  test("stops repeated tool cursors without disclosing the cursor", async () => {
    const { collectExternalMcpToolPages } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_loop")
    diagnostic.passed("MCP_INITIALIZED", "protocol_ready")
    let caught: unknown
    try {
      await collectExternalMcpToolPages({
        diagnostic,
        listPage: async () => ({
          tools: [],
          nextCursor: "opaque-secret-cursor",
        }),
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    if (!(caught instanceof Error)) throw new Error("Expected cursor loop to throw")
    expect(caught).toHaveProperty("diagnostic.code", "MCP_CATALOG_CURSOR_LOOP")
    expect(JSON.stringify(caught)).not.toContain("opaque-secret-cursor")
  })

  test("rejects duplicate tool names across catalog pages", async () => {
    const { collectExternalMcpToolPages } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_duplicate")
    await expect(collectExternalMcpToolPages({
      diagnostic,
      listPage: async (cursor) => cursor
        ? { tools: [{ name: "duplicate", inputSchema: { type: "object" } }] }
        : { tools: [{ name: "duplicate", inputSchema: { type: "object" } }], nextCursor: "next" },
    })).rejects.toHaveProperty("diagnostic.code", "MCP_CATALOG_DUPLICATE_TOOL")
  })

  test.each([
    ["name", { name: "n".repeat(513), inputSchema: { type: "object" } }, "MCP_CATALOG_TOOL_NAME_LIMIT"],
    ["title", { name: "valid", title: "t".repeat(4 * 1024 + 1), inputSchema: { type: "object" } }, "MCP_CATALOG_TOOL_TITLE_LIMIT"],
    ["description", { name: "valid", description: "d".repeat(64 * 1024 + 1), inputSchema: { type: "object" } }, "MCP_CATALOG_TOOL_DESCRIPTION_LIMIT"],
  ])("rejects an oversized tool %s with a stable catalog diagnostic", async (_field, tool, code) => {
    const { collectExternalMcpToolPages } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker(`req_${String(_field)}_limit`)
    await expect(collectExternalMcpToolPages({
      diagnostic,
      listPage: async () => ({ tools: [tool] }),
    })).rejects.toHaveProperty("diagnostic.code", code)
  })

  test("rejects oversized and deeply nested schemas before retaining the catalog", async () => {
    const { collectExternalMcpToolPages } = await import("../src/capability-sources/external-mcp-client.js")

    const oversizedDiagnostic = new ExternalMcpDiagnosticTracker("req_schema_size")
    await expect(collectExternalMcpToolPages({
      diagnostic: oversizedDiagnostic,
      listPage: async () => ({
        tools: [{
          name: "oversized-schema",
          inputSchema: { type: "object", description: "s".repeat(512 * 1024) },
        }],
      }),
    })).rejects.toHaveProperty("diagnostic.code", "MCP_CATALOG_SCHEMA_SIZE_LIMIT")

    let deeplyNested: Record<string, unknown> = { type: "string" }
    for (let depth = 0; depth < 66; depth += 1) deeplyNested = { properties: deeplyNested }
    const depthDiagnostic = new ExternalMcpDiagnosticTracker("req_schema_depth")
    await expect(collectExternalMcpToolPages({
      diagnostic: depthDiagnostic,
      listPage: async () => ({ tools: [{ name: "deep-schema", inputSchema: deeplyNested }] }),
    })).rejects.toHaveProperty("diagnostic.code", "MCP_CATALOG_SCHEMA_DEPTH_LIMIT")
  })

  test("rejects oversized cursors without retaining or disclosing their value", async () => {
    const { collectExternalMcpToolPages } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_cursor_size")
    const secretCursor = `secret-${"c".repeat(16 * 1024)}`
    let caught: unknown
    try {
      await collectExternalMcpToolPages({
        diagnostic,
        listPage: async () => ({ tools: [], nextCursor: secretCursor }),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toHaveProperty("diagnostic.code", "MCP_CATALOG_CURSOR_SIZE_LIMIT")
    expect(JSON.stringify(caught)).not.toContain("secret-")
  })

  test("bounds cumulative serialized tool-catalog bytes across individually valid tools", async () => {
    const { collectExternalMcpToolPages } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_catalog_bytes")
    const tools = Array.from({ length: 129 }, (_, index) => ({
      name: `large-valid-${index}`,
      description: "d".repeat(64 * 1024 - 2),
      inputSchema: { type: "object" },
    }))
    await expect(collectExternalMcpToolPages({
      diagnostic,
      listPage: async () => ({ tools }),
    })).rejects.toHaveProperty("diagnostic.code", "MCP_CATALOG_BYTE_LIMIT")
  })

  test("uses one absolute deadline and passes decreasing remaining time to every tools/list page", async () => {
    const {
      collectExternalMcpToolPages,
      createExternalMcpLifecycleDeadline,
    } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_deadline_options")
    const totals: number[] = []
    const resetFlags: (boolean | undefined)[] = []
    let page = 0
    await collectExternalMcpToolPages({
      diagnostic,
      deadline: createExternalMcpLifecycleDeadline(1_000),
      listPage: async (_cursor, options) => {
        totals.push(options.maxTotalTimeout ?? 0)
        resetFlags.push(options.resetTimeoutOnProgress)
        page += 1
        if (page === 1) {
          await Bun.sleep(20)
          return { tools: [], nextCursor: "next" }
        }
        return { tools: [] }
      },
    })
    expect(totals).toHaveLength(2)
    expect(totals[0]).toBeGreaterThan(totals[1] ?? 0)
    expect(resetFlags).toEqual([false, false])
  })

  test("allows tool execution to use a longer bounded request timeout", async () => {
    const {
      createExternalMcpLifecycleDeadline,
      runExternalMcpRequestWithinDeadline,
    } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_tool_timeout")
    const options = await runExternalMcpRequestWithinDeadline({
      diagnostic,
      deadline: createExternalMcpLifecycleDeadline(150_000),
      phase: "MCP_TOOL_EXECUTION",
      requestTimeoutMs: 120_000,
      operation: async (requestOptions) => requestOptions,
    })

    expect(options.timeout).toBe(120_000)
    expect(options.maxTotalTimeout).toBeGreaterThanOrEqual(149_000)
    expect(options.maxTotalTimeout).toBeLessThanOrEqual(150_000)
    expect(options.resetTimeoutOnProgress).toBe(false)
  })

  test("fails a hung catalog page at the absolute lifecycle deadline", async () => {
    const {
      collectExternalMcpToolPages,
      createExternalMcpLifecycleDeadline,
    } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_deadline")
    await expect(collectExternalMcpToolPages({
      diagnostic,
      deadline: createExternalMcpLifecycleDeadline(10),
      listPage: async () => await new Promise<never>(() => undefined),
    })).rejects.toMatchObject({
      diagnostic: {
        phase: "MCP_TOOL_DISCOVERY",
        category: "lifecycle_deadline",
        code: "MCP_LIFECYCLE_DEADLINE",
        retryable: true,
      },
    })
  })

  test("bounds response bytes before JSON parsing while preserving larger SSE headroom", async () => {
    const {
      EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES,
      EXTERNAL_MCP_SSE_RESPONSE_LIMIT_BYTES,
    } = await import("../src/capability-sources/external-mcp-diagnostics.js")
    const tracker = new ExternalMcpDiagnosticTracker("req_response_limit")
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES + 1),
        },
      }),
    })
    await expect(diagnosticFetch("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })).rejects.toHaveProperty("diagnostic.code", "MCP_RESPONSE_BODY_LIMIT")

    const sseTracker = new ExternalMcpDiagnosticTracker("req_sse_headroom")
    const sseFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker: sseTracker,
      fetch: async () => new Response("event: message\ndata: {}\n\n", {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "content-length": String(EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES + 1),
        },
      }),
    })
    const sseResponse = await sseFetch("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    expect(EXTERNAL_MCP_SSE_RESPONSE_LIMIT_BYTES).toBeGreaterThan(EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES)
    expect(await sseResponse.text()).toContain("event: message")
  })

  test("aborts an unadvertised streaming response once decoded bytes cross the ceiling", async () => {
    const { EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES } = await import("../src/capability-sources/external-mcp-diagnostics.js")
    const tracker = new ExternalMcpDiagnosticTracker("req_stream_limit")
    const diagnosticFetch = createExternalMcpDiagnosticFetch({
      endpoint: "https://mcp.example.invalid/mcp",
      tracker,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES))
          controller.enqueue(new Uint8Array(1))
          controller.close()
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })
    const response = await diagnosticFetch("https://mcp.example.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    let streamError: unknown
    try {
      await response.arrayBuffer()
    } catch (error) {
      streamError = error
    }
    expect(streamError).toBeDefined()
    expect(tracker.error(streamError)).toMatchObject({
      diagnostic: {
        phase: "MCP_TOOL_DISCOVERY",
        category: "response_too_large",
        code: "MCP_RESPONSE_BODY_LIMIT",
      },
    })
  })

  test("hard-caps external connection fanout while prioritizing a name match", async () => {
    const {
      EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT,
      selectExternalMcpSearchConnections,
    } = await import("../src/mcp/external-capabilities.js")
    const connections = Array.from({ length: 100 }, (_, index) => ({
      name: index === 99 ? "Priority ServiceNow" : `Unrelated ${index}`,
      index,
    }))
    const selected = selectExternalMcpSearchConnections(connections, ["servicenow"])
    expect(selected).toHaveLength(EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT)
    expect(selected[0]?.index).toBe(99)
    expect(selected.every((connection) => connection.index < EXTERNAL_MCP_SEARCH_CONNECTION_LIMIT || connection.index === 99)).toBe(true)
  })

  test("shares one wall-clock search deadline across a bounded concurrent probe pool", async () => {
    const {
      createExternalMcpLifecycleDeadline,
      runExternalMcpRequestWithinDeadline,
    } = await import("../src/capability-sources/external-mcp-client.js")
    const {
      collectBoundedExternalMcpSearchMatches,
      EXTERNAL_MCP_SEARCH_CONCURRENCY,
    } = await import("../src/mcp/external-capabilities.js")
    let active = 0
    let maximumActive = 0
    let started = 0
    const startedAt = performance.now()
    await collectBoundedExternalMcpSearchMatches({
      connections: Array.from({ length: 100 }, (_, index) => index),
      deadline: createExternalMcpLifecycleDeadline(40),
      limit: 5,
      probe: async (connection, deadline) => {
        const diagnostic = new ExternalMcpDiagnosticTracker(`req_search_deadline_${connection}`)
        try {
          await runExternalMcpRequestWithinDeadline({
            deadline,
            diagnostic,
            phase: "MCP_INITIALIZE",
            operation: async (options) => await new Promise<never>((_resolve, reject) => {
              started += 1
              active += 1
              maximumActive = Math.max(maximumActive, active)
              options.signal?.addEventListener("abort", () => {
                active -= 1
                reject(new DOMException("aborted", "AbortError"))
              }, { once: true })
            }),
          })
        } catch {
          return []
        }
        return []
      },
    })
    const elapsed = performance.now() - startedAt
    expect(elapsed).toBeLessThan(250)
    expect(maximumActive).toBe(EXTERNAL_MCP_SEARCH_CONCURRENCY)
    expect(started).toBe(EXTERNAL_MCP_SEARCH_CONCURRENCY)
    expect(active).toBe(0)
  })

  test("prunes matching summaries to top-K after every adversarial batch", async () => {
    const {
      EXTERNAL_MCP_SEARCH_MATCH_LIMIT,
      mergeBoundedExternalCapabilityMatches,
    } = await import("../src/mcp/external-capabilities.js")
    const retained: import("../src/mcp/external-capabilities.js").ExternalCapabilityMatch[] = []
    const largeSummary = "enterprise-description ".repeat(2_000)
    for (let batch = 0; batch < 16; batch += 1) {
      const candidates = Array.from({ length: 128 }, (_, index) => ({
        name: `mcp:connection-${batch}:tool-${index}`,
        method: "MCP",
        path: "https://mcp.example.invalid/mcp",
        score: batch * 128 + index,
        summary: largeSummary,
        pathParams: [],
        queryParams: [],
        hasBody: true,
      }))
      mergeBoundedExternalCapabilityMatches(retained, candidates, 5)
      expect(retained).toHaveLength(5)
    }
    expect(retained.map((match) => match.score)).toEqual([2047, 2046, 2045, 2044, 2043])
    expect(retained.reduce((bytes, match) => bytes + Buffer.byteLength(match.summary), 0)).toBeLessThan(250_000)

    const hardCapped: typeof retained = []
    mergeBoundedExternalCapabilityMatches(hardCapped, Array.from({ length: 100 }, (_, index) => ({
      name: `mcp:hard-cap:${index}`,
      method: "MCP",
      path: "https://mcp.example.invalid/mcp",
      score: index,
      summary: largeSummary,
      pathParams: [],
      queryParams: [],
      hasBody: true,
    })), Number.MAX_SAFE_INTEGER)
    expect(hardCapped).toHaveLength(EXTERNAL_MCP_SEARCH_MATCH_LIMIT)
  })

  test("OAuth completion validates MCP before success and invalidates unusable tokens", async () => {
    const { runExternalMcpAuthCompletionLifecycle } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_post_exchange")
    const events: string[] = []
    let caught: unknown
    try {
      await runExternalMcpAuthCompletionLifecycle({
        diagnostic,
        finishAuth: async () => { events.push("token") },
        validateMcp: async () => {
          events.push("initialize")
          throw Object.assign(new Error("wrong audience token"), { code: "EACCES" })
        },
        invalidateTokens: async () => { events.push("invalidate") },
        close: async () => { events.push("close") },
      })
    } catch (error) {
      caught = error
    }
    expect(events).toEqual(["token", "initialize", "invalidate", "close"])
    expect(caught).toHaveProperty("diagnostic.phase", "MCP_INITIALIZE")
    expect(caught).toHaveProperty("diagnostic.highestPassed", "configured")
  })

  test("OAuth completion reports success only after token, initialize, and close", async () => {
    const { runExternalMcpAuthCompletionLifecycle } = await import("../src/capability-sources/external-mcp-client.js")
    const diagnostic = new ExternalMcpDiagnosticTracker("req_post_exchange_ok")
    const events: string[] = []
    await runExternalMcpAuthCompletionLifecycle({
      diagnostic,
      finishAuth: async () => { events.push("token") },
      validateMcp: async () => { events.push("initialize") },
      invalidateTokens: async () => { events.push("unexpected-invalidate") },
      close: async () => { events.push("close") },
    })
    expect(events).toEqual(["token", "initialize", "close"])
  })

  test("aborts the real SDK finishAuth token request and prevents late token persistence", async () => {
    const {
      bindExternalMcpFetchToLifecycle,
      createExternalMcpLifecycleDeadline,
      runExternalMcpAuthCompletionLifecycle,
    } = await import("../src/capability-sources/external-mcp-client.js")
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")

    let tokenRequests = 0
    let completedTokenResponses = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const origin = url.origin
        if (url.pathname.includes("oauth-protected-resource")) {
          return Response.json({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
          })
        }
        if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration")) {
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          })
        }
        if (url.pathname === "/token") {
          tokenRequests += 1
          await Bun.sleep(120)
          completedTokenResponses += 1
          return Response.json({ access_token: "must-never-persist", token_type: "Bearer" })
        }
        return new Response(null, { status: 404 })
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}/mcp`
    const diagnostic = new ExternalMcpDiagnosticTracker("req_real_finish_auth_deadline")
    const deadline = createExternalMcpLifecycleDeadline(25)
    const provider = new RecordingOAuthProvider({ client: { client_id: "pre-registered-client" } })
    const lifecycleFetch = bindExternalMcpFetchToLifecycle(fetch, deadline, diagnostic)
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      authProvider: provider,
      fetch: createExternalMcpDiagnosticFetch({ fetch: lifecycleFetch, endpoint, tracker: diagnostic }),
    })

    try {
      await expect(runExternalMcpAuthCompletionLifecycle({
        diagnostic,
        finishAuth: () => transport.finishAuth("delayed-authorization-code"),
        validateMcp: async () => undefined,
        invalidateTokens: async () => undefined,
        close: () => transport.close(),
        deadline,
      })).rejects.toMatchObject({
        diagnostic: {
          phase: "AUTH_TOKEN_ACQUISITION",
          code: "MCP_LIFECYCLE_DEADLINE",
        },
      })
      await Bun.sleep(150)
      expect(tokenRequests).toBe(1)
      expect(completedTokenResponses).toBe(1)
      expect(provider.savedTokens).toBe(0)
      expect(provider.savedClients).toBe(0)
      expect(provider.savedVerifiers).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test("aborts delayed SDK discovery registration before client or PKCE persistence", async () => {
    const {
      bindExternalMcpFetchToLifecycle,
      createExternalMcpLifecycleDeadline,
      runExternalMcpRequestWithinDeadline,
    } = await import("../src/capability-sources/external-mcp-client.js")
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js")

    let registrationRequests = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const origin = url.origin
        if (url.pathname.includes("oauth-protected-resource")) {
          return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] })
        }
        if (url.pathname.includes("oauth-authorization-server") || url.pathname.includes("openid-configuration")) {
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          })
        }
        if (url.pathname === "/register") {
          registrationRequests += 1
          await Bun.sleep(120)
          return Response.json({ client_id: "must-never-persist" })
        }
        return new Response(null, { status: 404 })
      },
    })
    const endpoint = `http://127.0.0.1:${server.port}/mcp`
    const diagnostic = new ExternalMcpDiagnosticTracker("req_real_dcr_deadline")
    const deadline = createExternalMcpLifecycleDeadline(25)
    const provider = new RecordingOAuthProvider()
    const lifecycleFetch = bindExternalMcpFetchToLifecycle(fetch, deadline, diagnostic)
    const diagnosticFetch = createExternalMcpDiagnosticFetch({ fetch: lifecycleFetch, endpoint, tracker: diagnostic })

    try {
      await expect(runExternalMcpRequestWithinDeadline({
        deadline,
        diagnostic,
        phase: "MCP_INITIALIZE",
        operation: async () => {
          await auth(provider, { serverUrl: endpoint, fetchFn: diagnosticFetch })
        },
      })).rejects.toMatchObject({ diagnostic: { code: "MCP_LIFECYCLE_DEADLINE" } })
      await Bun.sleep(150)
      expect(registrationRequests).toBe(1)
      expect(provider.savedClients).toBe(0)
      expect(provider.savedTokens).toBe(0)
      expect(provider.savedVerifiers).toBe(0)
      expect(provider.redirects).toBe(0)
    } finally {
      server.stop(true)
    }
  })
})
