import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { z } from "zod"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  getProviderProfile,
} from "../src/index.js"
import type { ProviderProfileId } from "../src/index.js"
import { authorizeClient, authorizeManual, callRpc, initializeSession, rpcHeaders } from "./wire-client.js"

const oauthClientSecret = "synthetic-test-client-secret-32-bytes"

async function invalidClientTokenResponse(profileId: ProviderProfileId): Promise<Response> {
  const scenario = createDefaultScenario(profileId)
  const profile = getProviderProfile(profileId)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const verifier = "wire-test-pkce-verifier-with-more-than-43-characters-1234567890"
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const redirectUri = scenario.oauth.redirectUris[0]
    assert.ok(redirectUri)
    const authorize = new URL(profile.oauth.authorizationPath, server.baseUrl)
    authorize.searchParams.set("response_type", "code")
    authorize.searchParams.set("client_id", scenario.oauth.clientId)
    authorize.searchParams.set("redirect_uri", redirectUri)
    authorize.searchParams.set("scope", scenario.oauth.authorizationScopes.join(" "))
    authorize.searchParams.set("resource", server.mcpUrl)
    authorize.searchParams.set("state", "invalid-client-state")
    authorize.searchParams.set("code_challenge", challenge)
    authorize.searchParams.set("code_challenge_method", "S256")
    const authorizeResponse = await fetch(authorize, { redirect: "manual" })
    assert.equal(authorizeResponse.status, 302)
    const location = authorizeResponse.headers.get("location")
    assert.ok(location)
    const code = new URL(location).searchParams.get("code")
    assert.ok(code)

    return await fetch(new URL(profile.oauth.tokenPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: scenario.oauth.clientId,
        client_secret: "wrong-secret-must-not-be-echoed",
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
        resource: server.mcpUrl,
      }),
    })
  } finally {
    await server.stop()
  }
}

test("ServiceNow profile exposes exact manual OAuth topology and enforces exact redirects", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const profile = getProviderProfile(scenario.profileId)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const metadataResponse = await fetch(new URL("/.well-known/oauth-authorization-server", server.baseUrl))
    const metadataText = await metadataResponse.text()
    const metadataValue: unknown = JSON.parse(metadataText)
    const metadata = z.object({
      authorization_endpoint: z.url(),
      token_endpoint: z.url(),
      revocation_endpoint: z.url(),
      registration_endpoint: z.unknown().optional(),
    }).parse(metadataValue)
    assert.equal(new URL(metadata.authorization_endpoint).pathname, "/oauth_auth.do")
    assert.equal(new URL(metadata.token_endpoint).pathname, "/oauth_token.do")
    assert.equal(new URL(metadata.revocation_endpoint).pathname, "/oauth_revoke.do")
    assert.equal(metadata.registration_endpoint, undefined)

    const invalidRedirect = new URL(profile.oauth.authorizationPath, server.baseUrl)
    invalidRedirect.searchParams.set("response_type", "code")
    invalidRedirect.searchParams.set("client_id", scenario.oauth.clientId)
    invalidRedirect.searchParams.set("redirect_uri", "https://attacker.example/callback")
    invalidRedirect.searchParams.set("scope", scenario.oauth.authorizationScopes.join(" "))
    invalidRedirect.searchParams.set("resource", server.mcpUrl)
    invalidRedirect.searchParams.set("state", "state")
    invalidRedirect.searchParams.set("code_challenge", "challenge")
    invalidRedirect.searchParams.set("code_challenge_method", "S256")
    const invalidRedirectResponse = await fetch(invalidRedirect, { redirect: "manual" })
    assert.equal(invalidRedirectResponse.status, 400)

    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    assert.match(token.accessToken, /^access-token-/)
  } finally {
    await server.stop()
  }
})

test("Microsoft and ServiceNow retain distinct safe invalid-client evidence", async () => {
  const microsoftResponse = await invalidClientTokenResponse("microsoft-enterprise")
  assert.equal(microsoftResponse.status, 401)
  const microsoftValue: unknown = JSON.parse(await microsoftResponse.text())
  const microsoftError = z.object({
    error: z.literal("invalid_client"),
    error_description: z.string(),
    error_codes: z.tuple([z.literal(7_000_215)]),
    timestamp: z.string(),
    trace_id: z.string().uuid(),
    correlation_id: z.string().uuid(),
  }).parse(microsoftValue)
  assert.match(microsoftError.error_description, /AADSTS7000215/)
  assert.match(microsoftError.error_description, /client secret value, not the client secret ID/)
  assert.doesNotMatch(microsoftError.error_description, /wrong-secret-must-not-be-echoed/)

  const serviceNowResponse = await invalidClientTokenResponse("servicenow-inbound-quickstart")
  assert.equal(serviceNowResponse.status, 401)
  const serviceNowValue: unknown = JSON.parse(await serviceNowResponse.text())
  const serviceNowError = z.object({
    error: z.literal("invalid_client"),
    error_description: z.string(),
  }).strict().parse(serviceNowValue)
  assert.match(serviceNowError.error_description, /ServiceNow OAuth application/)
  assert.match(serviceNowError.error_description, /client ID and client secret/)
  assert.doesNotMatch(serviceNowError.error_description, /wrong-secret-must-not-be-echoed/)
  assert.doesNotMatch(serviceNowError.error_description, /AADSTS/)
})

