import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { describe, it } from "node:test"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/client"
import {
  createEnterpriseMcpClient,
  EnterpriseMcpOAuthContractError,
  type EnterpriseMcpConnection,
  type EnterpriseMcpOAuthAuthorizationHandle,
  type EnterpriseMcpOAuthClientRegistration,
  type EnterpriseMcpOAuthCredential,
  type EnterpriseMcpOAuthPersistence,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "../src/index.js"
import { EnterpriseMcpOAuthProvider } from "../src/oauth-provider.js"

// Regression test for a refresh race against authorization servers that rotate
// single-use refresh tokens (OAuth 2.1): several runtime operations start
// together with an expired access token, each gets a 401 and refreshes with
// the SAME refresh token. The first rotation wins; the others get
// invalid_grant, and servers with reuse detection revoke the whole grant.

async function requestBody(request: IncomingMessage): Promise<string> {
  let body = ""
  for await (const chunk of request) body += typeof chunk === "string" ? chunk : chunk.toString("utf8")
  return body
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(body))
}

async function sendMcpResponse(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const rpc = JSON.parse(await requestBody(request)) as { id?: string | number; method: string }
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
        serverInfo: { name: "rotating-refresh-test", version: "1.0.0" },
      },
    })
    return
  }
  if (rpc.method === "tools/list") {
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: rpc.id,
      result: { tools: [{ name: "oauth-tool", inputSchema: { type: "object", properties: {} } }] },
    })
    return
  }
  sendJson(response, 404, { error: "not_found" })
}

/**
 * Authorization server + MCP resource with strict OAuth 2.1 refresh rotation:
 * every refresh token is single-use, and presenting a spent one revokes the
 * whole grant (reuse detection), like Patrimonia and FastMCP-style proxies.
 * No access token is valid until the first refresh: the seeded one is expired.
 */
