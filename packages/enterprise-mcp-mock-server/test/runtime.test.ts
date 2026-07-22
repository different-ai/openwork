import assert from "node:assert/strict"
import test from "node:test"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  probeEnterpriseMcpMockServer,
  scenarioSchema,
  ScenarioRevisionConflictError,
} from "../src/index.js"

const oauthClientSecret = "synthetic-test-client-secret-32-bytes"

test("healthy ServiceNow profile completes OAuth, MCP, pagination, and cleanup", async () => {
  const scenario = createDefaultScenario("servicenow-inbound-quickstart")
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  const started = await server.start()
  try {
    assert.equal(started.status, "running")
    assert.match(server.mcpUrl, /\/sncapps\/mcp-server\/mcp\/sn_mcp_server_default$/)
    const result = await probeEnterpriseMcpMockServer({
      baseUrl: server.baseUrl,
      scenario,
      credentials: { clientSecret: oauthClientSecret },
    })
    assert.equal(result.ok, true, result.error?.messageSafe)
    assert.equal(result.observed.outcome, "success")
    assert.equal(result.toolCount, 4)
    assert.equal(server.snapshot().counts.sessions, 0)
    assert.equal(server.snapshot().counts.tokens, 0)
    const serializedEvents = JSON.stringify(server.events())
    assert.equal(serializedEvents.includes(oauthClientSecret), false)
    assert.equal(serializedEvents.includes("access-token-"), false)
    assert.equal(serializedEvents.includes("refresh-token-"), false)
  } finally {
    const stopped = await server.stop()
    assert.equal(stopped.status, "stopped")
    assert.equal(stopped.counts.sessions, 0)
    assert.equal(stopped.counts.tokens, 0)
  }
})

test("SSE and dynamic client registration form a healthy spec-conformance profile", async () => {
  const base = createDefaultScenario("synthetic-enterprise-oauth-mcp")
  const scenario = scenarioSchema.parse({ ...base, protocol: { ...base.protocol, responseMode: "sse" } })
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const result = await probeEnterpriseMcpMockServer({ baseUrl: server.baseUrl, scenario })
    assert.equal(result.ok, true, result.error?.messageSafe)
    assert.equal(result.toolCount, 2)
    assert.equal(server.snapshot().counts.sessions, 0)
  } finally {
    await server.stop()
  }
})

test("controller serializes concurrent lifecycle calls and enforces revision CAS", async () => {
  const scenario = createDefaultScenario()
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  const [first, second] = await Promise.all([server.start(), server.start()])
  assert.equal(first.baseUrl, second.baseUrl)
  assert.equal(first.instanceId, second.instanceId)

  const next = scenarioSchema.parse({ ...scenario, id: "servicenow-revision-two", revision: 2 })
  await assert.rejects(server.updateScenario(next, 99), ScenarioRevisionConflictError)
  const updated = await server.updateScenario(next, 1)
  assert.equal(updated.status, "running")
  assert.equal(updated.scenario.revision, 2)

  const [stoppedOnce, stoppedTwice] = await Promise.all([server.stop(), server.stop()])
  assert.equal(stoppedOnce.status, "stopped")
  assert.equal(stoppedTwice.status, "stopped")
  assert.equal(stoppedTwice.counts.sessions, 0)
})

test("injected environment makes runtime identifiers and time deterministic", async () => {
  let counter = 0
  const environment = {
    now: () => 1_700_000_000_000,
    randomId: () => `uuid-${++counter}`,
    opaqueValue: (prefix: string) => `${prefix}-value-${++counter}`,
  }
  const scenario = createDefaultScenario()
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret }, environment })
  const started = await server.start()
  try {
    assert.equal(started.instanceId, "uuid-1")
    assert.equal(server.events()[0]?.occurredAt, "2023-11-14T22:13:20.000Z")
  } finally {
    await server.stop()
  }
})

test("data-plane health is minimal and contains no scenario or secret material", async () => {
  const scenario = createDefaultScenario()
  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const response = await fetch(new URL("/health", server.baseUrl))
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.equal(text.includes(oauthClientSecret), false)
    assert.equal(text.includes("authorizationScopes"), false)
    assert.equal(text.includes("activeFault"), false)
  } finally {
    await server.stop()
  }
})

test("public scenarios, catalogs, snapshots, and events are deeply immutable runtime values", async () => {
  const scenario = createDefaultScenario()
  assert.equal(Object.isFrozen(scenario), true)
  assert.equal(Object.isFrozen(scenario.oauth.authorizationScopes), true)
  assert.throws(() => {
    ;(scenario as { revision: number }).revision = 999
  }, TypeError)

  const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const snapshot = server.snapshot()
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.profile.tools), true)
    assert.throws(() => {
      ;(snapshot.scenario as { revision: number }).revision = 777
    }, TypeError)
    assert.equal(server.snapshot().scenario.revision, 1)
    assert.equal(Object.isFrozen(server.events()), true)
  } finally {
    await server.stop()
  }
  assert.throws(() => server.baseUrl, /has not started/)
})

test("failed live scenario activation restores the prior immutable revision transactionally", async () => {
  let counter = 0
  const scenario = createDefaultScenario()
  const server = createEnterpriseMcpMockServer({
    scenario,
    secrets: { oauthClientSecret },
    environment: {
      now: Date.now,
      randomId: () => `transaction-${++counter}`,
      opaqueValue: (prefix) => `${prefix}-${++counter}`,
      beforeListen: (attempt) => {
        if (attempt === 2) throw new Error("injected activation failure")
      },
    },
  })
  await server.start()
  const next = scenarioSchema.parse({ ...scenario, id: "servicenow-revision-two", revision: 2 })
  await assert.rejects(server.updateScenario(next, 1), /injected activation failure/)
  assert.equal(server.snapshot().status, "running")
  assert.equal(server.snapshot().scenario.revision, 1)
  assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal((await fetch(new URL("/health", server.baseUrl))).status, 200)
  await server.stop()
})
