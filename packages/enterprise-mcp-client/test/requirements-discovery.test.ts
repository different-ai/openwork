import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { z } from "zod"
import {
  discoverConnectionRequirements,
  selectRecoverableAuthorizationServerIssuer,
  type EnterpriseMcpFetch,
} from "../src/index.js"

const rpcRequestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
}).passthrough()

function unauthenticatedMcpFetch(): EnterpriseMcpFetch {
  return async (_url, init) => {
    const body = typeof init?.body === "string" ? init.body : ""
    if (!body) return new Response(null, { status: 202 })
    const request = rpcRequestSchema.parse(JSON.parse(body))
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (request.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "requirements-test", version: "1.0.0" },
        },
      })
    }
    if (request.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [{
            name: "read-record",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true, destructiveHint: false },
          }],
        },
      })
    }
    return new Response(null, { status: 404 })
  }
}

describe("enterprise MCP requirements discovery", () => {
  it("discovers a 2026 stateless server without an initialize handshake", async () => {
    const methods: string[] = []
    const fetch: EnterpriseMcpFetch = async (_url, init) => {
      assert.equal(typeof init?.body, "string")
      const request = rpcRequestSchema.parse(JSON.parse(init?.body as string))
      methods.push(request.method)
      assert.equal(new Headers(init?.headers).get("mcp-protocol-version"), "2026-07-28")
      assert.equal(new Headers(init?.headers).has("mcp-session-id"), false)
      if (request.method === "server/discover") {
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            _meta: {
              "io.modelcontextprotocol/serverInfo": { name: "requirements-modern-test", version: "1.0.0" },
            },
          },
        })
      }
      if (request.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [{
              name: "read-modern-record",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true, destructiveHint: false },
            }],
            _meta: {
              "io.modelcontextprotocol/serverInfo": { name: "requirements-modern-test", version: "1.0.0" },
            },
          },
        })
      }
      return new Response(null, { status: 404 })
    }

    const result = await discoverConnectionRequirements({
      serverUrl: "https://mcp.example.test/mcp",
      fetch,
    })

    assert.deepEqual(methods, ["server/discover", "tools/list"])
    assert.equal(result.status, "ready")
    assert.equal(result.server.initialize, "succeeded")
    assert.equal(result.server.protocolEra, "modern")
    assert.equal(result.server.protocolVersion, "2026-07-28")
    assert.equal(result.tools.items?.[0]?.name, "read-modern-record")
  })

  it("initializes and lists tools without creating registration state", async () => {
    const result = await discoverConnectionRequirements({
      serverUrl: "https://mcp.example.test/mcp",
      fetch: unauthenticatedMcpFetch(),
    })

    assert.equal(result.status, "ready")
    assert.equal(result.server.initialize, "succeeded")
    assert.equal(result.authentication.kind, "none")
    assert.equal(result.tools.visibility, "available_without_auth")
    assert.equal(result.tools.count, 1)
    assert.equal(result.tools.items?.[0]?.readOnlyHint, true)
  })

  it("discovers protected-resource and authorization-server requirements without performing DCR", async () => {
    let registrationRequests = 0
    const fetch: EnterpriseMcpFetch = async (url) => {
      const target = new URL(url)
      if (target.pathname === "/resource-metadata") {
        return Response.json({
          resource: "https://mcp.example.test/mcp",
          authorization_servers: ["https://identity.example.test/tenant"],
          scopes_supported: ["records.read", "records.write", "offline_access"],
        })
      }
      if (target.pathname === "/.well-known/oauth-authorization-server/tenant") {
        return Response.json({
          issuer: "https://identity.example.test/tenant",
          authorization_endpoint: "https://identity.example.test/tenant/authorize",
          token_endpoint: "https://identity.example.test/tenant/token",
          registration_endpoint: "https://identity.example.test/tenant/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
          scopes_supported: ["records.read", "records.write", "offline_access"],
        })
      }
      if (target.pathname.endsWith("/register")) {
        registrationRequests += 1
        return new Response(null, { status: 500 })
      }
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": "Bearer resource_metadata=\"https://mcp.example.test/resource-metadata\", scope=\"records.read\"",
        },
      })
    }

    const result = await discoverConnectionRequirements({
      serverUrl: "https://mcp.example.test/mcp",
      fetch,
    })

    assert.equal(result.server.initialize, "authentication_required")
    assert.equal(result.authentication.kind, "oauth")
    assert.deepEqual(result.authentication.requiredScopes, ["records.read"])
    assert.deepEqual(result.authentication.recommendedScopes, ["records.read", "offline_access"])
    assert.equal(result.authentication.recommendedRegistrationMethod, "client_metadata")
    assert.deepEqual(result.authentication.availableRegistrationMethods, ["client_metadata", "pre_registered", "dynamic"])
    assert.equal(result.authentication.refreshSupport, "supported")
    assert.equal(result.tools.visibility, "requires_auth")
    assert.equal(registrationRequests, 0)
  })

  it("requires explicit selection when protected-resource metadata advertises multiple issuers", async () => {
    const issuers = ["https://identity-a.example.test", "https://identity-b.example.test"]
    const fetch: EnterpriseMcpFetch = async (url) => {
      const target = new URL(url)
      if (target.pathname === "/resource-metadata") {
        return Response.json({ resource: "https://mcp.example.test/mcp", authorization_servers: issuers })
      }
      const issuer = issuers.find((candidate) => target.origin === candidate)
      if (issuer && target.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          client_id_metadata_document_supported: true,
        })
      }
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer resource_metadata=\"https://mcp.example.test/resource-metadata\"" },
      })
    }

    const result = await discoverConnectionRequirements({
      serverUrl: "https://mcp.example.test/mcp",
      fetch,
    })
    assert.equal(result.status, "manual_action_required")
    assert.equal(result.authentication.authorizationServers.length, 2)
    assert.equal(result.manualRequirements[0]?.code, "authorization_server_selection")
    assert.equal(result.manualRequirements[0]?.required, true)
  })

  it("accepts a resource-scoped OAuth discovery alias while exposing the canonical issuer", async () => {
    const resource = "https://api.salesforce.example:443/platform/mcp/v1/platform/sobject-all"
    const fetch: EnterpriseMcpFetch = async (url) => {
      const target = new URL(url)
      if (target.pathname === "/.well-known/oauth-protected-resource/platform/mcp/v1/platform/sobject-all") {
        return Response.json({
          resource,
          authorization_servers: [resource],
          scopes_supported: ["mcp_api", "refresh_token"],
        })
      }
      if (target.pathname === "/.well-known/oauth-authorization-server/platform/mcp/v1/platform/sobject-all") {
        return Response.json({
          issuer: "https://login.salesforce.example",
          authorization_endpoint: "https://login.salesforce.example/services/oauth2/authorize",
          token_endpoint: "https://login.salesforce.example/services/oauth2/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["mcp_api", "refresh_token"],
        })
      }
      if (target.origin === "https://login.salesforce.example" && target.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://login.salesforce.example",
          authorization_endpoint: "https://login.salesforce.example/services/oauth2/authorize",
          token_endpoint: "https://login.salesforce.example/services/oauth2/token",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["mcp_api", "refresh_token"],
        })
      }
      return new Response(null, { status: 401 })
    }

    const result = await discoverConnectionRequirements({
      serverUrl: "https://api.salesforce.example/platform/mcp/v1/platform/sobject-all",
      fetch,
    })

    assert.equal(result.authentication.authorizationServers[0]?.issuer, "https://login.salesforce.example")
    assert.deepEqual(result.authentication.authorizationServers[0]?.scopesSupported, ["mcp_api", "refresh_token"])
    assert.deepEqual(result.authentication.recommendedScopes, ["mcp_api", "refresh_token"])
    assert.equal(result.authentication.recommendedRegistrationMethod, "pre_registered")
    assert.equal(result.warnings.some((warning) => warning.code === "oauth_issuer_mismatch"), false)
    assert.equal(selectRecoverableAuthorizationServerIssuer({
      selectedIssuer: resource,
      requirements: result,
    }), "https://login.salesforce.example")
  })

  it("accepts a root resource discovery alias with an equivalent trailing slash", async () => {
    const fetch: EnterpriseMcpFetch = async (url) => {
      const target = new URL(url)
      if (target.origin === "https://mcp.vercel.example" && target.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: "https://mcp.vercel.example/",
          authorization_servers: ["https://mcp.vercel.example"],
        })
      }
      if (target.origin === "https://mcp.vercel.example" && target.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://vercel.example",
          authorization_endpoint: "https://vercel.example/oauth/authorize",
          token_endpoint: "https://vercel.example/oauth/token",
          registration_endpoint: "https://vercel.example/oauth/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        })
      }
      if (target.origin === "https://vercel.example" && target.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://vercel.example",
          authorization_endpoint: "https://vercel.example/oauth/authorize",
          token_endpoint: "https://vercel.example/oauth/token",
          registration_endpoint: "https://vercel.example/oauth/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        })
      }
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": "Bearer resource_metadata=\"https://mcp.vercel.example/.well-known/oauth-protected-resource\"",
        },
      })
    }

    const result = await discoverConnectionRequirements({
      serverUrl: "https://mcp.vercel.example",
      fetch,
    })

    assert.equal(result.authentication.authorizationServers[0]?.issuer, "https://vercel.example")
    assert.equal(result.authentication.recommendedRegistrationMethod, "dynamic")
    assert.equal(result.warnings.some((warning) => warning.code === "oauth_issuer_mismatch"), false)
    assert.equal(selectRecoverableAuthorizationServerIssuer({
      selectedIssuer: "https://mcp.vercel.example",
      requirements: result,
    }), "https://vercel.example")
    assert.equal(selectRecoverableAuthorizationServerIssuer({
      selectedIssuer: "https://unrelated.example",
      requirements: result,
    }), undefined)
  })

  it("ignores endpoints from a resource alias and uses strictly bound canonical metadata", async () => {
    const resource = "https://mcp.example.test/mcp"
    const issuer = "https://identity.example.test"
    const fetch: EnterpriseMcpFetch = async (url) => {
      const target = new URL(url)
      if (target.origin === "https://mcp.example.test" && target.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ resource, authorization_servers: [resource] })
      }
      if (target.origin === "https://mcp.example.test" && target.pathname === "/.well-known/oauth-authorization-server/mcp") {
        return Response.json({
          issuer,
          authorization_endpoint: "https://attacker.example.test/authorize",
          token_endpoint: "https://attacker.example.test/token",
          registration_endpoint: "https://attacker.example.test/register",
          response_types_supported: ["code"],
        })
      }
      if (target.origin === "https://identity.example.test" && target.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
        })
      }
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer resource_metadata=\"https://mcp.example.test/.well-known/oauth-protected-resource/mcp\"" },
      })
    }

    const result = await discoverConnectionRequirements({ serverUrl: resource, fetch })

    assert.equal(result.authentication.authorizationServers[0]?.issuer, issuer)
    assert.equal(result.authentication.authorizationServers[0]?.authorizationEndpoint, `${issuer}/authorize`)
    assert.equal(result.authentication.authorizationServers[0]?.tokenEndpoint, `${issuer}/token`)
    assert.equal(result.authentication.authorizationServers[0]?.registrationEndpoint, undefined)
  })

  it("rejects a resource alias when the claimed canonical issuer does not verify", async () => {
    const resource = "https://mcp.example.test/mcp"
    const fetch: EnterpriseMcpFetch = async (url) => {
      const target = new URL(url)
      if (target.origin === "https://mcp.example.test" && target.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ resource, authorization_servers: [resource] })
      }
      if (target.origin === "https://mcp.example.test" && target.pathname === "/.well-known/oauth-authorization-server/mcp") {
        return Response.json({
          issuer: "https://identity.example.test",
          authorization_endpoint: "https://attacker.example.test/authorize",
          token_endpoint: "https://attacker.example.test/token",
          response_types_supported: ["code"],
        })
      }
      if (target.origin === "https://identity.example.test" && target.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://different.example.test",
          authorization_endpoint: "https://attacker.example.test/authorize",
          token_endpoint: "https://attacker.example.test/token",
          response_types_supported: ["code"],
        })
      }
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": "Bearer resource_metadata=\"https://mcp.example.test/.well-known/oauth-protected-resource/mcp\"" },
      })
    }

    const result = await discoverConnectionRequirements({ serverUrl: resource, fetch })

    assert.equal(result.authentication.authorizationServers.length, 0)
    assert.equal(result.authentication.authorizationServers.some((server) => server.tokenEndpoint?.includes("attacker.example.test")), false)
    assert.equal(result.warnings.some((warning) => warning.code === "oauth_issuer_mismatch"), true)
    assert.equal(result.status, "manual_action_required")
  })

  it("accepts an authorization-server root issuer with an equivalent trailing slash", async () => {
    const fetch: EnterpriseMcpFetch = async (url) => {
      const target = new URL(url)
      if (target.origin === "https://mcp.close.example" && target.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: "https://mcp.close.example/",
          authorization_servers: ["https://api.close.example/"],
          scopes_supported: ["mcp.read", "offline_access"],
        })
      }
      if (target.origin === "https://api.close.example" && target.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://api.close.example",
          authorization_endpoint: "https://app.close.example/oauth2/authorize/",
          token_endpoint: "https://api.close.example/oauth2/token/",
          registration_endpoint: "https://api.close.example/oauth2/register/",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["mcp.read", "offline_access"],
        })
      }
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": "Bearer resource_metadata=\"https://mcp.close.example/.well-known/oauth-protected-resource\"",
        },
      })
    }

    const result = await discoverConnectionRequirements({
      serverUrl: "https://mcp.close.example/mcp",
      fetch,
    })

    assert.equal(result.authentication.authorizationServers[0]?.issuer, "https://api.close.example")
    assert.equal(result.authentication.recommendedRegistrationMethod, "dynamic")
    assert.equal(result.warnings.some((warning) => warning.code === "oauth_issuer_mismatch"), false)
    assert.equal(selectRecoverableAuthorizationServerIssuer({
      selectedIssuer: "https://api.close.example/",
      requirements: result,
    }), "https://api.close.example")
  })
})
