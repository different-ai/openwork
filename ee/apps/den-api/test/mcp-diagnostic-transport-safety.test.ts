import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES,
  ExternalMcpDiagnosticError,
  ExternalMcpHttpStatusError,
  bindExternalMcpFetchToLifecycle,
  boundExternalMcpResponse,
  classifyExternalMcpRequestPhase,
  collectExternalMcpToolPages,
  createExternalMcpLifecycleDeadline,
  externalMcpNetworkFailureProof,
  measureExternalMcpSerializedJson,
  observedFetch,
  runExternalMcpLifecycleWithClose,
  runExternalMcpRequestWithinDeadline,
  type DiagnosticContext,
} from "../src/capability-sources/external-mcp-client.js"
import {
  classifyMcpDiagnosticFailure,
  safeMcpDiagnosticEvidence,
} from "../src/capability-sources/external-mcp-diagnostics.js"
import { createGuardedFetch, createRealmSafeFetch } from "../src/capability-sources/url-guard.js"

process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DEN_DB_ENCRYPTION_KEY ??= "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET ??= "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790"

function tokenRequest(grantType: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: grantType, code: "must-not-be-retained" }),
  }
}

function httpDiagnostic(status: number, input: Partial<{
  hadAuthorization: boolean
  bearerChallenge: boolean
  invalidToken: boolean
  insufficientScope: boolean
}> = {}) {
  return {
    phase: "MCP_TOOL_DISCOVERY" as const,
    status,
    hadAuthorization: input.hadAuthorization ?? true,
    bearerChallenge: input.bearerChallenge ?? false,
    invalidToken: input.invalidToken ?? false,
    insufficientScope: input.insufficientScope ?? false,
  }
}

function trackedLiveResponse(input: {
  status: number
  headers?: HeadersInit
}) {
  const state = { active: 0, canceled: 0 }
  const body = new ReadableStream<Uint8Array>({
    start() {
      state.active += 1
    },
    cancel() {
      state.active -= 1
      state.canceled += 1
    },
  })
  return { response: new Response(body, input), state }
}

function testDiagnosticContext(connectionUrl: string) {
  const signals: Array<{ phase: string; outcome: string; evidence?: unknown }> = []
  const context: DiagnosticContext = {
    connectionUrl,
    networkPassed: true,
    routingPassed: true,
    lastPhase: "HTTP_ROUTING",
    lastEvidence: safeMcpDiagnosticEvidence({ url: connectionUrl }),
    observing: true,
    observe: async (signal) => { signals.push(signal) },
  }
  return { context, signals }
}

function issuerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }
}

function oidcIssuerMetadata(issuer: string) {
  return {
    ...issuerMetadata(issuer),
    jwks_uri: `${issuer}/discovery/v2.0/keys`,
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  }
}

