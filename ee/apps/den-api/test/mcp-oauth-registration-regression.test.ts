import assert from "node:assert/strict"
import { test } from "node:test"
import { createEnterpriseMcpClient } from "@openwork/enterprise-mcp-client"
import type { EnterpriseMcpOAuthClientRegistration, EnterpriseMcpOAuthCredential, EnterpriseMcpOAuthPersistence, OAuthDiscoveryState } from "@openwork/enterprise-mcp-client"

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

for (const registration of ["pre-registered", "dynamic", "client-metadata"]) {
  test(`ordinary 401 OAuth with ${registration} keeps strict discovery and completes S256 sign-in`, async () => {
    const resource = "https://resource.example/mcp"
    const issuer = "https://identity.example"
    let clientRecord: EnterpriseMcpOAuthClientRegistration | undefined = registration === "pre-registered"
      ? { clientInformation: { client_id: "exp-mcpmanual-preregistered" }, revision: "1", source: "pre-registered" } : undefined
    let discovery: OAuthDiscoveryState | undefined
    let credential: EnterpriseMcpOAuthCredential | undefined
    let pending: { id: string; codeVerifier: string; expiresAt: number; clientRegistrationRevision?: string } | undefined
    const requests: string[] = []
    let registrations = 0
    let tokenExchanges = 0
    const persistence: EnterpriseMcpOAuthPersistence = {
      clientRegistrations: {
        load: async () => clientRecord,
        save: async (input) => { clientRecord = { clientInformation: input.clientInformation, revision: "1", source: input.source }; return clientRecord },
        invalidate: async () => { throw new Error("No registration invalidation expected") },
      },
      discovery: { load: async () => discovery, save: async (input) => { discovery = input.state }, invalidate: async () => { throw new Error("No discovery invalidation expected") } },
      credentials: {
        load: async () => credential,
        save: async (input) => { assert.equal(input.source, "authorization-code"); assert.equal(input.authorization?.id, pending?.id); credential = { tokens: input.tokens, revision: "1", expiresAt: input.expiresAt }; pending = undefined },
        invalidate: async () => { throw new Error("No credential invalidation expected") },
      },
      authorizations: {
        begin: async (input) => { pending = input },
        load: async () => pending ? { codeVerifier: pending.codeVerifier, handle: { id: pending.id, revision: "1", expiresAt: pending.expiresAt, clientRegistrationRevision: pending.clientRegistrationRevision } } : undefined,
        invalidate: async () => { pending = undefined },
      },
    }
    const client = createEnterpriseMcpClient({ fetch: async (rawUrl, init) => {
      const url = String(rawUrl); requests.push(url)
      if (url === resource) {
        if (!new Headers(init?.headers).has("authorization")) return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
        if (!init?.body || init.method === "DELETE") return new Response(null, { status: 200 })
        const rpc: unknown = JSON.parse(String(init.body))
        if (!record(rpc) || !("id" in rpc)) return new Response(null, { status: 202 })
        if (rpc.method === "initialize") return json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "exp-mcpmanual-regression", version: "1" } } })
        if (rpc.method === "tools/list") return json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } })
        return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } })
      }
      if (url.includes("oauth-protected-resource")) return json({ resource, authorization_servers: [issuer] })
      if (url.includes("oauth-authorization-server")) return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], ...(registration === "dynamic" ? { registration_endpoint: `${issuer}/register` } : {}), ...(registration === "client-metadata" ? { client_id_metadata_document_supported: true } : {}) })
      if (url === `${issuer}/register`) { registrations++; return json({ client_id: "exp-mcpmanual-dynamic", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }, 201) }
      if (url === `${issuer}/token`) {
        const form = new URLSearchParams(String(init?.body))
        assert.equal(form.get("code_verifier"), pending?.codeVerifier)
        assert.equal(form.get("resource"), resource)
        assert.equal(form.has("client_secret"), false)
        tokenExchanges++; return json({ access_token: "exp-mcpmanual-test-access", token_type: "Bearer", expires_in: 3600 })
      }
      throw new Error(`Unexpected request: ${url}`)
    } })
    const connection = { id: "exp-mcpmanual-regression", serverUrl: resource, authorization: { type: "oauth", persistence, configuration: { applicationType: "web", clientMetadataUrl: "https://client.example/metadata" } } } satisfies Parameters<typeof client.connect>[0]["connection"]
    const started = await client.connect({ connection, redirectUri: "https://client.example/callback", authorizationId: "exp-mcpmanual-state" })
    assert.equal(started.status, "needs_auth")
    if (started.status !== "needs_auth") throw new Error("Expected authorization URL")
    const url = new URL(started.authorizeUrl)
    assert.equal(url.searchParams.get("code_challenge_method"), "S256")
    assert.equal(url.searchParams.get("resource"), resource)
    assert.ok(requests.some(url => url.includes("oauth-protected-resource")))
    assert.ok(requests.some(url => url.includes("oauth-authorization-server")))
    assert.equal(registrations, registration === "dynamic" ? 1 : 0)
    assert.equal(clientRecord?.source, registration)
    await client.completeAuthorization({ connection, redirectUri: "https://client.example/callback", authorizationId: "exp-mcpmanual-state", code: "exp-mcpmanual-code" })
    assert.equal(tokenExchanges, 1)
    assert.equal(credential?.tokens.access_token, "exp-mcpmanual-test-access")
    assert.equal(pending, undefined)
  })
}
