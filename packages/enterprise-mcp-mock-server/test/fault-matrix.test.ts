import assert from "node:assert/strict"
import test from "node:test"
import {
  createEnterpriseMcpMockServer,
  createFaultScenario,
  listFaultDefinitions,
  probeEnterpriseMcpMockServer,
  scenarioSchema,
} from "../src/index.js"

const oauthClientSecret = "synthetic-test-client-secret-32-bytes"

test("every advertised fault is observed at its actual first phase and leaves bounded state", async (context) => {
  for (const fault of listFaultDefinitions()) {
    for (const profileId of fault.applicableProfiles) {
      await context.test(`${fault.id} / ${profileId}`, async () => {
        const scenario = createFaultScenario(profileId, fault.id)
        const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
        await server.start()
        try {
          const result = await probeEnterpriseMcpMockServer({
            baseUrl: server.baseUrl,
            scenario,
            credentials: { clientSecret: oauthClientSecret },
          })
          assert.equal(result.ok, true, `${fault.id} / ${profileId}: ${result.error?.messageSafe ?? "unexpected success"}`)
          assert.equal(result.observed.outcome, "failure")
          assert.equal(result.observed.firstFailedPhase, fault.phase)
          assert.equal(result.observed.category, fault.category)
          assert.equal(server.snapshot().counts.sessions, 0)
          const events = server.events()
          const appliedIndex = events.findIndex((event) => event.kind === "fault" && event.details.faultId === fault.id)
          assert.notEqual(appliedIndex, -1, `${fault.id} did not emit its safe fault event`)
          assert.equal(
            events.slice(appliedIndex + 1).some((event) => event.phase === fault.phase && event.outcome === "passed"),
            false,
            `${fault.id} emitted a contradictory passed event after the fault was applied`,
          )
        } finally {
          await server.stop()
        }
      })
    }
  }
})

test("probe cannot pass by copying expected fault metadata", async () => {
  const serverScenario = createFaultScenario("synthetic-enterprise-oauth-mcp", "mcp-wrong-content-type")
  const claimedScenario = createFaultScenario("synthetic-enterprise-oauth-mcp", "mcp-version-unsupported")
  const server = createEnterpriseMcpMockServer({ scenario: serverScenario, secrets: { oauthClientSecret } })
  await server.start()
  try {
    const result = await probeEnterpriseMcpMockServer({ baseUrl: server.baseUrl, scenario: claimedScenario })
    assert.equal(result.ok, false)
    assert.equal(result.observed.firstFailedPhase, "MCP_TRANSPORT")
    assert.equal(result.observed.category, "mcp_transport")
    assert.notEqual(result.observed.firstFailedPhase, claimedScenario.expected.firstFailedPhase)
  } finally {
    await server.stop()
  }
})

test("probe refuses non-loopback targets before sending any request", async () => {
  const scenario = createFaultScenario("synthetic-enterprise-oauth-mcp", "mcp-version-unsupported")
  await assert.rejects(
    probeEnterpriseMcpMockServer({ baseUrl: "https://example.com", scenario }),
    /literal loopback/,
  )
})

test("once-triggered cursor and duplicate faults are consumed only when their effect is reachable", async () => {
  for (const faultId of ["mcp-catalog-cursor-loop", "mcp-duplicate-tool"] as const) {
    const base = createFaultScenario("synthetic-enterprise-oauth-mcp", faultId)
    const scenario = scenarioSchema.parse({
      ...base,
      activeFault: { id: faultId, trigger: { occurrence: "once" } },
    })
    const server = createEnterpriseMcpMockServer({ scenario, secrets: { oauthClientSecret } })
    await server.start()
    try {
      const result = await probeEnterpriseMcpMockServer({ baseUrl: server.baseUrl, scenario })
      assert.equal(result.ok, true, `${faultId}: ${result.error?.messageSafe ?? "unexpected success"}`)
    } finally {
      await server.stop()
    }
  }
})