async function runSdkAuthChallenge(input: {
  challenge: "invalid_token" | "insufficient_scope" | "policy"
  refresh: "success" | "invalid_grant"
}) {
  const endpoint = "https://resource.enterprise.example.test/mcp"
  const issuer = "https://login.enterprise.example.test"
  let tokens: OAuthTokens | undefined = {
    access_token: "old-access",
    refresh_token: "valid-refresh",
    token_type: "Bearer",
  }
  const savedTokens: OAuthTokens[] = []
  let redirects = 0
  let savedVerifiers = 0
  const provider: OAuthClientProvider = {
    get redirectUrl() { return "https://den.example.test/v1/mcp/callback" },
    get clientMetadata() {
      return {
        redirect_uris: ["https://den.example.test/v1/mcp/callback"],
        client_name: "OpenWork diagnostic test",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }
    },
    clientInformation: async () => ({ client_id: "enterprise-test-client" }),
    tokens: async () => tokens,
    saveTokens: async (next) => {
      tokens = next
      savedTokens.push(next)
    },
    redirectToAuthorization: async () => { redirects += 1 },
    saveCodeVerifier: async () => { savedVerifiers += 1 },
    codeVerifier: async () => "test-verifier",
    invalidateCredentials: async (scope) => {
      if (scope === "tokens" || scope === "all") tokens = undefined
    },
    discoveryState: async () => ({
      authorizationServerUrl: issuer,
      authorizationServerMetadata: issuerMetadata(issuer),
      resourceMetadata: {
        resource: endpoint,
        authorization_servers: [issuer],
        scopes_supported: ["mcp.read", "mcp.admin"],
      },
    } as OAuthDiscoveryState),
  }

  const state = { mcpCalls: 0, refreshCalls: 0 }
  const { context, signals } = testDiagnosticContext(endpoint)
  const tracedFetch = observedFetch(async (rawUrl, init) => {
    const url = new URL(String(rawUrl))
    if (url.toString() === `${issuer}/token`) {
      state.refreshCalls += 1
      if (input.refresh === "invalid_grant") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "rotated-refresh",
        token_type: "Bearer",
      }), { headers: { "content-type": "application/json" } })
    }
    if (url.toString() !== endpoint) throw new Error(`Unexpected SDK test URL: ${url}`)
    if ((init?.method ?? "GET").toUpperCase() === "GET") return new Response(null, { status: 405 })

    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { method?: string; id?: string | number } : {}
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (body.method !== "initialize") throw new Error(`Unexpected SDK test method: ${body.method}`)
    state.mcpCalls += 1
    const authorization = new Headers(init?.headers).get("authorization")
    if (state.mcpCalls === 1) {
      if (input.challenge === "policy") {
        return new Response("policy denied", { status: 403 })
      }
      const challenge = input.challenge === "insufficient_scope"
        ? 'Bearer error="insufficient_scope", scope="mcp.admin"'
        : 'Bearer error="invalid_token"'
      return new Response(null, {
        status: input.challenge === "insufficient_scope" ? 403 : 401,
        headers: { "www-authenticate": challenge },
      })
    }
    if (authorization !== "Bearer new-access") {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer error="invalid_token"' },
      })
    }
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "enterprise-sdk-test", version: "1.0.0" },
      },
    }), { headers: { "content-type": "application/json" } })
  }, context)

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    authProvider: provider,
    fetch: tracedFetch,
  })
  const client = new Client({ name: "diagnostic-sdk-test", version: "1.0.0" }, { capabilities: {} })
  let error: unknown
  try {
    await client.connect(transport)
  } catch (cause) {
    error = cause
  } finally {
    context.observing = false
    await client.close().catch(() => undefined)
  }
  return { context, error, redirects, savedTokens, savedVerifiers, signals, state, tokens }
}

