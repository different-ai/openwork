import { describe, expect, test } from "bun:test"

import { deriveDenMcpResource, deriveFirstPartyMcpTokenResourceFromRequest, isHostedWebAppHost } from "../src/mcp/resource.js"

const DIRECT_API_MCP_RESOURCE = "https://api.example.com/mcp"
const TRUSTED_WEB_ORIGINS = ["https://app.example.com"]

function firstPartyTokenResource(headers: HeadersInit = {}) {
  return deriveFirstPartyMcpTokenResourceFromRequest(new Request("http://den-api.internal/v1/mcp/token", { headers }), {
    fallback: DIRECT_API_MCP_RESOURCE,
    trustedOrigins: TRUSTED_WEB_ORIGINS,
  })
}

describe("deriveDenMcpResource", () => {
  test("routes hosted web-app origins through the /api/den proxy", () => {
    expect(deriveDenMcpResource("https://app.openworklabs.com", [])).toBe(
      "https://app.openworklabs.com/api/den/mcp",
    )
    expect(deriveDenMcpResource("https://app.openwork.software", [])).toBe(
      "https://app.openwork.software/api/den/mcp",
    )
    expect(deriveDenMcpResource("https://den-web-abc123.run.app", [])).toBe(
      "https://den-web-abc123.run.app/api/den/mcp",
    )
  })

  test("keeps direct API origins on the bare /mcp path", () => {
    expect(deriveDenMcpResource("https://api.openworklabs.com", [])).toBe(
      "https://api.openworklabs.com/mcp",
    )
    expect(deriveDenMcpResource("http://127.0.0.1:8790", [])).toBe(
      "http://127.0.0.1:8790/mcp",
    )
    expect(deriveDenMcpResource("http://localhost:8790", [])).toBe(
      "http://localhost:8790/mcp",
    )
  })

  test("honors configured DEN_WEB_APP_HOSTS entries", () => {
    expect(deriveDenMcpResource("https://cloud.example.com", ["cloud.example.com"])).toBe(
      "https://cloud.example.com/api/den/mcp",
    )
    expect(deriveDenMcpResource("https://den.corp.example.com", [".example.com"])).toBe(
      "https://den.corp.example.com/api/den/mcp",
    )
    expect(deriveDenMcpResource("https://den.elsewhere.io", [".example.com"])).toBe(
      "https://den.elsewhere.io/mcp",
    )
  })

  test("strips trailing slashes before appending the path", () => {
    expect(deriveDenMcpResource("https://app.openworklabs.com/", [])).toBe(
      "https://app.openworklabs.com/api/den/mcp",
    )
    expect(deriveDenMcpResource("https://api.openworklabs.com//", [])).toBe(
      "https://api.openworklabs.com/mcp",
    )
  })
})

describe("isHostedWebAppHost", () => {
  test("matches app.* and *.run.app hosts", () => {
    expect(isHostedWebAppHost("app.openworklabs.com", [])).toBe(true)
    expect(isHostedWebAppHost("APP.OPENWORK.SOFTWARE", [])).toBe(true)
    expect(isHostedWebAppHost("den-web-abc.run.app", [])).toBe(true)
  })

  test("rejects API, loopback, and unrelated hosts", () => {
    expect(isHostedWebAppHost("api.openworklabs.com", [])).toBe(false)
    expect(isHostedWebAppHost("localhost", [])).toBe(false)
    expect(isHostedWebAppHost("127.0.0.1", [])).toBe(false)
    expect(isHostedWebAppHost("example.com", [])).toBe(false)
    expect(isHostedWebAppHost("", [])).toBe(false)
  })
})

describe("deriveFirstPartyMcpTokenResourceFromRequest", () => {
  test("uses the trusted den-web /api/den proxy origin", () => {
    expect(firstPartyTokenResource({
      "x-forwarded-host": "app.example.com",
      "x-forwarded-prefix": "/api/den",
      "x-forwarded-proto": "https",
    })).toBe("https://app.example.com/api/den/mcp")
  })

  test("falls back for direct API calls", () => {
    expect(firstPartyTokenResource()).toBe(DIRECT_API_MCP_RESOURCE)
  })

  test("rejects untrusted forwarded hosts", () => {
    expect(firstPartyTokenResource({
      "x-forwarded-host": "evil.example",
      "x-forwarded-prefix": "/api/den",
      "x-forwarded-proto": "https",
    })).toBe(DIRECT_API_MCP_RESOURCE)
  })
})
