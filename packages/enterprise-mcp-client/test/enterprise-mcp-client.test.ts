import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { describe, it } from "node:test"
import { z } from "zod"
import {
  createEnterpriseMcpClient,
  collectEnterpriseMcpTools,
  EnterpriseMcpCatalogError,
  EnterpriseMcpClientError,
  EnterpriseMcpOAuthProvider,
  EnterpriseMcpToolResultError,
  type EnterpriseMcpDiagnosticEvent,
  type EnterpriseMcpConnection,
  type EnterpriseMcpFetch,
  type EnterpriseMcpOAuthStore,
} from "../src/index.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"

const rpcRequestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
}).passthrough()

type MockMcpOptions = {
  toolError?: boolean
  expectedApiKey?: string
}

function requestText(body: BodyInit | null | undefined): string {
  return typeof body === "string" ? body : ""
}

function mockMcpFetch(options: MockMcpOptions = {}): EnterpriseMcpFetch {
  return async (_url, init) => {
    if (options.expectedApiKey) {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get("authorization"), `Bearer ${options.expectedApiKey}`)
    }

    const body = requestText(init?.body)
    if (!body) return new Response(null, { status: 202 })
    const parsed: unknown = JSON.parse(body)
    const request = rpcRequestSchema.parse(parsed)
    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 })
    }

    if (request.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "enterprise-mcp-test", version: "1.0.0" },
        },
      })
    }

    if (request.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [{
            name: "lookup-record",
            description: "Looks up an enterprise record",
            inputSchema: { type: "object", properties: {} },
          }],
        },
      })
    }

    if (request.method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: options.toolError ? "Provider rejected the operation" : "Record found" }],
          isError: options.toolError ?? false,
        },
      })
    }

    return new Response(null, { status: 404 })
  }
}

async function requestBody(request: IncomingMessage): Promise<string> {
  let body = ""
  for await (const chunk of request) {
    body += typeof chunk === "string" ? chunk : chunk.toString("utf8")
  }
  return body
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(body))
}

async function sendMcpResponse(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsed: unknown = JSON.parse(await requestBody(request))
  const rpc = rpcRequestSchema.parse(parsed)
  if (rpc.method === "notifications/initialized") {
    response.writeHead(202)
    response.end()
    return
  }
  if (rpc.method === "initialize") {
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "oauth-enterprise-mcp-test", version: "1.0.0" },
      },
    })
    return
  }
  if (rpc.method === "tools/list") {
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        tools: [{ name: "oauth-tool", inputSchema: { type: "object", properties: {} } }],
      },
    })
    return
  }
  sendJson(response, 404, { error: "not_found" })
}

