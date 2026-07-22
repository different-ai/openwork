import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { deriveDenMcpResource, resolveMcpResourceFromRequest } from "../src/mcp/resource.js"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const denApiRoot = path.join(repoRoot, "ee/apps/den-api")

type ProbeOptions = {
  betterAuthUrl: string
  apiPublicUrl?: string
  additionalResources?: string
  headers?: Record<string, string>
  requestUrl: string
  expectedResource: string
  metadataUrl?: string
  expectedMetadataResource?: string
  expectedAuthorizationServer?: string
  authMetadataUrl?: string
  expectedAuthIssuer?: string
  route?: "mcp" | "agent" | "admin"
  expectedMetadataUrl?: string
}

function runMcpResourceProbe(options: ProbeOptions) {
  const script = `
const requestUrl = process.env.TEST_REQUEST_URL
const expectedResource = process.env.EXPECTED_RESOURCE
if (!requestUrl || !expectedResource) {
  throw new Error("Missing MCP resource probe inputs")
}

const { DEN_MCP_OAUTH_VALID_AUDIENCES } = await import("./src/auth.js")
const { getMcpResourceContext, getMcpResourceUrl } = await import("./src/mcp/auth.js")
const requestHeaders = JSON.parse(process.env.TEST_REQUEST_HEADERS ?? "{}")
const requestInit = { headers: requestHeaders }
const route = process.env.TEST_MCP_ROUTE
const request = new Request(requestUrl, requestInit)
const context = route ? getMcpResourceContext(request, route) : null
const resource = context ? context.resourceUrl : getMcpResourceUrl(request)
if (resource !== expectedResource) {
  throw new Error(\`Expected resource \${expectedResource}, got \${resource}\`)
}
if (route === "agent" && (DEN_MCP_OAUTH_VALID_AUDIENCES.length !== 1 || DEN_MCP_OAUTH_VALID_AUDIENCES[0] !== expectedResource)) {
  throw new Error(\`Expected single OAuth audience \${expectedResource}, got \${DEN_MCP_OAUTH_VALID_AUDIENCES.join(",")}\`)
}
const expectedMetadataUrl = process.env.EXPECTED_METADATA_URL
if (expectedMetadataUrl && context?.metadataUrl !== expectedMetadataUrl) {
  throw new Error(\`Expected metadata URL \${expectedMetadataUrl}, got \${context?.metadataUrl}\`)
}

const metadataUrl = process.env.TEST_METADATA_URL
if (metadataUrl) {
  const expectedMetadataResource = process.env.EXPECTED_METADATA_RESOURCE
  const expectedAuthorizationServer = process.env.EXPECTED_AUTHORIZATION_SERVER
  if (!expectedMetadataResource || !expectedAuthorizationServer) {
    throw new Error("Missing MCP metadata probe expectations")
  }

  const { protectedResourceMetadata } = await import("./src/mcp/index.js")
  const metadata = protectedResourceMetadata(new Request(metadataUrl, requestInit), route || "mcp")
  const authorizationServer = metadata.authorization_servers[0]
  if (metadata.resource !== expectedMetadataResource) {
    throw new Error(\`Expected metadata resource \${expectedMetadataResource}, got \${metadata.resource}\`)
  }
  if (authorizationServer !== expectedAuthorizationServer) {
    throw new Error(\`Expected authorization server \${expectedAuthorizationServer}, got \${authorizationServer}\`)
  }
}

const authMetadataUrl = process.env.TEST_AUTH_METADATA_URL
if (authMetadataUrl) {
  const expectedAuthIssuer = process.env.EXPECTED_AUTH_ISSUER
  if (!expectedAuthIssuer) {
    throw new Error("Missing auth metadata probe expectations")
  }

  const { Hono } = await import("hono")
  const { registerAuthRoutes } = await import("./src/routes/auth/index.js")
  const app = new Hono()
  registerAuthRoutes(app)
  const response = await app.request(new Request(authMetadataUrl, requestInit))
  if (!response.ok) {
    throw new Error(\`Expected auth metadata response to be ok, got \${response.status}: \${await response.text()}\`)
  }
  const metadata = await response.json()
  if (metadata.issuer !== expectedAuthIssuer) {
    throw new Error(\`Expected auth issuer \${expectedAuthIssuer}, got \${metadata.issuer}\`)
  }
  if (metadata.authorization_response_iss_parameter_supported !== false) {
    throw new Error("Expected authorization response issuer support to remain optional")
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    const endpoint = metadata[key]
    if (typeof endpoint !== "string" || !endpoint.startsWith(\`\${expectedAuthIssuer}/\`)) {
      throw new Error(\`Expected \${key} to use canonical auth issuer \${expectedAuthIssuer}, got \${endpoint}\`)
    }
  }
}

console.log("ok")
`

  const result = spawnSync(process.execPath, ["--conditions", "development", "--eval", script], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: options.betterAuthUrl,
      DEN_API_PUBLIC_URL: options.apiPublicUrl ?? "",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      DEN_ORG_MODE: "",
      DEN_MCP_RESOURCE_URL: "",
      DEN_MCP_ADDITIONAL_RESOURCES: options.additionalResources ?? "",
      DEN_WEB_APP_HOSTS: "",
      TEST_REQUEST_HEADERS: JSON.stringify(options.headers ?? {}),
      TEST_REQUEST_URL: options.requestUrl,
      EXPECTED_RESOURCE: options.expectedResource,
      TEST_METADATA_URL: options.metadataUrl ?? "",
      EXPECTED_METADATA_RESOURCE: options.expectedMetadataResource ?? "",
      EXPECTED_AUTHORIZATION_SERVER: options.expectedAuthorizationServer ?? "",
      TEST_AUTH_METADATA_URL: options.authMetadataUrl ?? "",
      EXPECTED_AUTH_ISSUER: options.expectedAuthIssuer ?? "",
      TEST_MCP_ROUTE: options.route ?? "",
      EXPECTED_METADATA_URL: options.expectedMetadataUrl ?? "",
    },
  })

  if (result.status !== 0) {
    throw new Error([
      "MCP resource probe failed",
      `status: ${result.status}`,
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
    ].join("\n"))
  }

  expect(result.stdout).toContain("ok")
}