describe("diagnostic transport truth and bounds", () => {
  test("parses refresh and authorization-code grants without substring inference", () => {
    const endpoint = "https://1.1.1.1/mcp"
    const token = new URL("https://8.8.8.8/token")
    expect(classifyExternalMcpRequestPhase(token, tokenRequest("refresh_token"), endpoint)).toBe("CONTINUITY_REFRESH")
    expect(classifyExternalMcpRequestPhase(token, tokenRequest("authorization_code"), endpoint)).toBe("AUTH_TOKEN_ACQUISITION")
    expect(classifyExternalMcpRequestPhase(token, {
      ...tokenRequest("authorization_code"),
      body: new URLSearchParams({ note: "grant_type=refresh_token" }),
    }, endpoint)).toBe("AUTH_TOKEN_ACQUISITION")
  })

  test("emits distinct refresh success and failure traces", async () => {
    const endpoint = "https://1.1.1.1/mcp"
    const token = new URL("https://8.8.8.8/token")
    const signals: Array<{ phase: string; outcome: string }> = []
    const context: DiagnosticContext = {
      connectionUrl: endpoint,
      networkPassed: true,
      lastPhase: "HTTP_ROUTING",
      lastEvidence: safeMcpDiagnosticEvidence({ url: endpoint }),
      observing: true,
      observe: async (signal) => { signals.push(signal) },
    }
    const success = observedFetch(
      async () => new Response(JSON.stringify({ access_token: "not-retained" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      context,
    )
    const successResponse = await success(token, tokenRequest("refresh_token"))
    await successResponse.body?.cancel()
    expect(signals.filter((signal) => signal.phase === "CONTINUITY_REFRESH").map((signal) => signal.outcome)).toEqual(["running", "passed"])

    signals.length = 0
    const failure = observedFetch(
      async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "must-not-be-retained" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
      context,
    )
    const failureResponse = await failure(token, tokenRequest("refresh_token"))
    await failureResponse.body?.cancel()
    expect(signals.filter((signal) => signal.phase === "CONTINUITY_REFRESH").map((signal) => signal.outcome)).toEqual(["running", "running"])
    const wrapped = new ExternalMcpDiagnosticError(
      "CONTINUITY_REFRESH",
      new Error("The refresh endpoint rejected the request."),
      context.lastEvidence,
      context.lastHttp,
    )
    expect(classifyMcpDiagnosticFailure(wrapped, "CONTINUITY_REFRESH")).toMatchObject({
      category: "oauth_refresh_failure",
      retryable: true,
    })
    expect(JSON.stringify(signals)).not.toContain("must-not-be-retained")
  })

  test("does not fabricate lower-layer passes for timeout and abort errors", () => {
    expect(externalMcpNetworkFailureProof(new DOMException("timed out", "TimeoutError"))).toEqual({ phase: null, passed: [] })
    expect(externalMcpNetworkFailureProof(new DOMException("aborted", "AbortError"))).toEqual({ phase: null, passed: [] })
    expect(externalMcpNetworkFailureProof(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }))).toEqual({
      phase: "NETWORK_TCP",
      passed: ["NETWORK_DNS"],
    })
    expect(externalMcpNetworkFailureProof(Object.assign(new Error("certificate"), { code: "CERT_HAS_EXPIRED" }))).toEqual({
      phase: "NETWORK_TLS",
      passed: ["NETWORK_DNS", "NETWORK_TCP"],
    })
  })

  test("accepts the SDK-supported 2025-03-26 protocol in safe evidence", () => {
    expect(safeMcpDiagnosticEvidence({ protocolVersion: "2025-03-26" })).toMatchObject({
      protocolVersion: "2025-03-26",
      detailsRedacted: true,
    })
    expect(safeMcpDiagnosticEvidence({ protocolVersion: "2099-secret" })).not.toHaveProperty("protocolVersion")
  })

  test("caps advertised and streaming response bodies before buffering", async () => {
    const advertised = trackedLiveResponse({
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES + 1),
      },
    })
    expect(() => boundExternalMcpResponse(advertised.response)).toThrow("byte limit")
    expect(advertised.state).toEqual({ active: 0, canceled: 1 })

    const response = boundExternalMcpResponse(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(EXTERNAL_MCP_JSON_RESPONSE_LIMIT_BYTES))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    }), { headers: { "content-type": "application/json" } }))
    await expect(response.arrayBuffer()).rejects.toThrow("byte limit")
  })

  test("returns typed bounded status responses to the SDK and cancels discarded bodies once", async () => {
    const endpoint = "https://1.1.1.1/mcp"
    const tracked = trackedLiveResponse({ status: 503 })
    const context: DiagnosticContext = {
      connectionUrl: endpoint,
      networkPassed: true,
      routingPassed: true,
      lastPhase: "HTTP_ROUTING",
      lastEvidence: safeMcpDiagnosticEvidence({ url: endpoint }),
      observing: true,
      observe: async () => undefined,
    }
    const traced = observedFetch(async () => tracked.response, context)
    const response = await traced(new URL(endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(response.status).toBe(503)
    expect(context.lastHttp).toMatchObject({ phase: "MCP_TOOL_DISCOVERY", status: 503 })
    await response.body?.cancel()
    expect(tracked.state).toEqual({ active: 0, canceled: 1 })
  })

  test("bounds schema bytes, depth, nodes, keys, arrays, strings, and cursor bytes", async () => {
    let deep: Record<string, unknown> = { type: "string" }
    for (let index = 0; index < 66; index += 1) deep = { properties: deep }
    expect(measureExternalMcpSerializedJson(deep)).toEqual({ ok: false, reason: "depth" })
    expect(measureExternalMcpSerializedJson({ description: "x".repeat(64 * 1024 + 1) })).toEqual({ ok: false, reason: "string" })
    expect(measureExternalMcpSerializedJson({ enum: Array.from({ length: 20_001 }, () => 1) })).toEqual({ ok: false, reason: "array_items" })

    await expect(collectExternalMcpToolPages({
      listPage: async () => ({ tools: [{ name: "deep", inputSchema: deep }] }),
    })).rejects.toHaveProperty("code", "MCP_CATALOG_SCHEMA_DEPTH_LIMIT")
    await expect(collectExternalMcpToolPages({
      listPage: async () => ({ tools: [], nextCursor: "c".repeat(16 * 1024 + 1) }),
    })).rejects.toHaveProperty("code", "MCP_CATALOG_CURSOR_SIZE_LIMIT")
  })

  test("uses one aborting lifecycle deadline for hung catalog pages", async () => {
    await expect(collectExternalMcpToolPages({
      deadline: createExternalMcpLifecycleDeadline(10),
      listPage: async () => await new Promise<never>(() => undefined),
    })).rejects.toHaveProperty("code", "MCP_LIFECYCLE_DEADLINE")
  })

  test("binds an options-ignoring callback exchange to its absolute deadline", async () => {
    const deadline = createExternalMcpLifecycleDeadline(15)
    const state = {
      activeIo: 0,
      abortedRequests: 0,
      operationCompletedAfterRejection: false,
      credentialMutations: 0,
      clientMutations: 0,
      grantMutations: 0,
    }
    const callbackFetch = bindExternalMcpFetchToLifecycle(async (_url, init) => {
      state.activeIo += 1
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          state.activeIo -= 1
          resolve(new Response(JSON.stringify({ access_token: "must-not-persist" }), {
            headers: { "content-type": "application/json" },
          }))
        }, 100)
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          state.activeIo -= 1
          state.abortedRequests += 1
          reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"))
        }, { once: true })
      })
    }, deadline)

    let failure: unknown
    try {
      await runExternalMcpRequestWithinDeadline({
        deadline,
        // finishAuth(code) has no RequestOptions parameter. This deliberately
        // ignores the wrapper's options and proves the transport fetch is bound.
        operation: async () => {
          const response = await callbackFetch("https://issuer.example.test/token", { method: "POST" })
          await response.json()
          state.operationCompletedAfterRejection = true
          state.credentialMutations += 1
          state.clientMutations += 1
          state.grantMutations += 1
        },
      })
    } catch (error) {
      failure = error
    }
    await Bun.sleep(25)

    expect(failure).toHaveProperty("code", "MCP_LIFECYCLE_DEADLINE")
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.signal.reason).toBe(failure)
    expect(state).toEqual({
      activeIo: 0,
      abortedRequests: 1,
      operationCompletedAfterRejection: false,
      credentialMutations: 0,
      clientMutations: 0,
      grantMutations: 0,
    })
  })

  test("closes needs-auth and thrown-initialize lifecycles exactly once and bounds close", async () => {
    let closes = 0
    await expect(runExternalMcpLifecycleWithClose({
      operation: async () => ({ status: "needs_auth" as const }),
      close: async () => { closes += 1 },
    })).resolves.toEqual({ status: "needs_auth" })
    expect(closes).toBe(1)

    const primary = new Error("initialize failed")
    closes = 0
    await expect(runExternalMcpLifecycleWithClose({
      operation: async () => { throw primary },
      close: async () => { closes += 1; throw new Error("close failed") },
    })).rejects.toBe(primary)
    expect(closes).toBe(1)

    await expect(runExternalMcpLifecycleWithClose({
      operation: async () => "ok",
      close: async () => await new Promise<never>(() => undefined),
      closeTimeoutMs: 5,
    })).rejects.toHaveProperty("code", "MCP_CLOSE_TIMEOUT")
  })

  test.each([
    [httpDiagnostic(401, { bearerChallenge: true, invalidToken: true }), "oauth_invalid_token", true],
    [httpDiagnostic(401, { hadAuthorization: false, bearerChallenge: true }), "oauth_authorization_required", true],
    [httpDiagnostic(401, { hadAuthorization: false }), "oauth_authentication_failed", true],
    [httpDiagnostic(403), "provider_policy_denied", false],
    [httpDiagnostic(403, { bearerChallenge: true }), "provider_policy_denied", false],
    [httpDiagnostic(403, { hadAuthorization: false }), "provider_policy_denied", false],
    [httpDiagnostic(403, { bearerChallenge: true, insufficientScope: true }), "oauth_insufficient_scope", false],
    [httpDiagnostic(429), "provider_throttled", true],
    [httpDiagnostic(404), "endpoint_not_found", false],
    [httpDiagnostic(503), "provider_unavailable", true],
    [httpDiagnostic(405), "method_not_allowed", false],
  ])("classifies typed HTTP evidence for status $status", (http, category, retryable) => {
    const cause = new ExternalMcpHttpStatusError(http)
    const error = new ExternalMcpDiagnosticError(http.phase, cause, safeMcpDiagnosticEvidence({ status: http.status }), http)
    expect(classifyMcpDiagnosticFailure(error, http.phase)).toMatchObject({ category, retryable })
  })
})

