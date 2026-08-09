import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { z } from "zod"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  getProviderProfile,
  probeEnterpriseMcpMockServer,
  type EnterpriseMcpMockServer,
  type EnterpriseMcpScenario,
} from "../src/index.js"
import { authorizeManual, initializeSession, rpcHeaders } from "./wire-client.js"

const oauthClientSecret = "slack-user-mcp-client-secret-32-bytes"
const verifier = "slack-wire-pkce-verifier-with-more-than-43-characters-1234567890"

async function authorizationCode(
  server: EnterpriseMcpMockServer,
  scenario: EnterpriseMcpScenario,
): Promise<string> {
  const profile = getProviderProfile(scenario.profileId)
  const redirectUri = scenario.oauth.redirectUris[0]
  assert.ok(redirectUri)
  const authorize = new URL(profile.oauth.authorizationPath, server.baseUrl)
  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("client_id", scenario.oauth.clientId)
  authorize.searchParams.set("redirect_uri", redirectUri)
  authorize.searchParams.set("scope", scenario.oauth.authorizationScopes.join(" "))
  authorize.searchParams.set("resource", server.mcpUrl)
  authorize.searchParams.set("state", "slack-wire-state")
  authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"))
  authorize.searchParams.set("code_challenge_method", "S256")
  const response = await fetch(authorize, { redirect: "manual" })
  assert.equal(response.status, 302)
  const location = response.headers.get("location")
  assert.ok(location)
  const code = new URL(location).searchParams.get("code")
  assert.ok(code)
  return code
}

function tokenForm(
  server: EnterpriseMcpMockServer,
  scenario: EnterpriseMcpScenario,
  code: string,
): URLSearchParams {
  const redirectUri = scenario.oauth.redirectUris[0]
  assert.ok(redirectUri)
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: scenario.oauth.clientId,
    client_secret: oauthClientSecret,
    redirect_uri: redirectUri,
    resource: server.mcpUrl,
    code,
    code_verifier: verifier,
  })
}

test("Slack profile returns user-token success bodies with observed expiry and token prefixes", async () => {
  const scenario = createDefaultScenario("slack-user-mcp")
  const profile = getProviderProfile(scenario.profileId)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const response = await fetch(new URL(profile.oauth.tokenPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenForm(server, scenario, await authorizationCode(server, scenario)),
    })
    assert.equal(response.status, 200)
    const value: unknown = JSON.parse(await response.text())
    const token = z.object({
      ok: z.literal(true),
      access_token: z.string(),
      refresh_token: z.string(),
      token_type: z.literal("user"),
      expires_in: z.literal(43_200),
      scope: z.string(),
    }).strict().parse(value)
    assert.match(token.access_token, /^xoxp-/)
    assert.match(token.refresh_token, /^xoxe-1-/)
    assert.equal(token.scope, scenario.oauth.authorizationScopes.join(" "))
  } finally {
    await server.stop()
  }
})

test("Slack profile returns HTTP 200 ok:false for bad code, refresh token, and client secret", async () => {
  const scenario = createDefaultScenario("slack-user-mcp")
  const profile = getProviderProfile(scenario.profileId)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const tokenUrl = new URL(profile.oauth.tokenPath, server.baseUrl)
    const badCode = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenForm(server, scenario, "not-a-real-code"),
    })
    assert.equal(badCode.status, 200)
    assert.deepEqual(JSON.parse(await badCode.text()), { ok: false, error: "invalid_code" })

    const badRefresh = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: scenario.oauth.clientId,
        client_secret: oauthClientSecret,
        refresh_token: "not-a-real-refresh-token",
      }),
    })
    assert.equal(badRefresh.status, 200)
    assert.deepEqual(JSON.parse(await badRefresh.text()), { ok: false, error: "invalid_refresh_token" })

    const badClient = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: scenario.oauth.clientId,
        client_secret: "wrong-slack-client-secret",
        code: "not-a-real-code",
      }),
    })
    assert.equal(badClient.status, 200)
    assert.deepEqual(JSON.parse(await badClient.text()), { ok: false, error: "bad_client_secret" })
  } finally {
    await server.stop()
  }
})

test("Slack profile strictly rejects unsupported initialize versions after authentication", async () => {
  const scenario = createDefaultScenario("slack-user-mcp")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const unsupported = await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, token.accessToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "slack-wire-test", version: "1" },
        },
      }),
    })
    assert.equal(unsupported.status, 400)
    assert.deepEqual(JSON.parse(await unsupported.text()), {
      error: "unsupported_protocol_version",
      supportedVersions: ["2025-06-18"],
    })

    const supported = await initializeSession(server.baseUrl, scenario, token)
    assert.equal(supported.protocolVersion, "2025-06-18")
  } finally {
    await server.stop()
  }
})

test("Slack profile checks authentication before strict initialize version validation", async () => {
  const scenario = createDefaultScenario("slack-user-mcp")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        origin: new URL(server.baseUrl).origin,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "slack-wire-test", version: "1" },
        },
      }),
    })
    assert.equal(response.status, 401)
    assert.equal(response.headers.has("www-authenticate"), true)
  } finally {
    await server.stop()
  }
})

test("default probe accepts Slack user tokens only for the Slack response profile", async () => {
  const scenario = createDefaultScenario("slack-user-mcp")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const result = await probeEnterpriseMcpMockServer({
      baseUrl: server.baseUrl,
      scenario,
      credentials: { clientSecret: oauthClientSecret },
    })
    assert.equal(result.ok, true, result.error?.messageSafe)
    assert.equal(result.negotiatedProtocolVersion, "2025-06-18")
    assert.equal(result.toolCount, 3)
  } finally {
    await server.stop()
  }
})