describe("getMcpResourceUrl", () => {
  test("auto-trusts the public API origin resource", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.example.com",
      apiPublicUrl: "https://api.example.com",
      route: "agent",
      requestUrl: "https://api.example.com/mcp/agent",
      expectedResource: "https://api.example.com/mcp/agent",
      expectedMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource/mcp/agent",
      metadataUrl: "https://api.example.com/mcp/agent",
      expectedMetadataResource: "https://api.example.com/mcp/agent",
      expectedAuthorizationServer: "https://app.example.com/api/auth",
    })
  })

  test("keeps the external OAuth resource on the configured public API origin for proxied requests", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.example.com",
      apiPublicUrl: "https://api.example.com",
      route: "agent",
      headers: {
        "x-forwarded-host": "app.example.com",
        "x-forwarded-prefix": "/api/den",
        "x-forwarded-proto": "https",
      },
      requestUrl: "http://den-api.internal/mcp/agent",
      expectedResource: "https://api.example.com/mcp/agent",
      expectedMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource/mcp/agent",
    })
  })

  test("does not derive the agent OAuth resource from a spoofed request host", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.example.com",
      apiPublicUrl: "https://api.example.com",
      route: "agent",
      requestUrl: "https://attacker.example/mcp/agent",
      expectedResource: "https://api.example.com/mcp/agent",
      expectedMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource/mcp/agent",
      metadataUrl: "https://attacker.example/mcp/agent",
      expectedMetadataResource: "https://api.example.com/mcp/agent",
      expectedAuthorizationServer: "https://app.example.com/api/auth",
    })
  })

  test("auto-trusts a path-prefixed public API resource", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.example.com",
      apiPublicUrl: "https://openwork.example/api/den",
      route: "agent",
      requestUrl: "https://openwork.example/api/den/mcp/agent",
      expectedResource: "https://openwork.example/api/den/mcp/agent",
      expectedMetadataUrl: "https://openwork.example/.well-known/oauth-protected-resource/api/den/mcp/agent",
      metadataUrl: "https://openwork.example/api/den/mcp/agent",
      expectedMetadataResource: "https://openwork.example/api/den/mcp/agent",
      expectedAuthorizationServer: "https://app.example.com/api/auth",
    })
  })

  test("selects the https public API resource behind a TLS-terminating proxy", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.example.com",
      apiPublicUrl: "https://api.example.com",
      route: "agent",
      headers: { "x-forwarded-proto": "https, http" },
      requestUrl: "http://api.example.com/mcp/agent",
      expectedResource: "https://api.example.com/mcp/agent",
      expectedMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource/mcp/agent",
      metadataUrl: "http://api.example.com/mcp/agent",
      expectedMetadataResource: "https://api.example.com/mcp/agent",
      expectedAuthorizationServer: "https://app.example.com/api/auth",
      authMetadataUrl: "http://api.example.com/api/auth/.well-known/oauth-authorization-server",
      expectedAuthIssuer: "https://app.example.com/api/auth",
    })
  })

  test("uses the configured public API agent resource instead of the incoming plain-http origin", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.example.com",
      apiPublicUrl: "https://api.example.com",
      route: "agent",
      requestUrl: "http://api.example.com/mcp/agent",
      expectedResource: "https://api.example.com/mcp/agent",
    })
  })

  test("honors an additional direct API-origin resource", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.openworklabs.com",
      additionalResources: " https://api.openworklabs.com/mcp/ ",
      requestUrl: "https://api.openworklabs.com/mcp/agent",
      expectedResource: "https://api.openworklabs.com/mcp",
      metadataUrl: "https://api.openworklabs.com/mcp/agent",
      expectedMetadataResource: "https://api.openworklabs.com/mcp",
      expectedAuthorizationServer: "https://app.openworklabs.com/api/auth",
    })
  })

  test("falls back to the configured resource when the request origin is not allowlisted", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.openworklabs.com",
      route: "agent",
      requestUrl: "https://api.openworklabs.com/mcp/agent",
      expectedResource: "https://app.openworklabs.com/api/den/mcp/agent",
    })
  })

  test("treats an empty public API URL as unset", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.example.com",
      apiPublicUrl: "",
      route: "agent",
      requestUrl: "https://api.example.com/mcp/agent",
      expectedResource: "https://app.example.com/api/den/mcp/agent",
    })
  })

  test("honors the proxied web-app resource derived from BETTER_AUTH_URL", () => {
    runMcpResourceProbe({
      betterAuthUrl: "https://app.example.com",
      requestUrl: "https://app.example.com/api/den/mcp",
      expectedResource: "https://app.example.com/api/den/mcp",
      metadataUrl: "https://app.example.com/api/den/mcp",
      expectedMetadataResource: "https://app.example.com/api/den/mcp",
      expectedAuthorizationServer: "https://app.example.com/api/auth",
    })
  })
})

