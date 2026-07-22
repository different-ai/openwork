import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:net"
import test from "node:test"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  createFaultScenario,
  getProviderProfile,
  scenarioSchema,
  ScenarioCredentialContinuityError,
  type EnterpriseMcpScenario,
} from "../src/index.js"
import { authorizeManual, callRpc, initializeSession, rpcHeaders, sessionHeaders } from "./wire-client.js"

const oauthClientSecret = "synthetic-test-client-secret-32-bytes"

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP port")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function createPendingAuthorization(
  baseUrl: string,
  scenario: EnterpriseMcpScenario,
): Promise<{ code: string; verifier: string }> {
  const profile = getProviderProfile(scenario.profileId)
  const redirectUri = scenario.oauth.redirectUris[0]
  if (!redirectUri) throw new Error("Scenario redirect URI missing")
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const authorize = new URL(profile.oauth.authorizationPath, baseUrl)
  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("client_id", scenario.oauth.clientId)
  authorize.searchParams.set("redirect_uri", redirectUri)
  authorize.searchParams.set("scope", scenario.oauth.authorizationScopes.join(" "))
  authorize.searchParams.set("resource", new URL(profile.endpointPath, baseUrl).href)
  authorize.searchParams.set("state", "pending-across-revision")
  authorize.searchParams.set("code_challenge", challenge)
  authorize.searchParams.set("code_challenge_method", "S256")
  const response = await fetch(authorize, { redirect: "manual" })
  assert.equal(response.status, 302)
  const location = response.headers.get("location")
  assert.ok(location)
  const code = new URL(location).searchParams.get("code")
  assert.ok(code)
  return { code, verifier }
}

function exchangePendingAuthorization(
  baseUrl: string,
  scenario: EnterpriseMcpScenario,
  pending: { code: string; verifier: string },
): Promise<Response> {
  const profile = getProviderProfile(scenario.profileId)
  const redirectUri = scenario.oauth.redirectUris[0]
  assert.ok(redirectUri)
  return fetch(new URL(profile.oauth.tokenPath, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: scenario.oauth.clientId,
      client_secret: oauthClientSecret,
      redirect_uri: redirectUri,
      resource: new URL(profile.endpointPath, baseUrl).href,
      code: pending.code,
      code_verifier: pending.verifier,
    }),
  })
}

function refreshToken(baseUrl: string, scenario: EnterpriseMcpScenario, refreshTokenValue: string): Promise<Response> {
  const profile = getProviderProfile(scenario.profileId)
  return fetch(new URL(profile.oauth.tokenPath, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: scenario.oauth.clientId,
      client_secret: oauthClientSecret,
      refresh_token: refreshTokenValue,
    }),
  })
}

test("compatible scenario activation preserves established OAuth authority but clears revision-local state", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const server = createEnterpriseMcpMockServer({
    scenario,
    secrets: { oauthClientSecret },
    port: await freePort(),
  })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const oldSession = await initializeSession(server.baseUrl, scenario, token)
    const mutation = await callRpc(server.baseUrl, scenario, oldSession, 30, "tools/call", {
      name: "create_incident",
      arguments: {
        approved: true,
        idempotency_key: "continuity-operation-must-not-cross",
        short_description: "Synthetic continuity boundary",
      },
    })
    assert.equal(mutation.response.status, 200)
    assert.equal(server.snapshot().counts.operations, 1)
    const pending = await createPendingAuthorization(server.baseUrl, scenario)

    const faulted = createFaultScenario("servicenow-inbound-quickstart", "mcp-empty-tool-catalog", 2)
    const activated = await server.updateScenario(faulted, 1, {
      credentialContinuity: "preserve-compatible-oauth",
    })
    assert.equal(activated.counts.clients, 1)
    assert.equal(activated.counts.tokens, 2)
    assert.equal(activated.counts.sessions, 0)
    assert.equal(activated.counts.operations, 0)
    assert.ok(server.events().length > 0)
    assert.ok(server.events().every((event) => event.revision === 2))

    const oldSessionResponse = await fetch(server.mcpUrl, {
      method: "POST",
      headers: sessionHeaders(
        server.baseUrl,
        oldSession.accessToken,
        oldSession.sessionId,
        oldSession.protocolVersion,
      ),
      body: JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/list", params: {} }),
    })
    assert.equal(oldSessionResponse.status, 404)

    const newSession = await initializeSession(server.baseUrl, faulted, token)
    const catalog = await callRpc(server.baseUrl, faulted, newSession, 32, "tools/list", {})
    assert.equal(catalog.response.status, 200)
    assert.deepEqual(catalog.envelope.result, { tools: [] })
    assert.equal((await exchangePendingAuthorization(server.baseUrl, faulted, pending)).status, 400)
    const publicEvidence = JSON.stringify({ snapshot: server.snapshot(), events: server.events() })
    assert.equal(publicEvidence.includes(oauthClientSecret), false)
    assert.equal(publicEvidence.includes(token.accessToken), false)
    assert.equal(publicEvidence.includes(token.refreshToken), false)
    assert.equal((await refreshToken(server.baseUrl, faulted, token.refreshToken)).status, 200)
  } finally {
    await server.stop()
  }
})

