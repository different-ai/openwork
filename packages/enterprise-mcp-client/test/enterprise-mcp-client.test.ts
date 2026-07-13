import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { describe, it } from "node:test"
import { z } from "zod"
import {
  createEnterpriseMcpClient,
  EnterpriseMcpCatalogError,
  EnterpriseMcpClientError,
  EnterpriseMcpToolResultError,
  EnterpriseMcpToolInputError,
  EnterpriseMcpOAuthContractError,
  type EnterpriseMcpDiagnosticEvent,
  type EnterpriseMcpConnection,
  type EnterpriseMcpFetch,
  type EnterpriseMcpOAuthAuthorizationHandle,
  type EnterpriseMcpOAuthClientRegistration,
  type EnterpriseMcpOAuthCredential,
  type EnterpriseMcpOAuthPersistence,
} from "../src/index.js"
import { EnterpriseMcpOAuthProvider } from "../src/oauth-provider.js"
import { createEnterpriseMcpRequestObserver } from "../src/request-observer.js"
import { collectEnterpriseMcpTools } from "../src/tool-catalog.js"
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
  it("preserves the last failed OAuth phase when a later cleanup request succeeds", async () => {
    const controller = new AbortController()
    const observer = createEnterpriseMcpRequestObserver({
      connectionId: "connection-1",
      operationPhase: "authorization-callback",
      fetch: async (url) => new URL(url).pathname.endsWith("/token")
        ? Response.json({ error: "invalid_client" }, { status: 401 })
        : Response.json({ issuer: "https://provider.example.test" }),
      signal: controller.signal,
      clock: { now: () => Date.now() },
    })

    await observer.fetch("https://provider.example.test/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: "code" }),
    })
    await observer.fetch("https://provider.example.test/.well-known/oauth-authorization-server")

    assert.equal(observer.lastRequestPhase(), "oauth-server-discovery")
    assert.equal(observer.lastFailedRequestPhase(), "oauth-token-exchange")
  })

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

  it("rejects oversized or cyclic tool arguments before opening a provider connection", async () => {
    let fetchCount = 0
    const client = createEnterpriseMcpClient({
      fetch: async () => {
        fetchCount += 1
        return new Response(null, { status: 500 })
      },
    })
    await assert.rejects(
      client.callTool({
        connection: noAuthConnection(),
        redirectUri: "https://den.example.test/callback",
        toolName: "lookup-record",
        arguments: { payload: "x".repeat(1024 * 1024) },
      }),
      (error: unknown) => error instanceof EnterpriseMcpClientError
        && error.cause instanceof EnterpriseMcpToolInputError
        && error.cause.code === "MCP_TOOL_ARGUMENT_SIZE_LIMIT",
    )
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await assert.rejects(
      client.callTool({
        connection: noAuthConnection(),
        redirectUri: "https://den.example.test/callback",
        toolName: "lookup-record",
        arguments: cyclic,
      }),
      (error: unknown) => error instanceof EnterpriseMcpClientError
        && error.cause instanceof EnterpriseMcpToolInputError
        && error.cause.code === "MCP_TOOL_ARGUMENT_CYCLE",
    )
    assert.equal(fetchCount, 0)
  })
})

class MemoryOAuthPersistence implements EnterpriseMcpOAuthPersistence {
  registration: EnterpriseMcpOAuthClientRegistration | undefined
  credential: EnterpriseMcpOAuthCredential | undefined
  authorizationRecords = new Map<string, { handle: EnterpriseMcpOAuthAuthorizationHandle; codeVerifier: string }>()
  invalidationCount = 0
  revision = 0

  private nextRevision(): string {
    this.revision += 1
    return `revision-${this.revision}`
  }

  private assertActive(input: { commitExpiresAt: number; signal: AbortSignal }): void {
    if (input.signal.aborted || input.commitExpiresAt <= Date.now()) throw new Error("persistence deadline expired")
  }

  readonly clientRegistrations = {
    load: async () => this.registration,
    save: async (input: {
      context: { commitExpiresAt: number; signal: AbortSignal }
      clientInformation: OAuthClientInformationMixed
      expiresAt?: number
    }) => {
      this.assertActive(input.context)
      if (!this.registration) {
        this.registration = {
          clientInformation: input.clientInformation,
          revision: this.nextRevision(),
          expiresAt: input.expiresAt,
          source: "dynamic" as const,
        }
      }
      return this.registration
    },
    invalidate: async () => {
      this.registration = undefined
    },
  }

