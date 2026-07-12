import assert from "node:assert/strict"
import test from "node:test"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createDefaultScenario, getProviderProfile, probeEnterpriseMcpMockServer } from "../src/index.js"

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse, baseUrl: string) => void | Promise<void>,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let baseUrl = ""
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response, baseUrl)).catch(() => response.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Test server did not bind")
  baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function challenge(response: ServerResponse, baseUrl: string, endpointPath: string): void {
  response.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${endpointPath}"`,
  })
  response.end('{"error":"unauthorized"}')
}

test("probe bounds oversized and stalled response bodies after headers", async () => {
  const scenario = createDefaultScenario("synthetic-enterprise-oauth-mcp")
  const profile = getProviderProfile(scenario.profileId)

  const oversized = await localServer((request, response, baseUrl) => {
    if (request.method === "POST" && request.url === profile.endpointPath) return challenge(response, baseUrl, profile.endpointPath)
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }))
  })
  try {
    const result = await probeEnterpriseMcpMockServer({ baseUrl: oversized.baseUrl, scenario })
    assert.equal(result.ok, false)
    assert.match(result.error?.messageSafe ?? "", /exceeded the 1048576-byte probe limit/)
  } finally {
    await oversized.close()
  }

  const stalled = await localServer((request, response, baseUrl) => {
    if (request.method === "POST" && request.url === profile.endpointPath) return challenge(response, baseUrl, profile.endpointPath)
    response.writeHead(200, { "content-type": "application/json" })
    response.write('{"resource":')
  })
  try {
    const result = await probeEnterpriseMcpMockServer({ baseUrl: stalled.baseUrl, scenario, timeoutMs: 100 })
    assert.equal(result.ok, false)
    assert.match(result.error?.messageSafe ?? "", /timed out/)
  } finally {
    await stalled.close()
  }
})

test("probe redacts a client secret echoed by a hostile local OAuth endpoint", async () => {
  const secret = "echoed-client-secret-must-never-return"
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const profile = getProviderProfile(scenario.profileId)
  const fake = await localServer(async (request, response, baseUrl) => {
    const url = new URL(request.url ?? "/", baseUrl)
    if (request.method === "POST" && url.pathname === profile.endpointPath) return challenge(response, baseUrl, profile.endpointPath)
    if (url.pathname === `/.well-known/oauth-protected-resource${profile.endpointPath}`) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        resource: `${baseUrl}${profile.endpointPath}`,
        authorization_servers: [baseUrl],
        scopes_supported: scenario.oauth.requiredResourceScopes,
      }))
      return
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}${profile.oauth.authorizationPath}`,
        token_endpoint: `${baseUrl}${profile.oauth.tokenPath}`,
        revocation_endpoint: `${baseUrl}${profile.oauth.revocationPath}`,
        code_challenge_methods_supported: ["S256"],
      }))
      return
    }
    if (url.pathname === profile.oauth.authorizationPath) {
      const destination = new URL(scenario.oauth.redirectUris[0] ?? "http://127.0.0.1/callback")
      destination.searchParams.set("code", "synthetic-code")
      destination.searchParams.set("state", url.searchParams.get("state") ?? "")
      response.writeHead(302, { location: destination.href })
      response.end()
      return
    }
    if (url.pathname === profile.oauth.tokenPath) {
      for await (const _chunk of request) {
        // Consume the bounded request so the fake endpoint behaves like a real token endpoint.
      }
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "invalid_client", error_description: `provider echoed ${secret}` }))
      return
    }
    response.writeHead(404).end()
  })
  try {
    const result = await probeEnterpriseMcpMockServer({
      baseUrl: fake.baseUrl,
      scenario,
      credentials: { clientSecret: secret },
    })
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.match(result.error?.messageSafe ?? "", /\[REDACTED\]/)
  } finally {
    await fake.close()
  }
})

test("probe attributes a closed loopback port to TCP reachability, not HTTP routing", async () => {
  const closed = await localServer((_request, response) => {
    response.end()
  })
  const baseUrl = closed.baseUrl
  await closed.close()
  const scenario = createDefaultScenario("synthetic-enterprise-oauth-mcp")
  const result = await probeEnterpriseMcpMockServer({ baseUrl, scenario, timeoutMs: 500 })
  assert.equal(result.ok, false)
  assert.equal(result.observed.firstFailedPhase, "NETWORK_TCP")
  assert.equal(result.observed.category, "network_tcp")
  assert.equal(result.error?.messageSafe.includes("HTTP routing"), false)
})
