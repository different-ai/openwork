import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { z } from "zod"
import { discoverConnectionRequirements, type EnterpriseMcpFetch } from "../src/index.js"

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
  })
})