  readonly authorizations = {
    begin: async (input: {
      context: { commitExpiresAt: number; signal: AbortSignal }
      id: string
      codeVerifier: string
      expiresAt: number
      clientRegistrationRevision?: string
    }) => {
      this.assertActive(input.context)
      this.authorizationRecords.set(input.id, {
        handle: {
          id: input.id,
          revision: this.nextRevision(),
          expiresAt: input.expiresAt,
          clientRegistrationRevision: input.clientRegistrationRevision,
        },
        codeVerifier: input.codeVerifier,
      })
    },
    load: async (input: { id: string }) => this.authorizationRecords.get(input.id),
    invalidate: async (input: { id: string }) => {
      this.authorizationRecords.delete(input.id)
    },
  }

  readonly credentials = {
    load: async () => this.credential,
    save: async (input: {
      context: { commitExpiresAt: number; signal: AbortSignal }
      tokens: OAuthTokens
      expiresAt?: number
      source: "authorization-code" | "refresh"
      authorization?: EnterpriseMcpOAuthAuthorizationHandle
      clientRegistrationRevision?: string
    }) => {
      this.assertActive(input.context)
      if (input.source === "authorization-code") {
        const pending = input.authorization ? this.authorizationRecords.get(input.authorization.id) : undefined
        if (!pending || pending.handle.revision !== input.authorization?.revision) throw new Error("authorization was not active")
        if (pending.handle.clientRegistrationRevision !== input.clientRegistrationRevision) {
          throw new Error("client registration changed")
        }
        this.authorizationRecords.delete(pending.handle.id)
      }
      this.credential = {
        tokens: input.tokens,
        expiresAt: input.expiresAt,
        revision: this.nextRevision(),
      }
      this.assertActive(input.context)
    },
    invalidate: async () => {
      this.credential = undefined
      this.invalidationCount += 1
    },
  }

  seedRegistration(clientInformation: OAuthClientInformationMixed, expiresAt?: number): void {
    this.registration = {
      clientInformation,
      revision: this.nextRevision(),
      expiresAt,
      source: "pre-registered",
    }
  }

  seedCredential(tokens: OAuthTokens, expiresAt?: number): void {
    this.credential = { tokens, expiresAt, revision: this.nextRevision() }
  }
}

function oauthProvider(input: {
  persistence: EnterpriseMcpOAuthPersistence
  flow: { kind: "connect"; authorizationId?: string } | { kind: "callback"; authorizationId: string } | { kind: "runtime" }
  now?: () => number
  authorizationTransactionTtlMs?: number
  expirationSkewMs?: number
}): EnterpriseMcpOAuthProvider {
  const controller = new AbortController()
  const now = input.now ?? (() => Date.now())
  return new EnterpriseMcpOAuthProvider({
    redirectUri: "https://den.example.test/callback",
    connectionId: "connection-1",
    persistence: input.persistence,
    flow: input.flow,
    clientName: "OpenWork",
    clock: { now },
    lifecycle: { expiresAt: now() + 30_000, signal: controller.signal },
    authorizationTransactionTtlMs: input.authorizationTransactionTtlMs ?? 600_000,
    expirationSkewMs: input.expirationSkewMs ?? 0,
  })
}

