import { describe, expect, test } from "bun:test"
import {
  discoverExternalMcpConfiguration,
  inferExternalMcpManifestConfiguration,
} from "../src/capability-sources/external-mcp-discovery.js"

const MCP_URL = "https://mcp.example.test/mcp"
const AUTH_URL = "https://auth.example.test"

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
}

function initializeResponse(): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id: "openwork-mcp-discovery",
    result: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      serverInfo: { name: "test-mcp", version: "1.0.0" },
    },
  })
}

describe("external MCP configuration discovery", () => {
  test("maps a declared Bearer placeholder to one supported secret input", () => {
    const result = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: {
        type: "remote",
        url: MCP_URL,
        headers: { Authorization: "Bearer ${EXA_API_KEY}" },
      },
    })

    expect(result.auth).toEqual({ confidence: "declared", kind: "apikey", source: "plugin_manifest" })
    expect(result.inputs).toEqual([expect.objectContaining({
      label: "Exa Api Key",
      placement: "api_key",
      required: true,
      secret: true,
      supported: true,
      variable: "EXA_API_KEY",
    })])
  })

  test("rejects Bearer templates that add fixed text around the secret", () => {
    const result = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: { headers: { Authorization: "Bearer prefix-${API_KEY}" } },
    })

    expect(result.inputs).toEqual([expect.objectContaining({ placement: "api_key", supported: false })])
    expect(result.warnings.join(" ")).toContain("fixed text")
  })

  test("reports custom and multiple setup inputs without pretending Den can apply them", () => {
    const result = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: {
        headers: [
          { name: "X-API-Key", value: "${CUSTOM_KEY}", isSecret: true, isRequired: true },
          { name: "X-Tenant", value: "${TENANT_ID}", isSecret: false, isRequired: true },
        ],
        env: { LOCAL_TOKEN: "${LOCAL_TOKEN}" },
      },
    })

    expect(result.auth.kind).toBe("apikey")
    expect(result.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ placement: "api_key", supported: false, variable: "CUSTOM_KEY" }),
      expect.objectContaining({ placement: "header", supported: false, variable: "TENANT_ID" }),
      expect.objectContaining({ placement: "environment", supported: false, variable: "LOCAL_TOKEN" }),
    ]))
    expect(result.warnings.join(" ")).toContain("Authorization: Bearer")
  })

  test("understands official Registry remotes and their declared variables", () => {
    const result = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: {
        packages: [{ registryType: "npm", identifier: "@example/local-mcp" }],
        remotes: [{
          type: "streamable-http",
          url: MCP_URL,
          headers: [{
            name: "Authorization",
            value: "Bearer {github_pat}",
            variables: {
              github_pat: {
                description: "Fine-grained GitHub token",
                isRequired: true,
                isSecret: true,
              },
            },
          }],
          variables: {
            tenant: { description: "Tenant slug", isRequired: true, isSecret: false },
          },
        }],
      },
    })

    expect(result.transportSupported).toBe(true)
    expect(result.auth.kind).toBe("apikey")
    expect(result.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Fine-grained GitHub token",
        placement: "api_key",
        required: true,
        secret: true,
        supported: true,
        variable: "github_pat",
      }),
      expect.objectContaining({
        label: "Tenant slug",
        placement: "url",
        required: true,
        supported: false,
        variable: "tenant",
      }),
    ]))
  })

  test("marks package-only and executable header configurations unsupported", () => {
    const packageOnly = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: {
        packages: [{ registryType: "npm", identifier: "@example/local-mcp" }],
      },
    })
    expect(packageOnly.transportSupported).toBe(false)

    const helper = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: { type: "http", url: MCP_URL, headersHelper: "print-auth-headers" },
    })
    expect(helper.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Dynamic authentication header helper", supported: false }),
    ]))
    expect(helper.warnings.join(" ")).toContain("will not execute commands")

    const legacySse = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: { type: "sse", url: MCP_URL },
    })
    expect(legacySse.transportSupported).toBe(false)
    expect(legacySse.warnings.join(" ")).toContain("legacy SSE")
  })

  test("never returns a literal credential from a plugin declaration", () => {
    const literal = "do-not-return-this-secret"
    const result = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: { headers: { Authorization: `Bearer ${literal}` } },
    })

    expect(JSON.stringify(result)).not.toContain(literal)
    expect(result.warnings.join(" ")).toContain("literal value")
  })

  test("bounds manifest headers, variables, and environment inputs while scanning", () => {
    const declaredVariables = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
      `TOKEN_${index}`,
      { description: `Token ${index}`, isRequired: true, isSecret: true },
    ]))
    const environment = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
      `ENV_${index}`,
      { description: `Environment ${index}` },
    ]))
    const result = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: {
        headers: [{
          name: "Authorization",
          value: "Bearer ${TOKEN_0}",
          variables: declaredVariables,
        }],
        env: environment,
      },
    })

    expect(result.inputs).toHaveLength(100)
    expect(result.inputs.at(-1)).toEqual(expect.objectContaining({
      label: "Additional publisher configuration inputs",
      supported: false,
    }))
    expect(result.warnings.join(" ")).toContain("more than 100 configuration inputs")
  })

  test("does not mark a declaration oversized at the exact input limit", () => {
    const result = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: {
        env: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`ENV_${index}`, `\${ENV_${index}}`])),
      },
    })

    expect(result.inputs).toHaveLength(100)
    expect(result.warnings.join(" ")).not.toContain("more than 100 configuration inputs")
  })

  test("verifies a valid unauthenticated MCP initialize response", async () => {
    const result = await discoverExternalMcpConfiguration({
      url: MCP_URL,
      fetch: async () => initializeResponse(),
    })

    expect(result.auth).toEqual({ confidence: "inferred", kind: "none", source: "live_protocol" })
    expect(result.support.status).toBe("needs_review")
    expect(result.oauth).toBeNull()
    expect(result.warnings.join(" ")).toContain("later methods")
  })

  test("does not classify an arbitrary successful HTTP response as no-auth MCP", async () => {
    const result = await discoverExternalMcpConfiguration({
      url: MCP_URL,
      fetch: async () => new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }),
    })

    expect(result.auth.kind).toBe("unknown")
    expect(result.support.status).toBe("needs_review")
  })

  test("does not mistake a bare Bearer API-key challenge for verified OAuth", async () => {
    const result = await discoverExternalMcpConfiguration({
      url: "https://mcp.exa.ai/mcp",
      fetch: async (rawUrl, init) => String(rawUrl) === "https://mcp.exa.ai/mcp" && init?.method === "POST"
        ? new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
        : new Response(null, { status: 404 }),
    })

    expect(result.auth).toEqual({ confidence: "curated", kind: "apikey", source: "openwork_preset" })
    expect(result.oauth).toBeNull()
    expect(result.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ placement: "api_key" })]))
  })

  test("applies the response byte ceiling to OAuth metadata fetched by the SDK", async () => {
    const resourceMetadataUrl = `${MCP_URL}/.well-known/oauth-protected-resource`
    const result = await discoverExternalMcpConfiguration({
      url: MCP_URL,
      fetch: async (rawUrl, init) => {
        const url = String(rawUrl)
        if (url === MCP_URL && init?.method === "POST") {
          return new Response(null, {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
          })
        }
        if (url === resourceMetadataUrl) {
          return jsonResponse({ resource: MCP_URL, padding: "x".repeat(70 * 1024) })
        }
        return new Response(null, { status: 404 })
      },
    })

    expect(result.auth.kind).toBe("unknown")
    expect(result.oauth).toBeNull()
    expect(result.warnings.join(" ")).toContain("OAuth metadata")
  })

  test("discovers OAuth, challenge scopes, dynamic registration, and PKCE without registering a client", async () => {
    const calls: Array<{ method: string; url: string }> = []
    const fetch = async (rawUrl: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(rawUrl)
      calls.push({ method: init?.method ?? "GET", url })
      if (url === MCP_URL && init?.method === "POST") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${MCP_URL}/.well-known/oauth-protected-resource", scope="issues:read issues:write"`,
          },
        })
      }
      if (url.includes("oauth-protected-resource")) {
        return jsonResponse({
          resource: MCP_URL,
          authorization_servers: [AUTH_URL],
          scopes_supported: ["issues:read", "issues:write", "admin"],
        })
      }
      if (url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: AUTH_URL,
          authorization_endpoint: `${AUTH_URL}/authorize`,
          token_endpoint: `${AUTH_URL}/token`,
          registration_endpoint: `${AUTH_URL}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile", "issues:read", "issues:write"],
        })
      }
      return new Response(null, { status: 404 })
    }

    const result = await discoverExternalMcpConfiguration({ url: MCP_URL, fetch })

    expect(result.auth).toEqual({ confidence: "verified", kind: "oauth", source: "live_protocol" })
    expect(result.oauth).toEqual(expect.objectContaining({
      clientIdRequired: false,
      clientSecretRequired: false,
      pkce: "s256",
      registration: "dynamic",
      scopes: ["issues:read", "issues:write"],
      scopesSource: "challenge",
    }))
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/register"))).toBe(false)
  })

  test("bounds publisher-controlled OAuth metadata scopes", async () => {
    const fetch = async (rawUrl: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(rawUrl)
      if (url === MCP_URL && init?.method === "POST") {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
      }
      if (url.includes("oauth-protected-resource")) {
        return jsonResponse({
          resource: MCP_URL,
          authorization_servers: [AUTH_URL],
          scopes_supported: ["x".repeat(513), ...Array.from({ length: 105 }, (_, index) => `scope-${index}`)],
        })
      }
      if (url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: AUTH_URL,
          authorization_endpoint: `${AUTH_URL}/authorize`,
          token_endpoint: `${AUTH_URL}/token`,
          registration_endpoint: `${AUTH_URL}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      }
      return new Response(null, { status: 404 })
    }

    const result = await discoverExternalMcpConfiguration({ url: MCP_URL, fetch })

    expect(result.oauth?.scopes).toHaveLength(100)
    expect(result.oauth?.scopes[0]).toBe("scope-0")
    expect(result.oauth?.scopes[99]).toBe("scope-99")
    expect(result.oauth?.scopes.some((scope) => scope.length > 512)).toBe(false)
  })

  test("keeps the combined discovered scope string within the persistence ceiling", () => {
    const scopes = Array.from({ length: 100 }, (_, index) => `${index}-${"x".repeat(500)}`)
    const result = inferExternalMcpManifestConfiguration({
      url: MCP_URL,
      config: {
        auth: { type: "oauth", scopes: scopes.slice(0, 34) },
        oauth: { scopes: scopes.slice(34, 67) },
        scopes: scopes.slice(67),
      },
    })

    expect(result.scopes.length).toBeGreaterThan(0)
    expect(result.scopes.length).toBeLessThan(100)
    expect(result.scopes.join(" ").length).toBeLessThanOrEqual(8_192)
  })

  test("requires only a public client ID when metadata supports token auth none", async () => {
    const fetch = async (rawUrl: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(rawUrl)
      if (url === MCP_URL && init?.method === "POST") {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
      }
      if (url.includes("oauth-protected-resource")) {
        return jsonResponse({ resource: MCP_URL, authorization_servers: [AUTH_URL] })
      }
      if (url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: AUTH_URL,
          authorization_endpoint: `${AUTH_URL}/authorize`,
          token_endpoint: `${AUTH_URL}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }
      return new Response(null, { status: 404 })
    }

    const result = await discoverExternalMcpConfiguration({ url: MCP_URL, fetch })

    expect(result.oauth).toEqual(expect.objectContaining({
      clientIdRequired: true,
      clientSecretRequired: false,
      registration: "pre_registered",
    }))
    expect(result.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ placement: "oauth_client_id", required: true }),
    ]))
    expect(result.inputs.some((field) => field.placement === "oauth_client_secret")).toBe(false)
  })

  test("applies the RFC 8414 client-secret default when token auth methods are omitted", async () => {
    const fetch = async (rawUrl: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(rawUrl)
      if (url === MCP_URL && init?.method === "POST") {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
      }
      if (url.includes("oauth-protected-resource")) {
        return jsonResponse({ resource: MCP_URL, authorization_servers: [AUTH_URL] })
      }
      if (url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: AUTH_URL,
          authorization_endpoint: `${AUTH_URL}/authorize`,
          token_endpoint: `${AUTH_URL}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      }
      return new Response(null, { status: 404 })
    }

    const result = await discoverExternalMcpConfiguration({ url: MCP_URL, fetch })

    expect(result.oauth).toEqual(expect.objectContaining({
      clientIdRequired: true,
      clientSecretRequired: true,
      registration: "pre_registered",
    }))
    expect(result.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ placement: "oauth_client_secret", required: true }),
    ]))
  })

  test("rejects unsupported token endpoint client authentication methods", async () => {
    const fetch = async (rawUrl: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(rawUrl)
      if (url === MCP_URL && init?.method === "POST") {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
      }
      if (url.includes("oauth-protected-resource")) {
        return jsonResponse({ resource: MCP_URL, authorization_servers: [AUTH_URL] })
      }
      if (url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: AUTH_URL,
          authorization_endpoint: `${AUTH_URL}/authorize`,
          token_endpoint: `${AUTH_URL}/token`,
          registration_endpoint: `${AUTH_URL}/register`,
          client_id_metadata_document_supported: true,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["private_key_jwt"],
        })
      }
      return new Response(null, { status: 404 })
    }

    const result = await discoverExternalMcpConfiguration({ url: MCP_URL, fetch })

    expect(result.support.status).toBe("unsupported")
    expect(result.oauth?.registration).toBe("pre_registered")
    expect(result.warnings.join(" ")).toContain("does not support")
  })

  test("keeps authorization-server scopes informational and flags missing PKCE", async () => {
    const fetch = async (rawUrl: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(rawUrl)
      if (url === MCP_URL && init?.method === "POST") {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
      }
      if (url.includes("oauth-protected-resource")) {
        return jsonResponse({ resource: MCP_URL, authorization_servers: [AUTH_URL] })
      }
      if (url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: AUTH_URL,
          authorization_endpoint: `${AUTH_URL}/authorize`,
          token_endpoint: `${AUTH_URL}/token`,
          registration_endpoint: `${AUTH_URL}/register`,
          response_types_supported: ["code"],
          scopes_supported: ["openid", "admin"],
        })
      }
      return new Response(null, { status: 404 })
    }

    const result = await discoverExternalMcpConfiguration({ url: MCP_URL, fetch })

    expect(result.oauth).toEqual(expect.objectContaining({
      pkce: "missing",
      scopes: ["openid", "admin"],
      scopesSource: "authorization_server",
    }))
    expect(result.support.status).toBe("unsupported")
    expect(result.warnings.join(" ")).toContain("catalog")
    expect(result.warnings.join(" ")).toContain("PKCE S256")
  })

  test("prefers Client ID Metadata Documents over legacy dynamic registration", async () => {
    const fetch = async (rawUrl: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(rawUrl)
      if (url === MCP_URL && init?.method === "POST") {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } })
      }
      if (url.includes("oauth-protected-resource")) {
        return jsonResponse({ resource: MCP_URL, authorization_servers: [AUTH_URL] })
      }
      if (url.includes("oauth-authorization-server")) {
        return jsonResponse({
          issuer: AUTH_URL,
          authorization_endpoint: `${AUTH_URL}/authorize`,
          token_endpoint: `${AUTH_URL}/token`,
          registration_endpoint: `${AUTH_URL}/register`,
          client_id_metadata_document_supported: true,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }
      return new Response(null, { status: 404 })
    }

    const result = await discoverExternalMcpConfiguration({ url: MCP_URL, fetch })

    expect(result.oauth).toEqual(expect.objectContaining({
      clientIdRequired: false,
      registration: "client_metadata_document",
    }))
    expect(result.support.status).toBe("auto_configurable")
  })
})