test("default reset activation still invalidates all issued OAuth authority", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret }, port: await freePort() })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    assert.equal(server.snapshot().counts.tokens, 2)
    const next = scenarioSchema.parse({ ...scenario, id: "servicenow-reset-revision", revision: 2 })
    const activated = await server.updateScenario(next, 1)
    assert.equal(activated.counts.tokens, 0)
    assert.equal(activated.counts.sessions, 0)
    const response = await fetch(server.mcpUrl, {
      method: "POST",
      headers: rpcHeaders(server.baseUrl, token.accessToken),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 40,
        method: "initialize",
        params: { protocolVersion: next.protocol.version, capabilities: {}, clientInfo: { name: "reset-test", version: "1" } },
      }),
    })
    assert.equal(response.status, 401)
  } finally {
    await server.stop()
  }
})

test("preservation rejects ephemeral ports and incompatible OAuth authority before changing the active revision", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const revisionTwo = scenarioSchema.parse({ ...scenario, id: "servicenow-compatible-revision", revision: 2 })
  const ephemeral = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await ephemeral.start()
  try {
    await assert.rejects(
      ephemeral.updateScenario(revisionTwo, 1, { credentialContinuity: "preserve-compatible-oauth" }),
      (error: unknown) => error instanceof ScenarioCredentialContinuityError && error.code === "fixed_port_required",
    )
    assert.equal(ephemeral.snapshot().scenario.revision, 1)
    assert.equal((await fetch(new URL("/health", ephemeral.baseUrl))).status, 200)
  } finally {
    await ephemeral.stop()
  }

  const fixed = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret }, port: await freePort() })
  await fixed.start()
  try {
    const changedClient = scenarioSchema.parse({
      ...scenario,
      id: "servicenow-changed-client",
      revision: 2,
      oauth: { ...scenario.oauth, clientId: "different-pre-registered-client" },
    })
    const changedProvider = scenarioSchema.parse({ ...createDefaultScenario("microsoft-enterprise"), revision: 2 })
    for (const incompatible of [changedClient, changedProvider]) {
      await assert.rejects(
        fixed.updateScenario(incompatible, 1, { credentialContinuity: "preserve-compatible-oauth" }),
        (error: unknown) =>
          error instanceof ScenarioCredentialContinuityError && error.code === "incompatible_oauth_authority",
      )
      assert.equal(fixed.snapshot().scenario.revision, 1)
    }
    assert.equal((await fetch(new URL("/health", fixed.baseUrl))).status, 200)
  } finally {
    await fixed.stop()
  }
})

test("failed compatible activation rolls back the prior scenario, bearer, and MCP session", async () => {
  let listenAttempt = 0
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const server = createEnterpriseMcpMockServer({
    scenario,
    secrets: { oauthClientSecret },
    port: await freePort(),
    environment: {
      now: Date.now,
      randomId: () => `continuity-rollback-${randomBytes(8).toString("hex")}`,
      opaqueValue: (prefix) => `${prefix}-${randomBytes(12).toString("base64url")}`,
      beforeListen: () => {
        listenAttempt += 1
        if (listenAttempt === 2) throw new Error("injected compatible activation failure")
      },
    },
  })
  await server.start()
  try {
    const token = await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    const session = await initializeSession(server.baseUrl, scenario, token)
    const next = scenarioSchema.parse({ ...scenario, id: "servicenow-failed-compatible-revision", revision: 2 })
    await assert.rejects(
      server.updateScenario(next, 1, { credentialContinuity: "preserve-compatible-oauth" }),
      /injected compatible activation failure/,
    )
    assert.equal(server.snapshot().scenario.revision, 1)
    assert.equal(server.snapshot().counts.tokens, 2)
    assert.equal(server.snapshot().counts.sessions, 1)
    const list = await callRpc(server.baseUrl, scenario, session, 50, "tools/list", {})
    assert.equal(list.response.status, 200)
    assert.ok(Array.isArray((list.envelope.result as { tools?: unknown[] } | undefined)?.tools))
  } finally {
    await server.stop()
  }
})

test("preservation copies only OAuth records that remain unexpired at activation time", async () => {
  let now = 1_700_000_000_000
  let identifier = 0
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const server = createEnterpriseMcpMockServer({
    scenario,
    secrets: { oauthClientSecret },
    port: await freePort(),
    environment: {
      now: () => now,
      randomId: () => `continuity-expiry-${++identifier}`,
      opaqueValue: (prefix) => `${prefix}-${++identifier}`,
    },
  })
  await server.start()
  try {
    await authorizeManual(server.baseUrl, scenario, oauthClientSecret)
    assert.equal(server.snapshot().counts.tokens, 2)
    now += 31 * 24 * 60 * 60 * 1_000
    const next = scenarioSchema.parse({ ...scenario, id: "servicenow-expired-authority", revision: 2 })
    const activated = await server.updateScenario(next, 1, { credentialContinuity: "preserve-compatible-oauth" })
    assert.equal(activated.counts.clients, 1)
    assert.equal(activated.counts.tokens, 0)
  } finally {
    await server.stop()
  }
})