describe("enterprise MCP OAuth persistence contract", () => {
  it("round-trips state, client registration, tokens, and PKCE through the injected store", async () => {
    const persistence = new MemoryOAuthPersistence()
    const controller = new AbortController()
    const provider = new EnterpriseMcpOAuthProvider({
      redirectUri: "https://den.example.test/callback",
      connectionId: "connection-1",
      persistence,
      flow: { kind: "connect", authorizationId: "signed-state" },
      clientName: "OpenWork",
      clock: { now: () => Date.now() },
      lifecycle: { expiresAt: Date.now() + 30_000, signal: controller.signal },
      authorizationTransactionTtlMs: 600_000,
      expirationSkewMs: 0,
    })

    assert.equal(provider.state(), "signed-state")
    assert.equal(provider.redirectUrl, "https://den.example.test/callback")
    await provider.saveClientInformation({ client_id: "registered-client" })
    assert.equal((await provider.clientInformation())?.client_id, "registered-client")
    await provider.saveCodeVerifier("pkce-verifier")
    assert.equal(persistence.authorizationRecords.get("signed-state")?.codeVerifier, "pkce-verifier")
    provider.redirectToAuthorization(new URL("https://identity.example.test/authorize"))
    assert.equal(provider.authorizeUrl, "https://identity.example.test/authorize")
  })

  it("completes discovery, dynamic registration, PKCE exchange, and authenticated MCP initialization", async () => {
    const server = await startOAuthMcpServer()
    try {
      const persistence = new MemoryOAuthPersistence()
      const events: EnterpriseMcpDiagnosticEvent[] = []
      const client = createEnterpriseMcpClient({ fetch, diagnosticSink: (event) => events.push(event) })
      const connection: EnterpriseMcpConnection = {
        id: "oauth-connection",
        serverUrl: `${server.origin}/mcp`,
        authorization: { type: "oauth", persistence },
      }
      const redirectUri = "https://den.example.test/v1/mcp-connections/oauth-connection/connect/callback"
      const started = await client.connect({ connection, redirectUri, authorizationId: "signed-den-state" })
      assert.equal(started.status, "needs_auth")
      if (started.status !== "needs_auth") throw new Error("Expected OAuth authorization to be required.")
      const authorizeUrl = new URL(started.authorizeUrl)
      assert.equal(authorizeUrl.searchParams.get("state"), "signed-den-state")
      assert.equal(authorizeUrl.searchParams.get("client_id"), "enterprise-test-client")
      assert.ok(persistence.authorizationRecords.get("signed-den-state")?.codeVerifier)

      await client.completeAuthorization({
        connection,
        redirectUri,
        code: "approved-code",
        authorizationId: "signed-den-state",
      })
      assert.equal(persistence.credential?.tokens.access_token, "enterprise-access-token")
      assert.equal(persistence.authorizationRecords.size, 0)
      assert.deepEqual(await client.connect({
        connection,
        redirectUri,
        authorizationId: "signed-den-state-after-callback",
      }), { status: "connected" })
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
      const persistence = new MemoryOAuthPersistence()
      persistence.seedRegistration({ client_id: "enterprise-test-client" })
      persistence.seedCredential({
        access_token: "expired-access-token",
        refresh_token: "enterprise-refresh-token",
        token_type: "Bearer",
      }, Date.now() - 1_000)
      const events: EnterpriseMcpDiagnosticEvent[] = []
      const client = createEnterpriseMcpClient({ fetch, diagnosticSink: (event) => events.push(event) })
      const connection: EnterpriseMcpConnection = {
        id: "oauth-refresh-connection",
        serverUrl: `${server.origin}/mcp`,
        authorization: { type: "oauth", persistence },
      }

      assert.deepEqual(await client.connect({
        connection,
        redirectUri: "https://den.example.test/oauth-refresh-callback",
        authorizationId: "signed-refresh-state",
      }), { status: "connected" })
      assert.equal(persistence.credential?.tokens.access_token, "enterprise-access-token")
      assert.equal(persistence.credential?.tokens.refresh_token, "enterprise-refresh-token")
      assert.ok(events.some((event) => event.requestPhase === "oauth-token-refresh"))
    } finally {
      await server.close()
    }
  })

  it("invalidates exchanged tokens when callback validation cannot initialize MCP", async () => {
    const server = await startOAuthMcpServer({ rejectAuthenticatedMcp: true })
    try {
      const persistence = new MemoryOAuthPersistence()
      const client = createEnterpriseMcpClient({ fetch, operationTimeoutMs: 5_000 })
      const connection: EnterpriseMcpConnection = {
        id: "oauth-validation-failure",
        serverUrl: `${server.origin}/mcp`,
        authorization: { type: "oauth", persistence },
      }
      const redirectUri = "https://den.example.test/oauth-validation-failure"
      const started = await client.connect({ connection, redirectUri, authorizationId: "signed-state" })
      assert.equal(started.status, "needs_auth")

      await assert.rejects(client.completeAuthorization({
        connection,
        redirectUri,
        code: "approved-code",
        authorizationId: "signed-state",
      }))
      assert.equal(persistence.credential, undefined)
      assert.equal(persistence.invalidationCount, 1)
    } finally {
      await server.close()
    }
  })

  it("requires an explicit signed authorization id before OAuth performs network or persistence work", async () => {
    const persistence = new MemoryOAuthPersistence()
    let fetchCount = 0
    const client = createEnterpriseMcpClient({
      fetch: async () => {
        fetchCount += 1
        return new Response(null, { status: 500 })
      },
    })
    await assert.rejects(
      client.connect({
        connection: {
          id: "oauth-missing-state",
          serverUrl: "https://mcp.example.test/mcp",
          authorization: { type: "oauth", persistence },
        },
        redirectUri: "https://den.example.test/callback",
      }),
      (error: unknown) => error instanceof EnterpriseMcpClientError
        && error.code === "MCP_CONFIGURATION_FAILED",
    )
    assert.equal(fetchCount, 0)
    assert.equal(persistence.authorizationRecords.size, 0)
  })

  it("keeps concurrent PKCE transactions isolated by signed state", async () => {
    const persistence = new MemoryOAuthPersistence()
    persistence.seedRegistration({ client_id: "registered-client" })
    const first = oauthProvider({
      persistence,
      flow: { kind: "connect", authorizationId: "signed-state-a" },
    })
    const second = oauthProvider({
      persistence,
      flow: { kind: "connect", authorizationId: "signed-state-b" },
    })
    await first.clientInformation()
    await second.clientInformation()
    await first.saveCodeVerifier("a".repeat(43))
    await second.saveCodeVerifier("b".repeat(43))
    assert.equal(persistence.authorizationRecords.size, 2)

    const firstCallback = oauthProvider({
      persistence,
      flow: { kind: "callback", authorizationId: "signed-state-a" },
    })
    const secondCallback = oauthProvider({
      persistence,
      flow: { kind: "callback", authorizationId: "signed-state-b" },
    })
    await firstCallback.clientInformation()
    await secondCallback.clientInformation()
    assert.equal(await firstCallback.codeVerifier(), "a".repeat(43))
    assert.equal(await secondCallback.codeVerifier(), "b".repeat(43))
  })

  it("rejects an expired authorization transaction with a stable source code", async () => {
    const persistence = new MemoryOAuthPersistence()
    persistence.seedRegistration({ client_id: "registered-client" })
    const base = Date.now()
    let now = base
    const start = oauthProvider({
      persistence,
      flow: { kind: "connect", authorizationId: "signed-expiring-state" },
      now: () => now,
      authorizationTransactionTtlMs: 100,
    })
    await start.clientInformation()
    await start.saveCodeVerifier("v".repeat(43))
    now = base + 101
    const callback = oauthProvider({
      persistence,
      flow: { kind: "callback", authorizationId: "signed-expiring-state" },
      now: () => now,
    })
    await callback.clientInformation()
    await assert.rejects(
      callback.codeVerifier(),
      (error: unknown) => error instanceof EnterpriseMcpOAuthContractError
        && error.code === "MCP_OAUTH_AUTHORIZATION_EXPIRED",
    )
    assert.equal(persistence.authorizationRecords.size, 0)
  })

  it("rejects callbacks when the OAuth client changed after authorization started", async () => {
    const persistence = new MemoryOAuthPersistence()
    persistence.seedRegistration({ client_id: "client-a" })
    const start = oauthProvider({
      persistence,
      flow: { kind: "connect", authorizationId: "signed-client-revision" },
    })
    await start.clientInformation()
    await start.saveCodeVerifier("v".repeat(43))
    persistence.seedRegistration({ client_id: "client-b" })
    const callback = oauthProvider({
      persistence,
      flow: { kind: "callback", authorizationId: "signed-client-revision" },
    })
    await callback.clientInformation()
    await assert.rejects(
      callback.codeVerifier(),
      (error: unknown) => error instanceof EnterpriseMcpOAuthContractError
        && error.code === "MCP_OAUTH_AUTHORIZATION_CLIENT_CHANGED",
    )
  })

  it("invalidates an expired access token when no refresh token exists", async () => {
    const persistence = new MemoryOAuthPersistence()
    persistence.seedCredential({ access_token: "expired", token_type: "Bearer" }, 999)
    const provider = oauthProvider({
      persistence,
      flow: { kind: "runtime" },
      now: () => 1_000,
    })
    await assert.rejects(
      provider.tokens(),
      (error: unknown) => error instanceof EnterpriseMcpOAuthContractError
        && error.code === "MCP_OAUTH_CREDENTIAL_EXPIRED",
    )
    assert.equal(persistence.credential, undefined)
  })

  it("fails a losing concurrent dynamic registration instead of using the wrong client", async () => {
    const persistence = new MemoryOAuthPersistence()
    const winner = oauthProvider({ persistence, flow: { kind: "connect", authorizationId: "winner-state" } })
    const loser = oauthProvider({ persistence, flow: { kind: "connect", authorizationId: "loser-state" } })
    await winner.saveClientInformation({ client_id: "winner-client" })
    await assert.rejects(
      loser.saveClientInformation({ client_id: "loser-client" }),
      (error: unknown) => error instanceof EnterpriseMcpOAuthContractError
        && error.code === "MCP_OAUTH_AUTHORIZATION_CLIENT_CHANGED",
    )
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