describe("resolveMcpResourceFromRequest", () => {
  test("checks bare and proxied candidates against a static allowlist", () => {
    expect(resolveMcpResourceFromRequest(
      "https://api.openworklabs.com/mcp/agent",
      ["https://api.openworklabs.com/mcp"],
      "https://app.openworklabs.com/api/den/mcp",
    )).toBe("https://api.openworklabs.com/mcp")

    expect(resolveMcpResourceFromRequest(
      "https://api.openworklabs.com/mcp/agent",
      ["https://app.openworklabs.com/api/den/mcp"],
      "https://app.openworklabs.com/api/den/mcp",
    )).toBe("https://app.openworklabs.com/api/den/mcp")

    expect(resolveMcpResourceFromRequest(
      "https://app.example.com/.well-known/oauth-protected-resource/mcp/agent",
      ["https://app.example.com/api/den/mcp", "https://app.example.com/mcp"],
      "https://app.example.com/api/den/mcp",
    )).toBe("https://app.example.com/api/den/mcp")
  })
})

describe("deriveDenMcpResource", () => {
  test("keeps hosted web-app and direct API origin behavior unchanged", () => {
    expect(deriveDenMcpResource("https://app.openworklabs.com", [])).toBe(
      "https://app.openworklabs.com/api/den/mcp",
    )
    expect(deriveDenMcpResource("https://api.openworklabs.com", [])).toBe(
      "https://api.openworklabs.com/mcp",
    )
  })
})