describe("MCP SDK discovery and authentication parity", () => {
  test("lets RFC 9728 path discovery fall back from path 404 to root", async () => {
    const endpoint = "https://resource.enterprise.example.test/tenant/mcp"
    const issuer = "https://login.enterprise.example.test"
    const calls: string[] = []
    const { context, signals } = testDiagnosticContext(endpoint)
    const metadata = await discoverOAuthProtectedResourceMetadata(endpoint, undefined, observedFetch(async (rawUrl) => {
      const url = String(rawUrl)
      calls.push(url)
      return calls.length === 1
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify({ resource: endpoint, authorization_servers: [issuer] }), {
            headers: { "content-type": "application/json" },
          })
    }, context))

    expect(metadata.authorization_servers).toEqual([issuer])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("/.well-known/oauth-protected-resource/tenant/mcp")
    expect(calls[1]).toContain("/.well-known/oauth-protected-resource")
    expect(signals.some((signal) => signal.phase === "AUTH_RESOURCE_DISCOVERY" && signal.outcome === "passed")).toBe(true)
  })

  test("lets RFC 8414 404 fall back to OIDC metadata", async () => {
    const issuer = "https://login.enterprise.example.test"
    const calls: string[] = []
    const { context } = testDiagnosticContext("https://resource.enterprise.example.test/mcp")
    const metadata = await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: observedFetch(async (rawUrl) => {
        const url = String(rawUrl)
        calls.push(url)
        return calls.length === 1
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify(oidcIssuerMetadata(issuer)), {
              headers: { "content-type": "application/json" },
            })
      }, context),
    })

    expect(metadata?.token_endpoint).toBe(`${issuer}/token`)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("oauth-authorization-server")
    expect(calls[1]).toContain("openid-configuration")
  })

  test("supports Microsoft-style tenant OIDC metadata after every earlier candidate misses", async () => {
    const issuer = "https://login.microsoftonline.example.test/tenant-id/v2.0"
    const calls: string[] = []
    const { context } = testDiagnosticContext("https://graph.enterprise.example.test/mcp")
    const metadata = await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: observedFetch(async (rawUrl) => {
        const url = String(rawUrl)
        calls.push(url)
        return calls.length < 3
          ? new Response(null, { status: 404 })
          : new Response(JSON.stringify(oidcIssuerMetadata(issuer)), {
              headers: { "content-type": "application/json" },
            })
      }, context),
    })

    expect(metadata?.issuer).toBe(issuer)
    expect(calls).toHaveLength(3)
    expect(calls[2]).toContain("/tenant-id/v2.0/.well-known/openid-configuration")
  })

  test("retains one safe issuer-discovery cause after SDK fallbacks are exhausted", async () => {
    const issuer = "https://login.enterprise.example.test/tenant-secret"
    const { context, signals } = testDiagnosticContext("https://resource.enterprise.example.test/mcp")
    let cause: unknown
    try {
      await discoverAuthorizationServerMetadata(issuer, {
        fetchFn: observedFetch(async (_rawUrl) => {
          const priorCandidates = signals.filter((signal) => signal.phase === "AUTH_ISSUER_DISCOVERY" && signal.outcome === "running").length
          return new Response(null, { status: priorCandidates <= 1 ? 404 : 503 })
        }, context),
      })
    } catch (error) {
      cause = error
    }
    const wrapped = new ExternalMcpDiagnosticError(
      context.lastPhase,
      cause,
      context.lastEvidence,
      context.lastHttp,
    )

    expect(context.lastPhase).toBe("AUTH_ISSUER_DISCOVERY")
    expect(context.lastHttp).toMatchObject({ phase: "AUTH_ISSUER_DISCOVERY", status: 503 })
    expect(classifyMcpDiagnosticFailure(wrapped, wrapped.phase)).toMatchObject({
      category: "oauth_handshake_failure",
      operatorAction: "verify_authorization_server_metadata",
      retryable: true,
    })
    expect(JSON.stringify({ evidence: wrapped.evidence, signals })).not.toContain("tenant-secret")
  })

  test.each(["invalid_token", "insufficient_scope"] as const)(
    "lets the SDK recover an authenticated %s challenge by refreshing once and retrying",
    async (challenge) => {
      const result = await runSdkAuthChallenge({ challenge, refresh: "success" })
      expect(result.error).toBeUndefined()
      expect(result.state).toEqual({ mcpCalls: 2, refreshCalls: 1 })
      expect(result.savedTokens).toHaveLength(1)
      expect(result.tokens).toMatchObject({ access_token: "new-access", refresh_token: "rotated-refresh" })
      expect(result.signals.filter((signal) => signal.phase === "CONTINUITY_REFRESH").map((signal) => signal.outcome)).toEqual(["running", "passed"])
    },
  )

  test("keeps invalid refresh terminal at continuity without a late token write", async () => {
    const result = await runSdkAuthChallenge({ challenge: "invalid_token", refresh: "invalid_grant" })
    const wrapped = new ExternalMcpDiagnosticError(
      result.context.lastPhase,
      result.error,
      result.context.lastEvidence,
      result.context.lastHttp,
    )
    expect(result.state).toEqual({ mcpCalls: 1, refreshCalls: 1 })
    expect(result.savedTokens).toHaveLength(0)
    expect(result.redirects).toBe(1)
    expect(result.savedVerifiers).toBe(1)
    expect(wrapped.phase).toBe("CONTINUITY_REFRESH")
    expect(classifyMcpDiagnosticFailure(wrapped, wrapped.phase)).toMatchObject({ category: "oauth_refresh_failure" })
  })

  test("keeps a generic authenticated 403 as provider policy instead of OAuth recovery", async () => {
    const result = await runSdkAuthChallenge({ challenge: "policy", refresh: "success" })
    const wrapped = new ExternalMcpDiagnosticError(
      result.context.lastPhase,
      result.error,
      result.context.lastEvidence,
      result.context.lastHttp,
    )
    expect(result.state).toEqual({ mcpCalls: 1, refreshCalls: 0 })
    expect(result.savedTokens).toHaveLength(0)
    expect(classifyMcpDiagnosticFailure(wrapped, wrapped.phase)).toMatchObject({
      category: "provider_policy_denied",
      operatorAction: "grant_required_provider_role_acl_or_application_permission",
    })
  })

  test.each([
    ["AUTH_TOKEN_ACQUISITION", "authorization_code", 404, "oauth_token_failure", "verify_authorization_server_token_endpoint"],
    ["AUTH_TOKEN_ACQUISITION", "authorization_code", 405, "oauth_token_failure", "verify_authorization_server_token_endpoint"],
    ["AUTH_TOKEN_ACQUISITION", "authorization_code", 503, "oauth_token_failure", "inspect_authorization_server_token_endpoint_availability"],
    ["CONTINUITY_REFRESH", "refresh_token", 404, "oauth_refresh_failure", "verify_authorization_server_token_endpoint"],
    ["CONTINUITY_REFRESH", "refresh_token", 405, "oauth_refresh_failure", "verify_authorization_server_token_endpoint"],
    ["CONTINUITY_REFRESH", "refresh_token", 503, "oauth_refresh_failure", "inspect_authorization_server_token_endpoint_availability"],
  ] as const)("keeps %s HTTP status context for %s status %i", async (phase, grantType, status, category, operatorAction) => {
    const endpoint = "https://resource.enterprise.example.test/mcp"
    const { context } = testDiagnosticContext(endpoint)
    const response = await observedFetch(async () => new Response(null, { status }), context)(
      "https://login.enterprise.example.test/token",
      tokenRequest(grantType),
    )
    await response.body?.cancel()
    const wrapped = new ExternalMcpDiagnosticError(context.lastPhase, new Error("SDK rejected OAuth response"), context.lastEvidence, context.lastHttp)
    expect(wrapped.phase).toBe(phase)
    expect(classifyMcpDiagnosticFailure(wrapped, wrapped.phase)).toMatchObject({ category, operatorAction })
  })

  test.each([
    [404, "HTTP_ROUTING", "endpoint_not_found"],
    [405, "MCP_TRANSPORT", "method_not_allowed"],
  ] as const)("keeps MCP endpoint status %i terminal at %s", async (status, phase, category) => {
    const endpoint = "https://resource.enterprise.example.test/mcp"
    const { context } = testDiagnosticContext(endpoint)
    const response = await observedFetch(async () => new Response(null, { status }), context)(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: status === 405 ? "notifications/initialized" : "initialize" }),
    })
    await response.body?.cancel()
    const failurePhase = status === 404 ? "HTTP_ROUTING" : "MCP_TRANSPORT"
    const wrapped = new ExternalMcpDiagnosticError(failurePhase, new Error("SDK rejected MCP response"), context.lastEvidence, context.lastHttp)
    expect(wrapped.phase).toBe(phase)
    expect(classifyMcpDiagnosticFailure(wrapped, wrapped.phase)).toMatchObject({ category })
  })

  test.each([404, 405, 503] as const)("keeps DCR status %i at client registration", async (status) => {
    const endpoint = "https://resource.enterprise.example.test/mcp"
    const { context } = testDiagnosticContext(endpoint)
    const response = await observedFetch(async () => new Response(null, { status }), context)(
      "https://login.enterprise.example.test/register",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://den.example.test/callback"], client_name: "OpenWork" }),
      },
    )
    await response.body?.cancel()
    const wrapped = new ExternalMcpDiagnosticError(context.lastPhase, new Error("SDK rejected DCR response"), context.lastEvidence, context.lastHttp)
    expect(wrapped.phase).toBe("AUTH_CLIENT_REGISTRATION")
    expect(classifyMcpDiagnosticFailure(wrapped, wrapped.phase)).toMatchObject({ category: "oauth_client_registration" })
  })
})