async function startRotatingOAuthServer() {
  let origin = ""
  let generation = 0
  let currentAccessToken: string | null = null
  const liveRefreshTokens = new Set(["refresh-0"])
  const spentRefreshTokens = new Set<string>()
  const state = { refreshCalls: 0, rejectedRefreshes: 0, revoked: false }
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
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["tools.read"],
        })
        return
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await requestBody(request))
        assert.equal(form.get("grant_type"), "refresh_token")
        state.refreshCalls += 1
        const presented = form.get("refresh_token") ?? ""
        if (state.revoked || !liveRefreshTokens.has(presented)) {
          if (spentRefreshTokens.has(presented)) state.revoked = true
          state.rejectedRefreshes += 1
          sendJson(response, 400, { error: "invalid_grant", error_description: "refresh token does not exist" })
          return
        }
        // Consume atomically, then answer slowly so concurrent refreshes overlap.
        liveRefreshTokens.delete(presented)
        spentRefreshTokens.add(presented)
        generation += 1
        const refreshToken = `refresh-${generation}`
        currentAccessToken = `access-${generation}`
        liveRefreshTokens.add(refreshToken)
        const accessToken = currentAccessToken
        await new Promise((resolve) => setTimeout(resolve, 50))
        sendJson(response, 200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "tools.read",
        }, { "cache-control": "no-store" })
        return
      }
      if (url.pathname === "/mcp") {
        if (state.revoked || !currentAccessToken || request.headers.authorization !== `Bearer ${currentAccessToken}`) {
          response.writeHead(401, {
            "www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="tools.read"`,
          })
          response.end()
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
  if (!address || typeof address === "string") throw new Error("test server did not bind")
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    state,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

/** In-memory persistence with the same revision rule as the refresh commit contract. */
class CasOAuthPersistence implements EnterpriseMcpOAuthPersistence {
  registration: EnterpriseMcpOAuthClientRegistration | undefined
  credential: EnterpriseMcpOAuthCredential | undefined
  authorizationRecords = new Map<string, { handle: EnterpriseMcpOAuthAuthorizationHandle; codeVerifier: string }>()
  invalidationCount = 0
  revision = 0
  discoveryState: OAuthDiscoveryState | undefined

  private nextRevision(): string {
    this.revision += 1
    return `revision-${this.revision}`
  }

  readonly clientRegistrations = {
    load: async () => this.registration,
    save: async (input: {
      clientInformation: StoredOAuthClientInformation
      expiresAt?: number
      source: "client-metadata" | "dynamic"
    }) => {
      this.registration ??= {
        clientInformation: input.clientInformation,
        revision: this.nextRevision(),
        expiresAt: input.expiresAt,
        source: input.source,
      }
      return this.registration
    },
    invalidate: async () => {
      this.registration = undefined
    },
  }

  readonly authorizations = {
    begin: async (input: { id: string; codeVerifier: string; expiresAt: number; clientRegistrationRevision?: string }) => {
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

  readonly discovery = {
    load: async () => this.discoveryState,
    save: async (input: { state: OAuthDiscoveryState }) => {
      this.discoveryState = input.state
    },
    invalidate: async () => {
      this.discoveryState = undefined
    },
  }

  readonly credentials = {
    load: async () => this.credential,
    save: async (input: {
      tokens: StoredOAuthTokens
      expiresAt?: number
      source: "authorization-code" | "refresh"
      expectedCredentialRevision?: string
    }) => {
      if (input.source === "refresh" && input.expectedCredentialRevision !== this.credential?.revision) {
        throw new EnterpriseMcpOAuthContractError("MCP_OAUTH_CREDENTIAL_CHANGED", "credential changed during refresh")
      }
      this.credential = { tokens: input.tokens, expiresAt: input.expiresAt, revision: this.nextRevision() }
    },
    invalidate: async () => {
      this.credential = undefined
      this.invalidationCount += 1
    },
  }

  seedRegistration(clientInformation: StoredOAuthClientInformation): void {
    this.registration = { clientInformation, revision: this.nextRevision(), source: "pre-registered" }
  }

  seedCredential(tokens: StoredOAuthTokens, expiresAt?: number): void {
    this.credential = { tokens, expiresAt, revision: this.nextRevision() }
  }
}

function runtimeProvider(persistence: EnterpriseMcpOAuthPersistence): EnterpriseMcpOAuthProvider {
  const controller = new AbortController()
  return new EnterpriseMcpOAuthProvider({
    redirectUri: "https://den.example.test/callback",
    connectionId: "connection-1",
    persistence,
    flow: { kind: "runtime" },
    clientName: "OpenWork",
    clock: { now: () => Date.now() },
    lifecycle: { expiresAt: Date.now() + 30_000, signal: controller.signal },
    authorizationTransactionTtlMs: 600_000,
    expirationSkewMs: 0,
    fetch: async () => new Response(null, { status: 404 }),
  })
}

describe("enterprise MCP OAuth refresh under concurrency", () => {
  it("refreshes a single-use refresh token once when concurrent operations start with an expired access token", async () => {
    const server = await startRotatingOAuthServer()
    try {
      const persistence = new CasOAuthPersistence()
      persistence.seedRegistration({ client_id: "rotating-client" })
      persistence.seedCredential({
        access_token: "access-0",
        refresh_token: "refresh-0",
        token_type: "Bearer",
      }, Date.now() - 1_000)
      const connection: EnterpriseMcpConnection = {
        id: "rotating-connection",
        serverUrl: `${server.origin}/mcp`,
        authorization: { type: "oauth", persistence },
      }
      const client = createEnterpriseMcpClient({ fetch, operationTimeoutMs: 10_000 })
      const redirectUri = "https://den.example.test/v1/mcp-connections/rotating-connection/connect/callback"

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => client.listTools({ connection, redirectUri })),
      )

      assert.deepEqual(results.map((result) => result.status), Array(5).fill("fulfilled"))
      assert.equal(server.state.refreshCalls, 1)
      assert.equal(server.state.rejectedRefreshes, 0)
      assert.equal(server.state.revoked, false)
      assert.equal(persistence.invalidationCount, 0)
      assert.equal(persistence.credential?.tokens.access_token, "access-1")
      assert.equal(persistence.credential?.tokens.refresh_token, "refresh-1")
    } finally {
      await server.close()
    }
  })

  it("does not refresh ahead a credential that is not about to expire", async () => {
    const persistence = new CasOAuthPersistence()
    persistence.seedCredential({
      access_token: "fresh-access-token",
      refresh_token: "fresh-refresh-token",
      token_type: "Bearer",
    }, Date.now() + 60 * 60_000)
    const provider = runtimeProvider(persistence)
    let requests = 0
    await provider.refreshAheadIfExpiring({
      serverUrl: new URL("https://mcp.example.test/mcp"),
      fetchFn: async () => {
        requests += 1
        return new Response(null, { status: 500 })
      },
    })
    assert.equal(requests, 0)
    assert.equal(persistence.credential?.tokens.refresh_token, "fresh-refresh-token")
  })
})
