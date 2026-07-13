import assert from "node:assert/strict"
import test from "node:test"
import { once } from "node:events"
import { createConnection } from "node:net"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  getProviderProfile,
} from "../src/index.js"
import { InstanceState } from "../src/runtime/instance-state.js"

const oauthClientSecret = "synthetic-test-client-secret-32-bytes"

test("event and state buffers are capped, expire, and redact known secrets", () => {
  let now = 1_700_000_000_000
  let counter = 0
  const environment = {
    now: () => now,
    randomId: () => `id-${++counter}`,
    opaqueValue: (prefix: string) => `${prefix}-${++counter}`,
  }
  const scenario = createDefaultScenario()
  const profile = getProviderProfile(scenario.profileId)
  const state = new InstanceState(scenario, profile, [oauthClientSecret], environment)
  for (let index = 0; index < 600; index += 1) {
    state.emit({
      correlationId: `correlation-${index}`,
      scenario,
      phase: "CONFIGURATION",
      direction: "internal",
      kind: "lifecycle",
      outcome: "completed",
      summary: "Synthetic bounded event",
      details: {
        safe: `Bearer access-token-${index} ${oauthClientSecret}`,
        clientSecret: oauthClientSecret,
      },
    })
  }
  assert.equal(state.events().length, 500)
  const serialized = JSON.stringify(state.events())
  assert.equal(serialized.includes(oauthClientSecret), false)
  assert.equal(serialized.includes("access-token-"), false)

  for (let index = 0; index < 120; index += 1) {
    state.putClient({
      clientId: `client-${index}`,
      clientSecret: `secret-${index}`,
      redirectUris: ["http://127.0.0.1:19876/callback"],
      tokenEndpointAuthMethod: "client_secret_post",
      createdAt: now,
      expiresAt: now + 3_600_000,
    })
  }
  assert.equal(state.clients.size, 100)
  for (let index = 0; index < 120; index += 1) {
    state.putAuthorizationCode({
      code: `code-${index}`,
      clientId: `client-${index}`,
      redirectUri: "http://127.0.0.1:19876/callback",
      codeChallenge: `challenge-${index}`,
      resource: "http://127.0.0.1:9999/mcp",
      scopes: ["mcp_server"],
      expiresAt: now + 1_000,
    })
    state.putToken({
      accessToken: `access-${index}`,
      familyId: `family-${index}`,
      clientId: `client-${index}`,
      resource: "http://127.0.0.1:9999/mcp",
      scopes: ["mcp_server"],
      subject: `subject-${index}`,
      expiresAt: now + 1_000,
    })
    state.putRefreshToken({
      refreshToken: `refresh-${index}`,
      familyId: `family-${index}`,
      clientId: `client-${index}`,
      resource: "http://127.0.0.1:9999/mcp",
      scopes: ["mcp_server"],
      subject: `subject-${index}`,
      expiresAt: now + 2_000,
    })
    state.putSession({
      sessionId: `session-${index}`,
      tokenFamilyId: `family-${index}`,
      operationNamespace: `client-${index}\u0000subject-${index}\u0000resource`,
      profileId: profile.id,
      protocolVersion: scenario.protocol.version,
      scenarioRevision: scenario.revision,
      expiresAt: now + 1_000,
      initialized: true,
    })
  }
  assert.equal(state.authorizationCodes.size, 100)
  assert.equal(state.tokens.size, 100)
  assert.equal(state.refreshTokens.size, 100)
  assert.equal(state.sessions.size, 100)
  for (let index = 0; index < 1_020; index += 1) {
    const prepared = state.prepareOperation("test-family", "create_incident", `idempotency-${index}`, { value: index })
    if (prepared.kind === "prepared") state.transitionOperation(prepared.operation.operationId, "responded", `result-${index}`)
  }
  assert.equal(state.operations.size, 1000)
  for (let index = 0; index < 120; index += 1) state.faultCounters.set(`fault-${index}`, index)
  state.maintainBounds()
  assert.equal(state.faultCounters.size, 100)
  now += 3_600_001
  state.maintainBounds()
  assert.equal(state.clients.size, 0)
  assert.equal(state.authorizationCodes.size, 0)
  assert.equal(state.tokens.size, 0)
  assert.equal(state.refreshTokens.size, 0)
  assert.equal(state.sessions.size, 0)
  now += 86_400_001
  state.maintainBounds()
  assert.equal(state.operations.size, 0)
})