test("dynamic registration retains none and client_secret_post authentication methods", async () => {
  const scenario = createDefaultScenario("synthetic-enterprise-oauth-mcp")
  const profile = getProviderProfile(scenario.profileId)
  const registrationPath = profile.oauth.registrationPath
  assert.ok(registrationPath)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const noneRegistration = await fetch(new URL(registrationPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: scenario.oauth.redirectUris, token_endpoint_auth_method: "none" }),
    })
    assert.equal(noneRegistration.status, 201)
    const noneValue: unknown = JSON.parse(await noneRegistration.text())
    const noneClient = z.object({ client_id: z.string(), token_endpoint_auth_method: z.literal("none") }).parse(noneValue)
    const noneToken = await authorizeClient(server.baseUrl, scenario, noneClient.client_id)
    assert.ok(noneToken.accessToken)

    const secretRegistration = await fetch(new URL(registrationPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: scenario.oauth.redirectUris, token_endpoint_auth_method: "client_secret_post" }),
    })
    assert.equal(secretRegistration.status, 201)
    const secretValue: unknown = JSON.parse(await secretRegistration.text())
    const secretClient = z.object({
      client_id: z.string(),
      client_secret: z.string(),
      token_endpoint_auth_method: z.literal("client_secret_post"),
    }).parse(secretValue)
    const secretToken = await authorizeClient(server.baseUrl, scenario, secretClient.client_id, secretClient.client_secret)
    assert.ok(secretToken.accessToken)
    await assert.rejects(authorizeClient(server.baseUrl, scenario, secretClient.client_id), /Token exchange failed with 401/)
  } finally {
    await server.stop()
  }
})

test("refresh rotates tokens and revocation invalidates the active access token", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const profile = getProviderProfile(scenario.profileId)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const first = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const refreshForm = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: scenario.oauth.clientId,
      client_secret: oauthClientSecret,
      refresh_token: first.refreshToken,
    })
    const refreshResponse = await fetch(new URL(profile.oauth.tokenPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshForm,
    })
    assert.equal(refreshResponse.status, 200)
    const refreshedValue: unknown = JSON.parse(await refreshResponse.text())
    const refreshed = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(refreshedValue)
    assert.notEqual(refreshed.access_token, first.accessToken)
    assert.notEqual(refreshed.refresh_token, first.refreshToken)

    const replayResponse = await fetch(new URL(profile.oauth.tokenPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshForm,
    })
    assert.equal(replayResponse.status, 400)

    const revokeResponse = await fetch(new URL(profile.oauth.revocationPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshed.access_token,
        client_id: scenario.oauth.clientId,
        client_secret: oauthClientSecret,
      }),
    })
    assert.equal(revokeResponse.status, 200)
    const protectedResponse = await fetch(server.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${refreshed.access_token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        origin: new URL(server.baseUrl).origin,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    assert.equal(protectedResponse.status, 401)
  } finally {
    await server.stop()
  }
})

test("authorization codes bind exact PKCE verifier and become unusable after one exchange", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const profile = getProviderProfile(scenario.profileId)
  const redirectUri = scenario.oauth.redirectUris[0]
  assert.ok(redirectUri)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const verifier = "wire-test-pkce-verifier-with-more-than-43-characters-1234567890"
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const authorizeUrl = new URL(profile.oauth.authorizationPath, server.baseUrl)
    authorizeUrl.searchParams.set("response_type", "code")
    authorizeUrl.searchParams.set("client_id", scenario.oauth.clientId)
    authorizeUrl.searchParams.set("redirect_uri", redirectUri)
    authorizeUrl.searchParams.set("scope", scenario.oauth.authorizationScopes.join(" "))
    authorizeUrl.searchParams.set("resource", server.mcpUrl)
    authorizeUrl.searchParams.set("state", "one-time-state")
    authorizeUrl.searchParams.set("code_challenge", challenge)
    authorizeUrl.searchParams.set("code_challenge_method", "S256")
    const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" })
    const location = authorizeResponse.headers.get("location")
    assert.ok(location)
    const code = new URL(location).searchParams.get("code")
    assert.ok(code)

    const tokenRequest = (codeVerifier: string): Promise<Response> =>
      fetch(new URL(profile.oauth.tokenPath, server.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: scenario.oauth.clientId,
          client_secret: oauthClientSecret,
          redirect_uri: redirectUri,
          resource: server.mcpUrl,
          code,
          code_verifier: codeVerifier,
        }),
      })
    assert.equal((await tokenRequest("wrong-verifier")).status, 400)
    assert.equal((await tokenRequest(verifier)).status, 200)
    assert.equal((await tokenRequest(verifier)).status, 400)
  } finally {
    await server.stop()
  }
})