async function startOAuthMcpServer(options: { rejectAuthenticatedMcp?: boolean } = {}) {
  let origin = ""
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin)
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        sendJson(response, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["tools.read"],
          bearer_methods_supported: ["header"],
        })
        return
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        sendJson(response, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["tools.read"],
        })
        return
      }
      if (url.pathname === "/register") {
        const registration: unknown = JSON.parse(await requestBody(request))
        const metadata = z.object({ redirect_uris: z.array(z.string()) }).passthrough().parse(registration)
        sendJson(response, 201, {
          client_id: "enterprise-test-client",
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: "none",
          redirect_uris: metadata.redirect_uris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "tools.read",
        })
        return
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await requestBody(request))
        const grantType = form.get("grant_type")
        if (grantType === "authorization_code") {
          assert.equal(form.get("code"), "approved-code")
          assert.ok(form.get("code_verifier"))
        } else {
          assert.equal(grantType, "refresh_token")
          assert.equal(form.get("refresh_token"), "enterprise-refresh-token")
        }
        sendJson(response, 200, {
          access_token: "enterprise-access-token",
          refresh_token: "enterprise-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "tools.read",
        }, { "cache-control": "no-store" })
        return
      }
      if (url.pathname === "/mcp") {
        if (request.headers.authorization !== "Bearer enterprise-access-token") {
          response.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="tools.read"`,
          })
          response.end()
          return
        }
        if (options.rejectAuthenticatedMcp) {
          sendJson(response, 403, { error: "provider_policy_denied" })
          return
        }
        await sendMcpResponse(request, response)
        return
      }
      sendJson(response, 404, { error: "not_found" })
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("OAuth MCP test server did not bind to a TCP port.")
  }
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

function noAuthConnection(): EnterpriseMcpConnection {
  return {
    id: "connection-1",
    serverUrl: "https://mcp.example.test/mcp",
    authorization: { type: "none" },
  }
}

describe("enterprise MCP client", () => {
  it("connects, discovers tools, and calls a tool over MCP Streamable HTTP", async () => {
    const events: EnterpriseMcpDiagnosticEvent[] = []
    const client = createEnterpriseMcpClient({
      fetch: mockMcpFetch(),
      diagnosticSink: (event) => events.push(event),
    })
    const connection = noAuthConnection()
    const redirectUri = "https://den.example.test/v1/mcp-connections/connection-1/connect/callback"

    assert.deepEqual(await client.connect({ connection, redirectUri }), { status: "connected" })
    const tools = await client.listTools({ connection, redirectUri })
    assert.equal(tools[0]?.name, "lookup-record")
    const result = await client.callTool({
      connection,
      redirectUri,
      toolName: "lookup-record",
      arguments: { table: "incident" },
    })
    assert.equal("isError" in result ? result.isError : undefined, false)
    assert.ok(events.some((event) => event.requestPhase === "mcp-initialize" && event.outcome === "succeeded"))
    assert.ok(events.some((event) => event.requestPhase === "mcp-tool-discovery" && event.outcome === "succeeded"))
    assert.ok(events.some((event) => event.requestPhase === "mcp-tool-execution" && event.outcome === "succeeded"))
  })

  it("sends Den's API key as a bearer credential", async () => {
    const client = createEnterpriseMcpClient({ fetch: mockMcpFetch({ expectedApiKey: "secret-test-key" }) })
    const result = await client.connect({
      connection: {
        ...noAuthConnection(),
        authorization: { type: "api-key", token: "secret-test-key" },
      },
      redirectUri: "https://den.example.test/callback",
    })
    assert.deepEqual(result, { status: "connected" })
  })

  it("does not let a diagnostic consumer change a connection outcome", async () => {
    const client = createEnterpriseMcpClient({
      fetch: mockMcpFetch(),
      diagnosticSink: () => {
        throw new Error("diagnostic sink failed")
      },
    })
    assert.deepEqual(await client.connect({
      connection: noAuthConnection(),
      redirectUri: "https://den.example.test/callback",
    }), { status: "connected" })
  })

  it("identifies the exact request phase when endpoint access fails", async () => {
    const client = createEnterpriseMcpClient({
      fetch: async () => {
        throw new Error("simulated network failure")
      },
    })

    await assert.rejects(
      client.connect({
        connection: noAuthConnection(),
        redirectUri: "https://den.example.test/callback",
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnterpriseMcpClientError)
        assert.equal(error.code, "MCP_CONNECTION_HANDSHAKE_FAILED")
        assert.equal(error.operationPhase, "connection-handshake")
        assert.equal(error.requestPhase, "mcp-initialize")
        assert.match(error.message, /MCP connection handshake/)
        return true
      },
    )
  })

  it("honors an injected absolute lifecycle deadline", async () => {
    const controller = new AbortController()
    const expiresAt = Date.now() + 40
    const timer = setTimeout(() => controller.abort(new Error("shared deadline reached")), 40)
    const client = createEnterpriseMcpClient({
      lifecycle: { expiresAt, signal: controller.signal },
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason)
          return
        }
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      }),
    })
    const startedAt = Date.now()
    try {
      await assert.rejects(client.connect({
        connection: noAuthConnection(),
        redirectUri: "https://den.example.test/callback",
      }))
      assert.ok(Date.now() - startedAt < 500)
    } finally {
      clearTimeout(timer)
    }
  })

  it("treats an MCP isError tool result as a failed operation", async () => {
    const client = createEnterpriseMcpClient({ fetch: mockMcpFetch({ toolError: true }) })
    await assert.rejects(
      client.callTool({
        connection: noAuthConnection(),
        redirectUri: "https://den.example.test/callback",
        toolName: "lookup-record",
        arguments: {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnterpriseMcpClientError)
        assert.equal(error.code, "MCP_TOOL_EXECUTION_FAILED")
        assert.ok(error.cause instanceof EnterpriseMcpToolResultError)
        return true
      },
    )
  })
})

class MemoryOAuthStore implements EnterpriseMcpOAuthStore {
  clientInformation: OAuthClientInformationMixed | undefined
  tokens: OAuthTokens | undefined
  codeVerifier: string | undefined
  invalidationCount = 0

  async loadClientInformation() {
    return this.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed) {
    this.clientInformation = clientInformation
  }

  async loadTokens() {
    return this.tokens
  }

  async saveTokens(tokens: OAuthTokens) {
    this.tokens = tokens
  }

  async invalidateTokens() {
    this.tokens = undefined
    this.invalidationCount += 1
  }

  async saveCodeVerifier(codeVerifier: string) {
    this.codeVerifier = codeVerifier
  }

  async loadCodeVerifier() {
    if (!this.codeVerifier) throw new Error("No verifier")
    return this.codeVerifier
  }
}

describe("enterprise MCP OAuth persistence contract", () => {
  it("round-trips state, client registration, tokens, and PKCE through the injected store", async () => {
    const store = new MemoryOAuthStore()
    const provider = new EnterpriseMcpOAuthProvider({
      redirectUri: "https://den.example.test/callback",
      store,
      state: "signed-state",
      clientName: "OpenWork",
    })

    assert.equal(provider.state(), "signed-state")
    assert.equal(provider.redirectUrl, "https://den.example.test/callback")
    await provider.saveClientInformation({ client_id: "registered-client" })
    assert.equal((await provider.clientInformation())?.client_id, "registered-client")
    await provider.saveTokens({ access_token: "access", token_type: "Bearer", refresh_token: "refresh" })
    assert.equal((await provider.tokens())?.refresh_token, "refresh")
    await provider.saveCodeVerifier("pkce-verifier")
    assert.equal(await provider.codeVerifier(), "pkce-verifier")
    provider.redirectToAuthorization(new URL("https://identity.example.test/authorize"))
    assert.equal(provider.authorizeUrl, "https://identity.example.test/authorize")
  })

  it("completes discovery, dynamic registration, PKCE exchange, and authenticated MCP initialization", async () => {
    const server = await startOAuthMcpServer()
    try {
      const store = new MemoryOAuthStore()
      const events: EnterpriseMcpDiagnosticEvent[] = []
      const client = createEnterpriseMcpClient({ diagnosticSink: (event) => events.push(event) })
      const connection: EnterpriseMcpConnection = {
        id: "oauth-connection",
        serverUrl: `${server.origin}/mcp`,
        authorization: { type: "oauth", store },
      }
      const redirectUri = "https://den.example.test/v1/mcp-connections/oauth-connection/connect/callback"
      const started = await client.connect({ connection, redirectUri, state: "signed-den-state" })
      assert.equal(started.status, "needs_auth")
      if (started.status !== "needs_auth") throw new Error("Expected OAuth authorization to be required.")
      const authorizeUrl = new URL(started.authorizeUrl)
      assert.equal(authorizeUrl.searchParams.get("state"), "signed-den-state")
      assert.equal(authorizeUrl.searchParams.get("client_id"), "enterprise-test-client")
      assert.ok(store.codeVerifier)

      await client.completeAuthorization({
        connection,
        redirectUri,
        code: "approved-code",
      })
      assert.equal(store.tokens?.access_token, "enterprise-access-token")
      assert.deepEqual(await client.connect({ connection, redirectUri }), { status: "connected" })
      const tools = await client.listTools({ connection, redirectUri })
      assert.equal(tools[0]?.name, "oauth-tool")
      for (const phase of [
        "oauth-resource-discovery",
        "oauth-server-discovery",
        "oauth-client-registration",
        "oauth-token-exchange",
        "mcp-initialize",
        "mcp-tool-discovery",
      ]) {
        assert.ok(events.some((event) => event.requestPhase === phase), `Expected a diagnostic event for ${phase}`)
      }
    } finally {
      await server.close()
    }
  })

  it("refreshes an expired enterprise OAuth credential and persists the replacement", async () => {
    const server = await startOAuthMcpServer()
    try {
      const store = new MemoryOAuthStore()
      store.clientInformation = { client_id: "enterprise-test-client" }
      store.tokens = {
        access_token: "expired-access-token",
        refresh_token: "enterprise-refresh-token",
        token_type: "Bearer",
      }
      const events: EnterpriseMcpDiagnosticEvent[] = []
      const client = createEnterpriseMcpClient({ diagnosticSink: (event) => events.push(event) })
      const connection: EnterpriseMcpConnection = {
        id: "oauth-refresh-connection",
        serverUrl: `${server.origin}/mcp`,
        authorization: { type: "oauth", store },
      }

      assert.deepEqual(await client.connect({
        connection,
        redirectUri: "https://den.example.test/oauth-refresh-callback",
      }), { status: "connected" })
      assert.equal(store.tokens.access_token, "enterprise-access-token")
      assert.ok(events.some((event) => event.requestPhase === "oauth-token-refresh"))
    } finally {
      await server.close()
    }
  })

  it("invalidates exchanged tokens when callback validation cannot initialize MCP", async () => {
    const server = await startOAuthMcpServer({ rejectAuthenticatedMcp: true })
    try {
      const store = new MemoryOAuthStore()
      const client = createEnterpriseMcpClient({ operationTimeoutMs: 5_000 })
      const connection: EnterpriseMcpConnection = {
        id: "oauth-validation-failure",
        serverUrl: `${server.origin}/mcp`,
        authorization: { type: "oauth", store },
      }
      const redirectUri = "https://den.example.test/oauth-validation-failure"
      const started = await client.connect({ connection, redirectUri, state: "signed-state" })
      assert.equal(started.status, "needs_auth")

      await assert.rejects(client.completeAuthorization({
        connection,
        redirectUri,
        code: "approved-code",
      }))
      assert.equal(store.tokens, undefined)
      assert.equal(store.invalidationCount, 1)
    } finally {
      await server.close()
    }
  })
})

describe("enterprise MCP catalog contract", () => {
  it("collects a bounded paginated tool catalog", async () => {
    const tools = await collectEnterpriseMcpTools({
      requestOptions: {},
      listPage: async (cursor) => cursor
        ? {
            tools: [{ name: "second-tool", inputSchema: { type: "object" } }],
          }
        : {
            tools: [{ name: "first-tool", inputSchema: { type: "object" } }],
            nextCursor: "page-2",
          },
    })
    assert.deepEqual(tools.map((tool) => tool.name), ["first-tool", "second-tool"])
  })

  it("rejects duplicate tools across catalog pages", async () => {
    await assert.rejects(
      collectEnterpriseMcpTools({
        requestOptions: {},
        listPage: async (cursor) => cursor
          ? { tools: [{ name: "duplicate", inputSchema: { type: "object" } }] }
          : {
              tools: [{ name: "duplicate", inputSchema: { type: "object" } }],
              nextCursor: "page-2",
            },
      }),
      (error: unknown) => {
        assert.ok(error instanceof EnterpriseMcpCatalogError)
        assert.equal(error.code, "MCP_CATALOG_DUPLICATE_TOOL")
        return true
      },
    )
  })

  it("rejects a repeated pagination cursor", async () => {
    await assert.rejects(
      collectEnterpriseMcpTools({
        requestOptions: {},
        listPage: async () => ({ tools: [], nextCursor: "repeated-cursor" }),
      }),
      (error: unknown) => error instanceof EnterpriseMcpCatalogError
        && error.code === "MCP_CATALOG_CURSOR_LOOP",
    )
  })

  it("enforces the absolute catalog page limit", async () => {
    let page = 0
    await assert.rejects(
      collectEnterpriseMcpTools({
        requestOptions: {},
        listPage: async () => {
          page += 1
          return { tools: [], nextCursor: `page-${page}` }
        },
      }),
      (error: unknown) => error instanceof EnterpriseMcpCatalogError
        && error.code === "MCP_CATALOG_PAGE_LIMIT",
    )
    assert.equal(page, 20)
  })

  it("rejects oversized tool names and deeply nested schemas", async () => {
    await assert.rejects(
      collectEnterpriseMcpTools({
        requestOptions: {},
        listPage: async () => ({
          tools: [{ name: "x".repeat(513), inputSchema: { type: "object" } }],
        }),
      }),
      (error: unknown) => error instanceof EnterpriseMcpCatalogError
        && error.code === "MCP_CATALOG_TOOL_NAME_LIMIT",
    )

    let nested: Record<string, unknown> = { type: "string" }
    for (let depth = 0; depth < 70; depth += 1) nested = { nested }
    await assert.rejects(
      collectEnterpriseMcpTools({
        requestOptions: {},
        listPage: async () => ({
          tools: [{
            name: "deep-schema",
            inputSchema: { type: "object", properties: { value: nested } },
          }],
        }),
      }),
      (error: unknown) => error instanceof EnterpriseMcpCatalogError
        && error.code === "MCP_CATALOG_SCHEMA_DEPTH_LIMIT",
    )
  })
})