describe("guarded MCP redirects", () => {
  test("blocks public redirects to loopback/metadata, HTTPS downgrade, and cross-origin 307 body replay", async () => {
    const redirect = (location: string, status = 302) => async () => new Response(null, { status, headers: { location } })
    await expect(createGuardedFetch(redirect("https://127.0.0.1/mcp"))("https://1.1.1.1/mcp")).rejects.toThrow("private")
    await expect(createGuardedFetch(redirect("http://169.254.169.254/latest"))("https://1.1.1.1/mcp")).rejects.toThrow()
    await expect(createGuardedFetch(redirect("http://1.1.1.1/mcp"))("https://1.1.1.1/mcp")).rejects.toThrow("HTTPS")
    await expect(createGuardedFetch(redirect("https://8.8.8.8/token", 307))("https://1.1.1.1/token", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/x-www-form-urlencoded" },
      body: "code=secret&code_verifier=secret",
    })).rejects.toThrow("body")
  })

  test("strips every sensitive continuation header across an origin", async () => {
    const calls: { url: string; headers: Headers }[] = []
    const guarded = createGuardedFetch(async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) })
      return calls.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://8.8.8.8/next" } })
        : new Response("{}", { status: 200 })
    })
    await guarded("https://1.1.1.1/start", {
      headers: {
        authorization: "Bearer secret",
        cookie: "session=secret",
        "proxy-authorization": "Basic secret",
        "mcp-session-id": "secret",
        "last-event-id": "secret",
        "x-api-key": "secret",
      },
    })
    expect(calls).toHaveLength(2)
    for (const name of ["authorization", "cookie", "proxy-authorization", "mcp-session-id", "last-event-id", "x-api-key"]) {
      expect(calls[1]?.headers.has(name)).toBe(false)
    }
  })

  test("private mode still blocks credentialed URLs, downgrade, body replay, and redirect loops", async () => {
    await expect(createRealmSafeFetch(async () => new Response("ok"))("http://user:secret@127.0.0.1/mcp")).rejects.toThrow("credentials")
    const loop = createRealmSafeFetch(async (url) => new Response(null, { status: 302, headers: { location: String(url) } }))
    await expect(loop("http://127.0.0.1/mcp")).rejects.toThrow("loop")
  })

  test("cancels a malformed redirect body exactly once without masking the URL error", async () => {
    const tracked = trackedLiveResponse({
      status: 302,
      headers: { location: "http://[" },
    })
    const guarded = createRealmSafeFetch(async () => tracked.response)
    await expect(guarded("http://127.0.0.1/mcp")).rejects.toBeInstanceOf(TypeError)
    expect(tracked.state).toEqual({ active: 0, canceled: 1 })
  })
})