test("authorization rejects unsupported response types and malformed PKCE challenges", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const profile = getProviderProfile(scenario.profileId)
  const redirectUri = scenario.oauth.redirectUris[0]
  assert.ok(redirectUri)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const authorize = (responseType: string, challenge: string): Promise<Response> => {
      const url = new URL(profile.oauth.authorizationPath, server.baseUrl)
      url.searchParams.set("response_type", responseType)
      url.searchParams.set("client_id", scenario.oauth.clientId)
      url.searchParams.set("redirect_uri", redirectUri)
      url.searchParams.set("scope", scenario.oauth.authorizationScopes.join(" "))
      url.searchParams.set("resource", server.mcpUrl)
      url.searchParams.set("state", "state")
      url.searchParams.set("code_challenge", challenge)
      url.searchParams.set("code_challenge_method", "S256")
      return fetch(url, { redirect: "manual" })
    }
    assert.equal((await authorize("token", "A".repeat(43))).status, 400)
    assert.equal((await authorize("code", "short")).status, 400)
  } finally {
    await server.stop()
  }
})

test("refresh authority outlives access expiry and preserves only the original MCP session lineage", async () => {
  let now = 1_700_000_000_000
  let counter = 0
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const profile = getProviderProfile(scenario.profileId)
  const server = createEnterpriseMcpMockServer({
    scenario,
    secrets: { oauthClientSecret },
    environment: {
      now: () => now,
      randomId: () => `refresh-${++counter}`,
      opaqueValue: (prefix) => `${prefix}-${++counter}`,
    },
  })
  await server.start()
  try {
    const first = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const session = await initializeSession(server.baseUrl, scenario, first)
    now += 3_600_001
    const refreshResponse = await fetch(new URL(profile.oauth.tokenPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: scenario.oauth.clientId,
        client_secret: oauthClientSecret,
        refresh_token: first.refreshToken,
      }),
    })
    assert.equal(refreshResponse.status, 200)
    const refreshed = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(JSON.parse(await refreshResponse.text()))
    const continued = await callRpc(
      server.baseUrl,
      scenario,
      { ...session, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token },
      44,
      "tools/list",
      {},
    )
    assert.equal(continued.envelope.error, undefined)
    const expiredAccess = await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, first.accessToken),
      body: JSON.stringify({ jsonrpc: "2.0", id: 45, method: "initialize", params: {} }),
    })
    assert.equal(expiredAccess.status, 401)
  } finally {
    await server.stop()
  }
})

test("one dynamic OAuth client cannot revoke another client's token", async () => {
  const scenario = createDefaultScenario("synthetic-enterprise-oauth-mcp")
  const profile = getProviderProfile(scenario.profileId)
  assert.ok(profile.oauth.registrationPath)
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret: "" } })
  await server.start()
  try {
    const register = async (): Promise<string> => {
      const response = await fetch(new URL(profile.oauth.registrationPath ?? "", server.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: scenario.oauth.redirectUris, token_endpoint_auth_method: "none" }),
      })
      return z.object({ client_id: z.string() }).parse(JSON.parse(await response.text())).client_id
    }
    const clientA = await register()
    const clientB = await register()
    const tokenA = await authorizeClient(server.baseUrl, scenario, clientA)
    const denied = await fetch(new URL(profile.oauth.revocationPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokenA.accessToken, client_id: clientB }),
    })
    assert.equal(denied.status, 401)
    assert.equal((await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, tokenA.accessToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: scenario.protocol.version, capabilities: {}, clientInfo: { name: "owner-check", version: "1" } },
      }),
    })).status, 200)
    const allowed = await fetch(new URL(profile.oauth.revocationPath, server.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokenA.accessToken, client_id: clientA }),
    })
    assert.equal(allowed.status, 200)
  } finally {
    await server.stop()
  }
})