test("stop and reset drain an incomplete active request and leave no orphan listener", async () => {
  const scenario = createDefaultScenario("synthetic-enterprise-oauth-mcp")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  const firstBaseUrl = server.baseUrl
  const firstUrl = new URL(firstBaseUrl)
  const firstSocket = createConnection({ host: firstUrl.hostname, port: Number(firstUrl.port) })
  firstSocket.on("error", () => undefined)
  await once(firstSocket, "connect")
  firstSocket.write(
    "POST /oauth/register HTTP/1.1\r\n" +
      `Host: ${firstUrl.host}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 100\r\n" +
      "Connection: keep-alive\r\n\r\n" +
      "{",
  )
  const stopped = await server.stop()
  assert.equal(stopped.status, "stopped")
  assert.equal(stopped.counts.sessions, 0)
  assert.equal(stopped.counts.tokens, 0)
  await assert.rejects(fetch(new URL("/health", firstBaseUrl)))

  await server.start()
  const secondBaseUrl = server.baseUrl
  const secondUrl = new URL(secondBaseUrl)
  const secondSocket = createConnection({ host: secondUrl.hostname, port: Number(secondUrl.port) })
  secondSocket.on("error", () => undefined)
  await once(secondSocket, "connect")
  secondSocket.write(
    "POST /oauth/register HTTP/1.1\r\n" +
      `Host: ${secondUrl.host}\r\n` +
      "Content-Type: application/json\r\n" +
      "Content-Length: 100\r\n" +
      "Connection: keep-alive\r\n\r\n" +
      "{",
  )
  const reset = await server.reset()
  assert.equal(reset.status, "running")
  assert.equal(reset.counts.sessions, 0)
  assert.equal(reset.counts.tokens, 0)
  const health = await fetch(new URL("/health", server.baseUrl))
  assert.equal(health.status, 200)
  await server.stop()
})

test("only a responded mutation can be reported as an idempotent duplicate", () => {
  let counter = 0
  const scenario = createDefaultScenario()
  const state = new InstanceState(
    scenario,
    getProviderProfile(scenario.profileId),
    [oauthClientSecret],
    { now: Date.now, randomId: () => `id-${++counter}`, opaqueValue: (prefix) => `${prefix}-${++counter}` },
  )
  const prepared = state.prepareOperation("family-a", "create_incident", "stable-idempotency-key", { value: 1 })
  assert.equal(prepared.kind, "prepared")
  assert.equal(state.prepareOperation("family-a", "create_incident", "stable-idempotency-key", { value: 1 }).kind, "reconcile")
  if (prepared.kind !== "prepared") throw new Error("Expected prepared operation")
  state.transitionOperation(prepared.operation.operationId, "committed", "synthetic:result")
  assert.equal(state.prepareOperation("family-a", "create_incident", "stable-idempotency-key", { value: 1 }).kind, "reconcile")
  state.transitionOperation(prepared.operation.operationId, "responded", "synthetic:result")
  assert.equal(state.prepareOperation("family-a", "create_incident", "stable-idempotency-key", { value: 1 }).kind, "duplicate")
  assert.equal(state.prepareOperation("family-b", "create_incident", "stable-idempotency-key", { value: 1 }).kind, "prepared")
})

test("bounded eviction never forgets an unresolved mutation outcome", () => {
  let counter = 0
  const scenario = createDefaultScenario()
  const state = new InstanceState(
    scenario,
    getProviderProfile(scenario.profileId),
    [oauthClientSecret],
    { now: Date.now, randomId: () => `id-${++counter}`, opaqueValue: (prefix) => `${prefix}-${++counter}` },
  )
  const critical = state.prepareOperation("critical-client", "create_incident", "critical-key", { value: "critical" })
  if (critical.kind !== "prepared") throw new Error("Expected critical operation to prepare")
  state.transitionOperation(critical.operation.operationId, "indeterminate", "critical-result")
  for (let index = 0; index < 1_100; index += 1) {
    const filler = state.prepareOperation("filler-client", "create_incident", `filler-${index}`, { value: index })
    if (filler.kind === "prepared") state.transitionOperation(filler.operation.operationId, "responded", `result-${index}`)
  }
  assert.equal(state.operations.has(critical.operation.operationId), true)
  assert.equal(state.prepareOperation("critical-client", "create_incident", "critical-key", { value: "critical" }).kind, "reconcile")
  assert.equal(state.operations.size, 1000)
})

test("a ledger full of unresolved outcomes rejects new mutations instead of evicting evidence", () => {
  let counter = 0
  const scenario = createDefaultScenario()
  const state = new InstanceState(
    scenario,
    getProviderProfile(scenario.profileId),
    [oauthClientSecret],
    { now: Date.now, randomId: () => `id-${++counter}`, opaqueValue: (prefix) => `${prefix}-${++counter}` },
  )
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(state.prepareOperation("capacity-client", "create_incident", `unresolved-${index}`, { value: index }).kind, "prepared")
  }
  assert.equal(state.prepareOperation("capacity-client", "create_incident", "one-too-many", { value: 1_001 }).kind, "capacity")
  assert.equal(state.operations.size, 1_000)
})
