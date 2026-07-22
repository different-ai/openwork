import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const API_ORIGIN = "http://127.0.0.1:8790"
const AGENT_RESOURCE = `${API_ORIGIN}/mcp/agent`
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const denApiRoot = path.join(repoRoot, "ee/apps/den-api")

type ProbeOptions = {
  endpoint: "authorize" | "token"
  grantType?: "authorization_code" | "refresh_token" | "client_credentials"
  scope?: string
  omitScope?: boolean
  redirectUri?: string
  clientScopes?: string[]
  resources: string[]
  expect: "invalid_redirect_uri" | "invalid_target" | "normalized" | "unchanged"
  expectNoStore?: boolean
}

function runProbe(options: ProbeOptions) {
  const script = `
const options = JSON.parse(process.env.TEST_OPTIONS ?? "{}")
const apiOrigin = process.env.API_ORIGIN
const agentResource = process.env.AGENT_RESOURCE
if (!apiOrigin || !agentResource) throw new Error("Missing probe environment")
const { mock } = await import("bun:test")

mock.module("./src/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ scopes: JSON.stringify(options.clientScopes ?? ["mcp:read", "mcp:write"]) }]),
        }),
      }),
    }),
  },
}))

const { normalizeMcpOAuthRequest } = await import("./src/routes/auth/index.js")

function buildRequest() {
  if (options.endpoint === "authorize") {
    const url = new URL(apiOrigin + "/api/auth/oauth2/authorize")
    url.searchParams.set("client_id", "client_test")
    if (!options.omitScope) url.searchParams.set("scope", options.scope ?? "mcp:read")
    if (options.redirectUri) url.searchParams.set("redirect_uri", options.redirectUri)
    for (const resource of options.resources) url.searchParams.append("resource", resource)
    return new Request(url)
  }
  const body = new URLSearchParams({
    grant_type: options.grantType,
    client_id: "client_test",
    code: "code_test",
    refresh_token: "refresh_test",
  })
  for (const resource of options.resources) body.append("resource", resource)
  return new Request(apiOrigin + "/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
}

const result = await normalizeMcpOAuthRequest(buildRequest())
if (options.expect === "invalid_target" || options.expect === "invalid_redirect_uri") {
  if (!(result instanceof Response)) throw new Error("Expected OAuth error Response")
  if (result.status !== 400) throw new Error("Expected status 400, got " + result.status)
  if (options.expectNoStore && result.headers.get("cache-control") !== "no-store") throw new Error("Expected no-store")
  const body = await result.json()
  if (body.error !== options.expect) throw new Error("Expected " + options.expect + ", got " + body.error)
} else if (options.expect === "normalized") {
  if (!(result instanceof Request)) throw new Error("Expected normalized Request")
  const resource = result.method === "GET"
    ? new URL(result.url).searchParams.get("resource")
    : new URLSearchParams(await result.text()).get("resource")
  if (resource !== agentResource) throw new Error("Expected resource " + agentResource + ", got " + resource)
} else {
  if (!(result instanceof Request)) throw new Error("Expected unchanged Request")
  const resource = result.method === "GET"
    ? new URL(result.url).searchParams.get("resource")
    : new URLSearchParams(await result.text()).get("resource")
  if (resource !== null) throw new Error("Expected no resource, got " + resource)
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
      BETTER_AUTH_URL: API_ORIGIN,
      DEN_API_PUBLIC_URL: API_ORIGIN,
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      DEN_MCP_RESOURCE_URL: "",
      DEN_MCP_ADDITIONAL_RESOURCES: "",
      DEN_WEB_APP_HOSTS: "",
      API_ORIGIN,
      AGENT_RESOURCE,
      TEST_OPTIONS: JSON.stringify(options),
    },
  })

  if (result.status !== 0) {
    throw new Error([
      "MCP OAuth resource normalization probe failed",
      `status: ${result.status}`,
      `stdout: ${result.stdout}`,
      `stderr: ${result.stderr}`,
    ].join("\n"))
  }
  expect(result.stdout).toContain("ok")
}

test("non-MCP authorize and token requests without resource pass through", () => {
  const nonMcpClientScopes = ["openid", "profile", "email"]
  runProbe({ endpoint: "authorize", scope: "openid profile", clientScopes: nonMcpClientScopes, resources: [], expect: "unchanged" })
  runProbe({ endpoint: "token", grantType: "authorization_code", clientScopes: nonMcpClientScopes, resources: [], expect: "unchanged" })
  runProbe({ endpoint: "token", grantType: "refresh_token", clientScopes: nonMcpClientScopes, resources: [], expect: "unchanged" })
  runProbe({ endpoint: "token", grantType: "client_credentials", clientScopes: nonMcpClientScopes, resources: [], expect: "unchanged" })
})

test("authorize rejects missing MCP OAuth resource", () => {
  runProbe({ endpoint: "authorize", resources: [], expect: "invalid_target" })
})

test("token rejects missing MCP OAuth resource for authorization-code grants", () => {
  runProbe({ endpoint: "token", grantType: "authorization_code", resources: [], expect: "invalid_target", expectNoStore: true })
})

test("token rejects missing MCP OAuth resource for refresh grants", () => {
  runProbe({ endpoint: "token", grantType: "refresh_token", resources: [], expect: "invalid_target", expectNoStore: true })
})

test("token rejects missing MCP OAuth resource for client-credentials grants", () => {
  runProbe({ endpoint: "token", grantType: "client_credentials", resources: [], expect: "invalid_target", expectNoStore: true })
})

test("authorize rejects unknown and multiple MCP OAuth resources", () => {
  runProbe({ endpoint: "authorize", resources: ["https://evil.example/mcp"], expect: "invalid_target" })
  runProbe({ endpoint: "authorize", resources: [`${API_ORIGIN}/mcp`, AGENT_RESOURCE], expect: "invalid_target" })
})

test("authorize rejects fragment-bearing redirects from previously registered MCP clients", () => {
  runProbe({
    endpoint: "authorize",
    redirectUri: "https://client.example/oauth/callback#fragment",
    resources: [AGENT_RESOURCE],
    expect: "invalid_redirect_uri",
  })
  runProbe({
    endpoint: "authorize",
    omitScope: true,
    redirectUri: "https://client.example/oauth/callback#fragment",
    resources: [AGENT_RESOURCE],
    expect: "invalid_redirect_uri",
  })
})

test("token rejects unknown and multiple MCP OAuth resources", () => {
  runProbe({ endpoint: "token", grantType: "refresh_token", resources: ["https://evil.example/mcp"], expect: "invalid_target", expectNoStore: true })
  runProbe({ endpoint: "token", grantType: "refresh_token", resources: [`${API_ORIGIN}/mcp`, AGENT_RESOURCE], expect: "invalid_target", expectNoStore: true })
})

test("legacy parent and child resources normalize to the singleton agent resource", () => {
  runProbe({ endpoint: "authorize", resources: [`${API_ORIGIN}/mcp`], expect: "normalized" })
  runProbe({ endpoint: "authorize", resources: [`${API_ORIGIN}/mcp/admin`], expect: "normalized" })
  runProbe({ endpoint: "token", grantType: "refresh_token", resources: [`${API_ORIGIN}/mcp/agent`], expect: "normalized" })
})

test("exact singleton resource passes without changing OAuth requests", () => {
  runProbe({ endpoint: "authorize", resources: [AGENT_RESOURCE], expect: "normalized" })
  runProbe({ endpoint: "token", grantType: "refresh_token", resources: [AGENT_RESOURCE], expect: "normalized" })
})
